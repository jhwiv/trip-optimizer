// Tests for src/mealPolicy.js. Locks in the meal-policy leak fixes from
// meal_policy_leak_report.md (2026-07-31): the build model emitted
// Breakfast/Brunch/Lunch items that applyQualityLayer immediately deleted
// ("Auto-fixed 13 items … per meal policy").
//
// Four areas:
//   A. classifyMealPolicy — prose, with NEGATION handling (the regression
//      that mattered: "don't plan lunch" used to read as "plan lunch" and
//      silently disable the strip).
//   B. classifyMealPolicy — the non-prose input surfaces the old detector
//      could not see at all: restaurants[] chips and the dining object.
//   C. renderMealPolicyPromptRule — one case per output shape.
//   D. mealPolicyAllowsBreakfast / mealPolicyAllowsLunch.

import {
  classifyMealPolicy,
  renderMealPolicyPromptRule,
  mealPolicyAllowsBreakfast,
  mealPolicyAllowsLunch,
} from "../src/mealPolicy.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== A. classifyMealPolicy — empty / defensive ===");
{
  const r = classifyMealPolicy({});
  assert("empty object → both unspecified",
    r.breakfast === "unspecified" && r.lunch === "unspecified",
    JSON.stringify(r));
  assert("empty object → empty reasons arrays",
    r.reasons.breakfast.length === 0 && r.reasons.lunch.length === 0);

  assert("null → both unspecified",
    classifyMealPolicy(null).breakfast === "unspecified");
  assert("non-object → both unspecified",
    classifyMealPolicy("string").lunch === "unspecified");
  assert("undefined → reasons still present (no throw)",
    Array.isArray(classifyMealPolicy(undefined).reasons.lunch));
}

console.log("=== A2. classifyMealPolicy — explicit asks in prose ===");
{
  const r = classifyMealPolicy({ narrative: "reserve lunch at O Gaveto Day 3" });
  assert("'reserve lunch at O Gaveto Day 3' → lunch included",
    r.lunch === "included", JSON.stringify(r));
  assert("… and breakfast stays unspecified",
    r.breakfast === "unspecified");
  assert("… with a prose: reason recorded",
    r.reasons.lunch.some((x) => x.startsWith("prose:")), JSON.stringify(r.reasons));

  const asks = [
    ["book a lunch reservation on Day 3", "lunch"],
    ["breakfast at Tia Sophia's", "breakfast"],
    ["brunch on Sunday at Clafoutis", "breakfast"],
    ["we want brunch somewhere local", "breakfast"],
    ["please include lunch each day", "lunch"],
  ];
  for (const [phrase, meal] of asks) {
    const got = classifyMealPolicy({ narrative: phrase });
    assert(`ask: "${phrase}" → ${meal} included`,
      got[meal] === "included", JSON.stringify(got));
  }

  const viaGuidelines = classifyMealPolicy({ guidelines: "book lunch at Atardi" });
  assert("guidelines field is scanned too → lunch included",
    viaGuidelines.lunch === "included");
}

console.log("=== A3. NEGATION — the regression that caused the leak ===");
{
  // These ALL matched the old intent regexes and set explicit*=true,
  // which DISABLED the strip. Each must now classify as excluded.
  const negated = [
    ["don't plan any lunches", "lunch"],
    ["we don't need lunch this trip", "lunch"],
    ["lunch is not included in the plan", "lunch"],
    ["no lunch please", "lunch"],
    ["skip lunch", "lunch"],
    ["skip breakfast", "breakfast"],
    ["without lunch", "lunch"],
    ["exclude breakfast and brunch", "breakfast"],
    ["never book breakfast", "breakfast"],
    ["we don’t need lunch", "lunch"],          // curly apostrophe
    ["lunches aren't needed", "lunch"],        // post-posed copula negation
  ];
  for (const [phrase, meal] of negated) {
    const got = classifyMealPolicy({ narrative: phrase });
    assert(`REGRESSION: "${phrase}" → ${meal} excluded (NOT included)`,
      got[meal] === "excluded", JSON.stringify(got));
  }

  const r = classifyMealPolicy({ narrative: "don't plan any lunches" });
  assert("negated mention records a negated: reason",
    r.reasons.lunch.some((x) => x.startsWith("negated:")), JSON.stringify(r.reasons));
}

console.log("=== A4. NEGATION — must not over-reach ===");
{
  // Clause boundary: a negator in a PREVIOUS sentence is about a different
  // subject and must not leak forward onto the meal word.
  const r = classifyMealPolicy({
    narrative: "We don't want a rental car. Book lunch at Atardi.",
  });
  assert("negator in a previous sentence does NOT negate the ask",
    r.lunch === "included", JSON.stringify(r));

  // Beyond the 8-token window, in the same clause.
  const far = classifyMealPolicy({
    narrative: "no rental car and we are otherwise flexible about most things but book lunch",
  });
  assert("negator beyond the 8-token window does NOT negate",
    far.lunch === "included", JSON.stringify(far));

  // A trailing contrast clause must not read as negating the meal itself.
  const contrast = classifyMealPolicy({ narrative: "lunch at Atardi, not the hotel" });
  assert("'lunch at Atardi, not the hotel' → still included",
    contrast.lunch === "included", JSON.stringify(contrast));
}

console.log("=== B. classifyMealPolicy — chips (the chip-trap bug) ===");
{
  // The old detector never read restaurants[]. These chips were sent to
  // the model as an explicit ask and then silently stripped — the user got
  // the opposite of what they clicked.
  const lunchChip = classifyMealPolicy({ restaurants: ["Casual lunch"] });
  assert("CHIP-TRAP: restaurants:['Casual lunch'] → lunch included",
    lunchChip.lunch === "included", JSON.stringify(lunchChip));
  assert("… with a chip: reason naming the label",
    lunchChip.reasons.lunch.includes("chip:Casual lunch"), JSON.stringify(lunchChip.reasons));

  const bfChip = classifyMealPolicy({ restaurants: ["Cafe / breakfast"] });
  assert("CHIP-TRAP: restaurants:['Cafe / breakfast'] → breakfast included",
    bfChip.breakfast === "included", JSON.stringify(bfChip));
  assert("… chip reason recorded",
    bfChip.reasons.breakfast.includes("chip:Cafe / breakfast"));

  const brunchChip = classifyMealPolicy({ restaurants: ["Brunch spot"] });
  assert("CHIP-TRAP: restaurants:['Brunch spot'] → breakfast included",
    brunchChip.breakfast === "included", JSON.stringify(brunchChip));

  const unrelated = classifyMealPolicy({ restaurants: ["Steakhouse", "Wine bar"] });
  assert("unrelated chips → no meal opinion",
    unrelated.breakfast === "unspecified" && unrelated.lunch === "unspecified",
    JSON.stringify(unrelated));

  const bfChipOnly = classifyMealPolicy({ restaurants: ["Cafe / breakfast"] });
  assert("breakfast chip does not leak into lunch",
    bfChipOnly.lunch === "unspecified");
}

console.log("=== B2. classifyMealPolicy — dining object (the [object Object] bug) ===");
{
  // Old code did `${inputs?.dining}` on an object → "[object Object]",
  // so dining preferences contributed literally nothing.
  const brunchCuisine = classifyMealPolicy({ dining: { cuisine: "brunch, coffee", budget: [] } });
  assert("OBJECT-BUG: dining.cuisine 'brunch, coffee' → breakfast included",
    brunchCuisine.breakfast === "included", JSON.stringify(brunchCuisine));
  assert("… recorded as a prose: reason",
    brunchCuisine.reasons.breakfast.some((x) => x.startsWith("prose:")));

  const emptyDining = classifyMealPolicy({ dining: { cuisine: "", budget: [] } });
  assert("OBJECT-BUG: empty dining object → no opinion (no '[object Object]' match)",
    emptyDining.breakfast === "unspecified" && emptyDining.lunch === "unspecified",
    JSON.stringify(emptyDining));

  const budgetArray = classifyMealPolicy({ dining: { cuisine: "seafood", budget: ["$$", "$$$"] } });
  assert("dining.budget array is parsed without throwing and adds no meal signal",
    budgetArray.breakfast === "unspecified" && budgetArray.lunch === "unspecified");

  const legacyString = classifyMealPolicy({ dining: "lunch focused" });
  assert("legacy string dining still read (defensive)",
    legacyString.lunch === "included", JSON.stringify(legacyString));
}

console.log("=== B3. classifyMealPolicy — precedence: included beats excluded ===");
{
  const mixed = classifyMealPolicy({
    narrative: "skip lunch",
    restaurants: ["Casual lunch"],
  });
  assert("chip included + narrative 'skip lunch' → INCLUDED wins",
    mixed.lunch === "included", JSON.stringify(mixed));
  assert("… both reasons recorded so the disagreement is visible",
    mixed.reasons.lunch.some((x) => x.startsWith("chip:")) &&
    mixed.reasons.lunch.some((x) => x.startsWith("negated:")),
    JSON.stringify(mixed.reasons));

  const mixed2 = classifyMealPolicy({
    narrative: "no breakfast normally, but book breakfast at Tia Sophia's on Day 2",
  });
  assert("prose exclusion + prose ask → included wins",
    mixed2.breakfast === "included", JSON.stringify(mixed2));
}

console.log("=== C. renderMealPolicyPromptRule — one per output shape ===");
{
  const both = renderMealPolicyPromptRule({ breakfast: "included", lunch: "included" });
  assert("both included → requests BREAKFAST and LUNCH",
    both.includes("explicitly requested BREAKFAST and LUNCH"), both);

  const bfOnly = renderMealPolicyPromptRule({ breakfast: "included", lunch: "unspecified" });
  assert("breakfast only → emit breakfast, forbid lunch",
    bfOnly.includes("explicitly requested BREAKFAST") && bfOnly.includes("Do NOT emit Lunch items"),
    bfOnly);

  const lunchOnly = renderMealPolicyPromptRule({ breakfast: "unspecified", lunch: "included" });
  assert("lunch only → emit lunch, forbid breakfast/brunch",
    lunchOnly.includes("explicitly requested LUNCH") && lunchOnly.includes("Do NOT emit Breakfast or Brunch"),
    lunchOnly);

  const neither = renderMealPolicyPromptRule({ breakfast: "unspecified", lunch: "unspecified" });
  assert("neither → blanket DO NOT emit",
    neither.includes("has NOT requested Breakfast or Lunch") &&
    neither.includes("DO NOT emit any Breakfast, Brunch, or Lunch items"),
    neither);

  const excluded = renderMealPolicyPromptRule({ breakfast: "excluded", lunch: "excluded" });
  assert("explicitly excluded renders the same blanket rule as unspecified",
    excluded === neither);

  assert("always tagged as the per-trip section",
    both.includes("MEAL POLICY (per-trip):") && neither.includes("MEAL POLICY (per-trip):"));
  assert("leads with a blank-line separator for preamble concatenation",
    neither.startsWith("\n\n"));
  assert("never returns null (unlike renderActivityCountPromptRule)",
    typeof renderMealPolicyPromptRule(null) === "string");

  // The hardcoded per-user assertion removed from staticRules must not
  // reappear here.
  assert("no hardcoded 'traveler has explicitly added LUNCH to the meal-exclusion list'",
    !neither.includes("meal-exclusion list") && !both.includes("meal-exclusion list"));
}

console.log("=== D. mealPolicyAllowsBreakfast / mealPolicyAllowsLunch ===");
{
  assert("allowsBreakfast true only for 'included'",
    mealPolicyAllowsBreakfast({ breakfast: "included" }) === true &&
    mealPolicyAllowsBreakfast({ breakfast: "excluded" }) === false &&
    mealPolicyAllowsBreakfast({ breakfast: "unspecified" }) === false);
  assert("allowsLunch true only for 'included'",
    mealPolicyAllowsLunch({ lunch: "included" }) === true &&
    mealPolicyAllowsLunch({ lunch: "excluded" }) === false &&
    mealPolicyAllowsLunch({ lunch: "unspecified" }) === false);
  assert("null-safe",
    mealPolicyAllowsBreakfast(null) === false && mealPolicyAllowsLunch(undefined) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
