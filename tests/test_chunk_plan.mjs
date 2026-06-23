// Tests for src/chunkPlan.js — the chunked-build planner + stitcher that
// fixes the large-trip timeout. Repo convention: custom assert, prints
// "N passed, M failed", exits non-zero on failure. Auto-discovered by
// tests/run-all.mjs.

import {
  estimateSingleCallTokens,
  shouldChunk,
  planDayChunks,
  chunkMaxTokens,
  stitchPlan,
  collectRestaurantNames,
  SINGLE_CALL_TOKEN_BUDGET,
  MAX_DAYS_PER_CHUNK,
} from "../src/chunkPlan.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  \u2713", name); }
  else { failed++; console.log("  \u2717", name, detail || ""); }
}

// Helper: validate a chunk list fully covers 1..totalDays with no gaps/overlaps.
function coverageOk(chunks, totalDays) {
  if (chunks.length === 0) return false;
  if (chunks[0].startDay !== 1) return false;
  if (chunks[chunks.length - 1].endDay !== totalDays) return false;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].endDay < chunks[i].startDay) return false;
    if (i > 0 && chunks[i].startDay !== chunks[i - 1].endDay + 1) return false;
    if (chunks[i].endDay - chunks[i].startDay + 1 > MAX_DAYS_PER_CHUNK) return false;
  }
  return true;
}

console.log("\n[1] estimateSingleCallTokens matches the App formula");
{
  // 3-night single-city: 5000 + 4*2200 = 13800
  assert("3n/1c -> 13800", estimateSingleCallTokens({ nights: 3, citiesCount: 1 }) === 13800);
  // 7-night single-city: 5000 + 8*2200 = 22600
  assert("7n/1c -> 22600", estimateSingleCallTokens({ nights: 7, citiesCount: 1 }) === 22600);
  // 11-night single-city: 5000 + 12*2200 = 31400
  assert("11n/1c -> 31400", estimateSingleCallTokens({ nights: 11, citiesCount: 1 }) === 31400);
  // 12-night 7-city: 5000 + 13*2200 + 6*1200 = 40800
  assert("12n/7c -> 40800", estimateSingleCallTokens({ nights: 12, citiesCount: 7 }) === 40800);
  // capped at 64000
  assert("huge trip capped at 64000", estimateSingleCallTokens({ nights: 40, citiesCount: 3 }) === 64000);
}

console.log("\n[2] shouldChunk threshold boundary");
{
  // Boundary (single-city): 5000+(n+1)*2200 > 28000  =>  (n+1)*2200 > 23000
  //  => n+1 >= 11  => n >= 10. So 9n stays single-call, 10n+ chunks.
  //  9n  -> 5000 + 10*2200 = 27000 <= 28000  (single-call)
  // 10n  -> 5000 + 11*2200 = 29200 >  28000  (chunk)
  assert("9n/1c stays single-call (27000 <= 28000)", shouldChunk({ nights: 9, citiesCount: 1 }) === false, `est ${estimateSingleCallTokens({nights:9,citiesCount:1})}`);
  assert("10n/1c chunks (29200 > 28000)", shouldChunk({ nights: 10, citiesCount: 1 }) === true, `est ${estimateSingleCallTokens({nights:10,citiesCount:1})}`);
  assert("11n/1c chunks (31400 > 28000)", shouldChunk({ nights: 11, citiesCount: 1 }) === true);
  assert("budget constant is 28000", SINGLE_CALL_TOKEN_BUDGET === 28000);
}

console.log("\n[3] planDayChunks — single city");
{
  // 14 nights -> 15 days -> windows of <=6: [1-5][6-10][11-15]
  const c = planDayChunks({ nights: 14 });
  assert("14n/1c full coverage, <=6/day", coverageOk(c, 15), JSON.stringify(c));
  assert("14n/1c produces 3 chunks", c.length === 3, JSON.stringify(c.map(x => `${x.startDay}-${x.endDay}`)));
}

console.log("\n[4] planDayChunks — multi-city breaks on legs (Croatia 12n/7c)");
{
  const cities = [
    { name: "Rovinj", nights: 2 },
    { name: "Plitvice", nights: 1 },
    { name: "Zadar", nights: 1 },
    { name: "Dubrovnik", nights: 3 },
    { name: "Korčula", nights: 2 },
    { name: "Hvar", nights: 2 },
    { name: "Split", nights: 1 },
  ];
  // total nights 12 -> 13 days
  const c = planDayChunks({ nights: 12, cities });
  assert("Croatia full coverage 1..13, no chunk >6 days", coverageOk(c, 13), JSON.stringify(c.map(x => `${x.startDay}-${x.endDay}`)));
  // Leg 1 = Day 1..3 (2 nights + arrival). First chunk should start at day 1.
  assert("first chunk starts day 1", c[0].startDay === 1);
  // Each chunk carries its city name(s)
  assert("chunks carry city names", c.every(x => Array.isArray(x.cityNames)));
}

console.log("\n[5] planDayChunks — a single long leg gets sub-split");
{
  // One city, 9 nights -> 10 days -> must split (>6)
  const c = planDayChunks({ nights: 9, cities: [{ name: "Venice", nights: 9 }] });
  assert("9n single-leg coverage + split", coverageOk(c, 10), JSON.stringify(c.map(x => `${x.startDay}-${x.endDay}`)));
  assert("9n single-leg produces >1 chunk", c.length >= 2);
}

console.log("\n[6] chunkMaxTokens stays well under the 64k ceiling");
{
  assert("6-day chunk budget = 6*2200+1500 = 14700", chunkMaxTokens({ startDay: 1, endDay: 6 }) === 14700);
  assert("1-day chunk floored at 8000", chunkMaxTokens({ startDay: 5, endDay: 5 }) === 8000);
  assert("max chunk budget < 64000", chunkMaxTokens({ startDay: 1, endDay: MAX_DAYS_PER_CHUNK }) < 64000);
}

console.log("\n[7] stitchPlan — concatenates in order + merges wrapper");
{
  const dayChunks = [
    { days: [{ label: "Day 1", items: [] }, { label: "Day 2", items: [] }] },
    { days: [{ label: "Day 3", items: [] }] },
  ];
  const wrapper = {
    destination: "Venice",
    meta: "Sat–Tue · 2 nights",
    logistics: ["Water taxi from VCE"],
    planb: ["a", "b", "c", "d", "e"],
    cities: [{ name: "Venice", nights: 2 }],
  };
  const { plan, warnings } = stitchPlan({ dayChunks, wrapper, expectedDays: 3 });
  assert("days concatenated in order", plan.days.map(d => d.label).join(",") === "Day 1,Day 2,Day 3");
  assert("wrapper destination merged", plan.destination === "Venice");
  assert("wrapper planb merged", Array.isArray(plan.planb) && plan.planb.length === 5);
  assert("cities merged", Array.isArray(plan.cities) && plan.cities[0].name === "Venice");
  assert("no spurious warnings", warnings.length === 0, JSON.stringify(warnings));
}

console.log("\n[8] stitchPlan — rejects an incomplete assembly (truncation guard)");
{
  let threw = false;
  try {
    stitchPlan({ dayChunks: [{ days: [{ label: "Day 1" }] }], wrapper: {}, expectedDays: 5 });
  } catch (e) {
    threw = /assembled 1 days but expected 5/.test(String(e.message));
  }
  assert("throws when day count != expectedDays", threw);
}

console.log("\n[9] stitchPlan — dedupe warning on duplicate restaurant across chunks");
{
  const dayChunks = [
    { days: [{ label: "Day 1", items: [{ kind: "dining", name: "Osteria Alle Testiere" }] }] },
    { days: [{ label: "Day 2", items: [{ kind: "dining", name: "Osteria Alle Testiere" }] }] },
  ];
  const { plan, warnings } = stitchPlan({ dayChunks, wrapper: {}, expectedDays: 2 });
  assert("duplicate flagged in warnings", warnings.some(w => /Duplicate restaurant/.test(w)), JSON.stringify(warnings));
  assert("days still present (non-destructive)", plan.days.length === 2);
}

console.log("\n[10] collectRestaurantNames pulls dining items for cross-chunk context");
{
  const planLike = { days: [{ items: [{ kind: "dining", name: "Le Calandre" }, { kind: "activity", name: "Doge's Palace" }] }] };
  const names = collectRestaurantNames(planLike);
  assert("collects only the dining name", names.length === 1 && names[0] === "Le Calandre", JSON.stringify(names));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
