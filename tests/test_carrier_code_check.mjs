// Tests for src/carrierCodeCheck.js — the carrier-name vs flight-number
// cross-check (report §1, validator P4).
//
// The shipped failure: Day 1 of the 2026-07-28 build read "LOT flight from
// Newark to London Heathrow" over the number UA940, with "Book directly on
// lot.com" underneath. Two contradictory claims, both printed as fact.
//
// The policy under test is repair-first and provenance-dependent — a number
// that came off a live schedule row is ground truth (rename the carrier), a
// model-authored one is not (strip the number and block export). These
// fixtures pin both halves plus the "we couldn't even check" case.

import { findCarrierCodeMismatches } from "../src/carrierCodeCheck.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// One Flight item wrapped in the minimum plan shape the walker needs.
const planWith = (flight, text = "Fly to London") => ({
  days: [{ day: 1, items: [{ type: "Flight", text, flight }] }],
});

const LOT_UA940 = {
  carrier: "LOT",
  flight_number: "UA940",
  from_airport: "EWR",
  to_airport: "LHR",
  depart_time: "9:00 PM",
  arrive_time: "9:20 AM",
};

console.log("=== Case A: schedule-sourced number → carrier renamed ===");
{
  const plan = planWith({ ...LOT_UA940, _resolveSource: "route-only", _scheduleVerified: true });
  const fl = plan.days[0].items[0].flight;
  const hits = findCarrierCodeMismatches(plan);

  assert("one flag raised", hits.length === 1, JSON.stringify(hits));
  assert("code is CARRIER_CODE_REPAIRED", hits[0]?.code === "CARRIER_CODE_REPAIRED", hits[0]?.code);
  assert("severity is warn — the plan is still shippable", hits[0]?.severity === "warn", hits[0]?.severity);
  assert("carrier renamed to the code's airline", fl.carrier === "United", fl.carrier);
  assert("the model's carrier is preserved for audit", fl._originalCarrier === "LOT", fl._originalCarrier);
  assert("the schedule-confirmed number is untouched", fl.flight_number === "UA940", String(fl.flight_number));
  assert("_scheduleVerified survives — the number really was confirmed",
    fl._scheduleVerified === true, String(fl._scheduleVerified));
  assert("the flight is NOT marked unverified", fl._flightUnverified === undefined);
  assert("message names both carriers", /United/.test(hits[0].message) && /LOT/.test(hits[0].message), hits[0].message);
  assert("message states the route", /EWR→LHR/.test(hits[0].message), hits[0].message);
  assert("flag is located on day 1", hits[0].dayIdx === 0 && hits[0].day === 1 && hits[0].itemIdx === 0);

  const airlineSourced = planWith({ ...LOT_UA940, _resolveSource: "airline" });
  assert("_resolveSource 'airline' takes the same repair path",
    findCarrierCodeMismatches(airlineSourced)[0]?.code === "CARRIER_CODE_REPAIRED");
  assert("…and renames the carrier", airlineSourced.days[0].items[0].flight.carrier === "United");
}

console.log("\n=== Case A: the stale booking note goes with the old carrier ===");
{
  // carrierBookUrl() in the PDF has no LOT entry, so this note would otherwise
  // survive the rename and print "Book directly on lot.com" beside UA940.
  const plan = planWith({
    ...LOT_UA940,
    _resolveSource: "route-only",
    confirmation_note: "Book directly on lot.com for the best seat selection.",
  });
  const fl = plan.days[0].items[0].flight;
  const hits = findCarrierCodeMismatches(plan);

  assert("carrier still renamed", fl.carrier === "United", fl.carrier);
  assert("the lot.com note is nulled", fl.confirmation_note === null, String(fl.confirmation_note));
  assert("the flag says the note was removed",
    /note that named the old carrier was removed/.test(hits[0]?.message || ""), hits[0]?.message);

  // A note that never mentions the old brand is left alone — the scrub is
  // targeted, not a blanket wipe.
  const keeps = planWith({
    ...LOT_UA940,
    _resolveSource: "route-only",
    confirmation_note: "Verify flight number, times and equipment at booking — schedules change.",
  });
  findCarrierCodeMismatches(keeps);
  assert("an unrelated note survives the repair",
    keeps.days[0].items[0].flight.confirmation_note.startsWith("Verify flight number"),
    keeps.days[0].items[0].flight.confirmation_note);

  // Whole-word matching: "allotment" must not read as "LOT".
  const substring = planWith({
    ...LOT_UA940,
    _resolveSource: "route-only",
    confirmation_note: "Your seat allotment is confirmed at check-in.",
  });
  findCarrierCodeMismatches(substring);
  assert("a substring match does not trigger the scrub",
    /allotment/.test(substring.days[0].items[0].flight.confirmation_note || ""),
    substring.days[0].items[0].flight.confirmation_note);

  // flight.notes[] is not in the emitted schema today, but scrub it when a
  // plan carries one rather than leaving a wrong-brand line behind.
  const withNotes = planWith({
    ...LOT_UA940,
    _resolveSource: "route-only",
    notes: ["LOT serves a hot meal on this sector.", "Seat 12A requested."],
  });
  findCarrierCodeMismatches(withNotes);
  assert("only the brand-naming note is dropped from notes[]",
    JSON.stringify(withNotes.days[0].items[0].flight.notes) === JSON.stringify(["Seat 12A requested."]),
    JSON.stringify(withNotes.days[0].items[0].flight.notes));
}

console.log("\n=== Case B: model-authored number → stripped and BLOCKED ===");
{
  // This is what shipped. Nothing confirmed UA940; the model typed both the
  // carrier and the number and they contradict each other.
  const plan = planWith({ ...LOT_UA940, _flightUnverified: true, _scheduleVerified: true, _resolveSource: "verify-fallback" });
  const fl = plan.days[0].items[0].flight;
  const hits = findCarrierCodeMismatches(plan);

  assert("one flag raised", hits.length === 1, JSON.stringify(hits));
  assert("code is CARRIER_CODE_MISMATCH", hits[0]?.code === "CARRIER_CODE_MISMATCH", hits[0]?.code);
  assert("severity is BLOCK — this must not reach the PDF",
    hits[0]?.severity === "block", hits[0]?.severity);
  assert("the fabricated number is stripped", fl.flight_number === null, String(fl.flight_number));
  assert("the carrier the model named is NOT overwritten", fl.carrier === "LOT", fl.carrier);
  assert("_scheduleVerified is cleared so the strip can't be bypassed",
    fl._scheduleVerified === undefined, String(fl._scheduleVerified));
  assert("_flightUnverified stays set", fl._flightUnverified === true);
  assert("the flag records the number that was removed", hits[0]?.flightNumber === "UA940", hits[0]?.flightNumber);
  assert("message names the real operator of that number",
    /belongs to United/.test(hits[0].message), hits[0].message);

  // No provenance at all — a plan the resolver never touched. Same treatment:
  // there is no ground truth to repair toward.
  const bare = planWith({ ...LOT_UA940 });
  const bareHits = findCarrierCodeMismatches(bare);
  assert("no _resolveSource → block, not repair",
    bareHits[0]?.code === "CARRIER_CODE_MISMATCH" && bareHits[0]?.severity === "block",
    JSON.stringify(bareHits));
  assert("…and the number is stripped", bare.days[0].items[0].flight.flight_number === null);

  // A _resolveSource we don't recognize (legacy plan, future value) fails safe
  // into Case B rather than earning the repair path.
  const unknownSource = planWith({ ...LOT_UA940, _resolveSource: "some-future-mode" });
  assert("an unrecognized _resolveSource fails safe to block",
    findCarrierCodeMismatches(unknownSource)[0]?.code === "CARRIER_CODE_MISMATCH");
}

console.log("\n=== Case C: carrier can't be resolved → warn, no repair ===");
{
  const plan = planWith({
    carrier: "Some Airline",
    flight_number: "XX123",
    from_airport: "CDG",
    to_airport: "NUE",
    _resolveSource: "route-only",
  });
  const fl = plan.days[0].items[0].flight;
  const hits = findCarrierCodeMismatches(plan);

  assert("one flag raised", hits.length === 1, JSON.stringify(hits));
  assert("code is CARRIER_CODE_UNRESOLVED", hits[0]?.code === "CARRIER_CODE_UNRESOLVED", hits[0]?.code);
  assert("severity is warn", hits[0]?.severity === "warn", hits[0]?.severity);
  assert("the flight is not modified at all",
    fl.carrier === "Some Airline" && fl.flight_number === "XX123" && fl._originalCarrier === undefined,
    JSON.stringify(fl));
  assert("the flag names the carrier it couldn't resolve", hits[0]?.carrier === "Some Airline", hits[0]?.carrier);

  // A multi-carrier string is a deliberate non-claim, but it still means the
  // number went unchecked, so it warns rather than passing silently.
  const ambiguous = planWith({ carrier: "United or Delta", flight_number: "UA940", from_airport: "EWR", to_airport: "LHR" });
  assert("an ambiguous carrier string warns rather than blocking",
    findCarrierCodeMismatches(ambiguous)[0]?.code === "CARRIER_CODE_UNRESOLVED");
  assert("…and its number is left intact",
    ambiguous.days[0].items[0].flight.flight_number === "UA940");
}

console.log("\n=== agreement and no-claim cases raise nothing ===");
{
  assert("carrier agrees with the number → no flag",
    findCarrierCodeMismatches(planWith({ ...LOT_UA940, carrier: "United" })).length === 0);
  assert("agreement holds for the repaired shape too",
    findCarrierCodeMismatches(planWith({ ...LOT_UA940, carrier: "United", _resolveSource: "airline" })).length === 0);

  const noNumber = planWith({ carrier: "LOT", from_airport: "EWR", to_airport: "LHR" });
  assert("no flight number → no flag (nothing to cross-check)",
    findCarrierCodeMismatches(noNumber).length === 0, JSON.stringify(findCarrierCodeMismatches(noNumber)));
  assert("…and the flight is untouched", noNumber.days[0].items[0].flight.carrier === "LOT");
  assert("a null flight number → no flag",
    findCarrierCodeMismatches(planWith({ carrier: "LOT", flight_number: null })).length === 0);
  assert("a whitespace flight number → no flag",
    findCarrierCodeMismatches(planWith({ carrier: "LOT", flight_number: "   " })).length === 0);
  assert("no carrier → no flag (nothing claims to be contradicted)",
    findCarrierCodeMismatches(planWith({ flight_number: "UA940" })).length === 0);
  assert("an unparseable flight number → no flag",
    findCarrierCodeMismatches(planWith({ carrier: "LOT", flight_number: "see itinerary" })).length === 0);
}

console.log("\n=== plan walk: shape tolerance and multi-day placement ===");
{
  const plan = {
    days: [
      { day: 1, items: [{ type: "Hotel", text: "Check in", hotel: { name: "The Hoxton" } }] },
      { day: 2, items: [{ type: "Flight", text: "Fly home", flight: { ...LOT_UA940 } }] },
    ],
  };
  const hits = findCarrierCodeMismatches(plan);
  assert("non-Flight items are skipped", hits.length === 1, JSON.stringify(hits));
  assert("the flag lands on day 2", hits[0].dayIdx === 1 && hits[0].day === 2, JSON.stringify(hits[0]));

  const notAFlight = { days: [{ items: [{ type: "Transport", flight: { ...LOT_UA940 } }] }] };
  assert("a flight object on a non-Flight item is ignored",
    findCarrierCodeMismatches(notAFlight).length === 0);

  assert("null plan → []", findCarrierCodeMismatches(null).length === 0);
  assert("no days → []", findCarrierCodeMismatches({}).length === 0);
  assert("null day entries survive", findCarrierCodeMismatches({ days: [null] }).length === 0);
  assert("a day with no items survives", findCarrierCodeMismatches({ days: [{ day: 1 }] }).length === 0);
  assert("a Flight item with no flight object survives",
    findCarrierCodeMismatches({ days: [{ items: [{ type: "Flight", text: "TBD" }] }] }).length === 0);
  assert("a null item survives", findCarrierCodeMismatches({ days: [{ items: [null] }] }).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
