// Tests for the wizard's two-screen Step 2 flow in src/App.jsx.
//
// Why source-text assertions instead of rendering?
//   The flow lives inside the giant TripOptimizer React component in a .jsx
//   file; there is no harness that imports App.jsx in a plain node script (see
//   test_form_defaults.mjs for the same rationale). So we read the source and
//   assert on the structure of the Step-2 render.
//
// What this locks in (the mobile-build-flow fix):
//   1. Step 2 is split by an `outputsStep` boolean that defaults to false.
//   2. The Details sub-view advances with a "Jump to select outputs" button
//      that ONLY navigates (sets outputsStep=true) — it never starts a build.
//   3. The build trigger is a single "Plan my trip" button, and handleBuild
//      reaches it only via PreBuildScreen's `onBuild` prop.
//   4. The Details sub-view contains neither the build trigger (handleBuild)
//      nor the progress panel — so reaching output selection cannot start a
//      build or show progress (the premature-build bug this fix addresses).
//   5. The progress panel only mounts in the outputs sub-view, gated on
//      `loading`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// --- 1. outputsStep state, defaulting to false ----------------------------
console.log("\n[outputsStep state]");
assert(
  "outputsStep is declared with useState(false)",
  /const\s*\[\s*outputsStep\s*,\s*setOutputsStep\s*\]\s*=\s*useState\(\s*false\s*\)/.test(SRC),
  "could not find `const [outputsStep, setOutputsStep] = useState(false)`"
);

// --- 2. The Step-2 ternary split and button labels ------------------------
console.log("\n[two-screen split + labels]");
assert(
  "Step 2 render is gated by `{!outputsStep ? (`",
  SRC.includes("{!outputsStep ? ("),
  "missing the !outputsStep ternary gate"
);

const jumpLabel = />\s*Jump to select outputs/;
const buildLabel = />\s*Plan my trip\s*</;
assert("Details CTA labelled 'Jump to select outputs'", jumpLabel.test(SRC));
assert("Outputs CTA labelled 'Plan my trip'", buildLabel.test(SRC));

// --- 3. Jump button only navigates; Build button triggers the build -------
console.log("\n[CTA wiring]");
// Grab the <button ...> tag that immediately precedes the Jump label.
const jumpIdx = SRC.search(jumpLabel);
const jumpBtnStart = SRC.lastIndexOf("<button", jumpIdx);
const jumpBtnTag = SRC.slice(jumpBtnStart, jumpIdx);
assert(
  "Jump button sets outputsStep=true",
  /onClick=\{\s*\(\)\s*=>\s*\{[^}]*setOutputsStep\(true\)/.test(jumpBtnTag),
  jumpBtnTag.slice(0, 120)
);
assert(
  "Jump button does NOT call handleBuild",
  !jumpBtnTag.includes("handleBuild"),
  "Jump button must not start a build"
);

// The "Plan my trip" button's onClick must be the build trigger. The button
// moved into the PreBuildScreen component, which receives handleBuild as its
// `onBuild` prop, so the wiring is now checked in both halves — the CTA calls
// its prop, and the call site passes handleBuild to that prop. Asserting only
// one half would let the chain be broken at the other end.
const buildIdx = SRC.search(buildLabel);
const buildBtnStart = SRC.lastIndexOf("<button", buildIdx);
const buildBtnTag = SRC.slice(buildBtnStart, buildIdx);
assert(
  "Plan my trip button is wired to its build-trigger prop",
  /onClick=\{onBuild\}/.test(buildBtnTag),
  buildBtnTag.slice(0, 160)
);
const preBuildCallIdx = SRC.indexOf("<PreBuildScreen");
assert(
  "PreBuildScreen is rendered by the wizard",
  preBuildCallIdx > -1,
  "could not find the <PreBuildScreen ... /> call site"
);
const preBuildCall = SRC.slice(preBuildCallIdx, SRC.indexOf("/>", preBuildCallIdx));
assert(
  "PreBuildScreen receives handleBuild as onBuild",
  /onBuild=\{handleBuild\}/.test(preBuildCall),
  "the pre-build screen's build trigger must be handleBuild"
);

// --- 4. Details sub-view has no build trigger / no progress panel ---------
console.log("\n[premature-build guard]");
// The Details sub-view spans from the ternary open to just after the Jump
// button (the outputs sub-view begins after the `) : (`).
const ternaryIdx = SRC.indexOf("{!outputsStep ? (");
const detailsBranch = SRC.slice(ternaryIdx, jumpIdx);
assert(
  "Details sub-view contains no handleBuild call",
  !detailsBranch.includes("handleBuild"),
  "reaching output selection must not be able to start a build"
);
assert(
  "Details sub-view contains no progress panel",
  !detailsBranch.includes("(loading || extractingFromGuidelines)"),
  "progress panel must not render on the Details sub-view"
);

// --- 5. Progress panel lives in the outputs sub-view, gated on loading ----
console.log("\n[progress panel placement]");
const progressGateStr = "{(loading || extractingFromGuidelines) &&";
assert(
  "progress panel is gated on loading/extracting",
  SRC.includes(progressGateStr),
  "missing the loading-gated progress panel"
);
assert(
  "progress panel renders after the build trigger (outputs sub-view)",
  SRC.indexOf(progressGateStr) > preBuildCallIdx,
  "progress panel should follow the pre-build screen in source order"
);

// --- 6. Step 1 → Step 2 resets to the Details sub-view --------------------
console.log("\n[step 1 continue resets to details]");
assert(
  "Continue to Step 2 resets outputsStep to false",
  /setOutputsStep\(false\);\s*setStep\(2\)/.test(SRC),
  "Step 1 Continue should land on the Details sub-view, not Outputs"
);

// --- 7. Narrative mode lands on Outputs, not Details ----------------------
//
// Regression guard for 25bd571, which flipped this one boolean to false and
// stranded narrative users on the Details form — the sub-view that assertion
// set 4 above proves has no build trigger at all. Cheap source-text belt; the
// full click-through lives in tests/qa_narrative_to_outputs.mjs.
console.log("\n[narrative defer-nav lands on outputs]");
const deferIdx = SRC.indexOf("if (!pendingBuildFromGuidelines) return;");
assert("the defer-nav effect is still findable", deferIdx > -1);
// The effect ends at its dependency array; slice to there so nothing after it
// can satisfy these assertions.
// Comments are stripped so the "No handleBuild() here" note below the
// navigation calls can't satisfy the last assertion.
const deferBody = SRC
  .slice(deferIdx, SRC.indexOf("}, [pendingBuildFromGuidelines", deferIdx))
  .replace(/\/\/[^\n]*/g, "");
assert(
  "defer-nav sets outputsStep=true before setStep(2)",
  /setOutputsStep\(true\);\s*setStep\(2\);/.test(deferBody),
  "narrative mode must land on Outputs — Details has no handleBuild call site"
);
assert(
  "defer-nav does NOT send step 2 to the Details form",
  !/setOutputsStep\(false\);\s*setStep\(2\);/.test(deferBody),
  "this is the 25bd571 regression: outputsStep=false strands the user"
);
// The no-destination branch bails to step 1, where outputsStep is meaningless.
assert(
  "the no-destination branch still resets to step 1",
  /setOutputsStep\(false\);\s*setStep\(1\);/.test(deferBody),
  "the error path should return to Essentials, not Outputs"
);
assert(
  "defer-nav still does not start the build itself",
  !deferBody.includes("handleBuild("),
  "the user must confirm output choices before a build starts (df5051e)"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
