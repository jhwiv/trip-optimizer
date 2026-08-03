// Tests for feeding applyQualityLayer's "Marquee sight promised but not
// scheduled" warning into the Expert Review prompt (src/App.jsx
// buildReviewSystemPrompt), so a gap the deterministic marquee-coverage
// check already found (see tests/test_itinerary_quality_fixes.mjs section 2)
// gets actively escalated by the reviewer instead of sitting inert in the
// QC panel until a human happens to read it.
//
// Prompted by the user asking, after the item.name root-cause fix and its
// peer review: "Can the expert review be tweaked to ensure it picks up
// these issues?" Two of the three original findings (duplicate same-day
// venue) are already resolved by applyQualityLayer BEFORE the reviewer ever
// sees the plan, so there's nothing left for the reviewer to catch there —
// only the marquee-promise gap survives to review time, since it's a warn,
// not an auto-fix (inserting the missing item would require regenerating
// the day, which a post-processing pass can't safely do).
//
// buildReviewSystemPrompt is a closure inside src/App.jsx and can't be
// imported directly here (jsdom-free tests) — following the established
// convention, marqueeWarningsForReview (the new pure helper) and the prompt-
// injection shape are mirrored locally and tested against that mirror.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function marqueeWarningsForReview(warnings) {
  return (Array.isArray(warnings) ? warnings : []).filter((w) => /^Marquee sight/i.test(w));
}

// Mirrors the relevant slice of buildReviewSystemPrompt: the
// knownWarningsBlock construction and its presence/absence in the final
// prompt text.
function buildKnownWarningsBlock(qcWarnings) {
  const marqueeWarnings = marqueeWarningsForReview(qcWarnings);
  return marqueeWarnings.length
    ? `\nKNOWN QUALITY WARNINGS (already flagged by deterministic checks before this review — verify each is genuinely still unresolved in the plan below, and if so you MUST escalate it in structural_findings[] with check:"marquee_promises"):\n${marqueeWarnings.map((w) => `• ${w}`).join("\n")}\n`
    : "";
}

console.log("\nmarqueeWarningsForReview — filters to only the marquee-coverage warnings\n");
{
  const warnings = [
    "Marquee sight promised but not scheduled: pink jeep — the plan talks about it (headline or flags) but no day actually has an item for it. Tap Expert Review to add it.",
    "Day 2 dinner: Elote Cafe has no backup — add a same-tier fallback in the same neighborhood/cuisine",
    "Marquee sight not scheduled: cathedral rock — this is iconic to the destination and should appear on the itinerary. Tap Expert Review to add it.",
  ];
  const filtered = marqueeWarningsForReview(warnings);
  assert("both marquee warnings are kept", filtered.length === 2, JSON.stringify(filtered));
  assert("the unrelated backup-restaurant warning is excluded", !filtered.some(w => /backup/i.test(w)));
}
assert("non-array input degrades to empty, not a throw", JSON.stringify(marqueeWarningsForReview(null)) === "[]");
assert("no warnings at all → empty", marqueeWarningsForReview([]).length === 0);

console.log("\nKNOWN QUALITY WARNINGS block — only appears when there's something to escalate\n");
{
  const withGap = buildKnownWarningsBlock([
    "Marquee sight promised but not scheduled: pink jeep — the plan talks about it (headline or flags) but no day actually has an item for it. Tap Expert Review to add it.",
  ]);
  assert("the block is present when a marquee warning exists", withGap.includes("KNOWN QUALITY WARNINGS"));
  assert("the block names the actual gap (pink jeep)", withGap.includes("pink jeep"));
  assert("the block instructs escalation via structural_findings with the new check id",
    withGap.includes('check:"marquee_promises"'));
}
{
  const clean = buildKnownWarningsBlock(["Day 2 dinner: Elote Cafe has no backup — add a same-tier fallback"]);
  assert("no block at all when there's no marquee warning to escalate (avoid empty-section noise)",
    clean === "", JSON.stringify(clean));
}
{
  const noWarnings = buildKnownWarningsBlock(undefined);
  assert("undefined qcWarnings (e.g. a first-ever review with no qc prop yet) degrades to no block",
    noWarnings === "");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
