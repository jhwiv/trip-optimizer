// Tests for feeding applyQualityLayer's qc.warnings into the Expert Review
// prompt (src/App.jsx buildReviewSystemPrompt), so gaps the deterministic
// quality layer already found (a permanently-closed venue kept for
// visibility, a thin day with no anchor experience, a marquee experience
// promised in prose but never scheduled, a missing headline, etc. — see
// tests/test_itinerary_quality_fixes.mjs section 2 for the marquee check
// specifically) get actively escalated by the reviewer instead of sitting
// inert in the QC panel until a human happens to read it.
//
// Prompted by the user asking, after the item.name root-cause fix and its
// peer review: "Can the expert review be tweaked/tooled to ensure it picks
// up these issues?" — first scoped narrowly to just the marquee-coverage
// warning (this file's original version), then generalized here to ALL
// itinerary-content warnings once it became clear the same "detected but
// invisible to the reviewer" pattern applies to every warning
// applyQualityLayer produces, not just the marquee one. Two of the three
// original Sedona findings (duplicate same-day venue) are already resolved
// by applyQualityLayer BEFORE the reviewer ever sees the plan, so there's
// nothing left for the reviewer to catch there — only warn-severity gaps
// (which can't be auto-fixed, only flagged) survive to review time.
//
// buildReviewSystemPrompt is a closure inside src/App.jsx and can't be
// imported directly here (jsdom-free tests) — following the established
// convention, contentWarningsForReview (the pure helper) and the prompt-
// injection shape are mirrored locally and tested against that mirror.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const NON_CONTENT_WARNING_RE = /^Plan (hit the model's token budget|was cut off before finishing)/i;
function contentWarningsForReview(warnings) {
  return (Array.isArray(warnings) ? warnings : []).filter(
    (w) => typeof w === "string" && w && !NON_CONTENT_WARNING_RE.test(w),
  );
}

// Mirrors the relevant slice of buildReviewSystemPrompt: the
// knownWarningsBlock construction and its presence/absence in the final
// prompt text.
function buildKnownWarningsBlock(qcWarnings) {
  const contentWarnings = contentWarningsForReview(qcWarnings);
  return contentWarnings.length
    ? `\nKNOWN QUALITY WARNINGS (already flagged by deterministic checks before this review — verify each is genuinely still unresolved in the plan below. A warning matching one of the nine MUST-VERIFY CHECKLIST areas — especially MARQUEE PROMISES and LOYALTY-CLAIM PLAUSIBILITY — MUST be escalated in structural_findings[] with the matching check id if still unresolved. Anything else worth a note belongs in ordinary findings[]):\n${contentWarnings.map((w) => `• ${w}`).join("\n")}\n`
    : "";
}

console.log("\ncontentWarningsForReview — passes through itinerary-content warnings, excludes build-process ones\n");
{
  const warnings = [
    "Marquee sight promised but not scheduled: pink jeep — the plan talks about it (headline or flags) but no day actually has an item for it. Tap Expert Review to add it.",
    "Day 2 dinner: Elote Cafe has no backup — add a same-tier fallback in the same neighborhood/cuisine",
    "Geronimo (Day 4 dinner) is reported permanently closed — we left it in place so you can see what to replace, but it must NOT be booked. No backup was supplied; please pick a different restaurant.",
    "Day 1 is thin — only notes/transport/hotel with no anchor experience",
    "Plan B has only 3 entries (expected ≥5)",
    "Day 3 missing headline",
    "Plan hit the model's token budget mid-output. Try fewer cities or a shorter trip, or split this into a multi-leg flow.",
    "Plan was cut off before finishing — some sections may be incomplete. Tap Build again for a full plan.",
  ];
  const filtered = contentWarningsForReview(warnings);
  assert("all six itinerary-content warnings survive (not just marquee)", filtered.length === 6, JSON.stringify(filtered));
  assert("the permanently-closed-venue warning survives (a real independent-review-style catch)",
    filtered.some(w => /permanently closed/i.test(w)));
  assert("the thin-day warning survives", filtered.some(w => /is thin/i.test(w)));
  assert("the low-Plan-B warning survives", filtered.some(w => /Plan B has only/i.test(w)));
  assert("the missing-headline warning survives", filtered.some(w => /missing headline/i.test(w)));
  assert("the token-budget build-process warning is excluded (not an itinerary-content issue)",
    !filtered.some(w => /token budget/i.test(w)));
  assert("the cut-off-mid-build build-process warning is excluded",
    !filtered.some(w => /cut off before finishing/i.test(w)));
}
assert("non-array input degrades to empty, not a throw", JSON.stringify(contentWarningsForReview(null)) === "[]");
assert("no warnings at all → empty", contentWarningsForReview([]).length === 0);
assert("a non-string entry in the array is skipped, not a throw",
  contentWarningsForReview([null, undefined, 42, "Day 1 missing headline"]).length === 1);

console.log("\nKNOWN QUALITY WARNINGS block — only appears when there's something to escalate\n");
{
  const withGap = buildKnownWarningsBlock([
    "Marquee sight promised but not scheduled: pink jeep — the plan talks about it (headline or flags) but no day actually has an item for it. Tap Expert Review to add it.",
  ]);
  assert("the block is present when a content warning exists", withGap.includes("KNOWN QUALITY WARNINGS"));
  assert("the block names the actual gap (pink jeep)", withGap.includes("pink jeep"));
  assert("the block instructs escalating a MUST-VERIFY match via structural_findings",
    withGap.includes("structural_findings[]") && withGap.includes("MARQUEE PROMISES"));
}
{
  const withNonChecklistWarning = buildKnownWarningsBlock([
    "Geronimo (Day 4 dinner) is reported permanently closed — pick a different restaurant.",
  ]);
  assert("a non-checklist warning (e.g. a closed venue) still surfaces in the block",
    withNonChecklistWarning.includes("permanently closed"));
  assert("...routed to ordinary findings[], not forced into structural_findings",
    withNonChecklistWarning.includes("findings[]"));
}
{
  // 2026-08-07 regression: the checklist grew from seven areas to nine
  // (carrier_consistency, loyalty_claims added — see CLAUDE.md "why the
  // built-in Expert Review kept missing things a fresh Claude read caught
  // instantly"). The escalation instruction text must reflect the new
  // count and explicitly call out the new LOYALTY-CLAIM PLAUSIBILITY area,
  // the same way it already calls out MARQUEE PROMISES, so a hotel-loyalty
  // warning from applyQualityLayer §2e gets escalated into the uncapped
  // structural_findings[] bucket instead of competing for one of the
  // capped ordinary findings[] slots.
  const withLoyaltyGap = buildKnownWarningsBlock([
    "Day 1 hotel (Novotel Bayeux): claims a cross-chain loyalty affiliation (marriott / accor) that does not exist in the hotel industry — verify before booking",
  ]);
  assert("the block references nine checklist areas, not the stale seven",
    withLoyaltyGap.includes("nine MUST-VERIFY CHECKLIST areas") && !withLoyaltyGap.includes("seven MUST-VERIFY"));
  assert("the block explicitly calls out LOYALTY-CLAIM PLAUSIBILITY for escalation, same as MARQUEE PROMISES",
    withLoyaltyGap.includes("LOYALTY-CLAIM PLAUSIBILITY") && withLoyaltyGap.includes("MARQUEE PROMISES"));
  assert("the block names the actual hotel loyalty gap (Novotel Bayeux)",
    withLoyaltyGap.includes("Novotel Bayeux"));
}
{
  const onlyProcessWarnings = buildKnownWarningsBlock([
    "Plan was cut off before finishing — some sections may be incomplete. Tap Build again for a full plan.",
  ]);
  assert("a plan with ONLY a build-process warning gets no block at all (nothing content-related to escalate)",
    onlyProcessWarnings === "", JSON.stringify(onlyProcessWarnings));
}
{
  const clean = buildKnownWarningsBlock([]);
  assert("no block at all when there are no warnings (avoid empty-section noise)",
    clean === "", JSON.stringify(clean));
}
{
  const noWarnings = buildKnownWarningsBlock(undefined);
  assert("undefined qcWarnings (e.g. a first-ever review with no qc prop yet) degrades to no block",
    noWarnings === "");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
