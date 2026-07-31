// Integration test for the meal-policy arm of applyQualityLayer (§1c,
// src/App.jsx ~2844-2875) after it was rewired onto src/mealPolicy.js.
//
// applyQualityLayer is a large closure inside App.jsx and can't be imported
// from a DOM-free Node test, so — following the convention already used by
// tests/test_apply_quality_layer_structural.mjs — the ~20 lines of glue are
// mirrored here. The classifier it calls is imported from src and exercised
// for real; only the filter wiring is copied. Keep the mirror in sync when
// the App.jsx block changes shape.
//
// What this proves end-to-end: the four meal-policy states produce the right
// number of removals, and the three bugs from meal_policy_leak_report.md
// (chip trap, [object Object], negation blindness) no longer strip items the
// traveler asked for.

import {
  classifyMealPolicy,
  mealPolicyAllowsBreakfast,
  mealPolicyAllowsLunch,
} from "../src/mealPolicy.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// -----------------------------------------------------------------------------
// Mirror of src/App.jsx §1c (applyQualityLayer meal-policy strip)
// -----------------------------------------------------------------------------
function stripMeals(days, inputs) {
  const fixes = [];
  if (Array.isArray(days)) {
    const mealPolicy = classifyMealPolicy(inputs);
    const explicitBreakfast = mealPolicyAllowsBreakfast(mealPolicy);
    const explicitLunch = mealPolicyAllowsLunch(mealPolicy);
    days.forEach((day, dayIdx) => {
      if (!Array.isArray(day.items)) return;
      day.items = day.items.filter((item) => {
        const t = (item.type || "").toLowerCase();
        if ((t === "breakfast" || t === "brunch") && !explicitBreakfast) {
          fixes.push(`Day ${dayIdx + 1}: removed unrequested ${t} (${item.restaurant?.name || item.title || "meal"}) per meal policy`);
          return false;
        }
        if (t === "lunch" && !explicitLunch) {
          fixes.push(`Day ${dayIdx + 1}: removed unrequested lunch (${item.restaurant?.name || item.title || "meal"}) per meal policy`);
          return false;
        }
        return true;
      });
    });
  }
  return { days, fixes };
}

// 3 breakfasts + 2 lunches, plus dinners/activities that must never be touched.
function makePlan() {
  return [
    { label: "Day 1", items: [
      { type: "Breakfast", restaurant: { name: "Cafe A" } },
      { type: "Activity" },
      { type: "Lunch", restaurant: { name: "Bistro L1" } },
      { type: "Dinner", restaurant: { name: "D1" } },
    ]},
    { label: "Day 2", items: [
      { type: "Brunch", restaurant: { name: "Brunch B" } },
      { type: "Activity" },
      { type: "Dinner", restaurant: { name: "D2" } },
    ]},
    { label: "Day 3", items: [
      { type: "Breakfast", restaurant: { name: "Cafe C" } },
      { type: "Lunch", restaurant: { name: "Bistro L2" } },
      { type: "Dinner", restaurant: { name: "D3" } },
    ]},
  ];
}
const countType = (days, ...types) =>
  days.reduce((n, d) => n + d.items.filter((i) => types.includes((i.type || "").toLowerCase())).length, 0);

console.log("=== A. The four meal-policy states ===");
{
  // Both requested → nothing removed.
  const both = stripMeals(makePlan(), {
    narrative: "book breakfast at Tia Sophia's and reserve lunch at O Gaveto",
  });
  assert("both included → 0 removed",
    both.fixes.length === 0, JSON.stringify(both.fixes));
  assert("both included → all 3 breakfasts + 2 lunches survive",
    countType(both.days, "breakfast", "brunch") === 3 && countType(both.days, "lunch") === 2);

  // Breakfast only → the 2 lunches go.
  const bfOnly = stripMeals(makePlan(), { narrative: "book breakfast at Tia Sophia's" });
  assert("breakfast only → 2 removed (the lunches)",
    bfOnly.fixes.length === 2, JSON.stringify(bfOnly.fixes));
  assert("breakfast only → 3 breakfasts survive, 0 lunches",
    countType(bfOnly.days, "breakfast", "brunch") === 3 && countType(bfOnly.days, "lunch") === 0);

  // Lunch only → the 3 breakfasts/brunches go.
  const lunchOnly = stripMeals(makePlan(), { narrative: "reserve lunch at O Gaveto" });
  assert("lunch only → 3 removed (breakfasts + brunch)",
    lunchOnly.fixes.length === 3, JSON.stringify(lunchOnly.fixes));
  assert("lunch only → 0 breakfasts, 2 lunches survive",
    countType(lunchOnly.days, "breakfast", "brunch") === 0 && countType(lunchOnly.days, "lunch") === 2);

  // Neither → all 5 go.
  const neither = stripMeals(makePlan(), { narrative: "A relaxed week, good dinners" });
  assert("neither → all 5 removed",
    neither.fixes.length === 5, JSON.stringify(neither.fixes));
  assert("neither → dinners and activities untouched",
    countType(neither.days, "dinner") === 3 && countType(neither.days, "activity") === 2);
}

console.log("=== B. REGRESSION — the reported 13-meal build ===");
{
  // The observed failing case: narrative silent on meals except a negated
  // lunch mention. Old code read "don't need lunch" as an explicit ask and
  // disabled the strip; the classifier must report both unspecified/excluded
  // and every meal item must be removed.
  const inputs = {
    narrative: "Two weeks Bayeux, Nuremberg, Munich and Porto. Relaxed pace, great dinners. We don't need lunch.",
    guidelines: "",
    dining: { cuisine: "", budget: [] },
    restaurants: [],
  };
  const policy = classifyMealPolicy(inputs);
  assert("classifier: breakfast not included",
    !mealPolicyAllowsBreakfast(policy), JSON.stringify(policy));
  assert("classifier: lunch NOT included despite the word 'lunch' appearing",
    !mealPolicyAllowsLunch(policy), JSON.stringify(policy));
  assert("classifier: the lunch mention is recorded as negated",
    policy.reasons.lunch.some((x) => x.startsWith("negated:")), JSON.stringify(policy.reasons));

  // 13 meal items spread across 5 days, mirroring the reported build.
  const days = [];
  let emitted = 0;
  for (let d = 0; d < 5 && emitted < 13; d += 1) {
    const items = [{ type: "Dinner", restaurant: { name: `D${d}` } }];
    for (const t of ["Breakfast", "Lunch", "Brunch"]) {
      if (emitted < 13) { items.unshift({ type: t, restaurant: { name: `${t}${d}` } }); emitted += 1; }
    }
    days.push({ label: `Day ${d + 1}`, items });
  }
  assert("fixture really has 13 meal items", emitted === 13);

  const r = stripMeals(days, inputs);
  assert("REGRESSION: all 13 meal items removed",
    r.fixes.length === 13, `got ${r.fixes.length}`);
  assert("REGRESSION: 5 dinners survive",
    countType(r.days, "dinner") === 5);
  assert("REGRESSION: fixes read 'per meal policy'",
    r.fixes.every((f) => f.endsWith("per meal policy")));
}

console.log("=== C. REGRESSION — the chip trap ===");
{
  // User clicked "Casual lunch", narrative silent. The model complies and
  // emits lunches; the old strip deleted them because it never read
  // restaurants[]. The user got the opposite of what they clicked.
  const days = [
    { label: "Day 1", items: [{ type: "Lunch", restaurant: { name: "L1" } }, { type: "Dinner" }] },
    { label: "Day 2", items: [{ type: "Lunch", restaurant: { name: "L2" } }, { type: "Dinner" }] },
    { label: "Day 3", items: [{ type: "Lunch", restaurant: { name: "L3" } }, { type: "Dinner" }] },
  ];
  const r = stripMeals(days, {
    narrative: "A relaxed week in Porto",
    dining: { cuisine: "", budget: [] },
    restaurants: ["Casual lunch"],
  });
  assert("CHIP-TRAP: 0 removed — the chip is honored",
    r.fixes.length === 0, JSON.stringify(r.fixes));
  assert("CHIP-TRAP: all 3 lunches survive",
    countType(r.days, "lunch") === 3);

  // And the breakfast chip, symmetric.
  const bfDays = [{ label: "Day 1", items: [{ type: "Brunch" }, { type: "Dinner" }] }];
  const bf = stripMeals(bfDays, { restaurants: ["Brunch spot"] });
  assert("CHIP-TRAP: 'Brunch spot' chip keeps the Brunch item",
    bf.fixes.length === 0 && countType(bf.days, "brunch") === 1);
}

console.log("=== D. REGRESSION — dining object no longer '[object Object]' ===");
{
  const days = [{ label: "Day 1", items: [{ type: "Brunch", restaurant: { name: "B" } }, { type: "Dinner" }] }];
  const r = stripMeals(days, {
    narrative: "Relaxed week",
    dining: { cuisine: "brunch, coffee", budget: ["$$"] },
    restaurants: [],
  });
  assert("OBJECT-BUG: dining.cuisine 'brunch, coffee' keeps the Brunch item",
    r.fixes.length === 0 && countType(r.days, "brunch") === 1, JSON.stringify(r.fixes));

  // An empty dining object must not accidentally read as a signal.
  const empty = stripMeals(
    [{ label: "Day 1", items: [{ type: "Breakfast" }, { type: "Dinner" }] }],
    { dining: { cuisine: "", budget: [] } },
  );
  assert("OBJECT-BUG: empty dining object → breakfast still stripped",
    empty.fixes.length === 1);
}

console.log("=== E. Malformed input is survivable ===");
{
  assert("null days → no throw",
    stripMeals(null, { narrative: "x" }).fixes.length === 0);
  assert("day without items[] → skipped",
    stripMeals([{ label: "Day 1" }], { narrative: "x" }).fixes.length === 0);
  assert("null inputs → strips (safe default)",
    stripMeals([{ label: "Day 1", items: [{ type: "Lunch" }] }], null).fixes.length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
