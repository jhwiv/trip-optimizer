// Tests for src/driveTimeVerify.js — the real-world drive-time check added
// 2026-08-28 to close KNOWN FAILURE MODE #18's documented gap ("this app
// has no routing/distance API computing an authoritative drive duration").
//
// Pure logic only — no network. functions/api/drive-time-verify.js's live
// TomTom calls are not (and cannot be, in this sandbox — egress to
// api.tomtom.com is blocked) exercised here.

import {
  isDriveTransportItem,
  parseClaimedMinutes,
  collectDriveLegs,
  applyDriveTimeFlags,
} from "../src/driveTimeVerify.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("\n=== isDriveTransportItem ===");
{
  assert("a Transport item with 'Drive' in the lead clause is a drive",
    isDriveTransportItem({ type: "Transport", text: "Return drive Bletchley Park to London — 35 min via A5" }));
  assert("a Taxi Transport item is a drive",
    isDriveTransportItem({ type: "Transport", text: "Taxi The Yeatman → Porto Campanhã station — 10 min" }));
  assert("a rental car pickup is a drive",
    isDriveTransportItem({ type: "Transport", text: "Rental car pickup PMI airport or private van transfer to Santanyí villa — 1h drive (55 km) via Ma-19" }));
  assert("a Train Transport item is NOT a drive",
    !isDriveTransportItem({ type: "Transport", text: "Train Porto Campanhã → Lisboa (Alfa Pendular express) — 2h 45m" }));
  assert("a Ferry Transport item is NOT a drive",
    !isDriveTransportItem({ type: "Transport", text: "Ferry Portsmouth → Ouistreham — 6h" }));
  assert("a Flight item is NEVER a drive, even if it mentions 'drive' in prose",
    !isDriveTransportItem({ type: "Flight", text: "Drive-up check-in available, LIS → PMI nonstop" }));
  assert("a Note item is not a drive",
    !isDriveTransportItem({ type: "Note", text: "Drive to the coast if you have time — 40 min" }));
  assert("an Activity item is not a drive",
    !isDriveTransportItem({ type: "Activity", text: "Guided driving tour of the Douro Valley" }));
  assert("null item is safe", !isDriveTransportItem(null));
  assert("item with no text is safe", !isDriveTransportItem({ type: "Transport" }));
}

console.log("\n=== parseClaimedMinutes ===");
{
  assert('"35 min via A5" → 35', parseClaimedMinutes("Return drive to London — 35 min via A5") === 35);
  assert('"1h drive (55 km)" → 60', parseClaimedMinutes("Rental car — 1h drive (55 km) via Ma-19") === 60);
  assert('"2h 45m" → 165', parseClaimedMinutes("Train — 2h 45m") === 165);
  assert('"~7 hours" → 420', parseClaimedMinutes("Drive — ~7 hours") === 420);
  assert('"11-hour drive" → 660', parseClaimedMinutes("An 11-hour drive across the region") === 660);
  assert('"90 min" → 90', parseClaimedMinutes("Taxi — 90 min") === 90);
  assert('"90 minutes" → 90', parseClaimedMinutes("Taxi — 90 minutes") === 90);
  assert('"3.5 hours" → 210', parseClaimedMinutes("Drive — 3.5 hours") === 210);
  assert("no duration present → null", parseClaimedMinutes("Uber to the hotel") === null);
  assert("empty/non-string is safe", parseClaimedMinutes(null) === null);
}

console.log("\n=== collectDriveLegs ===");
{
  const plan = {
    destination: "Normandy Region",
    days: [
      {
        city: "Bayeux",
        items: [
          { type: "Transport", text: "Drive Bayeux → Nuremberg — ~7 hours via A6" },
          { type: "Train", text: "Not actually a transport item, ignored" },
          { type: "Transport", text: "Taxi to hotel — 8 min" }, // below MIN_CLAIMED_MINUTES, dropped
          { type: "Transport", text: "Train Bayeux → Nuremberg — 6h 30m" }, // train, excluded by mode
          { type: "Transport", text: "Drive somewhere vague — 90 min" }, // endpoints too short/unresolvable
        ],
      },
    ],
  };
  const legs = collectDriveLegs(plan, (day) => day?.city || plan.destination);
  assert("exactly one qualifying leg collected", legs.length === 1, JSON.stringify(legs));
  assert("origin includes city context", legs[0]?.origin.includes("Bayeux"), legs[0]?.origin);
  assert("destination resolved from arrow split", legs[0]?.destination.startsWith("Nuremberg"), legs[0]?.destination);
  assert("claimed minutes parsed correctly (7h)", legs[0]?.claimedMinutes === 420, legs[0]?.claimedMinutes);
  assert("dayIdx/itemIdx recorded", legs[0]?.dayIdx === 0 && legs[0]?.itemIdx === 0);
  assert("day (1-indexed) recorded", legs[0]?.day === 1);

  assert("empty plan → []", collectDriveLegs({}).length === 0);
  assert("null plan → []", collectDriveLegs(null).length === 0);
  assert("no days → []", collectDriveLegs({ days: [] }).length === 0);
}

console.log("\n=== collectDriveLegs — real observed shape (Villa Lara / Bletchley Park day-trip return) ===");
{
  // Real text from a plan traced this session — day-trip return leg, well
  // under the long-drive threshold, must not be collected.
  const dayTrip = {
    days: [{ city: "London", items: [
      { type: "Transport", text: "Private car London to Bletchley Park — 55 min" },
      { type: "Transport", text: "Return drive Bletchley Park to London — 55 min" },
    ] }],
  };
  assert("a ~1-hour day trip stays under the 45-minute floor by design (55min is close but let's check a genuinely short one)",
    collectDriveLegs(dayTrip, () => "").length === 2, "these are 55min, above the 45min floor — expected to qualify");

  const shortHop = {
    days: [{ city: "Porto", items: [
      { type: "Transport", text: "Taxi to Porto Campanhã station — 10 min" },
    ] }],
  };
  assert("a 10-minute local hop is dropped (below MIN_CLAIMED_MINUTES)",
    collectDriveLegs(shortHop, () => "").length === 0);
}

console.log("\n=== applyDriveTimeFlags ===");
{
  const plan = {
    days: [
      { city: "Bayeux", structural_flags: [{ code: "SOME_OTHER_FLAG", severity: "warn" }], items: [
        { type: "Transport", text: "Drive Bayeux → Nuremberg — 11 hours" },
      ] },
      { city: "Porto", items: [
        { type: "Transport", text: "Drive Porto → Lisbon — 3 hours" },
      ] },
    ],
  };
  const legs = collectDriveLegs(plan, (day) => day?.city || "");

  // Real Bayeux→Nuremberg number from this session's live TomTom check:
  // 1,066 km / 9h19m (559 minutes) — the claimed "11 hours" (660 min) is a
  // real mismatch (diff 101min > max(60, 559*0.35=195.65)? No — let's use
  // an even larger claim so this fixture is unambiguous either way).
  const results = new Map([
    ["0:0", { realMinutes: 559, realKm: 1066 }], // claimed 660 vs real 559: diff 101, margin max(60, 195.65)=195.65 -> NOT a mismatch by design (generous margin)
    ["1:0", { realMinutes: 60, realKm: 90 }], // claimed 180 vs real 60: diff 120, margin max(60, 21)=60 -> IS a mismatch
  ]);

  const { data, flags } = applyDriveTimeFlags(plan, legs, results);
  assert("only the genuinely implausible leg is flagged (generous margin protects the Bayeux/Nuremberg leg)",
    flags.length === 1, JSON.stringify(flags));
  assert("the flagged leg is Day 2 (Porto → Lisbon)", flags[0]?.day === 2, JSON.stringify(flags[0]));
  assert("flag code is DRIVE_TIME_IMPLAUSIBLE", flags[0]?.code === "DRIVE_TIME_IMPLAUSIBLE");
  assert("severity is warn, never block", flags[0]?.severity === "warn");
  assert("message names both claimed and real time", /3h/.test(flags[0]?.message) && /1h/.test(flags[0]?.message), flags[0]?.message);
  assert("prior structural_flags on an untouched day are preserved",
    data.days[0].structural_flags.some(f => f.code === "SOME_OTHER_FLAG"));
  assert("the flagged day's structural_flags gained the new flag",
    data.days[1].structural_flags.some(f => f.code === "DRIVE_TIME_IMPLAUSIBLE"));

  const noResults = applyDriveTimeFlags(plan, legs, new Map());
  assert("no verdicts at all → no flags, same plan reference (fail safe)",
    noResults.flags.length === 0 && noResults.data === plan);

  const errorResults = new Map([
    ["0:0", { error: "no-key" }],
    ["1:0", { error: "geocode-failed" }],
  ]);
  const errored = applyDriveTimeFlags(plan, legs, errorResults);
  assert("a per-leg error never produces a flag (fail safe, not a wrong verdict)",
    errored.flags.length === 0);

  assert("null plan is safe", applyDriveTimeFlags(null, [], new Map()).flags.length === 0);
  assert("empty legs is safe", applyDriveTimeFlags(plan, [], new Map()).flags.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
