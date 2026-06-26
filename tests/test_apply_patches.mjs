// Unit tests for applyPatchesToPlan — extracted via regex from App.jsx since
// it's not exported. Same pattern as test_booking_helpers.mjs.

import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf-8");

// Find the function (greedy through its closing brace at the end of the
// recursive walk). The function ends with a `return { plan: next, appliedCount, skipped, ... };\n}`.
const match = src.match(/function applyPatchesToPlan\(plan, patches\) \{[\s\S]*?return \{ plan: next, appliedCount, skipped, appliedFindingIds: Array\.from\(appliedFindingIds\) \};\n\}/);
if (!match) throw new Error("applyPatchesToPlan not found");
// eslint-disable-next-line no-eval
eval(`${match[0]}; globalThis.applyPatchesToPlan = applyPatchesToPlan;`);
const { applyPatchesToPlan } = globalThis;

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

const samplePlan = () => ({
  destination: "Test",
  days: [
    { items: [{ type: "Activity", name: "Walking tour" }, { type: "Dinner", name: "Geronimo" }] },
    { items: [{ type: "Activity", name: "Museum" }] },
  ],
  planb: ["Original plan b"],
  flags: [],
  tonight: [],
});

console.log("\n[1] Happy path — replace_item applies");
{
  const plan = samplePlan();
  const { plan: next, appliedCount, skipped } = applyPatchesToPlan(plan, [
    { op: "replace_item", day_index: 0, item_index: 1, new_item: { type: "Dinner", name: "Coyote Cafe" }, rationale: "x" },
  ]);
  assert("appliedCount = 1", appliedCount === 1);
  assert("skipped empty", skipped.length === 0);
  assert("item replaced", next.days[0].items[1].name === "Coyote Cafe");
  assert("original untouched", plan.days[0].items[1].name === "Geronimo");
}

console.log("\n[2] Out-of-range day_index — patch silently skipped, appliedCount tracks it");
{
  const plan = samplePlan();
  const { plan: next, appliedCount, skipped } = applyPatchesToPlan(plan, [
    { op: "replace_item", day_index: 99, item_index: 0, new_item: { type: "Activity", name: "X" }, rationale: "x" },
  ]);
  assert("appliedCount = 0", appliedCount === 0);
  assert("skipped reason recorded", skipped[0]?.includes("out-of-range") && skipped[0]?.includes("day=99"));
  // Plan should be unchanged
  assert("plan unchanged", JSON.stringify(next.days) === JSON.stringify(plan.days));
}

console.log("\n[3] Out-of-range item_index");
{
  const { appliedCount, skipped } = applyPatchesToPlan(samplePlan(), [
    { op: "replace_item", day_index: 0, item_index: 99, new_item: { type: "Activity", name: "X" }, rationale: "x" },
  ]);
  assert("appliedCount = 0", appliedCount === 0);
  assert("skipped reason recorded", skipped[0]?.includes("out-of-range") && skipped[0]?.includes("item=99"));
}

console.log("\n[4] Mixed — 2 applied, 1 skipped");
{
  const plan = samplePlan();
  const { appliedCount, skipped, plan: next } = applyPatchesToPlan(plan, [
    { op: "replace_item", day_index: 0, item_index: 0, new_item: { type: "Activity", name: "Hike" }, rationale: "x" },
    { op: "replace_item", day_index: 99, item_index: 0, new_item: { type: "Activity", name: "Bad" }, rationale: "x" },
    { op: "add_flag", new_text: "Closed Mondays", rationale: "x" },
  ]);
  assert("appliedCount = 2", appliedCount === 2, `got ${appliedCount}`);
  assert("1 skipped", skipped.length === 1);
  assert("flag added", next.flags.includes("Closed Mondays"));
  assert("item replaced", next.days[0].items[0].name === "Hike");
}

console.log("\n[5] replace_hotel — appends when no hotel exists");
{
  const { appliedCount, plan: next } = applyPatchesToPlan(samplePlan(), [
    { op: "replace_hotel", day_index: 0, new_item: { name: "Ritz" }, rationale: "x" },
  ]);
  assert("appliedCount = 1", appliedCount === 1);
  assert("hotel appended with type Hotel", next.days[0].items.some(i => i.type === "Hotel" && i.name === "Ritz"));
}

console.log("\n[6] Missing op");
{
  const { appliedCount, skipped } = applyPatchesToPlan(samplePlan(), [{ rationale: "no op" }]);
  assert("appliedCount = 0", appliedCount === 0);
  assert("skip recorded as missing-op", skipped[0] === "missing-op");
}

console.log("\n[7] Unrecognised op");
{
  const { appliedCount, skipped } = applyPatchesToPlan(samplePlan(), [{ op: "delete_item", day_index: 0, item_index: 0, rationale: "x" }]);
  assert("appliedCount = 0", appliedCount === 0);
  assert("skip mentions unrecognised", skipped[0]?.includes("unrecognised"));
}

console.log("\n[8] Empty patches array");
{
  const { appliedCount, skipped, plan: next } = applyPatchesToPlan(samplePlan(), []);
  assert("appliedCount = 0", appliedCount === 0);
  assert("skipped empty", skipped.length === 0);
  assert("plan still returned", next && Array.isArray(next.days));
}

console.log("\n[9] Null/invalid inputs");
{
  const r1 = applyPatchesToPlan(null, []);
  assert("null plan returns object with appliedCount 0", r1.appliedCount === 0);
  const r2 = applyPatchesToPlan(samplePlan(), null);
  assert("null patches returns object with appliedCount 0", r2.appliedCount === 0);
}

console.log("\n[10] replace_planb_entry happy + out-of-range");
{
  const { appliedCount, plan: next } = applyPatchesToPlan(samplePlan(), [
    { op: "replace_planb_entry", planb_index: 0, new_text: "New plan b", rationale: "x" },
  ]);
  assert("appliedCount = 1", appliedCount === 1);
  assert("planb replaced", next.planb[0] === "New plan b");

  const { appliedCount: c2, skipped: s2 } = applyPatchesToPlan(samplePlan(), [
    { op: "replace_planb_entry", planb_index: 5, new_text: "X", rationale: "x" },
  ]);
  assert("out-of-range planb skipped", c2 === 0 && s2[0]?.includes("out-of-range"));
}

console.log("\n[11] appliedFindingIds — records finding_id only for patches that applied");
{
  const { appliedCount, skipped, appliedFindingIds } = applyPatchesToPlan(samplePlan(), [
    { op: "replace_item", finding_id: "f1", day_index: 0, item_index: 0, new_item: { type: "Activity", name: "Hike" }, rationale: "x" },
    { op: "replace_item", finding_id: "f2", day_index: 99, item_index: 0, new_item: { type: "Activity", name: "Bad" }, rationale: "x" },
  ]);
  assert("appliedCount = 1", appliedCount === 1, `got ${appliedCount}`);
  assert("skipped non-empty", skipped.length === 1);
  assert("only f1 recorded as applied", appliedFindingIds.length === 1 && appliedFindingIds[0] === "f1");
  assert("f2 NOT recorded as applied", !appliedFindingIds.includes("f2"));
}

console.log("\n[12] appliedFindingIds — empty when patches carry no finding_id");
{
  const { appliedCount, appliedFindingIds } = applyPatchesToPlan(samplePlan(), [
    { op: "add_flag", new_text: "Closed Mondays", rationale: "x" },
  ]);
  assert("appliedCount = 1", appliedCount === 1);
  assert("no finding ids recorded", appliedFindingIds.length === 0);
}

console.log("\n[13] Honesty logic — partial batch must not mark the unsupported finding as applied");
{
  // Simulates the handleApply attribution: a batch with one applicable op and
  // one unsupported op. Only the finding whose patch landed may be recorded.
  const selected = [{ id: "f1" }, { id: "f2" }];
  const { appliedCount, skipped, appliedFindingIds } = applyPatchesToPlan(samplePlan(), [
    { op: "replace_item", finding_id: "f1", day_index: 0, item_index: 1, new_item: { type: "Dinner", name: "Coyote Cafe" }, rationale: "x" },
    { op: "delete_item", finding_id: "f2", day_index: 0, item_index: 0, rationale: "x" },
  ]);
  assert("appliedCount = 1", appliedCount === 1, `got ${appliedCount}`);
  assert("skipped non-empty", skipped.length >= 1);
  const appliedSet = new Set(appliedFindingIds);
  const appliedFindings = selected.filter(f => appliedSet.has(f.id));
  const unappliedFindings = selected.filter(f => !appliedSet.has(f.id));
  assert("f1 marked applied", appliedFindings.length === 1 && appliedFindings[0].id === "f1");
  assert("f2 left un-applied", unappliedFindings.length === 1 && unappliedFindings[0].id === "f2");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
