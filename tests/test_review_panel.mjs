// Tests for the reviewer surface: the header counters, the plan the reviewer
// is handed, and the free-form user context embedded in its prompt.
//
// pendingFindings and renderUserContextBlock live in App.jsx, which can't be
// imported from a DOM-free Node test — extracted via regex + eval, the same
// pattern as tests/test_apply_patches.mjs. The two JSX/wiring facts that can't
// be evaluated (which plan prop ReviewPanel receives, which helper the prompt
// calls) are asserted against the source text instead.

import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf-8");

function extract(re, name) {
  const m = src.match(re);
  if (!m) throw new Error(`${name} not found in App.jsx`);
  return m[0];
}

const maxCharsSrc = extract(/const MAX_REVIEWER_PROMPT_CHARS = \d+;/, "MAX_REVIEWER_PROMPT_CHARS");
const pendingSrc = extract(/export function pendingFindings\(findings, appliedIds\) \{[\s\S]*?\n\}/, "pendingFindings");
const contextSrc = extract(/export function renderUserContextBlock\(inputs, maxChars = MAX_REVIEWER_PROMPT_CHARS\) \{[\s\S]*?\n\}/, "renderUserContextBlock");

// eslint-disable-next-line no-eval
eval(`${maxCharsSrc}
${pendingSrc.replace("export ", "")}
${contextSrc.replace("export ", "")}
globalThis.__rp = { MAX_REVIEWER_PROMPT_CHARS, pendingFindings, renderUserContextBlock };`);
const { MAX_REVIEWER_PROMPT_CHARS, pendingFindings, renderUserContextBlock } = globalThis.__rp;

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// The three header counters, exactly as ReviewPanel computes them.
function headerCounts(findings, appliedIds) {
  const applicable = pendingFindings(findings, appliedIds);
  return {
    critical: applicable.filter(f => f.severity === "critical").length,
    suggested: applicable.filter(f => f.severity === "suggested").length,
    nice: applicable.filter(f => f.severity === "nice").length,
  };
}

console.log("\n[1] Header counters count PENDING findings, not all findings");
{
  // The reported shape: the reviewer is told to set default_apply on every
  // critical finding, the auto-apply effect fires them the moment the review
  // lands, and the header still read "3 critical" over a one-item list.
  const findings = [
    { id: "c1", severity: "critical", default_apply: true },
    { id: "c2", severity: "critical", default_apply: true },
    { id: "c3", severity: "critical", default_apply: false },
    { id: "s1", severity: "suggested", default_apply: true },
    { id: "n1", severity: "nice", default_apply: false },
  ];
  const appliedIds = ["c1", "c2", "s1"]; // auto-applied on completion (default_apply)

  const counts = headerCounts(findings, appliedIds);
  assert("1 critical pending, not 3", counts.critical === 1, `got ${counts.critical}`);
  assert("suggested also excludes the applied one", counts.suggested === 0, `got ${counts.suggested}`);
  assert("nice is untouched (never auto-applies)", counts.nice === 1, `got ${counts.nice}`);

  const applicable = pendingFindings(findings, appliedIds);
  assert("header total equals the pending list length",
    counts.critical + counts.suggested + counts.nice === applicable.length);
  assert("pending list holds exactly the un-applied ids",
    applicable.map(f => f.id).join(",") === "c3,n1", applicable.map(f => f.id).join(","));
}

console.log("\n[2] pendingFindings edge cases");
{
  assert("nothing applied → everything pending",
    pendingFindings([{ id: "a" }, { id: "b" }], []).length === 2);
  assert("everything applied → nothing pending",
    pendingFindings([{ id: "a" }, { id: "b" }], ["a", "b"]).length === 0);
  assert("non-array findings → empty", pendingFindings(null, ["a"]).length === 0);
  assert("non-array appliedIds → everything pending",
    pendingFindings([{ id: "a" }], undefined).length === 1);
  assert("null entries are dropped", pendingFindings([null, { id: "a" }], []).length === 1);
}

console.log("\n[3] ReviewPanel receives the post-quality-layer plan");
{
  // Reading rawData showed the reviewer items the quality layer had already
  // deleted, so it spent findings on venues the user would never see.
  const panel = src.match(/<ReviewPanel\n\s+plan=\{(\w+)\}/);
  assert("<ReviewPanel plan={...}> found in the render tree", !!panel, "prop not matched");
  assert("ReviewPanel is handed layeredData, not rawData",
    panel && panel[1] === "layeredData", panel ? panel[1] : "n/a");

  // Reviewer patches are positional (day_index / item_index), so read and
  // write must be the same array — a read-only swap would corrupt the plan.
  const block = src.slice(src.indexOf("<ReviewPanel"), src.indexOf("<ReviewPanel") + 600);
  assert("the same component still writes back through onPlanRevised",
    /onPlanRevised=\{onPlanRevised\}/.test(block));
}

console.log("\n[4] Reviewer prompt carries BOTH guidelines and narrative");
{
  const out = renderUserContextBlock({ guidelines: "AAA-guidelines", narrative: "BBB-narrative" });
  assert("guidelines present", out.includes("AAA-guidelines"), out);
  assert("narrative present", out.includes("BBB-narrative"), out);
  assert("each in its own labelled block, mirroring the build prompt",
    out.includes("TRIP GUIDELINES") && out.includes("TRAVELER NARRATIVE"), out);
  assert("guidelines block comes first, as in the build prompt",
    out.indexOf("TRIP GUIDELINES") < out.indexOf("TRAVELER NARRATIVE"));

  assert("guidelines only → no empty narrative block",
    !renderUserContextBlock({ guidelines: "only" }).includes("TRAVELER NARRATIVE"));
  assert("narrative only → no empty guidelines block",
    !renderUserContextBlock({ narrative: "only" }).includes("TRIP GUIDELINES"));
  assert("neither → empty string, so the prompt gains no blank section",
    renderUserContextBlock({}) === "" && renderUserContextBlock(null) === "");
  assert("whitespace-only fields count as absent",
    renderUserContextBlock({ guidelines: "   ", narrative: "\n\t" }) === "");
}

console.log("\n[5] Truncation is honest, and neither field can starve the other");
{
  assert("cap raised well past the old 3000", MAX_REVIEWER_PROMPT_CHARS === 8000);

  const long = "x".repeat(10000);
  const out = renderUserContextBlock({ guidelines: "short-guideline", narrative: long });
  assert("short field survives whole", out.includes("short-guideline"));
  assert("long field is not dropped", out.includes("xxxx"));
  assert("cut is announced, not silent", /truncated — \d+ of 10000 characters shown/.test(out), out.slice(-200));
  const shown = Number(out.match(/truncated — (\d+) of/)[1]);
  assert("long field still gets a meaningful slice (>7000 chars)", shown > 7000, `got ${shown}`);

  // Both oversized → each gets at least half the budget.
  const both = renderUserContextBlock({ guidelines: "g".repeat(10000), narrative: "n".repeat(10000) });
  const cuts = [...both.matchAll(/truncated — (\d+) of/g)].map(m => Number(m[1]));
  assert("both fields truncated", cuts.length === 2, JSON.stringify(cuts));
  assert("each gets half the budget", cuts.every(c => c === MAX_REVIEWER_PROMPT_CHARS / 2), JSON.stringify(cuts));
  assert("total stays within budget",
    cuts.reduce((a, b) => a + b, 0) <= MAX_REVIEWER_PROMPT_CHARS);

  // Under budget → nothing is announced.
  assert("short inputs are not marked truncated",
    !renderUserContextBlock({ guidelines: "a", narrative: "b" }).includes("truncated"));
}

console.log("\n[6] The reviewer prompt actually calls the helper");
{
  const fn = src.slice(src.indexOf("function buildReviewSystemPrompt"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  assert("buildReviewSystemPrompt uses renderUserContextBlock",
    /const userGuidelinesBlock = renderUserContextBlock\(inputs\);/.test(body));
  assert("the || that dropped one field is gone from the reviewer prompt",
    !/inputs\?\.guidelines \|\| inputs\?\.narrative/.test(body));
  assert("the block is still embedded in the prompt", body.includes("${userGuidelinesBlock}"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
