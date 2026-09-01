// Tests for src/budgetTotalsCheck.js — the cost-estimate internal-
// consistency check added for the ROUTESMITH ITINERARY-QUALITY UPGRADE
// spec's §15 "MANDATORY CONTRADICTION QA" ("budget totals").

import { findBudgetTotalMismatches } from "../src/budgetTotalsCheck.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("\n=== findBudgetTotalMismatches ===");
{
  assert("no cost_estimate → no flags", findBudgetTotalMismatches({}).length === 0);
  assert("null plan is safe", findBudgetTotalMismatches(null).length === 0);
  assert("cost_estimate with no breakdown → no flags (nothing to cross-check)",
    findBudgetTotalMismatches({ cost_estimate: { low: 3000, high: 5000, breakdown: [] } }).length === 0);
  assert("non-finite low/high → no flags (shape guard is costEstimate.js's job)",
    findBudgetTotalMismatches({ cost_estimate: { low: NaN, high: 5000, breakdown: [{ category: "Flights", low: 1000, high: 1500 }] } }).length === 0);

  const consistent = {
    cost_estimate: {
      currency: "USD",
      low: 8000,
      high: 12000,
      breakdown: [
        { category: "Flights", low: 3000, high: 4500 },
        { category: "Lodging", low: 3500, high: 5500 },
        { category: "Dining", low: 1000, high: 1500 },
      ],
    },
  };
  assert("breakdown roughly matches the stated total → no flag", findBudgetTotalMismatches(consistent).length === 0);

  const partial = {
    cost_estimate: {
      currency: "USD",
      low: 8000,
      high: 12000,
      breakdown: [
        { category: "Flights", low: 3000, high: 4500 },
      ],
    },
  };
  assert("a genuinely partial breakdown (schema allows omitting categories) within generous margin → no flag",
    findBudgetTotalMismatches(partial).length === 0);

  const breakdownExceedsTotal = {
    cost_estimate: {
      currency: "USD",
      low: 8000,
      high: 12000,
      breakdown: [
        { category: "Flights", low: 6000, high: 8000 },
        { category: "Lodging", low: 7000, high: 9000 },
        { category: "Dining", low: 3000, high: 4000 },
      ],
    },
  };
  const overFlags = findBudgetTotalMismatches(breakdownExceedsTotal);
  assert("breakdown sum wildly exceeds the stated high-case total → BUDGET_TOTAL_MISMATCH warn",
    overFlags.length === 1 && overFlags[0].code === "BUDGET_TOTAL_MISMATCH" && overFlags[0].severity === "warn");
  assert("message names both figures", /12,000/.test(overFlags[0].message) && /16,000/.test(overFlags[0].message));

  const breakdownFarUnder = {
    cost_estimate: {
      currency: "USD",
      low: 8000,
      high: 12000,
      breakdown: [
        { category: "Dining", low: 200, high: 300 },
      ],
    },
  };
  assert("breakdown sum far UNDER the stated range is deliberately NOT flagged (schema allows omitting categories — see file header comment)",
    findBudgetTotalMismatches(breakdownFarUnder).length === 0);

  const smallTripRounding = {
    cost_estimate: {
      currency: "USD",
      low: 500,
      high: 700,
      breakdown: [
        { category: "Dining", low: 300, high: 400 },
        { category: "Activities", low: 250, high: 350 },
      ],
    },
  };
  assert("small trip: flat +200 floor absorbs ordinary rounding noise → no false positive",
    findBudgetTotalMismatches(smallTripRounding).length === 0);

  assert("string-typed low/high on breakdown entries are ignored, not coerced into a false positive",
    findBudgetTotalMismatches({
      cost_estimate: { low: 8000, high: 12000, breakdown: [{ category: "X", low: "a lot", high: "so much" }] },
    }).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
