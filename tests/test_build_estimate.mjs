// Tests for the #5 dynamic build-time estimate helpers in src/App.jsx.
// estimateBuildMinutes / canEstimateBuild are not exported (App.jsx carries
// JSX and isn't import-safe in plain node), so we mirror the pure logic here.
// KEEP IN SYNC with src/App.jsx.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function estimateBuildMinutes({ nights, citiesCount = 1, outputsCount = 0 } = {}) {
  const days = Math.max(1, Number(nights) || 0);
  const cityN = Math.max(1, Number(citiesCount) || 1);
  const addons = Math.max(0, Number(outputsCount) || 0);
  const low = 2 + days * 0.5 + (cityN - 1) * 1 + addons * 0.4;
  const high = low * 1.7 + 2;
  const lo = Math.max(2, Math.round(low));
  const hi = Math.max(lo + 2, Math.round(high));
  return { lo, hi, text: `about ${lo}\u2013${hi} minutes` };
}

function canEstimateBuild(basics) {
  return !!(basics && (Number(basics.nights) > 0 || (Array.isArray(basics.cities) && basics.cities.some(c => c && c.name))));
}

console.log("\n[1] estimateBuildMinutes monotonicity & shape");
{
  const a = estimateBuildMinutes({ nights: 2, citiesCount: 1, outputsCount: 1 });
  const b = estimateBuildMinutes({ nights: 9, citiesCount: 1, outputsCount: 1 });
  assert("more nights -> higher low bound", b.lo > a.lo, `${a.lo} vs ${b.lo}`);

  const c = estimateBuildMinutes({ nights: 5, citiesCount: 1, outputsCount: 2 });
  const d = estimateBuildMinutes({ nights: 5, citiesCount: 4, outputsCount: 2 });
  assert("more cities -> higher low bound", d.lo > c.lo, `${c.lo} vs ${d.lo}`);

  const e = estimateBuildMinutes({ nights: 5, citiesCount: 1, outputsCount: 0 });
  const f = estimateBuildMinutes({ nights: 5, citiesCount: 1, outputsCount: 10 });
  assert("more outputs -> higher low bound", f.lo > e.lo, `${e.lo} vs ${f.lo}`);

  const g = estimateBuildMinutes({ nights: 3, citiesCount: 1, outputsCount: 0 });
  assert("hi is always at least lo+2", g.hi >= g.lo + 2, `lo=${g.lo} hi=${g.hi}`);
  assert("lo floors at 2 minutes", estimateBuildMinutes({ nights: 0 }).lo >= 2);
  assert("text reads 'about LO–HI minutes'", g.text === `about ${g.lo}\u2013${g.hi} minutes`, g.text);
}

console.log("\n[2] estimateBuildMinutes tolerates junk input");
{
  assert("no args -> valid range", (() => { const r = estimateBuildMinutes(); return r.lo >= 2 && r.hi >= r.lo + 2; })());
  assert("string nights coerced", (() => { const r = estimateBuildMinutes({ nights: "7" }); return r.lo > 2; })());
  assert("negative cities floored to 1", estimateBuildMinutes({ nights: 4, citiesCount: -3 }).lo === estimateBuildMinutes({ nights: 4, citiesCount: 1 }).lo);
}

console.log("\n[3] canEstimateBuild gating");
{
  assert("nights set -> can estimate", canEstimateBuild({ nights: 5 }) === true);
  assert("a named city -> can estimate", canEstimateBuild({ cities: [{ name: "Paris" }] }) === true);
  assert("blank basics -> cannot estimate", canEstimateBuild({ nights: "", cities: [{ name: "" }] }) === false);
  assert("null basics -> cannot estimate", canEstimateBuild(null) === false);
  assert("undefined -> cannot estimate", canEstimateBuild(undefined) === false);
}

// -----------------------------------------------------------------------------
// KNOWN FAILURE MODE #13 (2026-08-07): the client's actual hard-timeout
// budget (runBuildForJob / runChunkedBuild / resumeChunkedBuild, src/App.jsx)
// used to be computed from nights + citiesCount alone, with NO outputsCount
// term — while the pre-build screen's own estimateBuildMinutes() promise
// ("about X-Y minutes") DOES factor in active output sections. A trip with
// many outputs active could see the client abandon the connection well
// before the upper bound it had just told the user to expect. Real reported
// case: 14 nights, England (single city as far as the client's own state
// knew), 10/12 output sections active — advertised "13-24 minutes," but the
// old hard timeout fired at 16.5 minutes. Fixed by flooring the hard timeout
// at whatever estimateBuildMinutes().hi promised, for all three call sites.
// -----------------------------------------------------------------------------
console.log("\n[4] hard-timeout floor must never promise more than it waits for (2026-08-07 regression)");

// Mirrors runChunkedBuild's targetSec/hardTimeoutMs formula, pre- and
// post-fix, so the comparison is explicit.
function chunkedHardTimeoutMs({ nightsNum, citiesCount, outputsCount, chunksLen }, { floorAtEstimate }) {
  const targetSec = Math.round(90 + (chunksLen + 1) * 60 + Math.max(0, citiesCount - 1) * 30);
  const base = Math.max(600000, targetSec * 1000 * 3);
  if (!floorAtEstimate) return base;
  const promisedMs = estimateBuildMinutes({ nights: nightsNum, citiesCount, outputsCount }).hi * 60 * 1000;
  return Math.max(base, promisedMs);
}

// Mirrors runBuildForJob's targetSec/hardTimeoutMs formula.
function singleCallHardTimeoutMs({ nightsNum, citiesCount, outputsCount }, { floorAtEstimate }) {
  const totalDays = nightsNum + 1;
  const targetSec = Math.round(120 + totalDays * 12 + Math.max(0, citiesCount - 1) * 60);
  const base = Math.max(300000, targetSec * 1000 * 3);
  if (!floorAtEstimate) return base;
  const promisedMs = estimateBuildMinutes({ nights: nightsNum, citiesCount, outputsCount }).hi * 60 * 1000;
  return Math.max(base, promisedMs);
}

{
  // The exact reported scenario.
  const scenario = { nightsNum: 14, citiesCount: 1, outputsCount: 10, chunksLen: 3 };
  const est = estimateBuildMinutes({ nights: scenario.nightsNum, citiesCount: scenario.citiesCount, outputsCount: scenario.outputsCount });
  const promisedMs = est.hi * 60 * 1000;

  const before = chunkedHardTimeoutMs(scenario, { floorAtEstimate: false });
  const after = chunkedHardTimeoutMs(scenario, { floorAtEstimate: true });

  assert("(documents the bug) the OLD formula's timeout falls short of the advertised estimate",
    before < promisedMs, `before=${(before/60000).toFixed(1)}min promised=${(promisedMs/60000).toFixed(1)}min`);
  assert("the FIXED formula's timeout is at least the advertised estimate",
    after >= promisedMs, `after=${(after/60000).toFixed(1)}min promised=${(promisedMs/60000).toFixed(1)}min`);
  assert("concretely: the fix raises the timeout from ~16.5min to the full 24min promised",
    Math.round(after / 60000) === est.hi, `got ${(after/60000).toFixed(1)}min, expected ${est.hi}min`);
}
{
  // Small trip, few outputs: the estimate's upper bound is comfortably below
  // the existing 3x-target/floor formula, so the fix must be a no-op here —
  // never LOWERS the timeout, only raises it when needed.
  const scenario = { nightsNum: 3, citiesCount: 1, outputsCount: 2, chunksLen: 1 };
  const before = chunkedHardTimeoutMs(scenario, { floorAtEstimate: false });
  const after = chunkedHardTimeoutMs(scenario, { floorAtEstimate: true });
  assert("a small trip's timeout is unchanged by the fix (already generous enough)",
    after === before, `before=${before} after=${after}`);
}
{
  // Single-call path (runBuildForJob) gets the identical treatment.
  const scenario = { nightsNum: 11, citiesCount: 1, outputsCount: 10 };
  const est = estimateBuildMinutes({ nights: scenario.nightsNum, citiesCount: scenario.citiesCount, outputsCount: scenario.outputsCount });
  const after = singleCallHardTimeoutMs(scenario, { floorAtEstimate: true });
  assert("the single-call path's fixed timeout also honors the advertised estimate",
    after >= est.hi * 60 * 1000, `after=${(after/60000).toFixed(1)}min promised=${est.hi}min`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
