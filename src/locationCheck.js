// Per-leg location-sanity check for Trip Optimizer.
//
// The failure pattern this catches:
//   Itinerary destination: "Santa Fe, NM"
//   Model invents a restaurant: "Geronimo"
//   Places Text Search resolves to a real Geronimo in Santa Fe, Argentina
//     (15,000 km from the trip)
//   Old code: marks OPERATIONAL, overwrites address with Argentine one,
//             ships the PDF
//
// The fix:
//   1. Geocode each leg's city once → get its lat/lng centroid.
//   2. For each verified venue, compute great-circle distance to its
//      leg's centroid using Haversine.
//   3. If distance > radius_km, attach a WRONG_LOCATION block flag.
//
// What this module does NOT do:
//   - Geocode anything (that's the caller's job — see /api/geocode-city).
//   - Network I/O of any kind.
//   - Decide which leg a venue belongs to (assumed already tagged by
//     the verification pipeline — when not tagged, the venue is checked
//     against ALL legs and passes if it's within radius of any of them).
//
// Per-leg radius (user decision 2026-06-14):
//   Default 50 km, auto-widened for trips with long inter-city drives.
//   Computation: radius_km = max(50, distanceToNextLegCenter / 2).
//   Rationale: a leg whose next-leg center is 200 km away can legitimately
//   include venues anywhere along that route. Tight radii would
//   false-positive on transit-day items.

// Earth's mean radius in kilometers, per WGS-84.
const EARTH_RADIUS_KM = 6371.0088;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two {lat, lng} points, in kilometers.
// Returns Infinity if either input is malformed (so callers can rely on
// "outside-radius" semantics for missing data).
export function haversineKm(a, b) {
  if (
    !a || !b ||
    typeof a.lat !== "number" || typeof a.lng !== "number" ||
    typeof b.lat !== "number" || typeof b.lng !== "number"
  ) {
    return Infinity;
  }
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return EARTH_RADIUS_KM * c;
}

// Compute the per-leg radius for a list of leg centroids.
// `centers` is an array of { name, lat, lng } in trip order.
// Returns an array of { name, lat, lng, radius_km } in the same order.
//
// Default radius = 50 km. Widening rule: a leg's radius is
// max(50, distanceToNextCenter / 2). The last leg uses the same as the
// previous (no "next" to scale against).
export function computeLegRadii(centers, opts = {}) {
  const defaultRadius = typeof opts.defaultRadiusKm === "number" ? opts.defaultRadiusKm : 50;
  if (!Array.isArray(centers) || centers.length === 0) return [];
  const out = [];
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i];
    if (!c || typeof c.lat !== "number" || typeof c.lng !== "number") {
      out.push({ ...c, radius_km: defaultRadius });
      continue;
    }
    let radius = defaultRadius;
    if (i + 1 < centers.length) {
      const next = centers[i + 1];
      if (next && typeof next.lat === "number" && typeof next.lng === "number") {
        const d = haversineKm(c, next);
        if (Number.isFinite(d)) {
          radius = Math.max(defaultRadius, d / 2);
        }
      }
    } else if (i > 0) {
      // Last leg: inherit the previous leg's radius (already in `out`).
      const prev = out[i - 1];
      radius = prev?.radius_km || defaultRadius;
    }
    out.push({ ...c, radius_km: radius });
  }
  return out;
}

// Run the location check against a list of verifications.
//
// `verifications` is the array returned by /api/places-verify-batch.
//   Each entry has { name, kind, found, lat?, lng?, ... }
//
// `legs` is an array of { name, lat, lng, radius_km } in trip order.
//   Typically the output of computeLegRadii() seeded by /api/geocode-city.
//
// `opts.legIndexByVenueName` is an OPTIONAL Map<name, legIdx>: when the
//   pipeline already knows which leg a venue belongs to (e.g. because
//   the plan's days[].city field said so), pass it in. Otherwise the
//   check uses a "permissive" rule: pass if the venue is within ANY
//   leg's radius. The permissive rule is the right default — it never
//   blocks a venue that's plausibly part of the trip.
//
// `opts.kinds` (default ['restaurant', 'activity']) limits which kinds
//   to check. Hotels are excluded by default per user decision
//   2026-06-14.
//
// Returns: { flagsByName: Map<name, flag>, checked: N, blocked: M }
//   where flag = { code: 'WRONG_LOCATION', severity: 'block', message }
export function findVenuesOutsideRadius(verifications, legs, opts = {}) {
  const result = { flagsByName: new Map(), checked: 0, blocked: 0 };
  if (!Array.isArray(verifications) || !Array.isArray(legs) || legs.length === 0) {
    return result;
  }
  const kinds = Array.isArray(opts.kinds) ? opts.kinds : ["restaurant", "activity"];
  const kindSet = new Set(kinds);
  const legIndexByName = opts.legIndexByVenueName instanceof Map ? opts.legIndexByVenueName : null;

  for (const v of verifications) {
    if (!v || typeof v.name !== "string") continue;
    if (!v.found) continue; // unverified venues handled by UNVERIFIED flag elsewhere
    if (v.kind && !kindSet.has(v.kind)) continue;
    if (typeof v.lat !== "number" || typeof v.lng !== "number") continue;
    result.checked += 1;

    let passed = false;
    let nearestLegName = null;
    let nearestKm = Infinity;

    if (legIndexByName) {
      const legIdx = legIndexByName.get(v.name);
      if (typeof legIdx === "number" && legs[legIdx]) {
        const leg = legs[legIdx];
        const d = haversineKm({ lat: v.lat, lng: v.lng }, { lat: leg.lat, lng: leg.lng });
        if (Number.isFinite(d) && d <= (leg.radius_km || 50)) {
          passed = true;
        }
        nearestLegName = leg.name;
        nearestKm = d;
      }
    }

    if (!passed) {
      // Permissive check: pass if within ANY leg's radius.
      for (const leg of legs) {
        if (typeof leg.lat !== "number" || typeof leg.lng !== "number") continue;
        const d = haversineKm({ lat: v.lat, lng: v.lng }, { lat: leg.lat, lng: leg.lng });
        if (!Number.isFinite(d)) continue;
        if (d < nearestKm) {
          nearestKm = d;
          nearestLegName = leg.name;
        }
        if (d <= (leg.radius_km || 50)) {
          passed = true;
          break;
        }
      }
    }

    if (!passed) {
      result.blocked += 1;
      result.flagsByName.set(v.name, {
        code: "WRONG_LOCATION",
        severity: "block",
        message: nearestLegName
          ? `Venue is ${Math.round(nearestKm)} km from the nearest trip city (${nearestLegName}) — likely a wrong-city match.`
          : `Venue is far from any trip city (${Math.round(nearestKm)} km) — likely a wrong-city match.`,
      });
    }
  }

  return result;
}
