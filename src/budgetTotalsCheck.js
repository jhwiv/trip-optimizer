// Cost-estimate internal consistency check.
//
// ROUTESMITH ITINERARY-QUALITY UPGRADE spec, §15 "ADD MANDATORY
// CONTRADICTION QA" — one of the enumerated checks is "budget totals."
// cost_estimate.breakdown[] and cost_estimate.{low,high} are two
// independently-written numbers describing the SAME trip cost: the
// breakdown is supposed to be the components that add up to the total.
// Like this app's other contradiction checks (night counts vs. the
// day-by-day city sequence in legNights.js, a Flight item's header time vs.
// its own depart_time in flightTimeConsistency.js), these two numbers can
// silently disagree — the model writes a total that its own listed
// categories don't support.
//
// Deliberately generous margins, same discipline as driveTimeVerify.js's
// max(60min, 35%) floor: RESTAURANT_SCHEMA's sibling cost_estimate schema
// explicitly allows omitting a category the plan doesn't have, so the
// breakdown is not required to be exhaustive. This only catches a large,
// genuine disagreement — not a partial breakdown that's merely incomplete.
//
// Pure: no network, no React, no module state.

export function findBudgetTotalMismatches(plan) {
  const est = plan?.cost_estimate;
  if (!est || typeof est !== "object") return [];

  const low = Number(est.low);
  const high = Number(est.high);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= 0) return [];

  const breakdown = Array.isArray(est.breakdown) ? est.breakdown : [];
  if (breakdown.length === 0) return [];

  let sumLow = 0;
  let sawFinite = false;
  for (const b of breakdown) {
    const bl = Number(b?.low);
    const bh = Number(b?.high);
    if (Number.isFinite(bl) && Number.isFinite(bh)) {
      sumLow += bl;
      sawFinite = true;
    }
  }
  if (!sawFinite) return [];

  const currency = typeof est.currency === "string" && est.currency.trim() ? est.currency.trim() : "USD";
  const fmt = (n) => Math.round(n).toLocaleString("en-US");

  // Only check the ONE direction that's unambiguous: the breakdown's own
  // low-end sum already exceeding the stated high-case total is a clean
  // internal contradiction no matter how the breakdown was assembled — two
  // numbers about the same trip that can't both be right, the same shape as
  // this file's other contradiction checks (a header time vs. a departure
  // time, a night count vs. a day sequence). The OTHER direction — the
  // breakdown summing to noticeably LESS than the stated total — is
  // deliberately NOT flagged: RESTAURANT_SCHEMA's sibling cost_estimate
  // schema explicitly allows omitting a category the plan doesn't have
  // (minItems is only 2), so a short, honest, partial breakdown is a
  // completely normal shape here, not a contradiction — flagging it would
  // be a false positive on the common case rather than the rare bug.
  if (sumLow > high * 1.25 + 200) {
    return [{
      code: "BUDGET_TOTAL_MISMATCH",
      severity: "warn",
      target: "cost_estimate",
      message: `Cost breakdown categories sum to at least ${fmt(sumLow)} ${currency}, which exceeds the stated high-case total of ${fmt(high)} ${currency} — the total and its own breakdown disagree.`,
    }];
  }

  return [];
}
