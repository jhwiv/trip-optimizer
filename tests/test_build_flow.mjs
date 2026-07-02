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
//   3. The build trigger is a single "Build itinerary" button, and it is the
//      only thing wired to handleBuild in the Step-2 render.
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

// The "Plan my trip" button's onClick must be handleBuild.
const buildIdx = SRC.search(buildLabel);
const buildBtnStart = SRC.lastIndexOf("<button", buildIdx);
const buildBtnTag = SRC.slice(buildBtnStart, buildIdx);
assert(
  "Plan my trip button is wired to handleBuild",
  /onClick=\{handleBuild\}/.test(buildBtnTag),
  buildBtnTag.slice(0, 160)
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
  SRC.indexOf(progressGateStr) > buildIdx,
  "progress panel should follow the Build itinerary button in source order"
);

// --- 6. Step 1 → Step 2 resets to the Details sub-view --------------------
console.log("\n[step 1 continue resets to details]");
assert(
  "Continue to Step 2 resets outputsStep to false",
  /setOutputsStep\(false\);\s*setStep\(2\)/.test(SRC),
  "Step 1 Continue should land on the Details sub-view, not Outputs"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
