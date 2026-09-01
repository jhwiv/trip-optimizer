// Hard budget ceiling check.
//
// ROUTESMITH ITINERARY-QUALITY UPGRADE spec, §8 "ADD HARD BUDGET CONTROL":
// "If the user gives a hard maximum budget, the planned cash exposure must
// not silently exceed it... If the high-case estimate exceeds the ceiling,
// explicitly identify the adjustment needed."
//
// The comparison itself is deterministic and does NOT trust the model's
// own echo of the ceiling (cost_estimate.hard_ceiling, which exists purely
// for display continuity) — it compares the traveler's own stated number
// (inputs.basics.hardBudgetCeiling, a plain wizard field) against the
// model's own cost_estimate.high. Consistent with this app's verification
// discipline: a real dollar ceiling is a fact to check against ground
// truth, not something to trust the model's own arithmetic about (the same
// reasoning already applied to night counts in legNights.js and now to
// budget totals in budgetTotalsCheck.js).
//
// Severity is "warn", not "block": an estimate exceeding a self-reported
// ceiling is informative for the traveler to act on, not a fabricated fact
// the way the existing block-severity flags are.
//
// Pure: no network, no React, no module state.

export function findBudgetCeilingExceeded(plan, inputs) {
  const ceilingRaw = inputs?.basics?.hardBudgetCeiling;
  const ceiling = Number(String(ceilingRaw ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(ceiling) || ceiling <= 0) return [];

  const est = plan?.cost_estimate;
  const high = Number(est?.high);
  if (!Number.isFinite(high)) return [];
  if (high <= ceiling) return [];

  const currency = typeof est?.currency === "string" && est.currency.trim() ? est.currency.trim() : "USD";
  const fmt = (n) => Math.round(n).toLocaleString("en-US");

  const adjustments = Array.isArray(est?.ceiling_adjustment)
    ? est.ceiling_adjustment.filter((s) => typeof s === "string" && s.trim())
    : [];
  const adjustmentText = adjustments.length
    ? ` Suggested adjustments: ${adjustments.join("; ")}.`
    : " No specific adjustment was suggested — consider a lower room category, using points, or dropping a discretionary experience.";

  return [{
    code: "BUDGET_CEILING_EXCEEDED",
    severity: "warn",
    target: "cost_estimate",
    message: `High-case cost estimate (${fmt(high)} ${currency}) exceeds your stated hard budget ceiling (${fmt(ceiling)} ${currency}).${adjustmentText}`,
  }];
}
