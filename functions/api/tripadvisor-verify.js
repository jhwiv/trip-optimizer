// POST /api/tripadvisor-verify
// ------------------------------------------------------------------
// Independent-source check for a hotel's claimed chain/loyalty affiliation,
// via Tripadvisor's Content API. Added 2026-08-28 to close the gap
// applyQualityLayer's §2e loyalty-fabrication check (src/App.jsx) documents
// as its own known ceiling: it only catches a CROSS-chain claim (two
// different chains named together, e.g. "Novotel... Marriott Bonvoy
// affiliate via Accor partnership") — a DIRECT claim that an independently
// -named hotel (The Yeatman, Villa Lara) simply IS a specific chain's own
// sub-brand has no second chain name for that check to catch. See
// src/hotelBrandVerify.js for the client-side collection/merge logic this
// endpoint feeds.
//
// Architecture mirrors functions/api/drive-time-verify.js and
// functions/api/places-verify.js deliberately: env.PLACES KV reused
// (prefix "tripadvisor:v1:"), fail-safe on missing key or any per-hotel
// failure, server returns raw facts (resolved name + description text),
// client decides what counts as a brand-claim mismatch.
//
// Request body:
//   { hotels: [{ name: string, city: string }] }
//   Limit: 12 hotels per call.
//
// Response (200 unless input malformed):
//   {
//     results: [
//       { name, city, matched: boolean, resolvedName?, description?, cached?, error? }
//     ],
//     summary: { checked, cache_hits, elapsed_ms }
//   }
//
// `matched` is only true when the resolved Tripadvisor listing's name
// scores >= HOTEL_MATCH_THRESHOLD against the query name (the same 0.80 bar
// CLAUDE.md's HOTEL_MATCH_UNCERTAIN flag already uses for Google Places) —
// a low-confidence resolution returns matched:false rather than risk
// comparing the claim against the wrong property. That threshold exists
// precisely because free-text hotel search is unreliable without it: a
// live test this session resolved "JW Marriott Lisboa" to a same-named
// Marriott property in Florida on the first try.
//
// NOTE ON VERIFICATION STATUS (2026-08-28): written against Tripadvisor's
// publicly documented Content API shape from general knowledge — this
// sandbox's egress policy blocks every Tripadvisor host tried this session
// (tripadvisor.com, tripadvisor-content-api.readme.io, developer-
// tripadvisor.com), so the exact request/response field names here could
// NOT be confirmed with a live REST call before shipping, and there was no
// way to get the account holder a working curl command from a Windows
// PowerShell prompt without real friction, so that path was dropped too.
// The MCP Tripadvisor connector (a different product surface) WAS used
// earlier this session to empirically confirm two real risks this file
// defends against — free-text name resolution landing on the wrong
// property, and the response having no structured brand field at all (so
// this only ever compares free TEXT, never a clean boolean) — but that
// does not prove this file's raw REST calls are byte-for-byte correct.
// Every parse below is defensive (optional chaining, silent fallback to
// "no match") specifically so a wrong guess about field names degrades to
// "this check never fires" rather than a crash or a false accusation.
// Confirm against a real captured response before trusting this fully.

import { nameMatchScore } from "../../src/nameMatch.js";

const TRIPADVISOR_SEARCH_URL = "https://api.content.tripadvisor.com/api/v1/location/search";
const TRIPADVISOR_DETAILS_URL_BASE = "https://api.content.tripadvisor.com/api/v1/location/";

// Same bar CLAUDE.md's HOTEL_MATCH_UNCERTAIN flag already uses for Places —
// chain hotel names share enough surface text that a looser bar risks
// comparing a brand claim against the wrong property of the same chain.
const HOTEL_MATCH_THRESHOLD = 0.80;

const CACHE_PREFIX = "tripadvisor:v1:";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — matches the Places venue cache; hotel identity rarely changes
const HTTP_TIMEOUT_MS = 8000;
const MAX_HOTELS = 12;
const MAX_PARALLEL = 4;
const NAME_MAX = 200;
const CITY_MAX = 200;

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

async function cacheKeyFor(name, city) {
  const hash = await sha256Hex(`${normalizeForCacheKey(name)}|${normalizeForCacheKey(city)}`);
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

// Defensive parse: Tripadvisor's Content API wraps list responses as
// { data: [...] }. If that shape is wrong, this just returns [] rather
// than throwing — see the NOTE ON VERIFICATION STATUS above.
async function searchHotel(apiKey, name, city) {
  const query = city ? `${name} ${city}` : name;
  const url = `${TRIPADVISOR_SEARCH_URL}?key=${encodeURIComponent(apiKey)}&searchQuery=${encodeURIComponent(query)}&category=hotels&language=en`;
  const res = await fetchWithTimeout(url, { method: "GET", headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`search ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const candidates = Array.isArray(data?.data) ? data.data : Array.isArray(data?.results) ? data.results : [];
  return candidates;
}

async function fetchDetails(apiKey, locationId) {
  const url = `${TRIPADVISOR_DETAILS_URL_BASE}${encodeURIComponent(locationId)}/details?key=${encodeURIComponent(apiKey)}&language=en`;
  const res = await fetchWithTimeout(url, { method: "GET", headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`details ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

async function verifyOneHotel({ env, ctx, name, city }) {
  if (!name) return { name, city, matched: false, error: "missing-name" };
  const key = await cacheKeyFor(name, city);
  const cached = await readCache(env, key);
  if (cached) return { ...cached, name, city, cached: true };

  if (!env?.TRIPADVISOR_API_KEY) return { name, city, matched: false, error: "no-key" };

  try {
    const candidates = await searchHotel(env.TRIPADVISOR_API_KEY, name, city);
    const top = candidates[0];
    const resolvedName = top?.name || "";
    if (!top?.location_id || !resolvedName) {
      const result = { matched: false };
      writeCache(env, ctx, key, result);
      return { name, city, ...result };
    }
    const score = nameMatchScore(name, resolvedName);
    if (score < HOTEL_MATCH_THRESHOLD) {
      // Low confidence — could easily be the wrong property (chain names
      // share too much surface text). Don't compare a brand claim against
      // a hotel we're not confident is even the right one.
      const result = { matched: false, reason: "low-confidence", resolvedName };
      writeCache(env, ctx, key, result);
      return { name, city, ...result };
    }
    const details = await fetchDetails(env.TRIPADVISOR_API_KEY, top.location_id);
    const result = {
      matched: true,
      resolvedName: details?.name || resolvedName,
      description: typeof details?.description === "string" ? details.description.slice(0, 1000) : "",
    };
    writeCache(env, ctx, key, result);
    return { name, city, ...result };
  } catch (err) {
    // Transient error — don't cache, give the next build a fresh chance.
    return { name, city, matched: false, error: String(err?.message || err).slice(0, 200) };
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
        results[idx] = { name: items[idx]?.name, city: items[idx]?.city, matched: false, error: String(err?.message || err).slice(0, 200) };
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

  const rawHotels = Array.isArray(body?.hotels) ? body.hotels : [];
  const hotels = [];
  for (const h of rawHotels) {
    const name = typeof h?.name === "string" ? h.name.trim().slice(0, NAME_MAX) : "";
    if (!name) continue;
    const city = typeof h?.city === "string" ? h.city.trim().slice(0, CITY_MAX) : "";
    hotels.push({ name, city });
    if (hotels.length >= MAX_HOTELS) break;
  }

  if (hotels.length === 0) {
    return json({ results: [], summary: { checked: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt } });
  }

  let cacheHits = 0;
  const results = await mapParallel(hotels, MAX_PARALLEL, async (h) => {
    const r = await verifyOneHotel({ env, ctx: context, name: h.name, city: h.city });
    if (r.cached) cacheHits += 1;
    return r;
  });

  return json({
    results,
    summary: { checked: results.length, cache_hits: cacheHits, elapsed_ms: Date.now() - startedAt },
  });
}
