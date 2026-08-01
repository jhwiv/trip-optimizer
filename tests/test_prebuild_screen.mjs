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
//   6. Card #4 renders BuildPhaseBars inline when a build is running, and the
//      Plan-my-trip button when it isn't — same slot, same anchor.
//   7. Progress is rendered in exactly ONE place while outputsStep is true:
//      the fixed BuildAndReviewOverlay is suppressed. Two competing progress
//      surfaces would drift.
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

console.log("\n[6] card #4 swaps the CTA for progress bars in the same slot");
{
  const phase4Start = COMP.indexOf('title="Plan my trip"');
  const phase4End = COMP.length;
  const phase4 = phase4Start > -1 ? COMP.slice(phase4Start, phase4End) : "";
  assert("phase 4 was isolated", phase4.length > 0);
  assert(
    "phase 4 renders BuildPhaseBars while a build is running",
    phase4.includes("<BuildPhaseBars"),
    "inline progress in the same slot as the button"
  );
  assert(
    "phase 4 renders the Plan-my-trip button when idle",
    />\s*Plan my trip\s*</.test(phase4)
  );
  assert(
    "phase 4 renders Cancel while loading",
    phase4.includes("BuildCancelButton") && /onCancel=\{onCancel\}/.test(COMP)
  );
  assert(
    "phase 4 is anchored by progressPanelRef",
    /<div ref=\{progressPanelRef\}>[\s\S]*?<PhaseCard[\s\S]{0,400}title="Plan my trip"/.test(COMP),
    "the auto-scroll on build-start must land on the bars themselves"
  );
}

console.log("\n[7] the fixed overlay is suppressed on the pre-build screen");
{
  // BuildAndReviewOverlay is a fixed bottom sheet with progress. Rendering
  // it AND phase #4's inline BuildPhaseBars simultaneously would give two
  // progress surfaces that can drift.
  assert(
    "BuildAndReviewOverlay is gated on !outputsStep",
    /\{!outputsStep && \([\s\S]{0,200}<BuildAndReviewOverlay/.test(SRC),
    "the fixed overlay must not render when the phase-flow is showing progress inline"
  );
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
