// Tests for src/dayContinuityCheck.js — the day-to-day structural validator.
//
// The plan under test (tests/fixtures/plan_day67_collision.json) is a minimal
// reproduction of the 2026-07-28 London → Normandy → Amsterdam → Lisbon build:
// Day 6 drives to Amsterdam and checks into the Marriott, Day 7 wakes up back
// in Normandy, returns the rental there, flies to Amsterdam and checks into the
// same Marriott again. Nothing in the pipeline caught it, because every
// pre-existing validator looks at a single venue or a single day.
//
// Pure module; no DOM, no network.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDayLegs, findContinuityIssues, findStructuralBlockingIssues } from "../src/dayContinuityCheck.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const collision = fixture("plan_day67_collision.json");
const clean = fixture("plan_linear_clean.json");

const byCode = (issues) => {
  const m = new Map();
  for (const i of issues) m.set(i.code, [...(m.get(i.code) || []), i]);
  return m;
};

console.log("=== buildDayLegs ===");
{
  const legs = buildDayLegs(collision);
  assert("one leg per day", legs.length === collision.days.length, String(legs.length));
  assert("day numbers are 1-based", legs[0].day === 1 && legs[0].dayIdx === 0);
  assert("Day 6 city carried through", legs[5].city === "Amsterdam", legs[5].city);
  assert("Day 6 records the drive into Amsterdam",
    legs[5].transitions.some(t => t.to === "Amsterdam"), JSON.stringify(legs[5].transitions));
  assert("Day 6 records the Marriott check-in",
    legs[5].hotelIn?.name === "Amsterdam Marriott Hotel", JSON.stringify(legs[5].hotelIn));
  assert("Day 6 records the Villa Lara check-out",
    legs[5].hotelOut?.name === "Villa Lara Hotel", JSON.stringify(legs[5].hotelOut));
  assert("Day 7 records the flight into Amsterdam",
    legs[6].transitions.some(t => t.to === "Amsterdam"), JSON.stringify(legs[6].transitions));
  assert("Day 7 has transport", legs[6].hasTransport === true);
  assert("Day 2 has no transport", legs[1].hasTransport === false);
  assert("rental-return Note is not a transition",
    legs[6].transitions.every(t => t.to !== "Bayeux"), JSON.stringify(legs[6].transitions));
}

console.log("\n=== findContinuityIssues — Day 6/7 collision ===");
{
  const issues = findContinuityIssues(collision);
  const codes = byCode(issues);

  assert("DUPLICATE_CHECKIN raised", codes.has("DUPLICATE_CHECKIN"), JSON.stringify([...codes.keys()]));
  assert("DUPLICATE_CHECKIN is block", codes.get("DUPLICATE_CHECKIN")?.[0].severity === "block");
  assert("DUPLICATE_CHECKIN is on Day 7", codes.get("DUPLICATE_CHECKIN")?.[0].day === 7);
  assert("DUPLICATE_CHECKIN names the property",
    codes.get("DUPLICATE_CHECKIN")?.[0].target === "Amsterdam Marriott Hotel");
  assert("DUPLICATE_CHECKIN message cites both days",
    /Day 6\b/.test(codes.get("DUPLICATE_CHECKIN")?.[0].message || "") &&
    /Day 7\b/.test(codes.get("DUPLICATE_CHECKIN")?.[0].message || ""),
    codes.get("DUPLICATE_CHECKIN")?.[0].message);

  assert("ORPHANED_TRANSITION raised", codes.has("ORPHANED_TRANSITION"), JSON.stringify([...codes.keys()]));
  assert("ORPHANED_TRANSITION is block", codes.get("ORPHANED_TRANSITION")?.[0].severity === "block");
  assert("ORPHANED_TRANSITION is on Day 7", codes.get("ORPHANED_TRANSITION")?.[0].day === 7);
  assert("ORPHANED_TRANSITION names the city", codes.get("ORPHANED_TRANSITION")?.[0].target === "Amsterdam");

  assert("VEHICLE_STATE_CONFLICT raised", codes.has("VEHICLE_STATE_CONFLICT"));
  assert("VEHICLE_STATE_CONFLICT is warn, not block",
    codes.get("VEHICLE_STATE_CONFLICT")?.[0].severity === "warn");
  assert("VEHICLE_STATE_CONFLICT names the drop-off city",
    codes.get("VEHICLE_STATE_CONFLICT")?.[0].target === "Bayeux");

  assert("CITY_BACKTRACK raised", codes.has("CITY_BACKTRACK"), JSON.stringify([...codes.keys()]));
  assert("CITY_BACKTRACK is block", codes.get("CITY_BACKTRACK")?.[0].severity === "block");
  assert("CITY_BACKTRACK is on Day 7", codes.get("CITY_BACKTRACK")?.[0].day === 7);
  assert("CITY_BACKTRACK names the abandoned city",
    codes.get("CITY_BACKTRACK")?.[0].target === "Bayeux", codes.get("CITY_BACKTRACK")?.[0].target);
  assert("CITY_BACKTRACK reports each city once per day",
    codes.get("CITY_BACKTRACK")?.length === 1, JSON.stringify(codes.get("CITY_BACKTRACK")));

  // The catastrophic bug is caught by the two hotel/travel codes. It is NOT
  // caught by DAY_CITY_DISCONTINUITY: Day 7's declared city matches Day 6's,
  // and Day 7 does contain a Flight item, so that rule cannot see it. This
  // assertion pins the known limitation so it can't silently change.
  assert("DAY_CITY_DISCONTINUITY does not fire here (Day 7 has a flight)",
    !codes.has("DAY_CITY_DISCONTINUITY"), JSON.stringify([...codes.keys()]));

  assert("every issue carries the flag shape",
    issues.every(i => i.code && i.severity && typeof i.dayIdx === "number" && typeof i.day === "number" && i.message),
    JSON.stringify(issues[0]));
}

console.log("\n=== findContinuityIssues — clean linear trip ===");
{
  const issues = findContinuityIssues(clean);
  assert("zero findings on a sound plan", issues.length === 0, JSON.stringify(issues));
}

console.log("\n=== DAY_CITY_DISCONTINUITY ===");
{
  const teleport = {
    cities: [{ name: "London" }, { name: "Paris" }],
    days: [
      { day: 1, city: "London", items: [{ type: "Activity", text: "Tate Modern" }] },
      { day: 2, city: "Paris", items: [{ type: "Activity", text: "Musée d'Orsay" }] },
    ],
  };
  const issues = findContinuityIssues(teleport);
  assert("city change with no transport is flagged",
    issues.some(i => i.code === "DAY_CITY_DISCONTINUITY"), JSON.stringify(issues));
  assert("DAY_CITY_DISCONTINUITY is block",
    issues.find(i => i.code === "DAY_CITY_DISCONTINUITY")?.severity === "block");
  assert("flagged on the arriving day",
    issues.find(i => i.code === "DAY_CITY_DISCONTINUITY")?.day === 2);

  const withTrain = structuredClone(teleport);
  withTrain.days[1].items.unshift({ type: "Transport", text: "Eurostar London → Paris" });
  assert("same change with a Transport item is not flagged",
    !findContinuityIssues(withTrain).some(i => i.code === "DAY_CITY_DISCONTINUITY"));

  const missingCity = structuredClone(teleport);
  missingCity.days[1].city = "";
  assert("blank city is skipped rather than guessed",
    !findContinuityIssues(missingCity).some(i => i.code === "DAY_CITY_DISCONTINUITY"));
}

console.log("\n=== DAY_CITY_DISCONTINUITY — arrow-format transit day (2026-08-04 regression) ===");
{
  // Real observed case: a 14-night 5-city build. Day 8 is a transit day whose
  // own `city` field is the arrow-formatted "Normandy → Nuremberg" (per
  // DAY_SCHEMA's documented convention), and its Flight item's text carries a
  // trailing comma-qualifier ("Fly Paris CDG → Nuremberg, nonstop"). Day 9's
  // city is the plain "Nuremberg, Germany". Two compounding bugs blocked this
  // correct, continuous itinerary:
  //   1. the comma qualifier defeated resolveCity's substring match against
  //      "Nuremberg, Germany" ("Nuremberg, nonstop" is neither a substring of
  //      nor a superstring of "Nuremberg, Germany");
  //   2. canonicalCities() added every day's raw city field to the resolution
  //      list, including transit labels like "Normandy → Nuremberg" — whose
  //      raw text literally contains "Nuremberg" as a substring — so once (1)
  //      was fixed, the destination match landed on the transit label instead
  //      of the real city.
  const transitDay = {
    cities: [{ name: "Normandy" }, { name: "Nuremberg, Germany" }],
    days: [
      { day: 1, city: "Normandy", items: [{ type: "Activity", text: "Utah Beach" }] },
      {
        day: 2,
        city: "Normandy → Nuremberg",
        items: [
          { type: "Hotel", text: "Check out of Le Clos Fleuri", hotel: { name: "Le Clos Fleuri" } },
          { type: "Transport", text: "Drive to Paris CDG" },
          { type: "Flight", text: "Fly Paris CDG → Nuremberg, nonstop", flight: { to_airport: "NUE", from_airport: "CDG" } },
        ],
      },
      { day: 3, city: "Nuremberg, Germany", items: [{ type: "Activity", text: "Nuremberg Castle" }] },
    ],
  };
  const issues = findContinuityIssues(transitDay);
  assert("no DAY_CITY_DISCONTINUITY on a correctly-continuous arrow-format transit day",
    !issues.some(i => i.code === "DAY_CITY_DISCONTINUITY"), JSON.stringify(issues));

  const legs = buildDayLegs(transitDay);
  assert("the Flight's destination resolves to the real city, not the transit label",
    legs[1].transitions.some(t => t.to === "Nuremberg, Germany"), JSON.stringify(legs[1].transitions));

  const stillTeleports = structuredClone(transitDay);
  stillTeleports.days[2].city = "Porto, Portugal";
  assert("a genuine discontinuity after a transit day is still flagged",
    findContinuityIssues(stillTeleports).some(i => i.code === "DAY_CITY_DISCONTINUITY"),
    JSON.stringify(findContinuityIssues(stillTeleports)));
}

console.log("\n=== DUPLICATE_CHECKIN window ===");
{
  const base = (gap) => ({
    cities: [{ name: "Rome" }],
    days: Array.from({ length: gap + 1 }, (_, i) => ({
      day: i + 1,
      city: "Rome",
      items: i === 0 || i === gap
        ? [{ type: "Hotel", text: "Check in at Hotel de Russie", hotel: { name: "Hotel de Russie" } }]
        : [{ type: "Activity", text: "Borghese Gallery" }],
    })),
  });
  assert("re-check-in the next day is flagged",
    findContinuityIssues(base(1)).some(i => i.code === "DUPLICATE_CHECKIN"));
  assert("re-check-in two days later is flagged",
    findContinuityIssues(base(2)).some(i => i.code === "DUPLICATE_CHECKIN"));
  assert("a genuine return later in the trip is not flagged",
    !findContinuityIssues(base(5)).some(i => i.code === "DUPLICATE_CHECKIN"));

  const withCheckout = base(2);
  withCheckout.days[1].items.push({ type: "Hotel", text: "Check out of Hotel de Russie", hotel: { name: "Hotel de Russie" } });
  assert("an intervening check-out clears the flag",
    !findContinuityIssues(withCheckout).some(i => i.code === "DUPLICATE_CHECKIN"), JSON.stringify(findContinuityIssues(withCheckout)));
}

console.log("\n=== ORPHANED_TRANSITION scoping ===");
{
  const sameDay = {
    cities: [{ name: "Paris" }, { name: "Amsterdam" }],
    days: [
      { day: 1, city: "Paris", items: [{ type: "Activity", text: "Louvre" }] },
      { day: 2, city: "Amsterdam", items: [
        { type: "Transport", text: "Train Paris → Amsterdam" },
        { type: "Transport", text: "Taxi to Amsterdam Centraal" },
      ] },
    ],
  };
  assert("two arrivals into one city on the SAME day are one journey",
    !findContinuityIssues(sameDay).some(i => i.code === "ORPHANED_TRANSITION"),
    JSON.stringify(findContinuityIssues(sameDay)));

  const roundTrip = {
    cities: [{ name: "Amsterdam" }, { name: "Bruges" }],
    days: [
      { day: 1, city: "Amsterdam", items: [{ type: "Flight", text: "Fly Newark → Amsterdam" }] },
      { day: 2, city: "Bruges", items: [{ type: "Transport", text: "Train Amsterdam → Bruges" }] },
      { day: 3, city: "Amsterdam", items: [{ type: "Transport", text: "Train Bruges → Amsterdam" }] },
    ],
  };
  assert("a legitimate A→B→A return is not flagged",
    !findContinuityIssues(roundTrip).some(i => i.code === "ORPHANED_TRANSITION"),
    JSON.stringify(findContinuityIssues(roundTrip)));
}

console.log("\n=== CITY_BACKTRACK ===");
{
  // The belt-and-suspenders rule for the Day 6/7 shape: both days declare the
  // same city, so DAY_CITY_DISCONTINUITY is blind, but the day's items are
  // physically in a city the plan finished with.
  const backtrack = {
    cities: [{ name: "Bayeux" }, { name: "Amsterdam" }],
    days: [
      { day: 1, city: "Bayeux", items: [{ type: "Activity", text: "Bayeux Tapestry", location: "Bayeux" }] },
      { day: 2, city: "Amsterdam", items: [{ type: "Transport", text: "Drive Bayeux → Amsterdam" }] },
      { day: 3, city: "Amsterdam", items: [{ type: "Activity", text: "Pointe du Hoc", location: "Bayeux" }] },
    ],
  };
  const issues = findContinuityIssues(backtrack);
  const b = issues.filter(i => i.code === "CITY_BACKTRACK");
  assert("an item in an abandoned city is flagged", b.length === 1, JSON.stringify(issues));
  assert("severity is block", b[0]?.severity === "block");
  assert("flagged on the offending day", b[0]?.day === 3);
  assert("message names the city and the day", /Bayeux/.test(b[0]?.message || "") && /Day 3/.test(b[0]?.message || ""), b[0]?.message);

  // Departure mornings are the obvious false positive: the day starts in the
  // city it is leaving, so its first items are legitimately located there.
  const departureMorning = {
    cities: [{ name: "Bayeux" }, { name: "Amsterdam" }],
    days: [
      { day: 1, city: "Bayeux", items: [{ type: "Activity", text: "Bayeux Tapestry", location: "Bayeux" }] },
      { day: 2, city: "Amsterdam", items: [
        { type: "Breakfast", text: "Breakfast at the hotel", location: "Bayeux" },
        { type: "Transport", text: "Drive Bayeux → Amsterdam" },
        { type: "Hotel", text: "Check in", location: "Amsterdam" },
      ] },
    ],
  };
  assert("a departure morning in the city being left is not flagged",
    !findContinuityIssues(departureMorning).some(i => i.code === "CITY_BACKTRACK"),
    JSON.stringify(findContinuityIssues(departureMorning)));

  // Free text must never be read as a location — only item.location is.
  const pubName = structuredClone(backtrack);
  pubName.days[2].items = [{ type: "Dinner", text: "A Bayeux-style bistro", location: "Amsterdam" }];
  assert("a city named in prose is not a trip back there",
    !findContinuityIssues(pubName).some(i => i.code === "CITY_BACKTRACK"),
    JSON.stringify(findContinuityIssues(pubName)));

  // Transport items name their origin by design.
  const originNamed = structuredClone(backtrack);
  originNamed.days[2].items = [{ type: "Transport", text: "Return leg", location: "Bayeux" }];
  assert("Transport items are exempt",
    !findContinuityIssues(originNamed).some(i => i.code === "CITY_BACKTRACK"),
    JSON.stringify(findContinuityIssues(originNamed)));

  // A planned return is a return, not a backtrack.
  const plannedReturn = structuredClone(backtrack);
  plannedReturn.days[2].city = "Bayeux";
  plannedReturn.days[2].items.unshift({ type: "Transport", text: "Drive Amsterdam → Bayeux" });
  assert("travelling back on purpose is not flagged",
    !findContinuityIssues(plannedReturn).some(i => i.code === "CITY_BACKTRACK"),
    JSON.stringify(findContinuityIssues(plannedReturn)));

  assert("the clean linear plan stays clean",
    !findContinuityIssues(clean).some(i => i.code === "CITY_BACKTRACK"));
}

console.log("\n=== VEHICLE_STATE_CONFLICT ===");
{
  const plan = {
    cities: [{ name: "Bayeux" }, { name: "Amsterdam" }],
    days: [
      { day: 1, city: "Bayeux", items: [{ type: "Activity", text: "Bayeux Tapestry" }] },
      { day: 2, city: "Amsterdam", items: [
        { type: "Transport", text: "Drive Bayeux → Amsterdam" },
        { type: "Note", text: "Return the rental car", location: "Bayeux, France" },
      ] },
    ],
  };
  const issues = findContinuityIssues(plan);
  const v = issues.filter(i => i.code === "VEHICLE_STATE_CONFLICT");
  assert("drop-off in a city the plan has left is flagged", v.length === 1, JSON.stringify(issues));
  assert("severity is warn — the plan is still buildable", v[0]?.severity === "warn");
  assert("no block-severity flag from this rule alone",
    !issues.some(i => i.code === "VEHICLE_STATE_CONFLICT" && i.severity === "block"));

  const sameCity = structuredClone(plan);
  sameCity.days[1].items[1].location = "Amsterdam, Netherlands";
  assert("drop-off in the current city is fine",
    !findContinuityIssues(sameCity).some(i => i.code === "VEHICLE_STATE_CONFLICT"));
}

console.log("\n=== findStructuralBlockingIssues (gate adapter) ===");
{
  const plan = {
    days: [
      { city: "London", items: [] },
      { city: "Amsterdam", items: [], structural_flags: [
        { code: "DUPLICATE_CHECKIN", severity: "block", target: "Amsterdam Marriott Hotel", message: "…" },
        { code: "VEHICLE_STATE_CONFLICT", severity: "warn", target: "Bayeux", message: "…" },
      ] },
    ],
  };
  const issues = findStructuralBlockingIssues(plan);
  assert("only block-severity flags surface", issues.length === 1, JSON.stringify(issues));
  assert("dayIdx preserved", issues[0].dayIdx === 1);
  assert("name matches the venue-issue shape the gate formats",
    issues[0].name === "Amsterdam Marriott Hotel");
  assert("flag object carried through", issues[0].flag.code === "DUPLICATE_CHECKIN");
  assert("kind marks it as structural", issues[0].kind === "structure");
}

console.log("\n=== degenerate input ===");
{
  assert("null plan → []", findContinuityIssues(null).length === 0);
  assert("no days → []", findContinuityIssues({}).length === 0);
  assert("single day → []", findContinuityIssues({ days: [{ city: "Rome", items: [] }] }).length === 0);
  assert("days with null entries survive", Array.isArray(findContinuityIssues({ days: [null, null] })));
  assert("null plan → no blocking issues", findStructuralBlockingIssues(null).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
