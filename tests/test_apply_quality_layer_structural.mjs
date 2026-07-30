// Integration test for the structural / night-math tail of applyQualityLayer
// (src/App.jsx:3404-3472) and the pre-export gate's structural arm
// (src/App.jsx:3687-3712).
//
// applyQualityLayer is a large closure inside App.jsx and can't be imported
// from a DOM-free Node test, so — following the convention already used by
// tests/test_day_completeness_and_city_normalization.mjs for the two validators
// immediately above it — the ~40 lines of glue are mirrored here. Everything
// the glue calls (findContinuityIssues, findStructuralBlockingIssues,
// deriveCityNights, reconcileMetaNights, parseMetaNightsBreakdown) is imported
// from src and exercised for real; only the wiring is copied. Keep the mirror
// in sync when the App.jsx block changes shape.
//
// What this proves end-to-end: feeding the failing 2026-07-28 plan through the
// tail produces (a) block-severity structural flags that the gate collects and
// (b) plan.meta plus plan.cities[].nights overwritten in place with the
// code-derived counts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findContinuityIssues, findStructuralBlockingIssues } from "../src/dayContinuityCheck.js";
import { deriveCityNights, reconcileMetaNights, parseMetaNightsBreakdown } from "../src/legNights.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// -----------------------------------------------------------------------------
// Mirror of src/App.jsx:3404-3472 (applyQualityLayer tail)
// -----------------------------------------------------------------------------
function structuralQualityTail(input) {
  const fixes = [];
  const warnings = [];
  const out = { ...input, days: Array.isArray(input?.days) ? input.days : input?.days };

  if (Array.isArray(out.days)) {
    const continuity = findContinuityIssues(out);
    if (continuity.length > 0) {
      out.days = out.days.map((day, dayIdx) => {
        const dayFlags = continuity.filter(f => f.dayIdx === dayIdx);
        if (dayFlags.length === 0) return day;
        const prior = Array.isArray(day?.structural_flags) ? day.structural_flags : [];
        return { ...day, structural_flags: [...prior, ...dayFlags] };
      });
      for (const f of continuity) warnings.push(`Day ${f.day}: ${f.message}`);
    }
  }

  const metaBefore = typeof out.meta === "string" ? out.meta : "";
  const { meta: metaAfter, derived: derivedLegs } = reconcileMetaNights(metaBefore, out);
  if (metaAfter !== metaBefore) {
    out.meta = metaAfter;
    fixes.push(
      derivedLegs
        ? `Recomputed meta night breakdown from the day-by-day city sequence: "${metaAfter}"`
        : `Stripped unverifiable night breakdown from the meta line: "${metaAfter}"`
    );
  }

  let nightsDrifted = false;
  const modelBreakdown = parseMetaNightsBreakdown(metaBefore);
  if (derivedLegs && modelBreakdown) {
    const derivedBreakdown = derivedLegs.map(l => l.nights);
    nightsDrifted =
      modelBreakdown.length !== derivedBreakdown.length ||
      modelBreakdown.some((n, i) => n !== derivedBreakdown[i]);
  }

  const cityNights = deriveCityNights(out);
  if (cityNights && Array.isArray(out.cities)) {
    out.cities = out.cities.map((c) => {
      const derivedNights = cityNights.get(String(c?.name || "").trim().toLowerCase());
      if (!Number.isFinite(derivedNights) || derivedNights <= 0) return c;
      if (Number(c?.nights) === derivedNights) return c;
      nightsDrifted = true;
      fixes.push(`Recomputed ${c.name} nights ${c?.nights} → ${derivedNights} from the day-by-day city sequence`);
      return { ...c, nights: derivedNights };
    });
  }

  if (nightsDrifted) {
    const prior = Array.isArray(out.structural_flags) ? out.structural_flags : [];
    out.structural_flags = [...prior, {
      code: "NIGHT_COUNT_MISMATCH",
      severity: "warn",
      target: "meta",
      message: "The model's night counts disagreed with the day-by-day city sequence; the itinerary now shows the computed counts.",
    }];
    warnings.push("Night counts disagreed with the day-by-day city sequence — replaced with computed values");
  }

  return { data: out, qc: { fixes, warnings } };
}

// -----------------------------------------------------------------------------
// Mirror of the pre-export gate, src/App.jsx:3687-3712. findBlockingIssues
// (venue arm) is not imported — this test only covers the structural arm and
// the message format, so venueIssues is injected.
// -----------------------------------------------------------------------------
function exportGateError(data, venueIssues = []) {
  const structuralIssues = findStructuralBlockingIssues(data);
  const blockingIssues = [...venueIssues, ...structuralIssues];
  if (blockingIssues.length === 0) return null;
  const summary = blockingIssues
    .slice(0, 5)
    .map((iss) => `Day ${iss.dayIdx + 1}: ${iss.name} (${iss.flag.code})`)
    .join("; ");
  const more = blockingIssues.length > 5 ? ` … and ${blockingIssues.length - 5} more` : "";
  const counts = [
    `${venueIssues.length} venue verification`,
    `${structuralIssues.length} itinerary structure`,
  ].join(", ");
  const err = new Error(
    `Cannot export: ${blockingIssues.length} blocking issue${blockingIssues.length === 1 ? "" : "s"} — ${counts} — ${summary}${more}. Re-run the build or remove the affected items before exporting.`
  );
  err.code = "VERIFICATION_BLOCK";
  err.issues = blockingIssues;
  return err;
}

// -----------------------------------------------------------------------------
// Drift guard. A hand-copied mirror is only evidence for as long as it matches
// the original, so compare the shared span character-for-character (whitespace
// normalized). If this fails, App.jsx changed and the mirror above is stale.
// -----------------------------------------------------------------------------
console.log("=== mirror matches src/App.jsx ===");
{
  // Comments are allowed to differ — the mirror carries its own commentary.
  const span = (src, start, end) => {
    const a = src.indexOf(start);
    const b = src.indexOf(end, a);
    if (a < 0 || b < 0) return null;
    return src.slice(a, b)
      .split("\n")
      .map(line => line.replace(/^\s*\/\/.*$/, ""))
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
  };
  const START = "if (Array.isArray(out.days)) {";
  const END = "return { data:";
  const appSrc = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");
  const mirrorSrc = structuralQualityTail.toString();
  const inApp = span(appSrc, START, END);
  const inMirror = span(mirrorSrc, START, END);
  assert("block located in App.jsx", inApp !== null);
  assert("block located in the mirror", inMirror !== null);
  assert("mirror is character-identical to the App.jsx block", inApp === inMirror,
    `\n  app:    ${String(inApp).slice(0, 300)}\n  mirror: ${String(inMirror).slice(0, 300)}`);

  const gateSrc = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");
  assert("gate calls findStructuralBlockingIssues",
    /const structuralIssues = findStructuralBlockingIssues\(data\);/.test(gateSrc));
  assert("gate message mirrors this test's format",
    gateSrc.includes("blocking issue${blockingIssues.length === 1 ? \"\" : \"s\"} — ${counts}"));
}

console.log("\n=== failing plan: structural flags reach the plan object ===");
{
  const { data, qc } = structuralQualityTail(fixture("plan_day67_collision.json"));
  const day7 = data.days[6];
  const codes = (day7.structural_flags || []).map(f => f.code);

  assert("Day 7 carries structural_flags", Array.isArray(day7.structural_flags), JSON.stringify(day7.structural_flags));
  assert("DUPLICATE_CHECKIN present", codes.includes("DUPLICATE_CHECKIN"), JSON.stringify(codes));
  assert("ORPHANED_TRANSITION present", codes.includes("ORPHANED_TRANSITION"), JSON.stringify(codes));
  assert("VEHICLE_STATE_CONFLICT present", codes.includes("VEHICLE_STATE_CONFLICT"), JSON.stringify(codes));
  assert("clean days get no structural_flags", !data.days[1].structural_flags);
  assert("day.flags string array is untouched", data.days[6].flags === undefined);
  assert("each finding is echoed as a warning",
    qc.warnings.filter(w => /^Day 7: /.test(w)).length === 3, JSON.stringify(qc.warnings));
}

console.log("\n=== failing plan: gate blocks the export ===");
{
  const { data } = structuralQualityTail(fixture("plan_day67_collision.json"));
  const err = exportGateError(data);

  assert("gate throws", err instanceof Error);
  assert("code is VERIFICATION_BLOCK", err.code === "VERIFICATION_BLOCK");
  assert("only the two block-severity flags count", err.issues.length === 2, JSON.stringify(err.issues.map(i => i.flag.code)));
  assert("the warn-severity vehicle flag does not block",
    !err.issues.some(i => i.flag.code === "VEHICLE_STATE_CONFLICT"));
  assert("message counts both arms", /0 venue verification, 2 itinerary structure/.test(err.message), err.message);
  assert("message no longer claims a venue failed verification",
    !/venues? failed verification/.test(err.message), err.message);
  assert("message names the offending day", /Day 7:/.test(err.message), err.message);

  const withVenue = exportGateError(data, [
    { dayIdx: 3, name: "La Rapiere", flag: { code: "CLOSED_PERMANENTLY" } },
  ]);
  assert("venue and structural issues are counted separately",
    /3 blocking issues — 1 venue verification, 2 itinerary structure/.test(withVenue.message), withVenue.message);
}

console.log("\n=== failing plan: night counts overwritten in place ===");
{
  const before = fixture("plan_day67_collision.json");
  const { data, qc } = structuralQualityTail(before);

  assert("model meta was 2+3+2+3", before.meta === "11 days · 10 nights (2+3+2+3)");
  assert("meta rewritten to the derived split",
    data.meta === "11 days · 10 nights (3+2+3+2)", data.meta);

  const nights = Object.fromEntries(data.cities.map(c => [c.name, c.nights]));
  assert("London unchanged at 3", nights.London === 3, String(nights.London));
  assert("Bayeux unchanged at 2", nights.Bayeux === 2, String(nights.Bayeux));
  assert("Amsterdam corrected 4 → 3", nights.Amsterdam === 3, String(nights.Amsterdam));
  assert("Lisbon corrected 1 → 2", nights.Lisbon === 2, String(nights.Lisbon));
  assert("city nights sum to 10", data.cities.reduce((n, c) => n + c.nights, 0) === 10);

  assert("NIGHT_COUNT_MISMATCH raised",
    (data.structural_flags || []).some(f => f.code === "NIGHT_COUNT_MISMATCH"), JSON.stringify(data.structural_flags));
  assert("NIGHT_COUNT_MISMATCH is warn, not block",
    data.structural_flags.find(f => f.code === "NIGHT_COUNT_MISMATCH").severity === "warn");
  assert("plan-level warn flag does not block export",
    exportGateError(data).issues.every(i => i.flag.code !== "NIGHT_COUNT_MISMATCH"));

  assert("meta rewrite logged as a fix",
    qc.fixes.some(f => /Recomputed meta night breakdown/.test(f)), JSON.stringify(qc.fixes));
  assert("each corrected city logged as a fix",
    qc.fixes.filter(f => /Recomputed \w+ nights/.test(f)).length === 2, JSON.stringify(qc.fixes));
}

console.log("\n=== clean plan is left alone ===");
{
  const before = fixture("plan_linear_clean.json");
  const { data, qc } = structuralQualityTail(before);

  assert("no structural flags on any day", data.days.every(d => !d.structural_flags));
  assert("no plan-level structural flags", data.structural_flags === undefined);
  assert("meta unchanged", data.meta === before.meta, data.meta);
  assert("city nights unchanged",
    JSON.stringify(data.cities) === JSON.stringify(before.cities), JSON.stringify(data.cities));
  assert("no fixes", qc.fixes.length === 0, JSON.stringify(qc.fixes));
  assert("no warnings", qc.warnings.length === 0, JSON.stringify(qc.warnings));
  assert("gate lets it through", exportGateError(data) === null);
}

console.log("\n=== underivable nights are stripped, not printed ===");
{
  // One day is missing its city, so the split can't be verified. CLAUDE.md
  // requires sums to be computed in code — an unverified breakdown is removed
  // rather than presented as fact.
  const plan = {
    meta: "4 days · 3 nights (1+2)",
    cities: [{ name: "Rome", nights: 1 }, { name: "Florence", nights: 2 }],
    days: [
      { day: 1, city: "Rome", items: [] },
      { day: 2, city: "", items: [] },
      { day: 3, city: "Florence", items: [] },
      { day: 4, city: "Florence", items: [] },
    ],
  };
  const { data, qc } = structuralQualityTail(plan);
  assert("breakdown stripped from meta", data.meta === "4 days · 3 nights", data.meta);
  assert("strip logged as a fix",
    qc.fixes.some(f => /Stripped unverifiable night breakdown/.test(f)), JSON.stringify(qc.fixes));
  assert("model city nights left as-is when underivable",
    data.cities[0].nights === 1 && data.cities[1].nights === 2, JSON.stringify(data.cities));
  assert("no NIGHT_COUNT_MISMATCH when nothing could be compared",
    !(data.structural_flags || []).some(f => f.code === "NIGHT_COUNT_MISMATCH"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
