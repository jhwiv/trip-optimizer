// GET /api/trip-map?cities=City%20A|City%20B|City%20C
// ----------------------------------------------------------------------
// Returns a static route-overview map image for the trip's cities, in
// visiting order, sourced from Google Maps Platform's Static Maps API.
// Numbered pins mark each city; a connecting line shows the route.
//
// Used by the PDF export to embed a "Trip Map" page. Mirrors
// destination-photo.js's exact proxy/caching shape: the API key never
// reaches the browser, bytes + content-type are cached in the PLACES KV
// binding, and any failure degrades to a 4xx/5xx that the client already
// treats as "no map" (same fail-safe posture as the cover photo — a PDF
// export must never fail just because the map couldn't be built).
//
// Reuses geocodeCity() from places-verify.js — the SAME geocoding helper
// and KV cache (env.PLACES, prefix "geocity:v1:") already used by
// /api/geocode-cities for the post-build location check. No duplicated
// geocoding logic, no new API key: this rides on GOOGLE_PLACES_API_KEY.
//
// NOTE — NOT LIVE-VERIFIED (same caveat this codebase already carries for
// TomTom/Tripadvisor, per CLAUDE.md): this sandbox cannot reach
// maps.googleapis.com to confirm the Static Maps API request shape
// against a real response, and "Maps Static API" is a separate enablement
// toggle in Google Cloud Console from "Places API (New)" — it may not be
// turned on for this key yet. Written from Google's published Static Maps
// API docs. Fails safe either way: a disabled API or bad key returns a
// non-2xx upstream response, which this function turns into a 502 the
// client already treats as "skip the map."
//
// Request:
//   cities   required  pipe-separated city names, IN VISITING ORDER
//            (e.g. "Santa Fe, NM|Taos, NM|Albuquerque, NM"). Consecutive
//            duplicates are harmless (deduped server-side) but the caller
//            should already dedupe — see src/tripMap.js.
//
// Response:
//   200  image bytes (PNG), proxied from Google Static Maps
//   400  missing/empty cities param
//   404  none of the supplied cities could be geocoded
//   502  upstream Static Maps request failed
//   503  no GOOGLE_PLACES_API_KEY configured

import { geocodeCity } from "./places-verify.js";

const STATIC_MAPS_URL = "https://maps.googleapis.com/maps/api/staticmap";
const CACHE_PREFIX = "tripmap:v1:";
const CACHE_CT_PREFIX = "tripmap:ct:v1:";
const CACHE_TTL = 30 * 24 * 60 * 60; // 30 days — routes/geography don't change
const HTTP_TIMEOUT_MS = 8000;
const MAX_CITIES = 12;
const MAX_PARALLEL = 6;

// Teal accent used throughout the PDF (src/pdf/itineraryPdf.js COLOR.accent,
// [49, 97, 105]) — kept visually consistent with the rest of the document.
const MARKER_COLOR = "0x316169";
const PATH_COLOR = "0x316169CC"; // slight transparency so overlapping legs stay legible

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normaliseCacheKey(names) {
  return names
    .map((s) =>
      s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join("|");
}

async function mapParallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Google Static Maps marker labels accept a single alphanumeric character.
// 1-9 for the first nine stops, then A-Z for any beyond that (MAX_CITIES=12
// never actually needs a letter today, but this keeps the function honest
// if that cap ever grows).
function markerLabel(index) {
  return index < 9 ? String(index + 1) : String.fromCharCode(65 + index - 9);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const raw = (url.searchParams.get("cities") || "").trim();
  if (!raw) {
    return new Response("missing cities", { status: 400, headers: corsHeaders() });
  }
  const cities = raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CITIES);
  if (cities.length === 0) {
    return new Response("missing cities", { status: 400, headers: corsHeaders() });
  }
  if (!env?.GOOGLE_PLACES_API_KEY) {
    return new Response("no key", { status: 503, headers: corsHeaders() });
  }

  const cacheKeyBase = normaliseCacheKey(cities);
  const cacheKey = CACHE_PREFIX + cacheKeyBase;
  const cacheCtKey = CACHE_CT_PREFIX + cacheKeyBase;

  if (env?.PLACES) {
    try {
      const [cached, cachedCt] = await Promise.all([
        env.PLACES.get(cacheKey, { type: "arrayBuffer" }),
        env.PLACES.get(cacheCtKey, { type: "text" }),
      ]);
      if (cached && cached.byteLength > 0) {
        return new Response(cached, {
          headers: {
            "Content-Type": cachedCt || "image/png",
            "Cache-Control": "public, max-age=2592000",
            "X-Map-Source": "kv-cache",
            ...corsHeaders(),
          },
        });
      }
    } catch { /* continue to API */ }
  }

  // Geocode every city (parallel, same helper + KV cache /api/geocode-cities
  // uses), then keep only the ones that resolved, preserving visiting order.
  let points;
  try {
    const resolved = await mapParallel(cities, MAX_PARALLEL, (name) =>
      geocodeCity({ env, ctx: context, name }),
    );
    points = resolved
      .map((r, i) => (r?.found && typeof r.lat === "number" && typeof r.lng === "number" ? { lat: r.lat, lng: r.lng, i } : null))
      .filter(Boolean);
  } catch (err) {
    return new Response(`geocoding failed: ${String(err?.message || err).slice(0, 200)}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  if (points.length === 0) {
    return new Response("no locations found", { status: 404, headers: corsHeaders() });
  }

  const params = new URLSearchParams();
  params.set("size", "640x400");
  params.set("scale", "2");
  params.set("maptype", "roadmap");
  points.forEach((p, idx) => {
    params.append("markers", `color:${MARKER_COLOR}|label:${markerLabel(idx)}|${p.lat},${p.lng}`);
  });
  if (points.length >= 2) {
    const pathCoords = points.map((p) => `${p.lat},${p.lng}`).join("|");
    params.set("path", `color:${PATH_COLOR}|weight:3|${pathCoords}`);
  }
  params.set("key", env.GOOGLE_PLACES_API_KEY);
  const staticMapUrl = `${STATIC_MAPS_URL}?${params.toString()}`;

  let imgRes;
  try {
    imgRes = await fetchWithTimeout(staticMapUrl, {});
  } catch (err) {
    return new Response(`static map fetch failed: ${String(err?.message || err).slice(0, 200)}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }
  if (!imgRes.ok) {
    const body = await imgRes.text().catch(() => "");
    return new Response(`static map ${imgRes.status}: ${body.slice(0, 300)}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }
  const imgBuf = await imgRes.arrayBuffer();
  const contentType = imgRes.headers.get("content-type") || "image/png";

  if (env?.PLACES && imgBuf.byteLength > 0) {
    try {
      await Promise.all([
        env.PLACES.put(cacheKey, imgBuf, { expirationTtl: CACHE_TTL }),
        env.PLACES.put(cacheCtKey, contentType, { expirationTtl: CACHE_TTL }),
      ]);
    } catch { /* cache write failure is non-fatal */ }
  }

  return new Response(imgBuf, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=2592000",
      "X-Map-Source": "static-maps-api",
      ...corsHeaders(),
    },
  });
}
