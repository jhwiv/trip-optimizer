// GET /api/destination-photo?destination=Paris
//
// Returns a JPEG photo for the named destination, sourced from Google Places
// (New) Photo API. Cached in the PLACES KV binding for 30 days so each unique
// destination only hits the Places API once per month.
//
// Used by the PDF cover page to embed a location-aware hero image. The endpoint
// proxies the image bytes so the API key never reaches the browser.
//
// Billing note: requesting `places.photos` in the Text Search field mask uses
// the Advanced Data SKU ($32/1000). With 30-day KV caching per destination the
// effective cost per PDF export is negligible after the first one.

const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const CACHE_PREFIX = "destphoto:v1:";
const CACHE_TTL = 30 * 24 * 60 * 60; // 30 days
const HTTP_TIMEOUT_MS = 8000;

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

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const destination = (url.searchParams.get("destination") || "").trim();
  if (!destination) {
    return new Response("missing destination", { status: 400, headers: corsHeaders() });
  }
  if (!env?.GOOGLE_PLACES_API_KEY) {
    return new Response("no key", { status: 503, headers: corsHeaders() });
  }

  // Normalise cache key: lowercase, collapse whitespace, no punctuation variation.
  const cacheKey = CACHE_PREFIX + destination.toLowerCase().replace(/\s+/g, " ");

  // Check KV cache first.
  if (env?.PLACES) {
    try {
      const cached = await env.PLACES.get(cacheKey, { type: "arrayBuffer" });
      if (cached && cached.byteLength > 0) {
        return new Response(cached, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=2592000",
            "X-Photo-Source": "kv-cache",
            ...corsHeaders(),
          },
        });
      }
    } catch { /* continue to API */ }
  }

  try {
    // Step 1: Text Search to get place + first photo name.
    const searchRes = await fetchWithTimeout(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "places.id,places.photos",
      },
      body: JSON.stringify({ textQuery: destination, maxResultCount: 1 }),
    });
    if (!searchRes.ok) {
      return new Response("search failed", { status: 502, headers: corsHeaders() });
    }
    const searchData = await searchRes.json();
    const photoName = searchData?.places?.[0]?.photos?.[0]?.name;
    if (!photoName) {
      return new Response("no photo", { status: 404, headers: corsHeaders() });
    }

    // Step 2: Fetch photo media metadata (skipHttpRedirect returns JSON with photoUri).
    const mediaRes = await fetchWithTimeout(
      `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=600&maxWidthPx=900&skipHttpRedirect=true`,
      { headers: { "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY } }
    );
    if (!mediaRes.ok) {
      return new Response("media fetch failed", { status: 502, headers: corsHeaders() });
    }
    const mediaData = await mediaRes.json();
    const photoUri = mediaData?.photoUri;
    if (!photoUri) {
      return new Response("no photo uri", { status: 404, headers: corsHeaders() });
    }

    // Step 3: Fetch the actual image bytes.
    const imgRes = await fetch(photoUri);
    if (!imgRes.ok) {
      return new Response("image fetch failed", { status: 502, headers: corsHeaders() });
    }
    const imgBuf = await imgRes.arrayBuffer();

    // Write to KV for future requests.
    if (env?.PLACES && imgBuf.byteLength > 0) {
      try {
        await env.PLACES.put(cacheKey, imgBuf, { expirationTtl: CACHE_TTL });
      } catch { /* cache write failure is non-fatal */ }
    }

    return new Response(imgBuf, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=2592000",
        "X-Photo-Source": "places-api",
        ...corsHeaders(),
      },
    });
  } catch (err) {
    return new Response(String(err?.message || "internal error"), {
      status: 500,
      headers: corsHeaders(),
    });
  }
}
