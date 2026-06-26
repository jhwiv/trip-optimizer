// chunkPlan.js
// =====================================================================
// Pure, framework-free helpers for the CHUNKED BUILD path that fixes the
// large-trip timeout. A maxed single build needs up to 64k output tokens
// (~17.5 min at ~60 tok/s) which exceeds the 15-min client polling
// ceiling. We split big trips into day-range chunks, generate each well
// under the token/time ceiling, then stitch the pieces back into one
// canonical plan object identical in shape to the single-call output.
//
// These functions are pure (no React, no network) so they're unit-tested
// directly in tests/test_chunk_plan.mjs and reused by the App build path.
// =====================================================================

// Per-day output-token estimate, matched to the single-call formula's
// per-day term (see maxTokensForTrip in App.jsx).
export const TOKENS_PER_DAY = 2200;
// System/wrapper overhead the single-call formula adds as a floor.
export const BASE_TOKENS = 5000;
// Per-extra-city multi-city overhead, matched to the single-call formula.
export const TOKENS_PER_EXTRA_CITY = 1200;
// A single call is safe up to here (comfortably inside the streaming/poll
// time window). Above this we chunk. Trips at/below stay single-call.
export const SINGLE_CALL_TOKEN_BUDGET = 28000;
// Hard cap on days per chunk so no chunk approaches the time window.
export const MAX_DAYS_PER_CHUNK = 6;
// Continuity overhead per chunk (prior-day context + used-restaurants list).
export const CHUNK_CONTINUITY_TOKENS = 1500;

/**
 * The single-call max_tokens estimate. Mirrors App.jsx's maxTokensForTrip
 * so the threshold decision here matches what the model would be asked for.
 * @param {{nights:number, citiesCount:number}} p
 * @returns {number}
 */
export function estimateSingleCallTokens({ nights, citiesCount = 1 }) {
  const n = Math.max(0, nights | 0);
  const c = Math.max(1, citiesCount | 0);
  return Math.min(
    64000,
    Math.max(8000, BASE_TOKENS + (n + 1) * TOKENS_PER_DAY + (c - 1) * TOKENS_PER_EXTRA_CITY),
  );
}

/**
 * Should this trip be chunked? True only when a single call would exceed
 * the safe budget. Small/medium trips return false and keep the existing
 * single-call path unchanged.
 * @param {{nights:number, citiesCount:number}} p
 * @returns {boolean}
 */
export function shouldChunk({ nights, citiesCount = 1 }) {
  return estimateSingleCallTokens({ nights, citiesCount }) > SINGLE_CALL_TOKEN_BUDGET;
}

/**
 * Build contiguous, non-overlapping day-range chunks covering Day 1..nights+1.
 * Respects city/leg boundaries when cities[] is provided: a leg's days stay
 * together unless the leg itself exceeds MAX_DAYS_PER_CHUNK, in which case the
 * leg is sub-split. Total days = nights + 1 (arrival day + one per night).
 *
 * @param {{nights:number, cities?:Array<{name?:string, nights?:number|string}>}} p
 * @returns {Array<{startDay:number, endDay:number, cityNames:string[]}>}
 */
export function planDayChunks({ nights, cities }) {
  const totalDays = Math.max(1, (nights | 0) + 1);
  const hasCities = Array.isArray(cities) && cities.length > 0;

  // Build per-leg day spans. Day numbering is 1-based and inclusive.
  // Leg 1 spans its nights + the arrival day; each later leg spans its nights.
  // This matches the "Leg 1 = Day 1..nights[0]+1" convention in the prompt.
  const legs = [];
  if (hasCities) {
    let cursor = 1;
    for (let i = 0; i < cities.length; i++) {
      const legNights = Math.max(0, parseInt(cities[i]?.nights, 10) || 0);
      const span = i === 0 ? legNights + 1 : legNights;
      if (span <= 0) continue;
      const start = cursor;
      const end = Math.min(totalDays, cursor + span - 1);
      legs.push({ startDay: start, endDay: end, name: cities[i]?.name || `City ${i + 1}` });
      cursor = end + 1;
      if (cursor > totalDays) break;
    }
    // If leg math under-covers (e.g. nights mismatch), extend the last leg.
    if (legs.length > 0 && legs[legs.length - 1].endDay < totalDays) {
      legs[legs.length - 1].endDay = totalDays;
    }
  }
  if (legs.length === 0) {
    legs.push({ startDay: 1, endDay: totalDays, name: null });
  }

  // Sub-split any leg longer than MAX_DAYS_PER_CHUNK into <=MAX windows.
  const chunks = [];
  for (const leg of legs) {
    const legDays = leg.endDay - leg.startDay + 1;
    if (legDays <= MAX_DAYS_PER_CHUNK) {
      chunks.push({ startDay: leg.startDay, endDay: leg.endDay, cityNames: leg.name ? [leg.name] : [] });
      continue;
    }
    const nWindows = Math.ceil(legDays / MAX_DAYS_PER_CHUNK);
    const base = Math.ceil(legDays / nWindows);
    let s = leg.startDay;
    while (s <= leg.endDay) {
      const e = Math.min(leg.endDay, s + base - 1);
      chunks.push({ startDay: s, endDay: e, cityNames: leg.name ? [leg.name] : [] });
      s = e + 1;
    }
  }
  return chunks;
}

/**
 * Per-chunk max_tokens budget. Sized to the chunk's day count plus continuity
 * overhead, floored so even a 1-day chunk has room. Always well under 64k.
 * @param {{startDay:number, endDay:number}} chunk
 * @returns {number}
 */
export function chunkMaxTokens(chunk) {
  const days = Math.max(1, chunk.endDay - chunk.startDay + 1);
  return Math.max(8000, days * TOKENS_PER_DAY + CHUNK_CONTINUITY_TOKENS);
}

// Generic, non-unique meal placeholders that legitimately recur every day
// (e.g. "Breakfast at hotel"). These are NOT named restaurants and must be
// excluded from cross-chunk dedupe, or every multi-day trip flags them.
const GENERIC_MEAL_RE =
  /^(breakfast|lunch|dinner|brunch)?\s*(at|in|@)?\s*(the\s+)?(hotel|resort|villa|riad|property|room|suite|in[- ]?room|spa|pool|rooftop|terrace|club lounge|lounge)\b|^(hotel|room service|in[- ]?room dining|breakfast|continental breakfast|buffet breakfast|free time|self[- ]?guided|on your own|tbd|to be decided)\b/i;

/**
 * Is this item name a generic placeholder rather than a named venue?
 * @param {string} name
 * @returns {boolean}
 */
export function isGenericMealName(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  return GENERIC_MEAL_RE.test(n);
}

/**
 * Extract NAMED restaurant item names from a plan's days[] for cross-chunk
 * dedupe. Looks at item.name / item.text on Dining/Restaurant items and
 * skips generic placeholders ("Breakfast at hotel", "Room service", etc.).
 * Defensive about shape.
 * @param {object} planLike  object with days[]
 * @returns {string[]}
 */
export function collectRestaurantNames(planLike) {
  const out = [];
  const days = planLike && Array.isArray(planLike.days) ? planLike.days : [];
  for (const d of days) {
    const items = d && Array.isArray(d.items) ? d.items : [];
    for (const it of items) {
      const kind = String(it?.kind || it?.type || "").toLowerCase();
      const isFood = /dining|restaurant|meal|lunch|dinner|breakfast/.test(kind);
      const name = String(it?.name || it?.place || "").trim();
      if (isFood && name && !isGenericMealName(name)) out.push(name);
      else if (!it?.kind && !it?.type && name && !isGenericMealName(name) && /\b(lunch|dinner|breakfast|reservation)\b/i.test(String(it?.text || ""))) {
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * Stitch chunked day-segments + a wrapper pass into one canonical plan.
 *
 * @param {object} p
 * @param {Array<object>} p.dayChunks  plan-like objects, each with days[] for its range, in order
 * @param {object} p.wrapper           plan-like object with destination/meta/cities/logistics/etc.
 * @param {number} p.expectedDays      nights + 1; used to validate completeness
 * @returns {{plan:object, warnings:string[]}}
 * @throws {Error} when the assembled day count doesn't match expectedDays
 */
export function stitchPlan({ dayChunks, wrapper, expectedDays }) {
  const warnings = [];
  const days = [];
  for (const chunk of Array.isArray(dayChunks) ? dayChunks : []) {
    const cd = chunk && Array.isArray(chunk.days) ? chunk.days : [];
    for (const d of cd) days.push(d);
  }

  if (typeof expectedDays === "number" && expectedDays > 0 && days.length !== expectedDays) {
    throw new Error(
      `stitchPlan: assembled ${days.length} days but expected ${expectedDays}. A chunk likely came back short — refusing to ship a truncated plan.`,
    );
  }

  // Defensive cross-chunk restaurant dedupe (keep first occurrence). Only
  // NAMED venues are checked — generic placeholders like "Breakfast at hotel"
  // legitimately recur daily and must not be flagged.
  const seen = new Set();
  for (const d of days) {
    const items = d && Array.isArray(d.items) ? d.items : [];
    for (const it of items) {
      const kind = String(it?.kind || it?.type || "").toLowerCase();
      if (!/dining|restaurant|meal|lunch|dinner|breakfast/.test(kind)) continue;
      const rawName = String(it?.name || it?.place || "").trim();
      if (!rawName || isGenericMealName(rawName)) continue;
      const name = rawName.toLowerCase();
      if (seen.has(name)) {
        warnings.push(`Duplicate restaurant across chunks kept as-is: ${rawName}`);
      } else {
        seen.add(name);
      }
    }
  }

  const w = wrapper && typeof wrapper === "object" ? wrapper : {};
  const plan = {
    destination: w.destination || "",
    meta: w.meta || "",
    ...(Array.isArray(w.cities) && w.cities.length ? { cities: w.cities } : {}),
    days,
    ...(Array.isArray(w.logistics) ? { logistics: w.logistics } : {}),
    ...(w.weather_window ? { weather_window: w.weather_window } : {}),
    ...(Array.isArray(w.pack) ? { pack: w.pack } : {}),
    ...(Array.isArray(w.flags) ? { flags: w.flags } : {}),
    ...(Array.isArray(w.planb) ? { planb: w.planb } : {}),
    ...(Array.isArray(w.snobs) ? { snobs: w.snobs } : {}),
    ...(Array.isArray(w.tonight) ? { tonight: w.tonight } : {}),
  };

  return { plan, warnings };
}
