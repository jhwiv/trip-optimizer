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
//   - Text Search returns zero candidates → { found: false, error: "not-found" }.
//
// Cost shape:
//   - Text Search (one call) + Place Details (one call) per fresh lookup.
//   - Field mask on Details restricts billing to the cheapest SKU.
//   - 30-day cache deduplicates aggressively.
//
// Module exports:
//   - onRequestPost      — HTTP handler (this file's POST behavior).
//   - onRequestOptions   — CORS preflight.
//   - verifyOneVenue     — pure async function for in-process callers
//                          (used by /api/places-verify-batch and the
//                          server-side /api/find verification pass).

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
  "utcOffsetMinutes",
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

// --- Name-similarity guard ----------------------------------------
//
// Google Places (New) Text Search is fuzzy-by-design. When the model
// invents a venue name that doesn't exist, Text Search doesn't return
// zero matches — it picks the best nearby place that loosely resembles
// the query. This is how the Roxanich / Almayer / Lola hallucinations
// shipped: an invented name resolved to a real-but-unrelated venue, and
// our code happily marked it OPERATIONAL.
//
// The guard: after Places resolves a place_id, compute a normalized
// similarity between the QUERY name and the RESOLVED Places name. If
// they're too different, treat as not-found instead of operational.
//
// Similarity metric: Sørensen-Dice on character bigrams. Cheap,
// intuitive (0.0 = no overlap, 1.0 = identical), works well for short
// strings, handles word reorders and substring matches better than
// Levenshtein for venue-name cases.
//
// Normalization (both sides before comparison):
//   1. NFKD + strip diacritics (Café → Cafe)
//   2. Lowercase
//   3. Replace any non-alphanumeric run with single space
//   4. Drop a small stoplist of venue-class words that Places adds and
//      humans omit (or vice-versa): the, restaurant, cafe, hotel,
//      museum, inn, bar, pub, bistro, lounge.
//   5. Collapse whitespace.
//
// Threshold: 0.55. Accepts the legit Places extensions we tested
// against (Loretto Chapel → Loretto Chapel Museum, The Waterhouse →
// Waterhouse Restaurant, Café Sabarsky → Cafe Sabarsky, Aman Venice →
// Aman Venice Hotel) and rejects anything below the bar of a single
// shared meaningful word.
const NAME_STOPLIST = new Set([
  "the", "restaurant", "cafe", "hotel", "museum", "inn", "bar", "pub",
  "bistro", "lounge", "and", "a", "an", "of", "by", "at",
]);
const SIMILARITY_THRESHOLD = 0.55;

export function normalizeNameForCompare(s) {
  if (typeof s !== "string") return "";
  const stripped = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!stripped) return "";
  const tokens = stripped.split(" ").filter((t) => t && !NAME_STOPLIST.has(t));
  return tokens.join(" ");
}

export function diceCoefficient(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  if (a.length < 2 || b.length < 2) {
    const setA = new Set(a);
    const setB = new Set(b);
    const inter = [...setA].filter((c) => setB.has(c)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : inter / union;
  }
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersections = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      intersections += 1;
      bigrams.set(bg, count - 1);
    }
  }
  return (2.0 * intersections) / (a.length + b.length - 2);
}

// Returns true when the resolved Places name is similar enough to the
// original query that we trust the match. Pure function.
export function isSimilarEnough(queryName, resolvedName) {
  const a = normalizeNameForCompare(queryName);
  const b = normalizeNameForCompare(resolvedName);
  if (!a || !b) return false;
  if (a === b) return true;
  // Substring escape hatch: if one normalized name fully contains the
  // other and the smaller is at least 3 chars, accept.
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  return diceCoefficient(a, b) >= SIMILARITY_THRESHOLD;
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
    utc_offset_minutes: typeof details?.utcOffsetMinutes === "number" ? details.utcOffsetMinutes : undefined,
    website: details?.websiteUri || "",
    lat: typeof loc.latitude === "number" ? loc.latitude : undefined,
    lng: typeof loc.longitude === "number" ? loc.longitude : undefined,
  };
}

// ----------------------------------------------------------------------
// verifyOneVenue — pure function for in-process callers
// ----------------------------------------------------------------------
// Used by:
//   - onRequestPost in this file (HTTP wrapper)
//   - /api/places-verify-batch (batch endpoint)
//   - /api/find (in-process server-side verification pass)
//
// Behavior is identical to the HTTP endpoint minus the JSON shell:
//   - Cache hit → return cached payload + cached:true
//   - Missing key → return { found:false, error:"no-key" }
//   - Text Search empty → cache + return { found:false, error:"not-found" }
//   - Text Search hit → Place Details → shape + cache + return
//   - Transient error → return { found:false, error:<msg> }, NOT cached
//
// `ctx` is optional — passed only by HTTP callers so KV writes can hook
// into waitUntil. Batch callers from inside another handler may omit it.
export async function verifyOneVenue({ env, ctx, name, city, lat, lng }) {
  if (!name) return { found: false, error: "missing-name" };
  const key = await cacheKeyFor(name, city);
  const cached = await readCache(env, key);
  if (cached) return { ...cached, cached: true };

  if (!env?.GOOGLE_PLACES_API_KEY) {
    return { found: false, error: "no-key" };
  }

  try {
    const textHit = await textSearch(env.GOOGLE_PLACES_API_KEY, name, city, lat, lng);
    if (!textHit || !textHit.id) {
      const result = { found: false, error: "not-found" };
      writeCache(env, ctx, key, result);
      return result;
    }
    // Name-similarity guard: Places Text Search is fuzzy and will happily
    // resolve a hallucinated name to a real-but-unrelated venue. If the
    // resolved displayName is too different from the original query,
    // treat as not-found. This is what caught the Roxanich/Almayer/Lola
    // class of failures.
    const resolvedName = textHit?.displayName?.text || "";
    if (resolvedName && !isSimilarEnough(name, resolvedName)) {
      const result = { found: false, error: "not-found", reason: "name-mismatch", resolved_name: resolvedName };
      writeCache(env, ctx, key, result);
      return result;
    }
    const details = await placeDetails(env.GOOGLE_PLACES_API_KEY, textHit.id);
    const shaped = shapeResult(textHit, details);
    writeCache(env, ctx, key, shaped);
    return shaped;
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 200);
    // Don't cache transient errors — give the next call a chance.
    return { found: false, error: msg };
  }
}

// Entry point — HTTP wrapper around verifyOneVenue.
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

  const result = await verifyOneVenue({ env, ctx: context, name, city, lat, lng });
  return json({ ...result, elapsed_ms: Date.now() - startedAt });
}
