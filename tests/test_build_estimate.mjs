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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
