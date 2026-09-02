// Tests for src/costNightsTextCheck.js — cross-checks cost_estimate
// .breakdown[].category free text (e.g. "Cascade Wellness Resort 5n +
// Tivoli Carvoeiro 4n") against the real per-property night counts derived
// from the day-by-day sequence (legNights.js's deriveHotelNights).

import { findCostNightsTextMismatches } from "../src/costNightsTextCheck.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Real reported shape: 3 unpaid nights with friends, 6 paid nights at
// Cascade Wellness Resort, 3 paid nights at Tivoli Carvoeiro Algarve Resort.
const act = (text) => ({ type: "Activity", text });
function realPlan(breakdownCategory) {
  return {
    cost_estimate: {
      currency: "USD",
      low: 8000,
      high: 12000,
      breakdown: [
        { category: "Flights", low: 3000, high: 4000 },
        { category: breakdownCategory, low: 4200, high: 6000 },
      ],
    },
    days: [
      { city: "Carvoeiro", items: [act("Arrive at friends' home")] },
      { city: "Carvoeiro", items: [act("Beach day")] },
      { city: "Carvoeiro", items: [act("Benagil speedboat")] },
      {
        city: "Lagos",
        items: [
          { type: "Transport", text: "Drive Carvoeiro to Lagos" },
          { type: "Hotel", text: "Check in to Cascade Wellness Resort", hotel: { name: "Cascade Wellness Resort" } },
        ],
      },
      { city: "Lagos", items: [act("Old town")] },
      { city: "Lagos", items: [act("Paddleboard day trip")] },
      { city: "Lagos", items: [act("Ponta da Piedade")] },
      { city: "Lagos", items: [act("Sagres")] },
      { city: "Lagos", items: [act("Spa morning")] },
      {
        city: "Carvoeiro",
        items: [
          { type: "Transport", text: "Drive Lagos to Carvoeiro" },
          { type: "Hotel", text: "Check in to Tivoli Carvoeiro Algarve Resort", hotel: { name: "Tivoli Carvoeiro Algarve Resort" } },
        ],
      },
      { city: "Carvoeiro", items: [act("Sagres & Cape St. Vincent")] },
      { city: "Carvoeiro", items: [act("Silves")] },
      { city: "Carvoeiro", items: [{ type: "Hotel", text: "Check out of Tivoli Carvoeiro Algarve Resort", hotel: { name: "Tivoli Carvoeiro Algarve Resort" } }] },
    ],
  };
}

console.log("\n=== findCostNightsTextMismatches — the real reported case ===");
{
  const plan = realPlan("Lodging (9 paid nights: Cascade Wellness Resort 5n + Tivoli Carvoeiro 4n)");
  const flags = findCostNightsTextMismatches(plan);
  assert("two mismatches found (both named splits are wrong)", flags.length === 2, JSON.stringify(flags));
  assert("all flags carry the right code/severity",
    flags.every(f => f.code === "COST_ESTIMATE_NIGHTS_MISMATCH" && f.severity === "warn"));
  assert("Cascade mismatch names the real 6, not the claimed 5",
    flags.some(f => f.message.includes("Cascade Wellness Resort 5n") && f.message.includes("6 nights")), JSON.stringify(flags));
  assert("Tivoli mismatch (shortened name in the text) names the real 3, not the claimed 4",
    flags.some(f => f.message.includes("Tivoli Carvoeiro 4n") && f.message.includes("3 nights")), JSON.stringify(flags));
}

console.log("\n=== findCostNightsTextMismatches — correct text produces no flag ===");
{
  const plan = realPlan("Lodging (9 paid nights: Cascade Wellness Resort 6n + Tivoli Carvoeiro Algarve Resort 3n)");
  assert("matching real counts → no flags", findCostNightsTextMismatches(plan).length === 0);
}

console.log("\n=== findCostNightsTextMismatches — conservative / safe on unmatched or missing data ===");
{
  const plan = realPlan("Lodging: two properties, 9 nights total");
  assert("no name+nights pattern in the text → no flags", findCostNightsTextMismatches(plan).length === 0);

  const unrelatedName = realPlan("Lodging (Some Other Hotel 5n)");
  assert("a name that doesn't match any real hotel → no flag (not guessed at)",
    findCostNightsTextMismatches(unrelatedName).length === 0);

  assert("no cost_estimate → no flags", findCostNightsTextMismatches({ days: realPlan("x").days }).length === 0);
  assert("no breakdown → no flags", findCostNightsTextMismatches({ cost_estimate: { breakdown: [] }, days: realPlan("x").days }).length === 0);
  assert("no days / underivable → no flags",
    findCostNightsTextMismatches({ cost_estimate: { breakdown: [{ category: "Lodging (Cascade Wellness Resort 5n)" }] } }).length === 0);
  assert("null plan is safe", findCostNightsTextMismatches(null).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
