// Tests for src/activityCountConstraint.js. Locks in the recurrence
// guard for the activity-count "one per day" bug reported by user
// 2026-06-30 PM (SF build interpreted "one activity during the entire
// itinerary" as "one per day").
//
// Three areas:
//   A. classifyActivityCountConstraint — does it catch the phrasings
//      the prompt rule misses?
//   B. renderActivityCountPromptRule — does it render the hard cap text?
//   C. enforceTripTotalActivityCap — does it correctly trim when the
//      model overshoots?

import {
  classifyActivityCountConstraint,
  renderActivityCountPromptRule,
  countActivities,
  enforceTripTotalActivityCap,
} from "../src/activityCountConstraint.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== A. classifyActivityCountConstraint — trip-total phrasings ===");
{
  // The user's actual reported phrasing.
  const r = classifyActivityCountConstraint({
    narrative: "I want only one activity during the entire itinerary, keep it relaxed",
  });
  assert("RECURRENCE: 'one activity during the entire itinerary' → trip-total count=1",
    r.scope === "trip-total" && r.count === 1);

  // Variants of the same intent.
  const variants = [
    ["I want 2 activities total for the trip", 2],
    ["just 3 things total", 3],
    ["only 2 activities the whole stay", 2],
    ["keep it to 4 activities across the week", 4],
    ["2 activities total", 2],
    ["only 2 activities for the trip", 2],
    ["3 activities across the entire vacation", 3],
    ["just two outings for the whole trip", 2],
    ["one excursion in the entire itinerary", 1],
    ["five activities total for the week", 5],
    ["no more than 3 activities", 3],
    ["at most 4 activities", 4],
    ["one stop during the trip", 1],
    ["just one thing for the trip", 1],
    ["only one activity for the entire vacation", 1],
    ["3 total activities", 3],
  ];
  for (const [phrase, expected] of variants) {
    const result = classifyActivityCountConstraint({ narrative: phrase });
    assert(`trip-total: "${phrase}" → count=${expected}`,
      result.scope === "trip-total" && result.count === expected,
      `got ${JSON.stringify(result)}`);
  }
}

console.log("=== A2. classifyActivityCountConstraint — day-scoped phrasings ===");
{
  // Day-scoped phrasings should be classified as day-scoped (NOT
  // trip-total) so the trip-total cap doesn't fire on them.
  const dayScoped = [
    ["one activity on Day 3", 1],
    ["just one thing on Tuesday", 1],
    ["2 activities on Day 4", 2],
    ["only 1 activity on Wednesday", 1],
  ];
  for (const [phrase, expected] of dayScoped) {
    const r = classifyActivityCountConstraint({ narrative: phrase });
    assert(`day-scoped: "${phrase}" → scope=day-scoped count=${expected}`,
      r.scope === "day-scoped" && r.count === expected,
      `got ${JSON.stringify(r)}`);
  }
}

console.log("=== A3. classifyActivityCountConstraint — no match ===");
{
  const nones = [
    "A relaxed week in Santa Fe with good food",
    "I want to see the museums",
    "",
    "Beach mornings, dinner reservations every night",
  ];
  for (const phrase of nones) {
    const r = classifyActivityCountConstraint({ narrative: phrase });
    assert(`no constraint: "${phrase.slice(0, 40)}..." → scope=none`,
      r.scope === "none",
      `got ${JSON.stringify(r)}`);
  }
}

console.log("=== A4. classifyActivityCountConstraint — guidelines blob too ===");
{
  const r = classifyActivityCountConstraint({
    narrative: "Relaxed trip",
    guidelines: "Only 2 activities for the whole trip please",
  });
  assert("guidelines field also scanned → trip-total count=2",
    r.scope === "trip-total" && r.count === 2);
}

console.log("=== A5. classifyActivityCountConstraint — defensive ===");
{
  assert("null inputs → none", classifyActivityCountConstraint(null).scope === "none");
  assert("empty object → none", classifyActivityCountConstraint({}).scope === "none");
  assert("non-object → none", classifyActivityCountConstraint("string").scope === "none");
}

console.log("=== B. renderActivityCountPromptRule — text output ===");
{
  const rule = renderActivityCountPromptRule({ scope: "trip-total", count: 1, matchedPhrase: "one activity during the entire itinerary" });
  assert("renders 'ACTIVITY-COUNT HARD CAP' header",
    rule.includes("ACTIVITY-COUNT HARD CAP"));
  assert("renders exact count in the rule",
    rule.includes("exactly 1 activity item"));
  assert("renders the matched phrase as evidence",
    rule.includes("one activity during the entire itinerary"));

  const nullRule = renderActivityCountPromptRule({ scope: "day-scoped", count: 1 });
  assert("day-scoped constraint → null (no rule injected)",
    nullRule === null);

  const noneRule = renderActivityCountPromptRule({ scope: "none" });
  assert("none constraint → null",
    noneRule === null);
}

console.log("=== C. countActivities ===");
{
  const days = [
    { label: "Mon", items: [{ type: "Flight" }, { type: "Hotel" }, { type: "Activity" }, { type: "Activity" }] },
    { label: "Tue", items: [{ type: "Activity" }, { type: "Restaurant" }] },
    { label: "Wed", items: [{ type: "Restaurant" }, { type: "Restaurant" }] },
  ];
  const r = countActivities(days);
  assert("total = 3 (2 + 1 + 0)",
    r.total === 3);
  assert("per-day counts in order",
    r.perDay[0].count === 2 && r.perDay[1].count === 1 && r.perDay[2].count === 0);

  assert("malformed input → total 0, perDay empty",
    countActivities(null).total === 0 && countActivities(null).perDay.length === 0);
}

console.log("=== D. enforceTripTotalActivityCap — trimming ===");
{
  // User asked for 1 total; model emitted 4 (one per day across 4 days).
  // The cap should trim 3 of them, leaving exactly 1.
  const days = [
    { label: "Mon", items: [{ type: "Flight" }, { type: "Hotel" }, { type: "Activity", activity: { name: "Museum" } }] },
    { label: "Tue", items: [{ type: "Activity", activity: { name: "Walking tour" } }, { type: "Restaurant" }] },
    { label: "Wed", items: [{ type: "Activity", activity: { name: "Spa" } }, { type: "Restaurant" }] },
    { label: "Thu", items: [{ type: "Activity", activity: { name: "Shopping" } }, { type: "Flight" }] },
  ];
  const r = enforceTripTotalActivityCap(days, 1);
  const after = countActivities(r.days);
  assert("trimming brings total to exactly 1",
    after.total === 1);
  assert("fixes log has 3 trim entries",
    r.fixes.length === 3);
  assert("original days array NOT mutated",
    days[0].items.length === 3 && days[1].items.length === 2);
}

console.log("=== D2. enforceTripTotalActivityCap — already within cap ===");
{
  const days = [
    { label: "Mon", items: [{ type: "Activity" }] },
  ];
  const r = enforceTripTotalActivityCap(days, 3);
  assert("under-cap → no trimming",
    r.fixes.length === 0 && countActivities(r.days).total === 1);
}

console.log("=== D3. enforceTripTotalActivityCap — exactly at cap ===");
{
  const days = [
    { label: "Mon", items: [{ type: "Activity" }, { type: "Activity" }, { type: "Activity" }] },
  ];
  const r = enforceTripTotalActivityCap(days, 3);
  assert("at-cap → no trimming",
    r.fixes.length === 0 && countActivities(r.days).total === 3);
}

console.log("=== D4. enforceTripTotalActivityCap — uneven distribution levels out ===");
{
  // Day 1 has 4 activities, Day 2 has 1. Cap = 2 → trim 3 from Day 1
  // (the heavy day) until total = 2.
  const days = [
    { label: "Mon", items: [
      { type: "Activity", activity: { name: "A1" } },
      { type: "Activity", activity: { name: "A2" } },
      { type: "Activity", activity: { name: "A3" } },
      { type: "Activity", activity: { name: "A4" } },
    ]},
    { label: "Tue", items: [
      { type: "Activity", activity: { name: "B1" } },
    ]},
  ];
  const r = enforceTripTotalActivityCap(days, 2);
  const counts = countActivities(r.days);
  assert("total = 2",
    counts.total === 2);
  // Levels-out heuristic: trim from heaviest first → Day 1 from 4→3→2→1, Day 2 stays at 1.
  assert("Day 1 trimmed from 4 to 1",
    counts.perDay[0].count === 1);
  assert("Day 2 untouched at 1",
    counts.perDay[1].count === 1);
}

console.log("=== D5. enforceTripTotalActivityCap — defensive ===");
{
  assert("non-array days → unchanged",
    enforceTripTotalActivityCap(null, 1).days === null);
  assert("negative cap → unchanged",
    enforceTripTotalActivityCap([{ items: [{ type: "Activity" }] }], -1).fixes.length === 0);
}

console.log("=== RECURRENCE GUARD — exact user scenario ===");
{
  // The exact bug case: user wrote the SF narrative with "one activity
  // during the entire itinerary", model returned (e.g.) 4 activities
  // (one per day across 4 days). Pipeline must: classify as trip-total
  // count=1, render the prompt rule, and trim to 1 in post-build.
  const inputs = {
    narrative: "Planning a relaxed SF weekend. I want only one activity during the entire itinerary — no rush.",
  };
  const constraint = classifyActivityCountConstraint(inputs);
  assert("classifier catches user's exact phrasing",
    constraint.scope === "trip-total" && constraint.count === 1);

  const rule = renderActivityCountPromptRule(constraint);
  assert("prompt rule is rendered (model gets a hard cap)",
    rule && rule.includes("exactly 1 activity item"));

  // Simulate the model ignoring the rule and giving one per day anyway.
  const modelOutput = [
    { label: "Mon", items: [{ type: "Flight" }, { type: "Hotel" }, { type: "Activity", activity: { name: "Golden Gate" } }] },
    { label: "Tue", items: [{ type: "Activity", activity: { name: "Alcatraz" } }, { type: "Restaurant" }] },
    { label: "Wed", items: [{ type: "Activity", activity: { name: "Muir Woods" } }, { type: "Restaurant" }] },
    { label: "Thu", items: [{ type: "Activity", activity: { name: "Shopping" } }, { type: "Flight" }] },
  ];
  const enforced = enforceTripTotalActivityCap(modelOutput, constraint.count);
  const finalCount = countActivities(enforced.days).total;
  assert("RECURRENCE GUARD: model returned 4 activities, post-build trims to 1",
    finalCount === 1);
  assert("RECURRENCE GUARD: 3 trim entries in fixes log",
    enforced.fixes.length === 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
