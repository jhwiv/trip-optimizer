// POST /api/drive-time-verify
// ------------------------------------------------------------------
// Real driving-time facts for a batch of candidate legs, via TomTom's
// Search (geocode) + Routing APIs. Added 2026-08-28 to close the gap
// CLAUDE.md's KNOWN FAILURE MODE #18 documented as explicitly unfixed:
// "this app has no routing/distance API computing an authoritative drive
// duration." See src/driveTimeVerify.js for the client-side collection/
// merge logic this endpoint feeds.
//
// Architecture mirrors functions/api/places-verify.js deliberately:
//   - env.PLACES KV reused (prefix "drivetime:v1:" so it can't collide
//     with the venue cache) rather than provisioning a new namespace.
//   - Server returns raw facts only (realMinutes, realKm); the client
//     decides what counts as a mismatch and how to word it — same split
//     as /api/verify-url (ok/dead) feeding stripDeadBookingUrls's policy.
//   - Missing TOMTOM_API_KEY or any per-leg failure → { error: "..." },
//     never a thrown exception. Fail safe per this app's hard rule:
//     an unavailable verification tool means "unverified", not "wrong".
//
// Request body:
//   { legs: [{ origin: string, destination: string }] }
//   Limit: 20 legs per call.
//
// Response (200 unless input malformed):
//   {
//     results: [
//       { origin, destination, realMinutes?, realKm?, cached?, error? }
//     ],
//     summary: { checked, cache_hits, elapsed_ms }
//   }
//
// NOTE ON VERIFICATION STATUS (2026-08-28): this file was written against
// TomTom's publicly documented Search/Routing API shapes from general
// knowledge — this sandbox's network egress policy blocks api.tomtom.com,
// the same way it blocks routesmith.ai and every third-party API docs site
// tried this session, so the exact request/response field names here could
// NOT be confirmed with a live call before shipping. The MCP TomTom
// connector (a different product surface) WAS used to empirically confirm
// the real Bayeux→Nuremberg driving time (1,066 km / 9h19m) that motivated
// this feature, but that does not prove this file's raw REST calls are
// byte-for-byte correct. Treat this as "confident best-effort, not yet
// live-verified" until a real TOMTOM_API_KEY is provisioned and a request
// is captured against the deployed endpoint — per this repo's own
// Verification Discipline section, that gap is stated here explicitly
// rather than glossed over.

const TOMTOM_GEOCODE_URL = "https://api.tomtom.com/search/2/geocode/";
const TOMTOM_ROUTING_URL = "https://api.tomtom.com/routing/1/calculateRoute/";

const CACHE_PREFIX = "drivetime:v1:";
const CACHE_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days — road networks change slower than venue status, but not never
const HTTP_TIMEOUT_MS = 8000;
const MAX_LEGS = 20;
const MAX_PARALLEL = 5;
const ENDPOINT_MAX = 200;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      ...corsHeaders(),
    },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

function normalizeForCacheKey(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

async function cacheKeyFor(origin, destination) {
  const hash = await sha256Hex(`${normalizeForCacheKey(origin)}|${normalizeForCacheKey(destination)}`);
  return `${CACHE_PREFIX}${hash}`;
}

async function readCache(env, key) {
  if (!env?.PLACES) return null;
  try {
    const raw = await env.PLACES.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(env, ctx, key, payload) {
  if (!env?.PLACES) return;
  if (payload && payload.error) return; // only cache definitive results
  const p = env.PLACES.put(key, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function geocode(apiKey, query) {
  const url = `${TOMTOM_GEOCODE_URL}${encodeURIComponent(query)}.json?key=${encodeURIComponent(apiKey)}&limit=1`;
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`geocode ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const hit = Array.isArray(data?.results) ? data.results[0] : null;
  const pos = hit?.position;
  if (!hit || typeof pos?.lat !== "number" || typeof pos?.lon !== "number") return null;
  return { lat: pos.lat, lon: pos.lon };
}

async function route(apiKey, from, to) {
  // Typical driving conditions, not live traffic — the itinerary's travel
  // date is arbitrary/future, so "right now" traffic isn't the meaningful
  // ground truth to compare a planned trip against.
  const url = `${TOMTOM_ROUTING_URL}${from.lat},${from.lon}:${to.lat},${to.lon}/json?key=${encodeURIComponent(apiKey)}&routeType=fastest&traffic=false`;
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`routing ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const summary = data?.routes?.[0]?.summary;
  if (!summary || typeof summary.travelTimeInSeconds !== "number") return null;
  return {
    realMinutes: Math.round(summary.travelTimeInSeconds / 60),
    realKm: typeof summary.lengthInMeters === "number" ? summary.lengthInMeters / 1000 : undefined,
  };
}

async function verifyOneLeg({ env, ctx, origin, destination }) {
  if (!origin || !destination) return { origin, destination, error: "missing-endpoint" };
  const key = await cacheKeyFor(origin, destination);
  const cached = await readCache(env, key);
  if (cached) return { ...cached, origin, destination, cached: true };

  if (!env?.TOMTOM_API_KEY) return { origin, destination, error: "no-key" };

  try {
    const [from, to] = await Promise.all([
      geocode(env.TOMTOM_API_KEY, origin),
      geocode(env.TOMTOM_API_KEY, destination),
    ]);
    if (!from || !to) {
      const result = { error: "geocode-failed" };
      writeCache(env, ctx, key, result);
      return { origin, destination, ...result };
    }
    const routed = await route(env.TOMTOM_API_KEY, from, to);
    if (!routed) {
      const result = { error: "no-route" };
      writeCache(env, ctx, key, result);
      return { origin, destination, ...result };
    }
    writeCache(env, ctx, key, routed);
    return { origin, destination, ...routed };
  } catch (err) {
    // Transient errors (timeout, quota, 5xx) — don't cache, give the next
    // build a fresh chance rather than freezing a bad result for 14 days.
    return { origin, destination, error: String(err?.message || err).slice(0, 200) };
  }
}

async function mapParallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]);
      } catch (err) {
        results[idx] = { origin: items[idx]?.origin, destination: items[idx]?.destination, error: String(err?.message || err).slice(0, 200) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON" }, results: [], summary: { checked: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt } }, 400);
  }

  const rawLegs = Array.isArray(body?.legs) ? body.legs : [];
  const legs = [];
  for (const l of rawLegs) {
    const origin = typeof l?.origin === "string" ? l.origin.trim().slice(0, ENDPOINT_MAX) : "";
    const destination = typeof l?.destination === "string" ? l.destination.trim().slice(0, ENDPOINT_MAX) : "";
    if (!origin || !destination) continue;
    legs.push({ origin, destination });
    if (legs.length >= MAX_LEGS) break;
  }

  if (legs.length === 0) {
    return json({ results: [], summary: { checked: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt } });
  }

  let cacheHits = 0;
  const results = await mapParallel(legs, MAX_PARALLEL, async (leg) => {
    const r = await verifyOneLeg({ env, ctx: context, origin: leg.origin, destination: leg.destination });
    if (r.cached) cacheHits += 1;
    return r;
  });

  return json({
    results,
    summary: { checked: results.length, cache_hits: cacheHits, elapsed_ms: Date.now() - startedAt },
  });
}
