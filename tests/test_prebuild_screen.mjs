// Tests for the pre-build screen in src/App.jsx.
//
// The screen is a linear phase FLOW, not a form: four stacked PhaseCards,
// one per phase of getting a trip built. Cards 2 and 3 arrive already
// answered (defaults exist) and render collapsed; card 1 opens only while
// extraction is running; card 4 always holds the CTA and swaps in place to
// the two-bar progress display when a build starts.
//
// Why source-text assertions instead of rendering?
//   The screen renders inside the giant TripOptimizer component in a .jsx
//   file; there is no harness that imports App.jsx in a plain node script.
//   The click-through lives in tests/qa_narrative_to_outputs.mjs.
//
// What this locks in:
//   1. PhaseCard exists and is composable (title, status, summary, expanded, onToggle).
//   2. PreBuildScreen exists and the wizard renders it.
//   3. It is gated on a single `showPreBuild` predicate, and that same
//      predicate suppresses the wizard chrome — so the screen can never end
//      up half-promoted (content swapped, stepper still showing).
//   4. There are exactly four PhaseCards, in the specified order:
//      Reading your prompt → Expert review sources → Output sections → Plan my trip.
//   5. Card #1 auto-collapses on the true→false edge of extractingFromGuidelines
//      (edge, not level — otherwise Edit is undone every render).
//   6. Card #4 only ever renders idle (Back + Plan-my-trip, or the disabled
//      "reading narrative" state) — it never shows a build-running state,
//      because tapping Plan my trip swaps the whole screen for
//      BuildProgressScreen (a real full-screen takeover, not a modal:
//      no position:fixed, so it can't hit the containing-block bug that
//      broke the bottom-sheet version).
//   7. BuildAndReviewOverlay (the fixed bottom-sheet modal) is gated on
//      !showBuildProgress, not !outputsStep — it remains the fallback for
//      any OTHER path that reaches loading/reviewRunning without coming
//      through the pre-build screen (e.g. the post-build review phase).
//   8. Auto-added city sources are labelled from the shared registry and are
//      NOT toggleable — the server resolves them, so a toggle would be a
//      control that controls nothing.
//   9. Exactly one scroll-to-top per entry into the screen.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

// Isolate PreBuildScreen so "the screen contains X" can't be satisfied by
// something elsewhere in a 16k-line file.
const preBuildStart = SRC.indexOf("function PreBuildScreen({");
const preBuildEnd = SRC.indexOf("\nexport default function TripOptimizer()");
const COMP = preBuildStart > -1 && preBuildEnd > preBuildStart ? SRC.slice(preBuildStart, preBuildEnd) : "";

// Isolate PhaseCard too — some invariants (edit affordance, done-state row)
// live in the shared component, not the flow.
const phaseCardStart = SRC.indexOf("function PhaseCard({");
const phaseCardEnd = SRC.indexOf("\n// Pre-build phase flow", phaseCardStart);
const PHASE = phaseCardStart > -1 && phaseCardEnd > phaseCardStart ? SRC.slice(phaseCardStart, phaseCardEnd) : "";

console.log("\n[1] PhaseCard exists and carries the collapse contract");
{
  assert("PhaseCard is declared at module scope", phaseCardStart > -1);
  assert("PhaseCard body was isolated", PHASE.length > 0);
  assert(
    "signature is { title, status, summary, expanded, onToggle, cardStyleR, children }",
    /function PhaseCard\(\{ title, status[^}]*expanded, onToggle[^}]*children \}\)/.test(PHASE)
  );
  assert(
    "the done+collapsed row has an Edit affordance",
    PHASE.includes("Edit") && /aria-expanded="false"/.test(PHASE),
    "done + !expanded must let the user re-open the card"
  );
  assert(
    "in-progress cards render their body regardless of expanded",
    PHASE.includes("const showBody = expanded || working;"),
    "hiding an active phase would remove its only feedback that it's running"
  );
  assert(
    "the done+collapsed row shows a ✓",
    PHASE.includes("✓"),
    "success needs to read at a glance"
  );
}

console.log("\n[2] PreBuildScreen exists and the wizard renders it");
{
  assert("PreBuildScreen is declared at module scope", preBuildStart > -1);
  assert("PreBuildScreen body was isolated", COMP.length > 0);
  assert("the wizard renders <PreBuildScreen", SRC.includes("<PreBuildScreen"));
  assert(
    "it is declared before TripOptimizer (module scope, not inside render)",
    preBuildStart > -1 && preBuildEnd > preBuildStart
  );
}

console.log("\n[3] one predicate gates the screen and the chrome");
{
  assert(
    "showPreBuild is derived from findOnly + step + outputsStep",
    /const showPreBuild = !findOnly && step === 2 && outputsStep;/.test(SRC),
    "missing the single showPreBuild predicate"
  );
  // Chrome blocks must be suppressed by the same predicate.
  const guards = (SRC.match(/!showPreBuild/g) || []).length;
  assert("at least four chrome blocks are suppressed", guards >= 4, `found ${guards}`);
  assert(
    "the stepper is suppressed",
    /\{!showPreBuild && \(\n\s*<div style=\{\{ marginBottom: "1\.75rem" \}\}>/.test(SRC),
    "the step counter must not render on the pre-build screen"
  );
  assert(
    "the hero welcome banner is suppressed",
    /\{!showPreBuild && heroEntry && basics\.destination && \(/.test(SRC)
  );
  assert(
    "the find-only mode toggle row is suppressed",
    SRC.includes('{!showPreBuild && <hr style={{ border: "none"')
  );
}

console.log("\n[4] four phase cards in the specified order");
{
  const cardTitles = [];
  const re = /<PhaseCard\s[^>]*?title="([^"]+)"/g;
  let m;
  while ((m = re.exec(COMP)) !== null) cardTitles.push(m[1]);
  assert(
    "exactly four PhaseCards render",
    cardTitles.length === 4,
    `found ${cardTitles.length}: ${JSON.stringify(cardTitles)}`
  );
  assert(
    "phase 1 is Reading your prompt",
    cardTitles[0] === "Reading your prompt",
    cardTitles[0]
  );
  assert(
    "phase 2 is Expert review sources",
    cardTitles[1] === "Expert review sources",
    cardTitles[1]
  );
  assert(
    "phase 3 is Output sections",
    cardTitles[2] === "Output sections",
    cardTitles[2]
  );
  assert(
    "phase 4 is Plan my trip",
    cardTitles[3] === "Plan my trip",
    cardTitles[3]
  );
}

console.log("\n[5] phase 1 auto-collapses on the true→false edge of extraction");
{
  // Edge, not level — collapsing on the level would slam the card shut
  // every time the user re-opens it with Edit while extraction is still
  // running (it isn't, at that point, but the invariant matters).
  assert(
    "a ref tracks the previous extraction state",
    /wasExtractingRef\s*=\s*useRef\(extractingFromGuidelines\)/.test(COMP),
    "need to detect the edge, not the level"
  );
  assert(
    "collapse fires only on the true→false transition",
    /if \(wasExtractingRef\.current && !extractingFromGuidelines\) setReadingExpanded\(false\)/.test(COMP),
    "level-based collapse would undo the user's Edit toggle"
  );
  assert(
    "reading-card starts expanded only when extraction is still running",
    /useState\(extractingFromGuidelines\)/.test(COMP)
  );
}

console.log("\n[6] card #4 never shows a build-running state — that's a different screen now");
{
  const phase4Start = COMP.indexOf('title="Plan my trip"');
  const phase4End = COMP.length;
  const phase4 = phase4Start > -1 ? COMP.slice(phase4Start, phase4End) : "";
  assert("phase 4 was isolated", phase4.length > 0);
  assert(
    "phase 4 does NOT render BuildPhaseBars inline",
    !phase4.includes("<BuildPhaseBars"),
    "progress bars live only in BuildProgressScreen now — an inline copy would drift"
  );
  assert(
    "PreBuildScreen no longer accepts loading/reviewRunning props",
    !/function PreBuildScreen\(\{[\s\S]{0,400}\bloading\b/.test(SRC),
    "it only ever renders while idle now — showBuildProgress swaps the whole screen out from under it"
  );
  assert(
    "phase 4 renders the Plan-my-trip button unconditionally",
    />\s*Plan my trip\s*</.test(phase4)
  );
  assert(
    "phase 4 does NOT render its own Cancel button",
    !phase4.includes("BuildCancelButton"),
    "Cancel lives only in BuildProgressScreen now"
  );
  assert(
    "phase 4 is anchored by progressPanelRef",
    /<div ref=\{progressPanelRef\}>[\s\S]*?<PhaseCard[\s\S]{0,400}title="Plan my trip"/.test(COMP),
    "kept for the effect that skips auto-scroll on outputsStep, see section 7"
  );
}

console.log("\n[6b] BuildProgressScreen survives the step 2 → 3 transition (build AND review)");
{
  const bpsStart = SRC.indexOf("function BuildProgressScreen(");
  assert("BuildProgressScreen is declared at module scope", bpsStart > -1);
  const bpsEnd = SRC.indexOf("\nfunction BuildAndReviewOverlay(");
  const BPS = bpsStart > -1 && bpsEnd > bpsStart ? SRC.slice(bpsStart, bpsEnd) : "";
  assert("BuildProgressScreen body was isolated", BPS.length > 0);
  assert(
    "it IS position:fixed — has to cover both step 2 and step 3 as the page underneath changes",
    BPS.includes('position: "fixed"'),
    "safe now that #root no longer has contain:paint; this is exactly the containing-block-independent behavior that fix restored"
  );
  assert("it renders BuildPhaseBars", BPS.includes("<BuildPhaseBars"));
  // 2026-08-08 regression (CLAUDE.md "KNOWN FAILURE MODE #16"): Cancel used
  // to be gated on `loading` alone, so it disappeared the moment the
  // initial build finished and the review/apply phase started — a user
  // stuck in a review or an auto-fired revision had no way to stop it.
  assert("it renders Cancel during loading OR the review/apply phase, not loading alone",
    /\{\(loading \|\| reviewRunning\) && <BuildCancelButton/.test(BPS));
  assert("the old loading-only gate is gone", !/\{loading && <BuildCancelButton/.test(BPS));
  assert("it accepts a result prop to know when the review is truly done", /result, onCancel, onDone,/.test(BPS));
  assert(
    "it renders a completion CTA instead of auto-navigating",
    /Take me to my final itinerary/.test(BPS) && BPS.includes("onClick={onDone}"),
    "the user must be the one who leaves this screen, not an auto-navigate"
  );
  assert(
    "showBuildHero exists as its own flag, decoupled from step/outputsStep",
    /const \[showBuildHero, setShowBuildHero\] = useState\(false\);/.test(SRC),
    "applyBuiltPlan flips step to 3 the instant the initial build finishes, well before review is done — " +
    "gating on step/outputsStep would drop the hero mid-review"
  );
  assert(
    "showBuildHero turns on on the rising edge of loading",
    /const rising = loading && !prevBuildHeroLoadingRef\.current;[\s\S]{0,80}if \(rising\) setShowBuildHero\(true\);/.test(SRC)
  );
  assert(
    "showBuildProgress derives from showBuildHero, not showPreBuild",
    /const showBuildProgress = !findOnly && showBuildHero;/.test(SRC)
  );
  assert(
    "BuildProgressScreen renders as a step-independent sibling, not nested inside step === 2",
    /\{showBuildProgress && \(\s*<BuildProgressScreen/.test(SRC)
    && !/\{step === 2 && showBuildProgress/.test(SRC),
    "it must still be visible after step flips to 3 for the review phase"
  );
  assert(
    "the outer 'Your trip' recap card is suppressed during showBuildProgress",
    /\{step !== 3 && !showBuildProgress && \(/.test(SRC),
    "BuildProgressScreen renders its own copy — a second one below it would be a visible duplicate"
  );
  assert(
    "Cancel resets showBuildHero so a cancelled build doesn't leave the hero stranded",
    /setShowBuildHero\(false\);/.test(SRC)
  );
}

console.log("\n[7] BuildAndReviewOverlay is the fallback, not suppressed generically");
{
  // BuildAndReviewOverlay used to be suppressed while the pre-build phase
  // flow was up, in favor of an inline copy of the same bars in card #4 —
  // which meant starting a build scrolled the page down to reveal them. It's
  // guarded on showBuildProgress now (the full-screen takeover), not
  // outputsStep — it still fires for any OTHER path that reaches
  // loading/reviewRunning without coming through the pre-build screen.
  assert(
    "BuildAndReviewOverlay is gated on !showBuildProgress, not !outputsStep",
    /\{!showBuildProgress && \([\s\S]{0,200}<BuildAndReviewOverlay/.test(SRC)
  );
  assert(
    "BuildAndReviewOverlay is reachable",
    /<BuildAndReviewOverlay\s/.test(SRC)
  );
  assert(
    "the build-start auto-scroll effect skips outputsStep",
    /if \(!rising \|\| outputsStep\) return;/.test(SRC),
    "the modal doesn't need the page scrolled to it"
  );

  // 2026-08-08 regression (CLAUDE.md "KNOWN FAILURE MODE #16"): this overlay
  // is explicitly documented ("most importantly the post-build review
  // phase") as covering loading OR reviewRunning, but its own Cancel button
  // was still gated on loading alone — the exact same bug as
  // BuildProgressScreen's, in the fallback overlay this file's own [7]
  // section is about.
  const overlayStart = SRC.indexOf("function BuildAndReviewOverlay(");
  const overlayEnd = SRC.indexOf("\n}\n", overlayStart);
  const overlaySrc = SRC.slice(overlayStart, overlayEnd);
  assert("BuildAndReviewOverlay renders Cancel during loading OR the review/apply phase",
    /\{\(loading \|\| reviewRunning\) && <BuildCancelButton/.test(overlaySrc));
  assert("BuildAndReviewOverlay's old loading-only Cancel gate is gone",
    !/\{loading && <BuildCancelButton/.test(overlaySrc));
}

console.log("\n[8] auto-added city sources are labelled but not toggleable");
{
  assert(
    "the client mirrors the shared registry",
    SRC.includes('import { resolveDynamicSources } from "./citySources.js"'),
    "labels must come from the same registry the server queries"
  );
  assert(
    "the preview resolves from the trip's first city",
    /const dynamicSourcePreview = showPreBuild[\s\S]{0,160}resolveDynamicSources\(/.test(SRC)
  );
  const dynStart = COMP.indexOf("Auto-added for this destination");
  assert("the auto-added block exists", dynStart > -1);
  const dynBlock = dynStart > -1 ? COMP.slice(dynStart, dynStart + 1200) : "";
  assert(
    "auto-added sources render as spans, not buttons",
    dynBlock.includes("<span") && !dynBlock.includes("<button"),
    "a toggle here would be a control that controls nothing"
  );
  assert(
    "auto-added sources have no onClick",
    !dynBlock.includes("onClick"),
    "the server resolves these; the client only labels them"
  );
  assert("chips are labelled from the resolved source", dynBlock.includes("{s.label}"));
  assert(
    "the block is hidden when there are no dynamic sources",
    /dynamicSources\.length > 0 && \(/.test(COMP),
    "an empty 'auto-added' heading is noise for unregistered cities"
  );
}

console.log("\n[9] exactly one scroll per entry into the screen");
{
  const effectIdx = SRC.indexOf("if (!outputsStep) return;");
  assert("the outputsStep effect is still findable", effectIdx > -1);
  const effectBody = SRC.slice(effectIdx, SRC.indexOf("}, [outputsStep]);", effectIdx));
  assert(
    "the outputsStep effect no longer scrolls",
    !effectBody.includes("window.scrollTo"),
    "the effect's scroll double-fires against each entry point's own scroll"
  );
  assert(
    "the effect still pre-warms the PDF module",
    effectBody.includes('import("./pdf/itineraryPdf.js")'),
    "dropping the scroll must not drop the pre-warm"
  );
  const jumpIdx = SRC.search(/>\s*Jump to select outputs/);
  const jumpBtn = SRC.slice(SRC.lastIndexOf("<button", jumpIdx), jumpIdx);
  assert(
    "the jump button scrolls itself, instantly",
    jumpBtn.includes("setOutputsStep(true)") && jumpBtn.includes('behavior: "instant"'),
    jumpBtn.slice(0, 160)
  );
}

console.log("\n[10] handleBuild remains reachable from exactly one call site");
{
  // Regression guard: PR #156 established this invariant. Phase 4's Plan
  // button is the only handleBuild trigger.
  const calls = (SRC.match(/onClick=\{handleBuild\}|onClick=\{onBuild\}/g) || []).length;
  // The wizard passes handleBuild as onBuild={handleBuild}, and phase 4 uses
  // onClick={onBuild}. So we expect exactly one direct handleBuild callsite
  // (the prop wiring) and one onBuild use (the phase 4 button).
  const directHandleBuild = (SRC.match(/onBuild=\{handleBuild\}/g) || []).length;
  const onBuildClicks = (SRC.match(/onClick=\{onBuild\}/g) || []).length;
  assert(
    "handleBuild is wired to PreBuildScreen exactly once",
    directHandleBuild === 1,
    `found ${directHandleBuild} onBuild={handleBuild} references`
  );
  assert(
    "onBuild is used exactly once inside PreBuildScreen",
    onBuildClicks === 1,
    `found ${onBuildClicks} onClick={onBuild} in App.jsx`
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
