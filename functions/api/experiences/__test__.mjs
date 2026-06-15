// Quick local sanity test for the experiences module.
//
// Usage:
//   node functions/api/experiences/__test__.mjs
//
// Runs the in-memory private adapter (no network), exercises the ranker, and
// prints what /api/experiences/search would return. Provider adapters that
// require network keys (Viator, GYG, Tiqets) soft-skip when env vars are
// absent, so this test passes with or without keys present.

import { privateSearch } from "./private.js";
import { fuzzyScore, priceTier, toUsd } from "./_shared.js";

const env = {}; // no API keys → private provider is the only one with data

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

console.log("Test 1: priceTier classifies USD into editorial buckets");
assert(priceTier(20) === "low",   "20 → low");
assert(priceTier(90) === "mid",   "90 → mid");
assert(priceTier(300) === "high", "300 → high");
assert(priceTier(900) === "ultra","900 → ultra");
assert(priceTier(NaN) === undefined, "NaN → undefined");
console.log("  ok");

console.log("Test 2: toUsd converts EUR → USD with fallback rate");
const usd = toUsd(100, "EUR");
assert(usd > 100 && usd < 120, `100 EUR ≈ 108 USD (got ${usd})`);
console.log(`  ok (${usd})`);

console.log("Test 3: fuzzyScore matches city queries");
assert(fuzzyScore("Lisbon, Portugal", "Lisbon") === 1, "Lisbon matches Lisbon, Portugal");
assert(fuzzyScore("Lisbon", "Lisbon, Portugal") > 0, "Lisbon, Portugal matches Lisbon");
assert(fuzzyScore("Rome", "Lisbon") === 0, "Rome does not match Lisbon");
console.log("  ok");

console.log("Test 4: privateSearch returns Lisbon operators");
const lisbon = await privateSearch({ destination: "Lisbon", limit: 10 }, env);
assert(lisbon.results.length > 0, "expected at least one Lisbon operator");
const ops = lisbon.results.map((r) => r.operator);
console.log(`  matched ${lisbon.results.length} operators: ${ops.join(", ")}`);
assert(ops.includes("Context Travel"), "Context Travel should be in Lisbon results");
assert(ops.includes("ToursByLocals"), "ToursByLocals should be in Lisbon results");
assert(ops.includes("Withlocals"), "Withlocals should be in Lisbon results");

console.log("Test 5: every result has the required Experience fields");
for (const r of lisbon.results) {
  assert(r.id && r.id.startsWith("private:"), `id should be prefixed: ${r.id}`);
  assert(r.provider === "private", `provider should be private: ${r.provider}`);
  assert(r.name, `name required for ${r.id}`);
  assert(r.url, `url required for ${r.id}`);
  assert(r.bookingMode === "redirect" || r.bookingMode === "inquiry",
    `bookingMode should be redirect|inquiry for ${r.id}`);
}
console.log("  ok");

console.log("Test 6: interests boost matching categories");
const food = await privateSearch(
  { destination: "Lisbon", interests: ["food"], limit: 10 },
  env,
);
const foodFirst = food.results[0]?.operator;
console.log(`  top operator with food interest: ${foodFirst}`);
// We don't assert a specific operator (the directory may evolve), but the
// food interest should at least keep Withlocals or Context (food-tagged
// operators) in the top results.
const top3 = food.results.slice(0, 3).map((r) => r.operator);
assert(top3.includes("Withlocals") || top3.includes("Context Travel"),
  `food interest should surface a food operator (got ${top3.join(", ")})`);
console.log("  ok");

console.log("Test 7: destinations outside the directory return []");
const nowhere = await privateSearch({ destination: "Antarctica" }, env);
assert(nowhere.results.length === 0, "Antarctica should match 0 operators");
console.log("  ok");

console.log("\nAll tests passed.");
