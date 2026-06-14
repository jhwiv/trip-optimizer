// POST /api/places-verify-batch
// ------------------------------------------------------------------
// Batch verification for a list of venues. Wraps verifyOneVenue() from
// /api/places-verify.js with dedup, bounded parallelism, and the
// canonical flag taxonomy that the client and PDF exporter consume.
//
// Why a batch endpoint:
//   The wizard produces ~25 restaurants + ~20 activities per trip.
//   Posting them one-by-one would round-trip 45 HTTP requests; doing
//   it server-side in one POST lets us parallelize, dedup case-variants,
//   and share a single waitUntil for KV writes.
//
// Mirrors /api/confirm-booking architecturally: same dedup-by-name+city,
// same MAX_PARALLEL bound, same cache-hit accounting in the response,
// same soft-fail semantics (200 with per-venue errors, never a 500 that
// would break the client's plan rendering).
//
// Request body:
//   {
//     venues: [
//       { name: string, city?: string, neighborhood?: string,
//         lat?: number, lng?: number, kind?: "restaurant" | "activity" | "hotel" }
//     ]
//   }
//   Limit: 50 venues per call (covers a worst-case 9-day multi-city plan).
//
// Response (200 unless input malformed):
//   {
//     verifications: [
//       {
//         name: string,                  // echo of input name — key the client uses to merge
//         kind?: string,                 // echo of input kind
//         found: boolean,
//         place_id?: string,
//         business_status?: "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY",
//         resolved_name?: string,        // canonical name from Places (may differ from echo)
//         address?: string,
//         phone?: string,
//         hours?: string[],
//         website?: string,
//         lat?: number, lng?: number,
//         cached?: boolean,
//         flags: Array<{ code: string, severity: "block" | "warn" | "info", message?: string }>,
//         error?: string
//       }
//     ],
//     summary: {
//       checked: number,
//       blocked: number,           // count with at least one severity=block flag
//       warnings: number,          // count with at least one severity=warn (no block)
//       cache_hits: number,
//       elapsed_ms: number
//     }
//   }
//
// Flag taxonomy (this is the authoritative source — keep CLAUDE.md aligned):
//   block:
//     CLOSED_PERMANENTLY  — Places confirmed the venue is permanently closed
//     CLOSED_TEMPORARILY  — Places confirmed temporary closure
//     NOT_FOUND           — Places Text Search returned zero candidates for name+city
//   warn:
//     UNVERIFIED          — Places lookup couldn't run (missing key, network, timeout)
//
// Severity=warn is downgraded relative to block so the client can choose
// to surface a banner ("we couldn't verify 3 venues") without refusing
// to render the plan. Severity=block is the pre-export gate (Task 6).

import { verifyOneVenue } from "./places-verify.js";

const MAX_VENUES = 50;
const MAX_PARALLEL = 6;
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

// Bounded-parallelism worker pool. Same shape as confirm-booking.js's
// mapParallel, kept private here so we don't cross-import private
// helpers between endpoint files.
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
        // Should never happen — verifyOneVenue catches internally — but
        // belt-and-braces. Surface as UNVERIFIED for the client.
        results[idx] = {
          name: items[idx]?.name || "",
          kind: items[idx]?.kind,
          found: false,
          flags: [{ code: "UNVERIFIED", severity: "warn", message: String(err?.message || err).slice(0, 200) }],
          error: String(err?.message || err).slice(0, 200),
        };
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

// Produce the canonical flags array from a verifyOneVenue() result.
function flagsFor(result) {
  const flags = [];
  if (result.found) {
    if (result.business_status === "CLOSED_PERMANENTLY") {
      flags.push({ code: "CLOSED_PERMANENTLY", severity: "block", message: "Permanently closed per Google Places" });
    } else if (result.business_status === "CLOSED_TEMPORARILY") {
      flags.push({ code: "CLOSED_TEMPORARILY", severity: "block", message: "Temporarily closed per Google Places" });
    }
  } else if (result.error === "not-found") {
    flags.push({ code: "NOT_FOUND", severity: "block", message: "Google Places returned zero matches for this name + city" });
  } else if (result.error) {
    // no-key, timeout, 5xx, etc. — warn, not block. Fail safe per the
    // CLAUDE.md hard rule: treat as UNVERIFIED, never as operational.
    flags.push({ code: "UNVERIFIED", severity: "warn", message: result.error });
  }
  return flags;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON" }, verifications: [], summary: { checked: 0, blocked: 0, warnings: 0, cache_hits: 0, elapsed_ms: 0 } }, 400);
  }

  const venues = Array.isArray(body?.venues) ? body.venues : [];
  if (venues.length === 0) {
    return json({
      verifications: [],
      summary: { checked: 0, blocked: 0, warnings: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt },
    });
  }

  // Sanitize + dedup. Same identity rule as confirm-booking: lowercase
  // name + lowercase city. A venue listed for two different days collapses
  // to one Places call. Preserve original-name list so we can echo every
  // request entry in the response (the client uses name as merge key).
  const seen = new Map(); // dedupKey -> index in cleaned[]
  const cleaned = []; // [{ name, city, lat?, lng?, kind?, echoes: [originalName] }]
  for (const v of venues) {
    if (!v || typeof v.name !== "string") continue;
    const name = v.name.trim().slice(0, NAME_MAX);
    if (!name) continue;
    const city = typeof v.city === "string" ? v.city.trim().slice(0, CITY_MAX) : "";
    const lat = typeof v.lat === "number" ? v.lat : undefined;
    const lng = typeof v.lng === "number" ? v.lng : undefined;
    const kind = typeof v.kind === "string" ? v.kind.slice(0, 32) : undefined;
    const dedupKey = `${name.toLowerCase()}|${city.toLowerCase()}`;
    if (seen.has(dedupKey)) {
      // Add this echo so the response includes one entry per *original*
      // request entry — the client matches by exact name.
      cleaned[seen.get(dedupKey)].echoes.push(name);
      continue;
    }
    seen.set(dedupKey, cleaned.length);
    cleaned.push({ name, city, lat, lng, kind, echoes: [name] });
    if (cleaned.length >= MAX_VENUES) break;
  }

  if (cleaned.length === 0) {
    return json({
      verifications: [],
      summary: { checked: 0, blocked: 0, warnings: 0, cache_hits: 0, elapsed_ms: Date.now() - startedAt },
    });
  }

  let cacheHits = 0;

  const verifiedPerEntry = await mapParallel(cleaned, MAX_PARALLEL, async (entry) => {
    const result = await verifyOneVenue({
      env,
      ctx: context,
      name: entry.name,
      city: entry.city,
      lat: entry.lat,
      lng: entry.lng,
    });
    if (result.cached) cacheHits += 1;
    return { entry, result };
  });

  // Expand back to one row per *original* request entry. Same Places
  // result echoed for each duplicate so the client can merge by name
  // without surprise.
  const verifications = [];
  for (const { entry, result } of verifiedPerEntry) {
    const flags = flagsFor(result);
    for (const echoName of entry.echoes) {
      verifications.push({
        name: echoName,
        kind: entry.kind,
        found: result.found === true,
        ...(result.place_id ? { place_id: result.place_id } : {}),
        ...(result.business_status ? { business_status: result.business_status } : {}),
        ...(result.name ? { resolved_name: result.name } : {}),
        ...(result.address ? { address: result.address } : {}),
        ...(result.phone ? { phone: result.phone } : {}),
        ...(Array.isArray(result.hours) && result.hours.length ? { hours: result.hours } : {}),
        ...(typeof result.utc_offset_minutes === "number" ? { utc_offset_minutes: result.utc_offset_minutes } : {}),
        ...(result.website ? { website: result.website } : {}),
        ...(typeof result.lat === "number" ? { lat: result.lat } : {}),
        ...(typeof result.lng === "number" ? { lng: result.lng } : {}),
        ...(result.cached ? { cached: true } : {}),
        ...(result.error ? { error: result.error } : {}),
        flags,
      });
    }
  }

  let blocked = 0;
  let warnings = 0;
  for (const v of verifications) {
    if (v.flags.some((f) => f.severity === "block")) blocked += 1;
    else if (v.flags.some((f) => f.severity === "warn")) warnings += 1;
  }

  return json({
    verifications,
    summary: {
      checked: verifications.length,
      blocked,
      warnings,
      cache_hits: cacheHits,
      elapsed_ms: Date.now() - startedAt,
    },
  });
}
