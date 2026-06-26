// Integration tests: drive-time plausibility for known-hard routes.
//
// These exercise the REAL endpoint functions/api/routes-verify.js with a
// mocked Google Routes API (offline, no key, deterministic) and assert
// that the returned drive time/distance for cross-water / hard-access
// routes is physically plausible -- i.e. NOT a straight-line estimate.
//
// Two adapters are exercised through the same endpoint:
//   - CORRECT  : mock returns the fixture's true road distance/time   -> PASS
//   - BUGGY    : mock returns haversine distance at an assumed speed   -> CAUGHT
//
// This is the guardrail for the "fifteen minutes to Shelving Rock Falls"
// class of bug. Auto-discovered by tests/run-all.mjs.

import { onRequestPost } from "../functions/api/routes-verify.js";
import {
  HARD_ROUTES,
  WATER_CROSSING_ROUTES,
  getHardRoute,
} from "./fixtures/hardRoutes.mjs";
import {
  haversineMiles,
  detourFactor,
  routeRowToEstimate,
} from "./lib/geoSanity.mjs";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  \u2713", name); }
  else { failed++; console.log("  \u2717", name, detail || ""); }
}

const ROUTES_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const MI_TO_M = 1609.344;

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

function makeReq(body) {
  return new Request("http://localhost/api/routes-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Build a mocked global fetch for the Routes API. `resolve(pair)` returns
// { duration_seconds, distance_meters } for the diagonal cell of each
// origin/destination pair, looked up by index. We map each request's
// diagonal back to a fixture via coordinates.
function installRoutesMock(resolve) {
  globalThis.fetch = async (url, opts) => {
    if (url !== ROUTES_URL) throw new Error("Unexpected fetch: " + url);
    const body = JSON.parse(opts.body);
    const n = body.origins.length;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const o = body.origins[i].waypoint.location.latLng;
      const d = body.destinations[i].waypoint.location.latLng;
      const origin = { lat: o.latitude, lng: o.longitude };
      const dest = { lat: d.latitude, lng: d.longitude };
      const r = resolve(origin, dest);
      if (!r) {
        rows.push({ originIndex: i, destinationIndex: i, condition: "ROUTE_NOT_FOUND" });
        continue;
      }
      rows.push({
        originIndex: i,
        destinationIndex: i,
        condition: "ROUTE_EXISTS",
        duration: `${Math.round(r.duration_seconds)}s`,
        distanceMeters: Math.round(r.distance_meters),
      });
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  };
}

function fixtureFor(origin, dest, eps = 0.02) {
  return HARD_ROUTES.find(
    (f) =>
      Math.abs(f.origin.lat - origin.lat) < eps &&
      Math.abs(f.origin.lng - origin.lng) < eps &&
      Math.abs(f.destination.lat - dest.lat) < eps &&
      Math.abs(f.destination.lng - dest.lng) < eps,
  );
}

// CORRECT resolver: returns the fixture's true road numbers.
function correctResolver(origin, dest) {
  const f = fixtureFor(origin, dest);
  if (!f) return null;
  return {
    duration_seconds: f.truth.roadMinutes * 60,
    distance_meters: f.truth.roadMiles * MI_TO_M,
  };
}

// BUGGY resolver: mimics a straight-line estimator -- haversine distance
// at an assumed average speed, ignoring water and road topology.
function buggyResolver(assumedMph = 35) {
  return (origin, dest) => {
    const crow = haversineMiles(origin, dest);
    return {
      duration_seconds: (crow / assumedMph) * 3600,
      distance_meters: crow * MI_TO_M,
    };
  };
}

// Post all hard routes as pairs to the real endpoint, return id->estimate.
async function runEndpoint() {
  const pairs = HARD_ROUTES.map((f) => ({
    id: f.id,
    originLat: f.origin.lat,
    originLng: f.origin.lng,
    destLat: f.destination.lat,
    destLng: f.destination.lng,
    travelMode: "DRIVE",
  }));
  const ctx = {
    request: makeReq({ pairs }),
    env: { GOOGLE_PLACES_API_KEY: "test-key", PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  const byId = new Map();
  for (const row of body.routes) byId.set(row.id, row);
  return byId;
}

// Shared plausibility check. Returns null if OK, else a failure reason.
function plausibilityReason(estimate, f) {
  if (!estimate) return "no estimate";
  if (estimate.minutes < f.minPlausibleMinutes) return `too fast: ${estimate.minutes.toFixed(1)} < ${f.minPlausibleMinutes}`;
  if (estimate.minutes > f.maxPlausibleMinutes) return `too slow: ${estimate.minutes.toFixed(1)} > ${f.maxPlausibleMinutes}`;
  // Road can't be meaningfully shorter than straight-line. Allow 2% slack
  // for coordinate/rounding noise (crowMiles is stored to 2 decimals).
  if (estimate.miles < f.naive.crowMiles * 0.98) return `road shorter than crow: ${estimate.miles.toFixed(1)} < ${f.naive.crowMiles}`;
  const df = detourFactor(estimate.miles, f.naive.crowMiles);
  if (df < f.minDetourFactor * 0.9) return `detour factor too low: ${df.toFixed(2)} < ${(f.minDetourFactor * 0.9).toFixed(2)}`;
  return null;
}

const savedFetch = globalThis.fetch;

// ============================================================
console.log("\n[1] CORRECT routing -> every hard route is plausible (GREEN)");
{
  installRoutesMock(correctResolver);
  const byId = await runEndpoint();
  for (const f of HARD_ROUTES) {
    const est = routeRowToEstimate(byId.get(f.id));
    const reason = plausibilityReason(est, f);
    assert(`${f.id}: plausible`, reason === null, reason || "");
  }
}

// ============================================================
console.log("\n[2] BUGGY haversine routing -> water crossings are CAUGHT (RED)");
{
  installRoutesMock(buggyResolver(35));
  const byId = await runEndpoint();
  for (const f of WATER_CROSSING_ROUTES) {
    const est = routeRowToEstimate(byId.get(f.id));
    const reason = plausibilityReason(est, f);
    assert(`${f.id}: straight-line estimate rejected`, reason !== null, "buggy estimate slipped through");
  }
}

// ============================================================
console.log("\n[3] BUGGY routing on the CONTROL route is NOT a false positive");
{
  installRoutesMock(buggyResolver(35));
  const byId = await runEndpoint();
  const c = getHardRoute("bolton-landing-to-lake-george-village");
  const est = routeRowToEstimate(byId.get(c.id));
  // On a normal road, haversine ~= road, so even the "buggy" estimator
  // lands close enough to be plausible. We assert it does NOT get falsely
  // flagged -- proving the guard is specific to genuine water crossings.
  const reason = plausibilityReason(est, c);
  assert("control route stays plausible under buggy estimator", reason === null, reason || "");
}

// ============================================================
console.log("\n[4] Specifically: the Shelving Rock 15-minute bug is caught");
{
  installRoutesMock(buggyResolver(35));
  const byId = await runEndpoint();
  const f = getHardRoute("sagamore-to-shelving-rock-falls");
  const est = routeRowToEstimate(byId.get(f.id));
  assert(
    "buggy Sagamore->Shelving estimate is far below real minimum",
    est && est.minutes < f.minPlausibleMinutes,
    est ? `got ${est.minutes.toFixed(1)} min` : "no estimate",
  );
}

globalThis.fetch = savedFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
