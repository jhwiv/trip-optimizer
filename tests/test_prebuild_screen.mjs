// Tests for the pre-build screen in src/App.jsx.
//
// Why source-text assertions instead of rendering?
//   The screen renders inside the giant TripOptimizer component in a .jsx
//   file; there is no harness that imports App.jsx in a plain node script
//   (see test_build_flow.mjs and test_form_defaults.mjs for the same
//   rationale). The click-through lives in tests/qa_narrative_to_outputs.mjs.
//
// What this locks in:
//   1. PreBuildScreen exists and the wizard renders it.
//   2. It is gated on a single `showPreBuild` predicate, and that same
//      predicate suppresses the wizard chrome — so the screen can never end
//      up half-promoted (content swapped, stepper still showing).
//   3. The trip summary is READ-ONLY: no inputs, no setters for trip fields.
//      Editing lives one tap back on the Details form, so there is exactly
//      one place a value can change.
//   4. Every summary row is rendered, including empty ones. A hidden row
//      reads as "we've got it covered" — surfacing the gap is the point.
//   5. The meal-policy line uses the SAME classifier input shape as the build
//      prompt, so the preview cannot promise a policy the build won't apply.
//   6. Auto-added city sources are labelled from the shared registry and are
//      NOT toggleable — the server resolves them, so a toggle would be a
//      control that controls nothing.
//   7. Exactly one scroll-to-top per entry into the screen.

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

// Isolate the component body so "the screen contains X" can't be satisfied by
// something elsewhere in a 16k-line file.
const compStart = SRC.indexOf("function PreBuildScreen({");
const compEnd = SRC.indexOf("\nexport default function TripOptimizer()");
const COMP = compStart > -1 && compEnd > compStart ? SRC.slice(compStart, compEnd) : "";

console.log("\n[1] the component exists and is rendered");
{
  assert("PreBuildScreen is declared", compStart > -1);
  assert("component body was isolated", COMP.length > 0);
  assert("the wizard renders <PreBuildScreen", SRC.includes("<PreBuildScreen"));
  assert(
    "it is declared before TripOptimizer (module scope, not inside render)",
    compStart > -1 && compEnd > compStart,
    "PreBuildScreen must be a module-level component"
  );
}

console.log("\n[2] one predicate gates the screen and the chrome");
{
  assert(
    "showPreBuild is derived from findOnly + step + outputsStep",
    /const showPreBuild = !findOnly && step === 2 && outputsStep;/.test(SRC),
    "missing the single showPreBuild predicate"
  );
  // Four chrome blocks must be suppressed: mode toggle row, hero welcome
  // banner, the stepper, and step 2's Home/← Essentials row. Each is gated by
  // its own `!showPreBuild`, so count the guards rather than locating each.
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
    SRC.includes('{!showPreBuild && <hr style={{ border: "none"'),
  );
}

console.log("\n[3] the trip summary is read-only");
{
  const summaryStart = COMP.indexOf("What we understood");
  const summaryEnd = COMP.indexOf("Output sections");
  const summary = summaryStart > -1 && summaryEnd > summaryStart ? COMP.slice(summaryStart, summaryEnd) : "";
  assert("summary card was isolated", summary.length > 0);
  assert("no <input in the summary", !summary.includes("<input"), "the summary must not be editable");
  assert("no <textarea in the summary", !summary.includes("<textarea"));
  assert("no <select in the summary", !summary.includes("<select"));
  assert("no <Field in the summary", !summary.includes("<Field"));
  assert("no <Sel in the summary", !summary.includes("<Sel"));
  assert("no <TagInput in the summary", !summary.includes("<TagInput"));
  // The whole component receives no setter for any trip input bucket.
  for (const setter of ["setB", "setF", "setH", "setD", "setRest", "setActs", "setInt", "setNarrative", "setBasics"]) {
    assert(`no ${setter} anywhere in the component`, !COMP.includes(setter), `${setter} would make the preview editable`);
  }
  assert(
    "there is a way back to the editable form",
    COMP.includes("Back to edit these") && /onClick=\{onBack\}/.test(COMP),
    "read-only is only acceptable if editing is one tap away"
  );
}

console.log("\n[4] every summary row renders, empty ones included");
{
  const EXPECTED_ROWS = [
    "Destination", "Dates", "Nights", "Travelers", "Cities", "Base area",
    "Pace", "Style", "Budget", "Flights", "Hotel", "Restaurants",
    "Activities", "Meals",
  ];
  for (const label of EXPECTED_ROWS) {
    assert(`row: ${label}`, COMP.includes(`<PreBuildRow label="${label}"`), `missing the ${label} row`);
  }
  assert(
    "rows are never conditionally hidden",
    !/\{\s*\w+\s*&&\s*<PreBuildRow/.test(COMP),
    "a hidden row reads as 'we've got it covered' — render 'not specified' instead"
  );
  assert(
    "the empty-value placeholder exists",
    SRC.includes("not specified"),
    "empty fields must say so rather than vanish"
  );
  assert(
    "the placeholder lives in the shared row component",
    /function PreBuildRow\(\{ label, value \}\)[\s\S]{0,900}not specified/.test(SRC),
    "every row must fall back the same way"
  );
}

console.log("\n[5] meal policy matches the build prompt's classifier input");
{
  // The build prompt calls classifyMealPolicy({ narrative, guidelines,
  // dining, restaurants }). The preview must pass the same four fields or it
  // can display a policy the build then contradicts.
  const calls = SRC.match(/classifyMealPolicy\(\{[^}]*\}\)/g) || [];
  assert("at least two classifyMealPolicy call sites", calls.length >= 2, JSON.stringify(calls));
  const previewCall = calls.find((c) => c.includes("narrative") && c.includes("guidelines"));
  assert(
    "preview passes narrative + guidelines + dining + restaurants",
    !!previewCall && ["narrative", "guidelines", "dining", "restaurants"].every((f) => previewCall.includes(f)),
    previewCall || "none"
  );
  assert(
    "the preview summary is derived, not hardcoded",
    /const mealPolicySummary = \(\(\) => \{/.test(SRC)
  );
  assert(
    "the summary is passed to the screen",
    /mealPolicyText=\{mealPolicySummary\}/.test(SRC)
  );
}

console.log("\n[6] auto-added city sources are labelled but not toggleable");
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

console.log("\n[7] exactly one scroll per entry into the screen");
{
  // Two entry points set outputsStep=true: the "Jump to select outputs"
  // button and the narrative defer-nav path. Each scrolls itself. The
  // outputsStep effect must NOT scroll as well — that produced an instant
  // jump followed by a smooth slide.
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

console.log("\n[8] the build CTA stays reachable");
{
  // The screen is taller than a 390x844 viewport no matter how it is
  // arranged, and position:sticky is inert app-wide (index.html sets
  // overflow-x on html/body/#root). The action bar is pinned instead.
  assert(
    "the action bar is fixed to the bottom",
    /position: "fixed", bottom: 0, left: 0, right: 0/.test(COMP),
    "the CTA must not require scrolling on a phone"
  );
  assert(
    "content reserves room for the fixed bar",
    /height: "168px"/.test(SRC),
    "without a clearance spacer the last element hides behind the action bar"
  );
  assert("the bar carries the primary CTA", />\s*Plan my trip\s*</.test(COMP));
  assert("the bar carries the back affordance", COMP.includes("← Back"));
  assert("the bar swaps to Cancel while loading", /onClick=\{onCancel\}/.test(COMP));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
