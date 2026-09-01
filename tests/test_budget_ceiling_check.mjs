// Tests for src/budgetCeilingCheck.js — ROUTESMITH ITINERARY-QUALITY
// UPGRADE spec §8 "ADD HARD BUDGET CONTROL."

import { findBudgetCeilingExceeded } from "../src/budgetCeilingCheck.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const planWithHigh = (high, extra = {}) => ({
  cost_estimate: { currency: "USD", low: 3000, high, breakdown: [], ...extra },
});

console.log("\n=== findBudgetCeilingExceeded ===");
{
  assert("no ceiling set at all → no flags", findBudgetCeilingExceeded(planWithHigh(50000), {}).length === 0);
  assert("blank ceiling string → no flags", findBudgetCeilingExceeded(planWithHigh(50000), { basics: { hardBudgetCeiling: "" } }).length === 0);
  assert("zero ceiling → no flags (treated as unset)", findBudgetCeilingExceeded(planWithHigh(50000), { basics: { hardBudgetCeiling: "0" } }).length === 0);
  assert("non-numeric ceiling → no flags, no throw", findBudgetCeilingExceeded(planWithHigh(50000), { basics: { hardBudgetCeiling: "not a number" } }).length === 0);
  assert("null plan is safe", findBudgetCeilingExceeded(null, { basics: { hardBudgetCeiling: "10000" } }).length === 0);
  assert("no cost_estimate on the plan → no flags", findBudgetCeilingExceeded({}, { basics: { hardBudgetCeiling: "10000" } }).length === 0);

  assert("high-case WITHIN the ceiling → no flag",
    findBudgetCeilingExceeded(planWithHigh(9000), { basics: { hardBudgetCeiling: "10000" } }).length === 0);
  assert("high-case EXACTLY at the ceiling → no flag (not exceeded, equal)",
    findBudgetCeilingExceeded(planWithHigh(10000), { basics: { hardBudgetCeiling: "10000" } }).length === 0);

  const flags = findBudgetCeilingExceeded(planWithHigh(15000), { basics: { hardBudgetCeiling: "10000" } });
  assert("high-case EXCEEDS the ceiling → BUDGET_CEILING_EXCEEDED warn",
    flags.length === 1 && flags[0].code === "BUDGET_CEILING_EXCEEDED" && flags[0].severity === "warn");
  assert("message names both figures", /15,000/.test(flags[0].message) && /10,000/.test(flags[0].message));
  assert("no adjustments given → generic fallback guidance in the message",
    /No specific adjustment was suggested/.test(flags[0].message));

  const withAdjustments = findBudgetCeilingExceeded(
    planWithHigh(15000, { ceiling_adjustment: ["Drop to a Deluxe room", "Use points for the outbound flight"] }),
    { basics: { hardBudgetCeiling: "10000" } },
  );
  assert("model-suggested adjustments are surfaced verbatim in the message",
    withAdjustments[0].message.includes("Drop to a Deluxe room") && withAdjustments[0].message.includes("Use points for the outbound flight"));

  assert("the DETERMINISTIC comparison uses the user's own ceiling, ignoring a mismatched cost_estimate.hard_ceiling echo",
    findBudgetCeilingExceeded(planWithHigh(12000, { hard_ceiling: 999999 }), { basics: { hardBudgetCeiling: "10000" } }).length === 1);

  assert("a ceiling string with commas/currency noise is still parsed",
    findBudgetCeilingExceeded(planWithHigh(15000), { basics: { hardBudgetCeiling: "$10,000" } }).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
