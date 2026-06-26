// tests/lib/geoSanity.mjs
//
// Pure geometry + plausibility helpers used by the drive-time guardrail
// tests. Test-local (lives under tests/, not src/) so it stays out of the
// production lint/build surface. No dependency on app internals.
//
// Purpose: catch the class of bug that produced the bogus "fifteen
// minutes' drive from the Sagamore to Shelving Rock Falls" itinerary
// line -- where a drive time is derived from straight-line (haversine)
// distance instead of a real road route. Across Lake George the road is
// ~31 mi / ~55 min even though the crow-flies gap is only ~6.5 mi.

const EARTH_RADIUS_MI = 3958.7613;
const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle ("as the crow flies") distance in miles.
export function haversineMiles(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// How much longer the road route is than the straight line. ~1.2-1.4 for
// ordinary connected roads; 2x-10x+ for cross-water / hard-access spots.
export function detourFactor(roadMiles, crowMiles) {
  if (crowMiles <= 0) return Infinity;
  return roadMiles / crowMiles;
}

// Average speed (mph) implied by a (miles, minutes) estimate.
export function impliedMph(miles, minutes) {
  if (minutes <= 0) return Infinity;
  return miles / (minutes / 60);
}

// Heuristic detector: does a drive-time estimate look like it came from
// straight-line distance instead of a real route? True when the implied
// distance for the reported time hugs the crow-flies distance AND the
// real road is materially longer.
export function looksLikeStraightLineEstimate({
  crowMiles,
  roadMiles,
  estimateMinutes,
  assumedMph = 35,
  tolerance = 0.35,
}) {
  const impliedMiles = (estimateMinutes / 60) * assumedMph;
  const closeToCrow = Math.abs(impliedMiles - crowMiles) <= tolerance * crowMiles;
  const roadIsMuchLonger = roadMiles >= crowMiles * 1.5;
  return closeToCrow && roadIsMuchLonger;
}

// Convert the routes-verify response row shape to {minutes, miles}.
export function routeRowToEstimate(row) {
  if (!row || row.found !== true) return null;
  const minutes =
    typeof row.duration_seconds === "number" ? row.duration_seconds / 60 : null;
  const miles =
    typeof row.distance_meters === "number"
      ? row.distance_meters / 1609.344
      : null;
  if (minutes === null || miles === null) return null;
  return { minutes, miles };
}
