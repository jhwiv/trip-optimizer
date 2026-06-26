// Tests for tests/lib/geoSanity.mjs -- the drive-time plausibility
// helpers that catch straight-line/cross-water estimation bugs.
//
// Follows the repo convention: plain script, custom assert, prints
// "N passed, M failed" on the last line, exits non-zero on any failure.
// Auto-discovered by tests/run-all.mjs.

import {
  haversineMiles,
  detourFactor,
  impliedMph,
  looksLikeStraightLineEstimate,
} from "./lib/geoSanity.mjs";
import { HARD_ROUTES, getHardRoute } from "./fixtures/hardRoutes.mjs";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  \u2713", name); }
  else { failed++; console.log("  \u2717", name, detail || ""); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

console.log("\n[1] haversineMiles");
{
  const p = { lat: 43.63, lng: -73.66 };
  assert("0 for identical points", near(haversineMiles(p, p), 0, 1e-6));

  const f = getHardRoute("sagamore-to-shelving-rock-falls");
  const d = haversineMiles(f.origin, f.destination);
  assert("Sagamore->Shelving straight-line ~6.5 mi", d > 5 && d < 8, `got ${d.toFixed(2)}`);
  assert("matches fixture crowMiles", near(d, f.naive.crowMiles, 0.2), `got ${d.toFixed(2)}`);

  const t = getHardRoute("sf-to-tiburon");
  assert(
    "symmetric",
    near(haversineMiles(t.origin, t.destination), haversineMiles(t.destination, t.origin), 1e-6),
  );
}

console.log("\n[2] detourFactor");
{
  assert("~1 for straight road", near(detourFactor(10, 10), 1, 1e-9));
  assert("10x when road >> crow", detourFactor(30, 3) === 10);
  assert("Infinity at zero crow", detourFactor(5, 0) === Infinity);
}

console.log("\n[3] impliedMph");
{
  assert("35 mi in 60 min -> 35 mph", near(impliedMph(35, 60), 35, 1e-9));
  // The trap: 6.5 mi in 15 min is only ~26 mph -- SPEED looks fine; the
  // DISTANCE is what's wrong. That's why we need the dedicated detector.
  assert("short straight-line trip implies a benign speed", impliedMph(6.51, 15) < 30);
}

console.log("\n[4] looksLikeStraightLineEstimate (core bug detector)");
{
  const f = getHardRoute("sagamore-to-shelving-rock-falls");
  assert(
    "flags the 15-min Shelving Rock estimate",
    looksLikeStraightLineEstimate({
      crowMiles: f.naive.crowMiles,
      roadMiles: f.truth.roadMiles,
      estimateMinutes: f.naive.naiveMinutes,
    }) === true,
  );
  assert(
    "does NOT flag the correct ~55-min estimate",
    looksLikeStraightLineEstimate({
      crowMiles: f.naive.crowMiles,
      roadMiles: f.truth.roadMiles,
      estimateMinutes: f.truth.roadMinutes,
    }) === false,
  );
  const c = getHardRoute("bolton-landing-to-lake-george-village");
  assert(
    "does NOT flag a normal control route",
    looksLikeStraightLineEstimate({
      crowMiles: c.naive.crowMiles,
      roadMiles: c.truth.roadMiles,
      estimateMinutes: c.truth.roadMinutes,
    }) === false,
  );
}

console.log("\n[5] fixture self-consistency (guards against bad ground-truth)");
for (const f of HARD_ROUTES) {
  assert(
    `${f.id}: road >= straight-line`,
    f.truth.roadMiles >= f.naive.crowMiles,
    `${f.truth.roadMiles} < ${f.naive.crowMiles}`,
  );
  assert(
    `${f.id}: detour factor >= minDetourFactor`,
    detourFactor(f.truth.roadMiles, f.naive.crowMiles) >= f.minDetourFactor,
  );
  assert(
    `${f.id}: truth time within plausible window`,
    f.truth.roadMinutes >= f.minPlausibleMinutes && f.truth.roadMinutes <= f.maxPlausibleMinutes,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
