// POST /api/routes-verify
//
// Batch travel-time check using Google Routes API (the v2 successor to
// Distance Matrix). Given pairs of {originLat, originLng, destLat,
// destLng, travelMode}, returns duration_seconds + distance_meters per
// pair. Used by the post-build pacing check to flag impossible
// transitions between adjacent itinerary items.
//
// Why a separate endpoint (not just calling Routes from the client):
//   - Hides the API key (same pattern as Places).
//   - KV-cached at the server, so repeat-build pairs are free.
//   - Single Worker invocation handles N pairs in one
//     computeRouteMatrix call -- 1 subrequest regardless of N.
//
// Request body:
//   {
//     pairs: [
//       {
//         id: string,                       // echo key for the client
//         originLat: number, originLng: number,
//         destLat: number,   destLng: number,
//         travelMode: "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT"
//       },
//       ...
//     ]
//   }
// Limit: 20 pairs per call. Routes API allows much larger matrices but
// we cap to keep the Worker subrequest budget intact when combined with
// KV reads/writes.
//
// Response (200 unless input malformed):
//   {
//     routes: [
//       {
//         id: string,
//         found: boolean,
//         duration_seconds?: number,
//         distance_meters?: number,
//         cached?: boolean,
//         error?: string
//       },
//       ...
//     ],
//     summary: { checked, found, cache_hits, elapsed_ms }
//   }
//
// Soft-fail: missing GOOGLE_PLACES_API_KEY (the same key, but requires
// Routes API enabled in the same project) returns 200 with every
// route's found:false and error:"no-key". The client degrades to
// skipping the pacing check entirely.

const ROUTES_API_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const ROUTES_FIELD_MASK = "originIndex,destinationIndex,duration,distanceMeters,status,condition";

const MAX_PAIRS = 20;
const HTTP_TIMEOUT_MS = 8000;
const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CACHE_PREFIX = "route:" + CACHE_VERSION + ":";

const ALLOWED_MODES = new Set(["DRIVE", "WALK", "BICYCLE", "TRANSIT"]);

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
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// Round coords to 4 decimals (~11 m precision) so two venues a meter
// apart still share a cache key.
function roundCoord(n) {
  return Math.round(n * 10000) / 10000;
}

async function cacheKeyFor(pair) {
  const k = `${roundCoord(pair.originLat)},${roundCoord(pair.originLng)}|${roundCoord(pair.destLat)},${roundCoord(pair.destLng)}|${pair.travelMode}`;
  const hash = await sha256Hex(k);
  return CACHE_PREFIX + hash;
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
  // Don't cache transient errors.
  if (payload && payload.error && payload.error !== "not-found") return;
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

// Routes API returns duration as a string like "123s". Parse to integer.
function parseDuration(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d+)s$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

// computeRouteMatrix takes one travelMode per call. Group pairs by mode.
function groupByMode(pairs) {
  const byMode = new Map();
  for (const p of pairs) {
    const mode = p.travelMode || "DRIVE";
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode).push(p);
  }
  return byMode;
}

// Call Routes API once for one mode + array of pairs. We pass N origins
// + N destinations and read only the diagonal. Routes API bills per
// cell; the N^2 cost is acceptable since N <= 20 and cached results are
// free on re-run. Throws on HTTP error.
async function callRoutesApi(apiKey, mode, pairs) {
  const body = {
    origins: pairs.map((p) => ({
      waypoint: { location: { latLng: { latitude: p.originLat, longitude: p.originLng } } },
    })),
    destinations: pairs.map((p) => ({
      waypoint: { location: { latLng: { latitude: p.destLat, longitude: p.destLng } } },
    })),
    travelMode: mode,
  };
  if (mode === "DRIVE") body.routingPreference = "TRAFFIC_AWARE";

  const res = await fetchWithTimeout(ROUTES_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`routes ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const rows = Array.isArray(data) ? data : [];
  const out = new Map();
  for (const row of rows) {
    if (typeof row.originIndex !== "number" || typeof row.destinationIndex !== "number") continue;
    if (row.originIndex !== row.destinationIndex) continue;
    const pair = pairs[row.originIndex];
    if (!pair) continue;
    if (row.condition && row.condition !== "ROUTE_EXISTS") continue;
    const dur = parseDuration(row.duration);
    if (dur === null) continue;
    out.set(pair.id, {
      duration_seconds: dur,
      distance_meters: typeof row.distanceMeters === "number" ? row.distanceMeters : null,
    });
  }
  return out;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({
      error: { message: "Invalid JSON" },
      routes: [],
      summary: { checked: 0, found: 0, cache_hits: 0, elapsed_ms: 0 },
    }, 400);
  }

  const rawPairs = Array.isArray(body?.pairs) ? body.pairs : [];
  if (rawPairs.length === 0) {
    return json({
      routes: [],
      summary: { checked: 0, found: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt },
    });
  }

  // Sanitize: drop pairs with missing coords or unknown mode. Cap at MAX_PAIRS.
  const cleaned = [];
  for (const p of rawPairs) {
    if (!p || typeof p.id !== "string") continue;
    if (typeof p.originLat !== "number" || typeof p.originLng !== "number") continue;
    if (typeof p.destLat !== "number" || typeof p.destLng !== "number") continue;
    const mode = String(p.travelMode || "DRIVE").toUpperCase();
    if (!ALLOWED_MODES.has(mode)) continue;
    cleaned.push({
      id: p.id,
      originLat: p.originLat,
      originLng: p.originLng,
      destLat: p.destLat,
      destLng: p.destLng,
      travelMode: mode,
    });
    if (cleaned.length >= MAX_PAIRS) break;
  }

  if (cleaned.length === 0) {
    return json({
      routes: [],
      summary: { checked: 0, found: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt },
    });
  }

  // Cache lookup first.
  const results = new Map(); // id -> result
  const uncached = [];
  let cacheHits = 0;
  for (const p of cleaned) {
    const key = await cacheKeyFor(p);
    const cached = await readCache(env, key);
    if (cached) {
      cacheHits += 1;
      results.set(p.id, { ...cached, cached: true });
    } else {
      uncached.push({ pair: p, cacheKey: key });
    }
  }

  if (uncached.length > 0 && !env?.GOOGLE_PLACES_API_KEY) {
    for (const u of uncached) {
      results.set(u.pair.id, { found: false, error: "no-key" });
    }
  } else if (uncached.length > 0) {
    const byMode = groupByMode(uncached.map((u) => u.pair));
    for (const [mode, modePairs] of byMode.entries()) {
      try {
        const apiResults = await callRoutesApi(env.GOOGLE_PLACES_API_KEY, mode, modePairs);
        for (const p of modePairs) {
          const r = apiResults.get(p.id);
          const u = uncached.find((x) => x.pair.id === p.id);
          if (r) {
            const payload = { found: true, ...r };
            results.set(p.id, payload);
            if (u) writeCache(env, context, u.cacheKey, payload);
          } else {
            const payload = { found: false, error: "not-found" };
            results.set(p.id, payload);
            if (u) writeCache(env, context, u.cacheKey, payload);
          }
        }
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200);
        for (const p of modePairs) {
          results.set(p.id, { found: false, error: msg });
        }
      }
    }
  }

  // Echo in input order so the client can zip by id or position.
  const routes = [];
  let found = 0;
  for (const p of cleaned) {
    const r = results.get(p.id) || { found: false, error: "missing" };
    const row = { id: p.id, found: r.found === true };
    if (typeof r.duration_seconds === "number") row.duration_seconds = r.duration_seconds;
    if (typeof r.distance_meters === "number") row.distance_meters = r.distance_meters;
    if (r.cached) row.cached = true;
    if (r.error) row.error = r.error;
    if (row.found) found += 1;
    routes.push(row);
  }

  return json({
    routes,
    summary: {
      checked: routes.length,
      found,
      cache_hits: cacheHits,
      elapsed_ms: Date.now() - startedAt,
    },
  });
}
