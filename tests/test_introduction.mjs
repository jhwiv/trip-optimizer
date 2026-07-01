// Tests for src/introduction.js — the pure shaping/normalization/guard layer
// behind the in-app Introduction generation feature. Network lives in App.jsx
// (IntroductionPasteCard) and functions/api/introduction.js and is NOT
// exercised here. Repo convention: custom assert, prints "N passed, M failed",
// exits non-zero on failure. Auto-discovered by tests/run-all.mjs.

import {
  NONE_FLAGGED,
  hasIntroduction,
  shouldAutoGenerateIntroduction,
  shapeIntroRequest,
  normalizeIntroduction,
  applyGeneratedIntroduction,
  isPdfDownloadReady,
} from "../src/introduction.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// ---- fixtures ------------------------------------------------------------
const samplePlan = {
  destination: "Croatia",
  cities: [{ name: "Zagreb" }, { name: "Rovinj" }, { name: "Split" }],
  flags: ["Plitvice closed Mondays", "ferry books out in August", "", null],
  days: [
    {
      label: "Day 1 · Zagreb",
      headline: "Arrival and old town",
      items: [
        { type: "Hotel", text: "Esplanade Zagreb" },
        { type: "Dinner", text: "Noel — tasting menu" },
        { type: "Activity", text: "Upper Town walk" },
        { type: "Transport", text: "airport transfer" },
      ],
    },
    {
      label: "Day 2 · Rovinj",
      headline: "Istrian coast",
      items: [{ type: "Activity", name: "Roxanich winery" }],
    },
  ],
};
const sampleInputs = {
  basics: {
    startDate: "2027-08-25",
    endDate: "2027-09-05",
    nights: "11",
    travelers: "2",
    style: ["Food & wine", "Slow travel"],
    pace: "relaxed",
    budget: "premium",
  },
};

// ---- shapeIntroRequest ---------------------------------------------------
console.log("=== shapeIntroRequest ===");
const req = shapeIntroRequest(samplePlan, sampleInputs);
assert("destination carried through", req.destination === "Croatia");
assert("route joins cities with arrow", req.route === "Zagreb → Rovinj → Split");
assert("dates combine start/end", req.dates === "2027-08-25 — 2027-09-05");
assert("nights/travelers/pace/budget", req.nights === "11" && req.travelers === "2" && req.pace === "relaxed" && req.budget === "premium");
assert("style array joined", req.style === "Food & wine, Slow travel");
assert("days are strings, one per day", Array.isArray(req.days) && req.days.length === 2 && typeof req.days[0] === "string");
assert("day line includes label + headline + named items", req.days[0].includes("Day 1 · Zagreb") && req.days[0].includes("Arrival and old town") && req.days[0].includes("Noel"));
assert("day line caps named items at 3", (req.days[0].match(/;/g) || []).length <= 2);
assert("activity name (no text) still captured", req.days[1].includes("Roxanich winery"));
assert("transport item excluded from named items", !req.days[0].includes("airport transfer"));
assert("flags filtered to non-empty, capped at 4", Array.isArray(req.flags) && req.flags.length === 2 && req.flags[0] === "Plitvice closed Mondays");

// single-city plan -> no route
const oneCity = shapeIntroRequest({ destination: "Tokyo", cities: [{ name: "Tokyo" }], days: [{ label: "Day 1", items: [] }] }, {});
assert("single city -> empty route", oneCity.route === "");
assert("missing basics -> empty strings, no throw", oneCity.nights === "" && oneCity.travelers === "" && oneCity.style === "");

// garbage inputs don't throw
assert("null plan -> empty shape", (() => { const r = shapeIntroRequest(null, null); return Array.isArray(r.days) && r.days.length === 0 && r.destination === ""; })());
assert("days fallback label when missing", shapeIntroRequest({ days: [{ items: [] }] }, {}).days[0] === "Day 1");
assert("start only -> dates is start", shapeIntroRequest({ days: [{ label: "D1", items: [] }] }, { basics: { startDate: "2027-08-25" } }).dates === "2027-08-25");

// ---- normalizeIntroduction ----------------------------------------------
console.log("=== normalizeIntroduction ===");
assert("valid arc + diff", (() => { const n = normalizeIntroduction({ arc: " an arc ", differentiators: " some diffs " }); return n && n.arc === "an arc" && n.differentiators === "some diffs"; })());
assert("empty diff stays empty string", normalizeIntroduction({ arc: "x", differentiators: "" }).differentiators === "");
assert("missing diff -> empty string", normalizeIntroduction({ arc: "x" }).differentiators === "");
assert("NONE_FLAGGED canonicalized (exact)", normalizeIntroduction({ arc: "x", differentiators: "NONE_FLAGGED" }).differentiators === NONE_FLAGGED);
assert("none_flagged lowercase canonicalized", normalizeIntroduction({ arc: "x", differentiators: " none_flagged " }).differentiators === NONE_FLAGGED);
assert("missing arc -> null (unusable)", normalizeIntroduction({ differentiators: "stuff" }) === null);
assert("whitespace-only arc -> null", normalizeIntroduction({ arc: "   ", differentiators: "stuff" }) === null);
assert("null raw -> null", normalizeIntroduction(null) === null);
assert("non-object raw -> null", normalizeIntroduction("garbage") === null);
assert("non-string arc -> null", normalizeIntroduction({ arc: 42, differentiators: "x" }) === null);
assert("non-string diff -> empty string", normalizeIntroduction({ arc: "ok", differentiators: 99 }).differentiators === "");

// ---- hasIntroduction / shouldAutoGenerate -------------------------------
console.log("=== hasIntroduction / shouldAutoGenerateIntroduction ===");
assert("no introduction -> false", hasIntroduction(samplePlan) === false);
assert("non-empty arc -> true", hasIntroduction({ introduction: { arc: "hi" } }) === true);
assert("non-empty diff -> true", hasIntroduction({ introduction: { differentiators: "hi" } }) === true);
assert("empty intro object -> false", hasIntroduction({ introduction: { arc: "  ", differentiators: "" } }) === false);
assert("NONE_FLAGGED diff counts as present", hasIntroduction({ introduction: { differentiators: "NONE_FLAGGED" } }) === true);
assert("auto-gen when plan has days + no intro", shouldAutoGenerateIntroduction(samplePlan) === true);
assert("no auto-gen when intro present", shouldAutoGenerateIntroduction({ ...samplePlan, introduction: { arc: "x" } }) === false);
assert("no auto-gen when no days", shouldAutoGenerateIntroduction({ destination: "X", days: [] }) === false);
assert("no auto-gen for null plan", shouldAutoGenerateIntroduction(null) === false);

// ---- applyGeneratedIntroduction (precedence/guard) ----------------------
console.log("=== applyGeneratedIntroduction ===");
const gen = { arc: "generated arc", differentiators: "generated diffs" };

// auto-run (force:false) on a plan with no intro -> fills it
const filled = applyGeneratedIntroduction(samplePlan, gen, { force: false });
assert("auto-fill writes a NEW object", filled !== samplePlan);
assert("auto-fill sets introduction", filled.introduction.arc === "generated arc" && filled.introduction.differentiators === "generated diffs");
assert("auto-fill preserves other plan fields", filled.destination === "Croatia" && filled.days === samplePlan.days);

// auto-run on a plan that already has a user intro -> NO clobber (same ref)
const userPlan = { ...samplePlan, introduction: { arc: "user wrote this", differentiators: "" } };
const guarded = applyGeneratedIntroduction(userPlan, gen, { force: false });
assert("auto-run does not clobber existing intro", guarded === userPlan);
assert("existing intro unchanged after guarded auto-run", guarded.introduction.arc === "user wrote this");

// explicit regenerate (force:true) overwrites even an existing intro
const forced = applyGeneratedIntroduction(userPlan, gen, { force: true });
assert("force overwrites existing intro", forced !== userPlan && forced.introduction.arc === "generated arc");

// unusable response -> never writes, returns same ref (even with force)
assert("unusable response (no arc) returns same ref, no force", applyGeneratedIntroduction(samplePlan, { differentiators: "x" }, { force: false }) === samplePlan);
assert("unusable response returns same ref even with force", applyGeneratedIntroduction(userPlan, {}, { force: true }) === userPlan);
assert("garbage response returns same ref", applyGeneratedIntroduction(samplePlan, "not an object", { force: false }) === samplePlan);

// NONE_FLAGGED differentiators flows through apply
const nf = applyGeneratedIntroduction(samplePlan, { arc: "a", differentiators: "none_flagged" }, { force: false });
assert("apply canonicalizes NONE_FLAGGED", nf.introduction.differentiators === NONE_FLAGGED);

// default options (no opts arg) behaves as force:false
assert("default opts = no force (no clobber)", applyGeneratedIntroduction(userPlan, gen) === userPlan);

// ---- isPdfDownloadReady (PDF download gate) ------------------------------
// State-exposure path behind PR #69 race fix: the IntroductionAutoGenerator
// now lifts its isGenerating boolean via onGeneratingChange and the Save as
// PDF button is gated by this pure helper. The button stays disabled with a
// "Preparing introduction…" label while the headless POST /api/introduction
// call is in flight, and falls open the moment the intro is populated OR the
// generator finishes (success OR failure) so a silent server error never
// permanently blocks the PDF.
console.log("=== isPdfDownloadReady ===");

// Intro populated — always ready, regardless of isGenerating (covers the
// success path the moment onPlanRevised lands the new plan on the parent).
const planWithIntro = { ...samplePlan, introduction: { arc: "populated", differentiators: "" } };
assert(
  "ready when intro is populated and generator idle",
  (() => { const g = isPdfDownloadReady({ plan: planWithIntro, isGenerating: false }); return g.ready === true && g.label === ""; })(),
);
assert(
  "ready when intro is populated even if isGenerating flag still true (race-safe)",
  isPdfDownloadReady({ plan: planWithIntro, isGenerating: true }).ready === true,
);
assert(
  "NONE_FLAGGED diff counts as a populated intro (PDF will render honest no-diffs note)",
  isPdfDownloadReady({ plan: { ...samplePlan, introduction: { arc: "a", differentiators: NONE_FLAGGED } }, isGenerating: false }).ready === true,
);

// Gate CLOSED only while the generator is in flight on an intro-less plan.
const gateClosed = isPdfDownloadReady({ plan: samplePlan, isGenerating: true });
assert("not ready while generating on an intro-less plan", gateClosed.ready === false);
assert("label is the 'Preparing introduction…' copy when gated", gateClosed.label === "Preparing introduction…");

// Gate releases on generator FAILURE — isGenerating false + still no intro.
// This is the critical "never permanently block the PDF" guarantee: a silent
// /api/introduction error leaves the plan introduction-less but the gate is
// open so the user can still ship the PDF (it will just have no intro page).
assert(
  "ready when generator finished (failure path: no intro, not generating)",
  isPdfDownloadReady({ plan: samplePlan, isGenerating: false }).ready === true,
);
assert(
  "label is empty when ready (button shows 'Save as PDF', not the gated label)",
  isPdfDownloadReady({ plan: samplePlan, isGenerating: false }).label === "",
);

// Plans that don't need an intro (no days) — always ready, no gating needed.
assert(
  "ready when plan has no days (auto-gen disabled) and not generating",
  isPdfDownloadReady({ plan: { destination: "X", days: [] }, isGenerating: false }).ready === true,
);

// Defensive defaults — the helper must not throw on missing args or junk.
assert(
  "no args -> ready (helper never throws, defaults to open gate)",
  isPdfDownloadReady().ready === true,
);
assert(
  "null plan + not generating -> ready",
  isPdfDownloadReady({ plan: null, isGenerating: false }).ready === true,
);
assert(
  "null plan + generating -> still gated (covers very first render before plan settles)",
  isPdfDownloadReady({ plan: null, isGenerating: true }).ready === false,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
