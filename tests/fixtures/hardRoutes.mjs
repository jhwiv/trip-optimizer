// tests/fixtures/hardRoutes.mjs
//
// Ground-truth fixtures for "straight-line distance is fundamentally
// wrong" routes -- cross-lake, cross-bay, ferry-only, around-the-cape.
// These are the cases that broke the itinerary (Shelving Rock Falls) and
// the class of case we want CI to guard forever.
//
// Each route carries:
//   origin / destination   approx coordinates
//   truth                  REAL road distance + drive time (mapping data)
//   naive.crowMiles        ACTUAL haversine distance for these coords
//   naive.naiveMinutes     what a haversine@~assumedMph estimator yields
//   minDetourFactor        road must be >= this * crow distance
//   min/maxPlausibleMinutes plausible drive-time window
//   crossesWater           no direct road across the water gap
//
// Sources are cited per route. Coordinates are approximate; the geometry
// assertions only need them good to ~0.5 mi.

export const HARD_ROUTES = [
  {
    // THE ORIGINAL BUG. Sagamore Resort (Bolton Landing) -> Shelving Rock
    // Falls. ~6.5 mi straight-line across Lake George, but no road crosses
    // the lake -- you drive ~31 mi south around and up dirt roads. Real
    // time ~50-60 min; the app's narrative said "fifteen minutes".
    // Sources: Tripadvisor visitor reports ("40-45 min from Lake George
    // Village", "an hour from our lodging"); Booked.net distance.
    // https://www.tripadvisor.com/ShowUserReviews-g48016-d116367-r698984409
    id: "sagamore-to-shelving-rock-falls",
    label: "Sagamore Resort -> Shelving Rock Falls (across Lake George)",
    origin: { lat: 43.6309, lng: -73.6618 },
    destination: { lat: 43.5436, lng: -73.6128 },
    crossesWater: true,
    truth: { roadMiles: 31.0, roadMinutes: 55 },
    naive: { crowMiles: 6.51, naiveMinutes: 15 },
    minDetourFactor: 4.0,
    minPlausibleMinutes: 40,
    maxPlausibleMinutes: 75,
  },
  {
    // San Francisco -> Tiburon. ~7 mi across the bay; ~16.4 mi road over
    // the Golden Gate Bridge and up US-101. Source: Rome2Rio (road 16.4 mi,
    // straight 7 mi, ~27-30 min). https://www.rome2rio.com/s/San-Francisco/Tiburon
    id: "sf-to-tiburon",
    label: "San Francisco -> Tiburon (across San Francisco Bay)",
    origin: { lat: 37.7749, lng: -122.4194 },
    destination: { lat: 37.8735, lng: -122.4566 },
    crossesWater: true,
    truth: { roadMiles: 16.4, roadMinutes: 30 },
    naive: { crowMiles: 7.11, naiveMinutes: 12 },
    minDetourFactor: 1.8,
    minPlausibleMinutes: 22,
    maxPlausibleMinutes: 60,
  },
  {
    // Seattle -> Bainbridge Island. No road crossing: car route is a
    // ~36 mi drive-around through Tacoma, or a ferry. Straight-line ~9 mi.
    // Source: Rome2Rio / WSDOT. https://www.rome2rio.com/s/Seattle-WA/Bainbridge-Island
    id: "seattle-to-bainbridge",
    label: "Seattle -> Bainbridge Island (ferry-only or long detour)",
    origin: { lat: 47.6062, lng: -122.3321 },
    destination: { lat: 47.6262, lng: -122.5212 },
    crossesWater: true,
    truth: { roadMiles: 36.0, roadMinutes: 65 },
    naive: { crowMiles: 8.92, naiveMinutes: 16 },
    minDetourFactor: 3.0,
    minPlausibleMinutes: 45,
    maxPlausibleMinutes: 90,
  },
  {
    // Provincetown -> Plymouth, across Cape Cod Bay. ~26 mi straight-line
    // over water; ~55 mi road looping down the Cape and around the bay.
    // Source: See Plymouth / Wanderlog drive guides.
    // https://seeplymouth.com/news/cape-cod-road-trip-plymouth-to-provincetown/
    id: "provincetown-to-plymouth",
    label: "Provincetown -> Plymouth (around Cape Cod Bay)",
    origin: { lat: 42.0584, lng: -70.1787 },
    destination: { lat: 41.9584, lng: -70.6673 },
    crossesWater: true,
    truth: { roadMiles: 55.0, roadMinutes: 75 },
    naive: { crowMiles: 26.02, naiveMinutes: 45 },
    minDetourFactor: 2.0,
    minPlausibleMinutes: 60,
    maxPlausibleMinutes: 100,
  },
  {
    // CONTROL: a normal connected road pair. Guards against an over-eager
    // fix that flags EVERYTHING as a water crossing. Bolton Landing ->
    // Lake George Village, ~15 mi down Route 9N, detour ~1.05x.
    id: "bolton-landing-to-lake-george-village",
    label: "Bolton Landing -> Lake George Village (normal road, control)",
    origin: { lat: 43.6309, lng: -73.6618 },
    destination: { lat: 43.4251, lng: -73.7118 },
    crossesWater: false,
    truth: { roadMiles: 15.5, roadMinutes: 25 },
    naive: { crowMiles: 14.44, naiveMinutes: 25 },
    minDetourFactor: 1.0,
    minPlausibleMinutes: 18,
    maxPlausibleMinutes: 35,
  },
];

export const WATER_CROSSING_ROUTES = HARD_ROUTES.filter((r) => r.crossesWater);
export const CONTROL_ROUTES = HARD_ROUTES.filter((r) => !r.crossesWater);

export function getHardRoute(id) {
  const r = HARD_ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown hard route id: ${id}`);
  return r;
}
