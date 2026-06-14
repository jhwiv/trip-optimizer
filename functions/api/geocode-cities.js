// POST /api/geocode-cities
// ----------------------------------------------------------------------
// Resolve a list of city names to {lat, lng} centroids in one call.
// Used by the post-build location-check pass: the client passes the
// trip's destination cities (one per leg) and gets back authoritative
// coordinates that drive WRONG_LOCATION detection.
//
// Why a batch endpoint:
//   Most trips are 1–8 legs. Batching keeps the round-trip count low
//   and gives the server a single place to enforce concurrency + dedup.
//
// Request body:
//   { cities: [string, string, ...] }
//   Limit: 12 cities per call (matches the venue-batch cap; same
//          subrequest budget reasoning).
//
// Response (200 unless input malformed):
//   {
//     geocodes: [
//       {
//         name: <echo of input>,
//         found: boolean,
//         place_id?, resolved_name?, lat?, lng?, cached?, error?
//       }, ...
//     ],
//     summary: { checked, found, cache_hits, elapsed_ms }
//   }
//
// Soft-fail by design: a missing GOOGLE_PLACES_API_KEY returns 200
// with every city's found:false (and error:'no-key'), so the client's
// location check just degrades silently.

import { geocodeCity } from "./places-verify.js";

const MAX_CITIES = 12;
const MAX_PARALLEL = 6;

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

async function mapParallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { found: false, error: String(err?.message || err).slice(0, 200) };
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
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
    return json({
      error: { message: "Invalid JSON" },
      geocodes: [],
      summary: { checked: 0, found: 0, cache_hits: 0, elapsed_ms: 0 },
    }, 400);
  }

  const rawCities = Array.isArray(body?.cities) ? body.cities : [];
  if (rawCities.length === 0) {
    return json({
      geocodes: [],
      summary: { checked: 0, found: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt },
    });
  }

  // Dedup by lowercased trimmed name; echo every original entry in the
  // output so the client can merge by exact name match.
  const seen = new Map();
  const cleaned = [];
  for (const raw of rawCities) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().slice(0, 200);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) {
      cleaned[seen.get(key)].echoes.push(name);
      continue;
    }
    seen.set(key, cleaned.length);
    cleaned.push({ name, echoes: [name] });
    if (cleaned.length >= MAX_CITIES) break;
  }

  if (cleaned.length === 0) {
    return json({
      geocodes: [],
      summary: { checked: 0, found: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt },
    });
  }

  let cacheHits = 0;
  const perEntry = await mapParallel(cleaned, MAX_PARALLEL, async (entry) => {
    const r = await geocodeCity({ env, ctx: context, name: entry.name });
    if (r.cached) cacheHits += 1;
    return { entry, r };
  });

  const geocodes = [];
  let found = 0;
  for (const { entry, r } of perEntry) {
    for (const echoName of entry.echoes) {
      const row = {
        name: echoName,
        found: r.found === true,
        ...(r.place_id ? { place_id: r.place_id } : {}),
        ...(r.name && r.name !== echoName ? { resolved_name: r.name } : {}),
        ...(typeof r.lat === "number" ? { lat: r.lat } : {}),
        ...(typeof r.lng === "number" ? { lng: r.lng } : {}),
        ...(r.cached ? { cached: true } : {}),
        ...(r.error ? { error: r.error } : {}),
      };
      if (row.found) found += 1;
      geocodes.push(row);
    }
  }

  return json({
    geocodes,
    summary: {
      checked: geocodes.length,
      found,
      cache_hits: cacheHits,
      elapsed_ms: Date.now() - startedAt,
    },
  });
}
