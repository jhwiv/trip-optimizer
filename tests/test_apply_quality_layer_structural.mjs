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
import { findContinuityIssues, findStructuralBlockingIssues, dedupeChunkBoundaryArrivals } from "../src/dayContinuityCheck.js";
import { deriveCityNights, reconcileMetaNights, parseMetaNightsBreakdown } from "../src/legNights.js";
import { assertWeekdayClaims } from "../src/dateFacts.js";
import { findFlightTimeMismatches } from "../src/flightTimeConsistency.js";
import { findImplausibleBookingUrls } from "../src/bookingUrlCheck.js";
import { findUnverifiedFlights } from "../src/flightResolver.js";
import { findCarrierCodeMismatches } from "../src/carrierCodeCheck.js";
import { findBudgetTotalMismatches } from "../src/budgetTotalsCheck.js";
import { findOverconfidentLanguage } from "../src/overconfidentLanguageCheck.js";
import { findBudgetCeilingExceeded } from "../src/budgetCeilingCheck.js";

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
function structuralQualityTail(input, inputs) {
  const fixes = [];
  const warnings = [];
  let out = { ...input, days: Array.isArray(input?.days) ? input.days : input?.days };

  const weekdayFlags = [];
  if (inputs?.basics?.startDate) {
    const wk = assertWeekdayClaims(out, inputs.basics.startDate);
    out = wk.plan;
    weekdayFlags.push(...wk.flags);
    fixes.push(...wk.corrections);
  }

  let dedupFlags = [];
  if (Array.isArray(out.days)) {
    const dedup = dedupeChunkBoundaryArrivals(out);
    out = dedup.plan;
    fixes.push(...dedup.fixes);
    dedupFlags = dedup.flags;
  }

  if (Array.isArray(out.days)) {
    const structural = [
      ...findContinuityIssues(out),
      ...findFlightTimeMismatches(out),
      ...findImplausibleBookingUrls(out),
      ...findCarrierCodeMismatches(out),
      ...findUnverifiedFlights(out),
      ...weekdayFlags,
      ...dedupFlags,
    ];
    if (structural.length > 0) {
      out.days = out.days.map((day, dayIdx) => {
        const dayFlags = structural.filter(f => f.dayIdx === dayIdx);
        if (dayFlags.length === 0) return day;
        const prior = Array.isArray(day?.structural_flags) ? day.structural_flags : [];
        return { ...day, structural_flags: [...prior, ...dayFlags] };
      });
      for (const f of structural) warnings.push(`Day ${f.day}: ${f.message}`);
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

  // Contradiction QA (ROUTESMITH ITINERARY-QUALITY UPGRADE §15) — trip-level
  // internal-consistency checks, same shape as the NIGHT_COUNT_MISMATCH check
  // just above: pure functions in their own files (real unit-test coverage,
  // not the hand-copied-mirror convention this closure otherwise requires),
  // wired in here so they see the fully normalized plan (post cost_estimate
  // normalization, post city normalization, post activity-cap trim).
  const contradictionFlags = [
    ...findBudgetTotalMismatches(out),
    ...findOverconfidentLanguage(out),
    ...findBudgetCeilingExceeded(out, inputs),
  ];
  if (contradictionFlags.length > 0) {
    const prior = Array.isArray(out.structural_flags) ? out.structural_flags : [];
    out.structural_flags = [...prior, ...contradictionFlags];
    for (const f of contradictionFlags) warnings.push(f.message);
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
  assert("CITY_BACKTRACK present", codes.includes("CITY_BACKTRACK"), JSON.stringify(codes));
  assert("VEHICLE_STATE_CONFLICT present", codes.includes("VEHICLE_STATE_CONFLICT"), JSON.stringify(codes));
  assert("clean days get no structural_flags", !data.days[1].structural_flags);
  assert("day.flags string array is untouched", data.days[6].flags === undefined);
  assert("each finding is echoed as a warning",
    qc.warnings.filter(w => /^Day 7: /.test(w)).length === 4, JSON.stringify(qc.warnings));
}

console.log("\n=== failing plan: gate blocks the export ===");
{
  const { data } = structuralQualityTail(fixture("plan_day67_collision.json"));
  const err = exportGateError(data);

  assert("gate throws", err instanceof Error);
  assert("code is VERIFICATION_BLOCK", err.code === "VERIFICATION_BLOCK");
  // Day 1's UA934 row carries the header/depart_time mismatch (report bug 4),
  // so the same fixture trips the flight validator as well as the three
  // continuity rules.
  assert("only the four block-severity flags count", err.issues.length === 4, JSON.stringify(err.issues.map(i => i.flag.code)));
  assert("the warn-severity vehicle flag does not block",
    !err.issues.some(i => i.flag.code === "VEHICLE_STATE_CONFLICT"));
  assert("message counts both arms", /0 venue verification, 4 itinerary structure/.test(err.message), err.message);
  assert("message no longer claims a venue failed verification",
    !/venues? failed verification/.test(err.message), err.message);
  assert("message names the offending day", /Day 7:/.test(err.message), err.message);

  const withVenue = exportGateError(data, [
    { dayIdx: 3, name: "La Rapiere", flag: { code: "CLOSED_PERMANENTLY" } },
  ]);
  assert("venue and structural issues are counted separately",
    /5 blocking issues — 1 venue verification, 4 itinerary structure/.test(withVenue.message), withVenue.message);
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

console.log("\n=== every structural validator fires through one pass ===");
{
  // One plan carrying every failure the 2026-07-28 build shipped, so the tail
  // is proven to run all of them and to route each flag to the right day.
  // Oct 5 2026 is a Monday; the plan claims it is a Tuesday.
  const plan = {
    meta: "4 days · 3 nights (1+2)",
    cities: [{ name: "London", nights: 2 }, { name: "Amsterdam", nights: 1 }],
    days: [
      {
        day: 1,
        city: "London",
        items: [
          {
            type: "Flight",
            time: "09:30",
            text: "UA934 EWR → LHR",
            flight: { flight_number: "UA934", from_airport: "EWR", to_airport: "LHR", depart_time: "08:20", arrive_time: "20:40" },
          },
        ],
      },
      {
        day: 2,
        city: "London",
        notes: "Dinner tonight — this is a Tuesday, confirm the kitchen is open.",
        items: [
          {
            type: "Activity",
            time: "14:00",
            text: "WWII walking tour",
            location: "London",
            contact: { booking_url: "https://www.viator.com/tours/London/walk/d737-123456LONDONWW2" },
          },
        ],
      },
      {
        day: 3,
        city: "Amsterdam",
        items: [
          {
            type: "Flight",
            time: "11:00",
            text: "Fly London to Amsterdam",
            flight: { flight_number: "AF7652", from_airport: "LHR", to_airport: "AMS", depart_time: "11:00", arrive_time: "13:35", _flightUnverified: true, _unverifiedReason: "no-scheduled-route" },
          },
          { type: "Hotel", time: "16:30", text: "Check in", location: "Amsterdam", hotel: { name: "Amsterdam Marriott Hotel" } },
        ],
      },
      { day: 4, city: "Amsterdam", items: [] },
    ],
  };

  const { data, qc } = structuralQualityTail(plan, { basics: { startDate: "2026-10-04" } });
  const codesOn = (i) => (data.days[i].structural_flags || []).map(f => f.code);

  assert("FLIGHT_TIME_MISMATCH on Day 1", codesOn(0).includes("FLIGHT_TIME_MISMATCH"), JSON.stringify(codesOn(0)));
  assert("BOOKING_URL_IMPLAUSIBLE on Day 2", codesOn(1).includes("BOOKING_URL_IMPLAUSIBLE"), JSON.stringify(codesOn(1)));
  assert("WEEKDAY_CLAIM_MISMATCH on Day 2", codesOn(1).includes("WEEKDAY_CLAIM_MISMATCH"), JSON.stringify(codesOn(1)));
  assert("FLIGHT_UNVERIFIED on Day 3", codesOn(2).includes("FLIGHT_UNVERIFIED"), JSON.stringify(codesOn(2)));
  assert("NIGHT_COUNT_MISMATCH at plan level",
    (data.structural_flags || []).some(f => f.code === "NIGHT_COUNT_MISMATCH"), JSON.stringify(data.structural_flags));

  assert("the wrong weekday claim is corrected in place",
    /this is a Monday/.test(data.days[1].notes), data.days[1].notes);
  assert("the correction is logged as a fix",
    qc.fixes.some(f => /Tuesday/.test(f) && /Monday/.test(f)), JSON.stringify(qc.fixes));

  const err = exportGateError(data, [
    { dayIdx: 1, name: "La Rapiere", flag: { code: "CLOSED_ON_THIS_DAY" } },
  ]);
  assert("both block flags reach the gate",
    err.issues.filter(i => ["FLIGHT_TIME_MISMATCH", "BOOKING_URL_IMPLAUSIBLE"].includes(i.flag.code)).length === 2,
    JSON.stringify(err.issues.map(i => i.flag.code)));
  // Day 3's flight is marked no-scheduled-route — the API answered and knew of
  // no service. That is a block now, alongside the other two.
  assert("the no-scheduled-route flight blocks too",
    err.issues.some(i => i.flag.code === "FLIGHT_UNVERIFIED"),
    JSON.stringify(err.issues.map(i => i.flag.code)));
  assert("the genuinely-warn flags still do not block",
    !err.issues.some(i => ["WEEKDAY_CLAIM_MISMATCH", "NIGHT_COUNT_MISMATCH"].includes(i.flag.code)),
    JSON.stringify(err.issues.map(i => i.flag.code)));
  assert("an anchored closure blocks alongside them",
    /1 venue verification, 3 itinerary structure/.test(err.message), err.message);
}

console.log("\n=== the LOT/UA940 card reaches the gate as a block ===");
{
  // Report §1, verbatim from the 2026-07-28 PDF: Day 1 read "LOT flight from
  // Newark to London Heathrow" over UA940, note "Book directly on lot.com".
  // Nothing confirmed the number, so the validator strips it and blocks.
  const plan = {
    days: [{
      day: 1,
      city: "London",
      items: [{
        type: "Flight",
        time: "21:00",
        text: "LOT flight from Newark to London Heathrow via Warsaw",
        flight: {
          carrier: "LOT",
          flight_number: "UA940",
          from_airport: "EWR",
          to_airport: "LHR",
          depart_time: "21:00",
          arrive_time: "09:20",
          confirmation_note: "Book directly on lot.com.",
          _flightUnverified: true,
        },
      }],
    }],
  };

  const { data, qc } = structuralQualityTail(plan);
  const codes = (data.days[0].structural_flags || []).map(f => f.code);
  assert("CARRIER_CODE_MISMATCH lands on the day", codes.includes("CARRIER_CODE_MISMATCH"), JSON.stringify(codes));

  const err = exportGateError(data);
  assert("the gate blocks the export", err instanceof Error, String(err));
  assert("the mismatch is one of the blocking issues",
    err.issues.some(i => i.flag.code === "CARRIER_CODE_MISMATCH"), JSON.stringify(err.issues.map(i => i.flag.code)));
  assert("the block count includes it",
    /1 blocking issue — 0 venue verification, 1 itinerary structure/.test(err.message), err.message);
  assert("the fabricated number is gone from the plan",
    data.days[0].items[0].flight.flight_number === null,
    String(data.days[0].items[0].flight.flight_number));
  assert("the finding is echoed as a warning",
    qc.warnings.some(w => /UA940/.test(w)), JSON.stringify(qc.warnings));
}

console.log("\n=== the LH2224 CDG→NUE card reaches the gate as a block ===");
{
  // Report §2, verbatim from the 2026-07-28 PDF: "LH 2224 CDG Approx. 1:30 PM
  // → NUE Approx. 3:00 PM · nonstop", with a one-line UNVERIFIED caveat under
  // an 11pt flight number. Lufthansa does not fly CDG→NUE and the schedule API
  // said so. A warn let it print; it blocks now.
  const plan = {
    days: [{
      day: 4,
      city: "Nuremberg",
      items: [{
        type: "Flight",
        time: "13:30",
        text: "Fly Paris to Nuremberg",
        flight: {
          carrier: "Lufthansa",
          flight_number: "LH2224",
          from_airport: "CDG",
          to_airport: "NUE",
          depart_time: "13:30",
          arrive_time: "15:00",
          _flightUnverified: true,
          _unverifiedReason: "no-scheduled-route",
        },
      }],
    }],
  };

  const { data } = structuralQualityTail(plan);
  const flags = data.days[0].structural_flags || [];
  const unverified = flags.find(f => f.code === "FLIGHT_UNVERIFIED");
  assert("FLIGHT_UNVERIFIED raised", !!unverified, JSON.stringify(flags.map(f => f.code)));
  assert("its severity is block", unverified?.severity === "block", unverified?.severity);
  assert("the carrier check stays quiet — LH2224 really is a Lufthansa number",
    !flags.some(f => String(f.code).startsWith("CARRIER_CODE")), JSON.stringify(flags.map(f => f.code)));

  const err = exportGateError(data);
  assert("the gate blocks the export", err instanceof Error, String(err));
  assert("the flight is the blocking issue",
    err.issues.length === 1 && err.issues[0].flag.code === "FLIGHT_UNVERIFIED",
    JSON.stringify(err.issues.map(i => i.flag.code)));
  assert("the message names the flight",
    /Lufthansa LH2224/.test(err.message), err.message);

  // The same flight with a reason we could not establish stays exportable.
  const unknown = structuredClone(plan);
  unknown.days[0].items[0].flight._unverifiedReason = "schedule-unavailable";
  assert("schedule-unavailable does not block",
    exportGateError(structuralQualityTail(unknown).data) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
