// Derives the ordered list of city names to plot on the PDF's trip map.
//
// Deliberately keys off days[].city (walked in order), NOT the top-level
// cities[] field — cities[] is schema-capped at maxItems:3 (see
// TRIP_PLAN_TOOL in App.jsx), so a 4+ city trip would silently lose stops
// if the map were built from it. days[].city has no such cap and is
// already the field this app's other city-sequence logic trusts
// (deriveCityNights, dayContinuityCheck.js).
//
// A transit day's city label uses the arrow-joined "City A → City B"
// convention documented in DAY_SCHEMA (App.jsx) — both endpoints are real
// stops and are split out here, matching the arrow-handling already
// established in dayContinuityCheck.js / driveTimeVerify.js for the same
// convention.
//
// Pure: no network, no React, no module state.

const ARROW_SPLIT_RE = /\s*(?:→|->|—>|–>)\s*/;

export function deriveTripMapCities(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const names = [];
  let lastLower = "";
  for (const day of days) {
    const raw = typeof day?.city === "string" ? day.city.trim() : "";
    if (!raw) continue;
    const parts = raw.split(ARROW_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === lastLower) continue; // skip consecutive repeats only
      names.push(part);
      lastLower = lower;
    }
  }
  if (names.length > 0) return names;

  // No day.city data at all (rare — a very old or hand-edited plan).
  // destination follows the same arrow-joined convention for multi-city
  // trips ("Santa Fe → Taos → Albuquerque"), so split it the same way
  // rather than geocoding the whole joined string as one place.
  const dest = typeof plan?.destination === "string" ? plan.destination.trim() : "";
  if (!dest) return [];
  return dest.split(ARROW_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}
