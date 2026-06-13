// POST /api/places-verify
// ------------------------------------------------------------------
// Verify a single venue against Google Places API (New). This is the
// authoritative gate Trip Optimizer uses to decide whether a venue is
// safe to ship in a client-facing PDF.
//
// Why this endpoint exists (read functions/api/places-verify.js block
// in CLAUDE.md for the full rule). Prose grounding via Perplexity /
// Reddit / local press has no authoritative state field — a permanently
// closed restaurant still reads as "open" in a 2022 Reddit thread, and
// an LLM cannot tell present tense from past. Places (New) returns
// businessStatus = OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY
// for every place_id. That one field, checked per venue, catches every
// closed-venue failure the system has shipped to date.
//
// Request body:
//   { name: string, city?: string, lat?: number, lng?: number }
//
// Response (200 unless input malformed):
//   {
//     found: boolean,
//     place_id?: string,
//     business_status?: "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY",
//     name?: string,
//     address?: string,
//     phone?: string,
//     hours?: string[],
//     website?: string,
//     lat?: number,
//     lng?: number,
//     cached?: boolean,
//     elapsed_ms: number,
//     error?: string
//   }
//
// Caching: env.PLACES KV namespace, 30-day TTL, key = sha256 of normalized
// (name|city). Booking platforms and businessStatus rarely change; 30
// days is the right window between full re-verifications. Missing
// env.PLACES → no caching, fresh API hits every call (endpoint still
// works).
//
// Soft-fail behavior:
//   - Missing GOOGLE_PLACES_API_KEY → { found: false, error: "no-key" }.
//     Callers MUST treat this as "unverified", never as "operational".
//   - Network / quota errors → { found: false, error: "<reason>" }.
//   - Text Search returns zero candidates → { found: false }.
//
// Cost shape:
//   - Text Search (one call) + Place Details (one call) per fresh lookup.
//   - Field mask on Details restricts billing to the cheapest SKU.
//   - 30-day cache deduplicates aggressively.

const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_DETAILS_URL_BASE = "https://places.googleapis.com/v1/places/";

// Field mask sent to Places to keep billing minimal. Each field added
// here may push the response into a more expensive SKU — only add what
// you actually need downstream.
const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "businessStatus",
  "formattedAddress",
  "internationalPhoneNumber",
  "regularOpeningHours.weekdayDescriptions",
  "websiteUri",
  "location",
].join(",");

const TEXT_SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
].join(",");

const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const HTTP_TIMEOUT_MS = 8000;

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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function normalizeForCacheKey(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

async function cacheKeyFor(name, city) {
  const hash = await sha256Hex(`${normalizeForCacheKey(name)}|${normalizeForCacheKey(city)}`);
  return `places:${CACHE_VERSION}:${hash}`;
}

async function readCache(env, key) {
  if (!env?.PLACES) return null;
  try {
    const raw = await env.PLACES.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeCache(env, ctx, key, payload) {
  if (!env?.PLACES) return;
  // Only cache definitive results: found+operational/closed, or "not found".
  // Don't cache transient errors so we get a second chance next call.
  if (payload && payload.error && payload.error !== "not-found") return;
  const p = env.PLACES.put(key, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

// Bounded fetch — Places can occasionally hang on the slow tail. 8s ceiling.
async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// --- Text Search: resolve a name+city into a place_id ---
async function textSearch(apiKey, name, city, lat, lng) {
  const body = {
    textQuery: city ? `${name}, ${city}` : name,
    maxResultCount: 1,
  };
  // If caller provided coords, bias results to within ~50km of them.
  // Places' locationBias accepts circle{center{lat,lng},radius_meters}.
  if (typeof lat === "number" && typeof lng === "number") {
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 50000,
      },
    };
  }
  const res = await fetchWithTimeout(PLACES_TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": TEXT_SEARCH_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`text-search ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const places = Array.isArray(data?.places) ? data.places : [];
  if (places.length === 0) return null;
  return places[0]; // { id, displayName, location }
}

// --- Place Details: fetch full venue facts for a known place_id ---
async function placeDetails(apiKey, placeId) {
  const url = PLACES_DETAILS_URL_BASE + encodeURIComponent(placeId);
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`details ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

// --- Shape the Places response into our canonical output schema ---
function shapeResult(textHit, details) {
  const hours = Array.isArray(details?.regularOpeningHours?.weekdayDescriptions)
    ? details.regularOpeningHours.weekdayDescriptions
    : [];
  const loc = details?.location || textHit?.location || {};
  return {
    found: true,
    place_id: details?.id || textHit?.id,
    business_status: details?.businessStatus || "OPERATIONAL", // Places omits the field when OPERATIONAL
    name: details?.displayName?.text || textHit?.displayName?.text || "",
    address: details?.formattedAddress || "",
    phone: details?.internationalPhoneNumber || "",
    hours,
    website: details?.websiteUri || "",
    lat: typeof loc.latitude === "number" ? loc.latitude : undefined,
    lng: typeof loc.longitude === "number" ? loc.longitude : undefined,
  };
}

// Entry point
export async function onRequestPost(context) {
  const { request, env } = context;
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON" }, found: false, elapsed_ms: Date.now() - startedAt }, 400);
  }

  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 200) : "";
  if (!name) {
    return json({ error: { message: "name is required" }, found: false, elapsed_ms: Date.now() - startedAt }, 400);
  }
  const city = typeof body?.city === "string" ? body.city.trim().slice(0, 200) : "";
  const lat = typeof body?.lat === "number" ? body.lat : undefined;
  const lng = typeof body?.lng === "number" ? body.lng : undefined;

  // Cache hit?
  const key = await cacheKeyFor(name, city);
  const cached = await readCache(env, key);
  if (cached) {
    return json({ ...cached, cached: true, elapsed_ms: Date.now() - startedAt });
  }

  if (!env.GOOGLE_PLACES_API_KEY) {
    return json({ found: false, error: "no-key", elapsed_ms: Date.now() - startedAt });
  }

  try {
    const textHit = await textSearch(env.GOOGLE_PLACES_API_KEY, name, city, lat, lng);
    if (!textHit || !textHit.id) {
      const result = { found: false, error: "not-found" };
      writeCache(env, context, key, result);
      return json({ ...result, elapsed_ms: Date.now() - startedAt });
    }
    const details = await placeDetails(env.GOOGLE_PLACES_API_KEY, textHit.id);
    const shaped = shapeResult(textHit, details);
    writeCache(env, context, key, shaped);
    return json({ ...shaped, elapsed_ms: Date.now() - startedAt });
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 200);
    // Don't cache transient errors — give the next call a chance.
    return json({ found: false, error: msg, elapsed_ms: Date.now() - startedAt });
  }
}
