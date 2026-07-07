// POST /api/place-autocomplete
// ------------------------------------------------------------------
// Live-typing place suggestions for the /find LOCATION field. Proxies
// Google's Places Autocomplete (New) API so GOOGLE_PLACES_API_KEY never
// reaches the browser. Restricted to cities/regions/localities — the
// Find flow searches "a location" (city, neighborhood, or landmark),
// not individual addresses.
//
// Why this exists: the LOCATION field was a plain text input with zero
// disambiguation. Ambiguous or lesser-known place names (e.g. "Bolton"
// alone) could silently resolve to the wrong place client-request-side
// (Bolton, Greater Manchester UK, instead of Bolton Landing, NY) because
// nothing confirmed the place BEFORE the ~30-45s /api/find call ran.
// This endpoint lets the client show real suggestions as the user types
// so they pick a disambiguated place (with state/country) up front.
//
// Request body:
//   { input: string }        // required, 2-200 chars after trim
//
// Response (200 unless input malformed):
//   { suggestions: [ { description, place_id, main_text, secondary_text } ] }
//   400 { error: { message } }   — missing/too-short input
//
// Soft-fail: missing GOOGLE_PLACES_API_KEY or upstream error returns
// { suggestions: [] } with 200 — the field just falls back to freeform
// typing, same as today. Never blocks the user from searching.
//
// No KV caching — autocomplete queries are short-lived per-keystroke
// and Google's own client library would normally cache client-side;
// here we keep it simple and stateless. A future pass could add a
// short-TTL memory cache keyed by input prefix if quota becomes a
// concern.

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const HTTP_TIMEOUT_MS = 5000;
const MAX_SUGGESTIONS = 6;

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

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }

  const input = String(body?.input || "").trim();
  if (input.length < 2) {
    return json({ error: { message: "input must be at least 2 characters" } }, 400);
  }
  if (input.length > 200) {
    return json({ error: { message: "input too long" } }, 400);
  }

  if (!env?.GOOGLE_PLACES_API_KEY) {
    // Soft-fail — field degrades to freeform typing, exactly like before
    // this endpoint existed.
    return json({ suggestions: [], note: "autocomplete-not-configured" });
  }

  try {
    const upstream = await fetchWithTimeout(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      },
      body: JSON.stringify({
        input,
        // (regions) covers locality/sublocality/neighborhood/postal_code/
        // administrative_area — the right shape for "city, neighborhood,
        // or landmark" per the field's own hint text. We deliberately do
        // NOT restrict further (e.g. to cities only) because landmarks
        // like "Times Square" are legitimate Find-page queries too, and
        // Google doesn't offer a single type covering both cleanly.
        includedPrimaryTypes: ["locality", "sublocality", "neighborhood", "administrative_area_level_3"],
      }),
    });

    if (!upstream.ok) {
      // Soft-fail — don't surface upstream errors to the typing field.
      return json({ suggestions: [], note: "autocomplete-upstream-error" });
    }

    const data = await upstream.json().catch(() => ({}));
    const raw = Array.isArray(data?.suggestions) ? data.suggestions : [];
    const suggestions = raw
      .map((s) => s?.placePrediction)
      .filter(Boolean)
      .slice(0, MAX_SUGGESTIONS)
      .map((p) => ({
        description: p?.text?.text || "",
        place_id: p?.placeId || "",
        main_text: p?.structuredFormat?.mainText?.text || p?.text?.text || "",
        secondary_text: p?.structuredFormat?.secondaryText?.text || "",
      }))
      .filter((s) => s.description);

    return json({ suggestions });
  } catch {
    // Timeout or network failure — soft-fail to empty suggestions.
    return json({ suggestions: [], note: "autocomplete-network-error" });
  }
}
