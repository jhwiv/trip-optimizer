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

console.log("\n=== ORPHANED_TRANSITION — same-day round trip is not a re-arrival (2026-08-04 regression) ===");
{
  // Real observed case: a 15-day London/Paris/Normandy/Porto build. Day 4 is
  // a Bletchley Park day trip: outbound leg to a non-canonical destination
  // (so it registers no transition), then a return leg whose text ("Return
  // drive Bletchley Park to London") resolves to London -- the same city
  // the day (and the whole prior three days) is already based in. That
  // looked exactly like a brand-new arrival into London, which
  // ORPHANED_TRANSITION flagged against Day 1's real arrival, even though
  // the traveller never left London at all.
  const dayTrip = {
    cities: [{ name: "London" }],
    days: [
      { day: 1, city: "London", items: [
        { type: "Flight", text: "Fly Newark (EWR) → London Heathrow (LHR)" },
      ] },
      { day: 2, city: "London", items: [{ type: "Activity", text: "Imperial War Museum" }] },
      { day: 3, city: "London", items: [
        { type: "Transport", text: "Private car London to Bletchley Park" },
        { type: "Activity", text: "Bletchley Park — codebreaking HQ" },
        { type: "Transport", text: "Return drive Bletchley Park to London" },
      ] },
    ],
  };
  const issues = findContinuityIssues(dayTrip);
  assert("a same-day round trip to a non-canonical destination is not flagged as ORPHANED_TRANSITION",
    !issues.some(i => i.code === "ORPHANED_TRANSITION"), JSON.stringify(issues));

  const legs = buildDayLegs(dayTrip);
  assert("the round trip's return leg is not recorded as a transition at all",
    legs[2].transitions.length === 0, JSON.stringify(legs[2].transitions));

  // The Day 6/7 Amsterdam-collision fixture below (a REAL second arrival,
  // not a round trip) must still be caught -- the distinguishing signal is
  // "an earlier unresolved-destination transport leg the SAME day", not
  // "the previous day was already this city", which looks identical for a
  // genuine repeat-arrival bug and must not be used to suppress it.
  const issuesCollision = findContinuityIssues(collision);
  assert("a genuine second arrival (no matching same-day outbound leg) is still flagged",
    issuesCollision.some(i => i.code === "ORPHANED_TRANSITION"), JSON.stringify(issuesCollision));
}

console.log("\n=== DAY_CITY_DISCONTINUITY — travel day with unresolvable region-vs-town names (2026-08-04 regression) ===");
{
  // Real observed case: a Portsmouth-to-Normandy travel day (overnight
  // ferry + drives + a late hotel check-in) where every place name in the
  // route text is a real town within the region (Caen, Ouistreham, Bayeux)
  // -- none of which contain "normandy" as a substring, so dayEnd's
  // text-matching can never resolve the day's true ending city. The day DID
  // have real transport AND ended by checking into a new hotel -- strong
  // evidence of genuine travel even though the destination text can't be
  // resolved to the region's canonical name.
  const regionTravelDay = {
    cities: [{ name: "Portsmouth" }, { name: "Normandy" }],
    days: [
      { day: 1, city: "Portsmouth", items: [
        { type: "Transport", text: "Ferry Portsmouth to Caen (Ouistreham) — overnight" },
        { type: "Transport", text: "Arrive Ouistreham; drive to Bayeux — 30 min" },
        { type: "Hotel", text: "Late check-in Villa Lara Hotel & Spa", hotel: { name: "Villa Lara Hotel & Spa" } },
      ] },
      { day: 2, city: "Normandy", items: [{ type: "Activity", text: "Bayeux Tapestry Museum" }] },
    ],
  };
  const issues = findContinuityIssues(regionTravelDay);
  assert("no DAY_CITY_DISCONTINUITY when the previous day had real transport AND a hotel check-in",
    !issues.some(i => i.code === "DAY_CITY_DISCONTINUITY"), JSON.stringify(issues));

  const noHotelCheckin = structuredClone(regionTravelDay);
  noHotelCheckin.days[0].items.pop(); // drop the hotel check-in
  assert("WITHOUT a hotel check-in, the same unresolvable travel day is still flagged (exemption isn't a blanket pass)",
    findContinuityIssues(noHotelCheckin).some(i => i.code === "DAY_CITY_DISCONTINUITY"),
    JSON.stringify(findContinuityIssues(noHotelCheckin)));

  const noTransport = {
    cities: [{ name: "Portsmouth" }, { name: "Normandy" }],
    days: [
      { day: 1, city: "Portsmouth", items: [{ type: "Activity", text: "Portsmouth Historic Dockyard" }] },
      { day: 2, city: "Normandy", items: [{ type: "Activity", text: "Bayeux Tapestry Museum" }] },
    ],
  };
  assert("a genuine discontinuity with NO transport at all on the previous day is still flagged",
    findContinuityIssues(noTransport).some(i => i.code === "DAY_CITY_DISCONTINUITY"),
    JSON.stringify(findContinuityIssues(noTransport)));
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

console.log("\n=== ORPHANED_TRANSITION — pickup-phrased location false-positives a day trip (2026-08-07 regression) ===");
{
  // Real observed case: a 15-day London/Normandy/Nuremberg/Porto build, Day
  // 13's Douro Valley day trip. "Private driver pickup for Douro Valley —
  // full-day tour" carried location:"Porto Marriott Hotel Palácio" (the
  // hotel the driver picks up FROM, not a destination) — itemDestination
  // used to treat item.location as a `to` candidate unconditionally, so
  // this pickup item resolved to "Porto" as an ordinary, resolved arrival
  // instead of the unresolved outbound leg the day-trip-return exemption
  // depends on. Because it "resolved," sawUnresolvedTransportEarlierToday
  // never got set, so the later "Return drive to Porto" leg wasn't
  // recognized as that outbound leg's return half either — TWO bogus
  // same-city "arrivals" got recorded on a day the traveller never left.
  const douroDayTrip = {
    cities: [{ name: "Porto" }],
    days: [
      { day: 1, city: "Porto", items: [
        { type: "Flight", text: "Fly Nuremberg (NUE) to Porto (OPO) — connecting via Frankfurt" },
        { type: "Hotel", text: "Check in Porto Marriott Hotel Palácio", hotel: { name: "Porto Marriott Hotel Palácio" } },
      ] },
      { day: 2, city: "Porto", items: [{ type: "Activity", text: "Ribeira waterfront walk" }] },
      { day: 3, city: "Porto", items: [
        { type: "Transport", text: "Private driver pickup for Douro Valley — full-day tour", location: "Porto Marriott Hotel Palácio" },
        { type: "Activity", text: "Quinta do Vallado wine tasting" },
        { type: "Transport", text: "Return drive to Porto — 90 min" },
      ] },
    ],
  };
  const issues = findContinuityIssues(douroDayTrip);
  assert("the Douro Valley day trip is not flagged as ORPHANED_TRANSITION",
    !issues.some(i => i.code === "ORPHANED_TRANSITION"), JSON.stringify(issues));

  const legs = buildDayLegs(douroDayTrip);
  assert("the pickup item (location = the day-trip's own hotel) is not recorded as a transition",
    legs[2].transitions.length === 0, JSON.stringify(legs[2].transitions));
}

console.log("\n=== ORPHANED_TRANSITION — a hallucinated day's earlier unresolved leg must not exempt its own real arrival (2026-08-07 regression) ===");
{
  // Real observed case, same build: Day 11 opens "Return to hotel, collect
  // luggage" at a Paris hotel that doesn't belong on this itinerary at all
  // (Transport type, unresolved — Paris isn't one of this trip's cities),
  // checks OUT of that phantom hotel, then flies to Porto — a SECOND,
  // contradictory arrival the day after the real one (Day 10, Nuremberg to
  // Porto). Porto is also Day 11's own city label, and an earlier
  // unresolved Transport item existed that same day, so this satisfied
  // every existing day-trip-return condition and got silently swallowed —
  // hiding the exact duplicate-arrival bug this module exists to catch,
  // instead of surfacing it. The fix: the exemption now also requires no
  // hotel check-out yet that day, since a genuine day trip never checks out
  // (the traveller is still based where they started) — a day that DOES
  // check out is describing a real departure from somewhere, however
  // unresolvable that somewhere is.
  const phantomParisLeg = {
    cities: [{ name: "Nuremberg" }, { name: "Porto" }],
    days: [
      { day: 1, city: "Nuremberg", items: [
        { type: "Hotel", text: "Check out Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
        { type: "Flight", text: "Fly Nuremberg (NUE) to Porto (OPO) — connecting via Frankfurt" },
        { type: "Hotel", text: "Check in Porto Marriott Hotel Ribeira", hotel: { name: "Porto Marriott Hotel Ribeira" } },
      ] },
      { day: 2, city: "Porto", items: [
        { type: "Transport", text: "Return to hotel, collect luggage", location: "Marriott Paris Champs Elysees" },
        { type: "Hotel", text: "Check out Marriott Paris Champs Elysees", hotel: { name: "Marriott Paris Champs Elysees" } },
        { type: "Flight", text: "Fly Paris CDG → Porto OPO · LOT via Warsaw · connecting" },
        { type: "Hotel", text: "Check in Porto Marriott Hotel Palácio", hotel: { name: "Porto Marriott Hotel Palácio" } },
      ] },
    ],
  };
  const issues = findContinuityIssues(phantomParisLeg);
  assert("the second, contradictory arrival IS flagged as ORPHANED_TRANSITION",
    issues.some(i => i.code === "ORPHANED_TRANSITION" && i.day === 2), JSON.stringify(issues));

  const legs = buildDayLegs(phantomParisLeg);
  assert("the real flight into Porto is recorded as a transition, not exempted away",
    legs[1].transitions.some(t => t.to === "Porto"), JSON.stringify(legs[1].transitions));
}

console.log("\n=== ORPHANED_TRANSITION — a same-city local errand or own-airport transfer is not a re-arrival (2026-08-09 regression) ===");
{
  // Real observed case, a London/Normandy/Nuremberg/Porto rebuild: "Drive to
  // Memorium Nuremberg Trials" (a museum whose own name contains the city,
  // on an ordinary day with no travel at all) and "Taxi to London Heathrow"
  // / "Drive to Nuremberg Airport" (a transfer TO one's own city's departure
  // airport) both resolved to the city the traveller was already in —
  // carried forward from the previous day — and were misread as fresh
  // arrivals, false-blocking a correct itinerary.
  const localErrand = {
    cities: [{ name: "Nuremberg" }, { name: "Porto" }],
    days: [
      { day: 1, city: "Nuremberg", items: [
        { type: "Flight", text: "Fly Frankfurt → Nuremberg" },
        { type: "Hotel", text: "Check in Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
      ] },
      { day: 2, city: "Nuremberg", items: [
        { type: "Transport", text: "Drive to Memorium Nuremberg Trials — 15 min from hotel" },
        { type: "Activity", text: "Memorium Nurnberger Prozesse" },
        { type: "Dinner", text: "Dinner at Waidwerk" },
      ] },
    ],
  };
  const issues = findContinuityIssues(localErrand);
  assert("a same-city local errand is not flagged as ORPHANED_TRANSITION",
    !issues.some(i => i.code === "ORPHANED_TRANSITION"), JSON.stringify(issues));
  const legs = buildDayLegs(localErrand);
  assert("the local errand is not recorded as a transition at all",
    legs[1].transitions.length === 0, JSON.stringify(legs[1].transitions));

  const airportTransfer = {
    cities: [{ name: "London" }, { name: "Paris" }],
    days: [
      { day: 1, city: "London", items: [
        { type: "Flight", text: "Fly Newark → London Heathrow" },
        { type: "Hotel", text: "Check in London Marriott Park Lane", hotel: { name: "London Marriott Park Lane" } },
      ] },
      { day: 2, city: "London", items: [
        { type: "Activity", text: "Churchill War Rooms" },
      ] },
      { day: 3, city: "Paris", items: [
        { type: "Hotel", text: "Check out London Marriott Park Lane", hotel: { name: "London Marriott Park Lane" } },
        { type: "Transport", text: "Taxi to London Heathrow — 45 min" },
        { type: "Flight", text: "British Airways nonstop London Heathrow → Paris Charles de Gaulle" },
        { type: "Hotel", text: "Check in Le Meurice", hotel: { name: "Le Meurice" } },
      ] },
    ],
  };
  const issues2 = findContinuityIssues(airportTransfer);
  assert("a departure transfer to one's own city's airport is not flagged as ORPHANED_TRANSITION",
    !issues2.some(i => i.code === "ORPHANED_TRANSITION"), JSON.stringify(issues2));

  // A Flight item resolving to the same city the traveller is already in is
  // a much stronger signal of real duplicated content and must still be
  // caught — the exemption above is deliberately Transport-only.
  const duplicateFlight = {
    cities: [{ name: "London" }],
    days: [
      { day: 1, city: "London", items: [
        { type: "Flight", text: "LOT nonstop Newark → London Heathrow" },
      ] },
      { day: 2, city: "London", items: [
        { type: "Flight", text: "LOT arrival London Heathrow (overnight from Newark)" },
        { type: "Hotel", text: "Check in London Marriott Park Lane", hotel: { name: "London Marriott Park Lane" } },
      ] },
    ],
  };
  const issues3 = findContinuityIssues(duplicateFlight);
  assert("a duplicated Flight item into the same city IS still flagged as ORPHANED_TRANSITION",
    issues3.some(i => i.code === "ORPHANED_TRANSITION" && i.day === 2), JSON.stringify(issues3));
}

console.log("\n=== DUPLICATE_CHECKIN — an 'Overnight at...' reminder is not a re-check-in (2026-08-09 regression) ===");
{
  // Real observed case, same rebuild: three consecutive nights at the
  // Sheraton Carlton Hotel Nuremberg, each day's only Hotel item an
  // "Overnight at..." reminder (no "check in" phrasing), produced
  // DUPLICATE_CHECKIN on every night after the first at a hotel nobody
  // re-checked into.
  const multiNightStay = {
    cities: [{ name: "Nuremberg" }],
    days: [
      { day: 1, city: "Nuremberg", items: [
        { type: "Hotel", text: "Check in to Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
        { type: "Hotel", text: "Overnight at Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
      ] },
      { day: 2, city: "Nuremberg", items: [
        { type: "Activity", text: "Nuremberg Trials Memorial" },
        { type: "Hotel", text: "Overnight at Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
      ] },
      { day: 3, city: "Nuremberg", items: [
        { type: "Activity", text: "Old Town walk" },
        { type: "Hotel", text: "Overnight at Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
      ] },
    ],
  };
  const issues = findContinuityIssues(multiNightStay);
  assert("no DUPLICATE_CHECKIN across a multi-night stay with only 'Overnight at...' reminders",
    !issues.some(i => i.code === "DUPLICATE_CHECKIN"), JSON.stringify(issues));

  const legs = buildDayLegs(multiNightStay);
  assert("Day 1's real check-in is still recorded", legs[0].hotelIn?.name === "Sheraton Carlton Hotel Nuremberg");
  assert("Day 2's 'Overnight at...' reminder is not recorded as a check-in", legs[1].hotelIn === null, JSON.stringify(legs[1].hotelIn));
  assert("Day 3's 'Overnight at...' reminder is not recorded as a check-in", legs[2].hotelIn === null, JSON.stringify(legs[2].hotelIn));

  // A genuine re-check-in at the same hotel (real duplicate-booking bug)
  // still uses explicit check-in phrasing and must still be caught.
  const realDuplicateCheckin = {
    cities: [{ name: "Amsterdam" }],
    days: [
      { day: 1, city: "Amsterdam", items: [
        { type: "Hotel", text: "Check in at Amsterdam Marriott Hotel", hotel: { name: "Amsterdam Marriott Hotel" } },
      ] },
      { day: 2, city: "Amsterdam", items: [
        { type: "Hotel", text: "Check in at Amsterdam Marriott Hotel", hotel: { name: "Amsterdam Marriott Hotel" } },
      ] },
    ],
  };
  const issues2 = findContinuityIssues(realDuplicateCheckin);
  assert("a genuine re-check-in (explicit phrasing, two days) is still flagged as DUPLICATE_CHECKIN",
    issues2.some(i => i.code === "DUPLICATE_CHECKIN"), JSON.stringify(issues2));
}

console.log("\n=== hotelEvent — 'Overnight' text ordering and transit-day edge cases (2026-08-09 follow-up) ===");
{
  // A real check-in item can itself start with "Overnight" (the build prompt
  // uses "overnight / red-eye arrival" language for late landings) — the
  // explicit check-in phrase must win over the reminder pattern regardless
  // of word order, not be misread as a same-night reminder.
  const overnightArrivalCheckin = {
    cities: [{ name: "Tokyo" }],
    days: [
      { day: 1, city: "Tokyo", items: [
        { type: "Hotel", text: "Overnight arrival — check in at Park Hyatt Tokyo", hotel: { name: "Park Hyatt Tokyo" } },
      ] },
    ],
  };
  const legs1 = buildDayLegs(overnightArrivalCheckin);
  assert("an 'Overnight arrival, check in at...' item is still recorded as a real check-in",
    legs1[0].hotelIn?.name === "Park Hyatt Tokyo", JSON.stringify(legs1[0].hotelIn));

  // A genuine transit day whose ONLY signal for the new hotel is "Overnight
  // at [Hotel]" (no separate explicit "check in" line) must still register
  // as a check-in — the reminder exemption is scoped to "no check-out
  // recorded yet today," and a transit day always has one (written first).
  const transitDayOvernightOnly = {
    cities: [{ name: "Bayeux" }, { name: "Nuremberg" }],
    days: [
      { day: 1, city: "Bayeux", items: [
        { type: "Hotel", text: "Check out of Mercure Omaha Beach", hotel: { name: "Mercure Omaha Beach" } },
      ] },
      { day: 2, city: "Nuremberg", items: [
        { type: "Hotel", text: "Check out of Mercure Omaha Beach", hotel: { name: "Mercure Omaha Beach" } },
        { type: "Transport", text: "Drive Bayeux to Nuremberg — 7h" },
        { type: "Hotel", text: "Overnight at Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
      ] },
    ],
  };
  const legs2 = buildDayLegs(transitDayOvernightOnly);
  assert("a transit day's ONLY 'Overnight at...' item is still recorded as the real check-in",
    legs2[1].hotelIn?.name === "Sheraton Carlton Hotel Nuremberg", JSON.stringify(legs2[1].hotelIn));
  assert("the same day's real checkout is still recorded", legs2[1].hotelOut?.name === "Mercure Omaha Beach");
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
