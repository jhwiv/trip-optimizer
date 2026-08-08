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

// The two revision prompts, evaluated for real rather than asserted against
// source text — their pure dependencies come along so the strings under test
// are the ones the model actually receives.
const surgicalSrc = extract(/function buildRevisionSystemPromptSurgical\(plan, findings, inputs\) \{[\s\S]*?\n\}/, "buildRevisionSystemPromptSurgical");
const fullSrc = extract(/function buildRevisionSystemPromptFull\(plan, findings, inputs\) \{[\s\S]*?\n\}/, "buildRevisionSystemPromptFull");

// eslint-disable-next-line no-eval
eval(`${maxCharsSrc}
${contextSrc.replace("export ", "")}
${extract(/function prefToText\(v\) \{[\s\S]*?\n\}/, "prefToText")}
${extract(/function formatFindingTarget\(t\) \{[\s\S]*?\n\}/, "formatFindingTarget")}
${extract(/function planForPrompt\(plan\) \{[\s\S]*?\n\}/, "planForPrompt")}
${surgicalSrc}
${fullSrc}
globalThis.__rev = { buildRevisionSystemPromptSurgical, buildRevisionSystemPromptFull };`);
const { buildRevisionSystemPromptSurgical, buildRevisionSystemPromptFull } = globalThis.__rev;

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

console.log("\n[7] The revision prompts carry BOTH fields too");
{
  // Both revisers had the same `guidelines || narrative` bug the reviewer had.
  // They matter more, not less: the reviewer only proposes, these two write the
  // plan the user ends up with — a dropped constraint here ships.
  const plan = { destination: "Porto", days: [{ label: "Day 1", items: [] }] };
  const findings = [{ id: "f1", severity: "critical", mode_hint: "swap_restaurant", target: { day: 1 }, summary: "s", action: "a" }];
  const build = (inputs) => ({
    surgical: buildRevisionSystemPromptSurgical(plan, findings, inputs),
    full: buildRevisionSystemPromptFull(plan, findings, inputs),
  });
  const both = build({ guidelines: "AAA-guidelines", narrative: "BBB-narrative" });

  for (const [which, out] of Object.entries(both)) {
    assert(`${which}: guidelines present`, out.includes("AAA-guidelines"));
    assert(`${which}: narrative present`, out.includes("BBB-narrative"));
    assert(`${which}: each in its own labelled block`,
      out.includes("TRIP GUIDELINES") && out.includes("TRAVELER NARRATIVE"));
    assert(`${which}: the hard-constraint framing the rules below reference survives`,
      out.includes("USER'S EXPLICIT GUIDELINES (hard constraints — do not violate)"));
  }

  const gOnly = build({ guidelines: "only-guidelines" });
  assert("surgical: guidelines-only trip", gOnly.surgical.includes("only-guidelines") && !gOnly.surgical.includes("TRAVELER NARRATIVE"));
  assert("full: guidelines-only trip", gOnly.full.includes("only-guidelines") && !gOnly.full.includes("TRAVELER NARRATIVE"));

  const nOnly = build({ narrative: "only-narrative" });
  assert("surgical: narrative-only trip", nOnly.surgical.includes("only-narrative") && !nOnly.surgical.includes("TRIP GUIDELINES"));
  assert("full: narrative-only trip", nOnly.full.includes("only-narrative") && !nOnly.full.includes("TRIP GUIDELINES"));

  const none = build({});
  assert("neither → no empty guidelines heading in either prompt",
    !none.surgical.includes("USER'S EXPLICIT GUIDELINES") && !none.full.includes("USER'S EXPLICIT GUIDELINES"));

  // Oversized input truncates honestly, and the per-caller caps are preserved:
  // surgical stays tighter than full because it only rewrites one card.
  const long = build({ guidelines: "short-g", narrative: "n".repeat(10000) });
  for (const [which, out] of Object.entries(long)) {
    assert(`${which}: short field survives whole`, out.includes("short-g"));
    assert(`${which}: long field is truncated, and says so`,
      /truncated — \d+ of 10000 characters shown/.test(out));
  }
  const shown = (s) => Number(s.match(/truncated — (\d+) of/)[1]);
  assert("surgical keeps its 2000-char budget", shown(long.surgical) === 2000 - "short-g".length, String(shown(long.surgical)));
  assert("full keeps its larger 3000-char budget", shown(long.full) === 3000 - "short-g".length, String(shown(long.full)));
  assert("surgical is the tighter of the two", shown(long.surgical) < shown(long.full));

  // And the bug itself cannot come back in either function.
  for (const [which, fnSrc] of Object.entries({ surgical: surgicalSrc, full: fullSrc })) {
    assert(`${which}: the dropping || is gone`,
      !/inputs\?\.guidelines \|\| inputs\?\.narrative/.test(fnSrc));
    assert(`${which}: routes through the shared helper`,
      /renderUserContextBlock\(inputs, \d+\)/.test(fnSrc));
  }
}

// -----------------------------------------------------------------------------
// applyModeChoice default (2026-08-08 regression, CLAUDE.md "KNOWN FAILURE
// MODE #15"). autoReview = !initialReview re-runs the review from scratch on
// every reopen where it hasn't yet persisted a "done" state — with "auto" as
// the silent default apply mode, a user reopening the app mid-cycle
// retriggered a fresh review AND a fresh, unconfirmed, real ~2min full-plan
// revision apply, repeatedly.
//
// SAME-DAY FOLLOW-UP: the first version of this fix (default flips to
// approve_each) didn't help a trip that already went through a review cycle
// BEFORE the fix shipped — its persisted apply_mode_choice was already
// "auto" from the OLD silent default, and reading that back as "the user's
// explicit choice" kept the bug alive for every such trip. Reported live:
// "We had this before. Why is it back." Fixed with a companion
// apply_mode_explicit flag, set ONLY when the toggle is actually clicked —
// old persisted data has no such field, so it's always falsy for a
// pre-existing trip regardless of what apply_mode_choice says.
//
// The useState initializers aren't independently callable (inline in a
// component), so — following this file's own established convention for
// JSX-embedded logic that can't be evaluated standalone — this asserts
// against the source text directly.
// -----------------------------------------------------------------------------
{
  const explicitInitSrc = extract(
    /const \[applyModeExplicit, setApplyModeExplicit\] = useState\([^)]*\);/,
    "applyModeExplicit useState initializer",
  );
  assert("applyModeExplicit starts false unless the PRIOR session recorded it explicitly",
    /!!initialReview\?\.apply_mode_explicit/.test(explicitInitSrc), explicitInitSrc);

  const initSrc = extract(
    /const \[applyModeChoice, setApplyModeChoice\] = useState\(\s*[\s\S]*?\);/,
    "applyModeChoice useState initializer",
  );
  assert("auto is only honored when BOTH apply_mode_explicit AND apply_mode_choice === auto",
    /\(initialReview\?\.apply_mode_explicit && initialReview\?\.apply_mode_choice === "auto"\) \? "auto" : "approve_each"/.test(initSrc),
    initSrc);

  // A persisted "auto" with no explicit flag (every trip built before this
  // fix, or any tampered/legacy data) must NOT be honored — this is the
  // exact gap the "why is it back" report found.
  const resolveApplyModeChoice = (explicit, savedChoice) =>
    (explicit && savedChoice === "auto") ? "auto" : "approve_each";
  assert("a saved trip that explicitly chose auto (flag set) keeps auto",
    resolveApplyModeChoice(true, "auto") === "auto");
  assert("a saved trip that explicitly chose approve_each (flag set) keeps it",
    resolveApplyModeChoice(true, "approve_each") === "approve_each");
  assert("a fresh session with no prior choice at all defaults to approve_each",
    resolveApplyModeChoice(false, undefined) === "approve_each");
  assert("(the actual bug) a PRE-EXISTING trip with apply_mode_choice=\"auto\" but NO explicit flag no longer gets auto",
    resolveApplyModeChoice(false, "auto") === "approve_each");

  // The toggle's onClick must set the explicit flag, not just the choice —
  // otherwise a fresh in-session click wouldn't distinguish itself from old
  // leaked-in data either.
  const toggleSrc = extract(
    /onClick=\{\(\) => \{ setApplyModeChoice\(opt\.id\); setApplyModeExplicit\(true\); \}\}/,
    "apply-mode toggle onClick",
  );
  assert("the toggle's onClick sets applyModeExplicit(true) alongside the choice",
    /setApplyModeExplicit\(true\)/.test(toggleSrc));

  // Both onReviewChange payloads (fresh review, and after an apply) must
  // persist the explicit flag alongside the choice, or a genuine opt-in
  // wouldn't survive a reload either.
  const persistCount = (src.match(/apply_mode_choice: applyModeChoice,\s*\n\s*apply_mode_explicit: applyModeExplicit,/g) || []).length;
  assert("both onReviewChange call sites persist apply_mode_explicit alongside apply_mode_choice",
    persistCount === 2, String(persistCount));

  // The auto-apply effect's own gate must still correctly require "auto" —
  // this fix works by changing what a user gets WITHOUT choosing, not by
  // touching the effect's trigger condition itself.
  const autoApplySrc = extract(
    /useEffect\(\(\) => \{\s*if \(applyModeChoice !== "auto"\) return;[\s\S]*?\}, \[applyModeChoice, status, review, appliedIds\.length\]\);/,
    "auto-apply effect",
  );
  assert("the auto-apply effect still gates on applyModeChoice === \"auto\"",
    /if \(applyModeChoice !== "auto"\) return;/.test(autoApplySrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
