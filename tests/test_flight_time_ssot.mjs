// Tests for the day-sort / note-contradiction helpers in
// src/pdf/itineraryPdf.js (RCA bugs B / C):
//   • isOvernightArrivalFlight     — overnight-arrival detection (bug B tie-break)
//   • sortDayItems                 — numeric minute-of-day sort with the
//                                     overnight-arrival-first tie-break (bug B)
//   • flightNoteContradictsSchedule — untrusted confirmation_note time claims
//                                     (bug C)
//
// Bug A (schedule stamp reads resolved depart_time) has been reverted from
// this branch: the resolver's live-schedule path falls back to the model's
// fabricated times when the schedule fetch is empty, so routing the stamp
// through fl.depart_time propagates the fabrication. The upstream resolver
// fix is being tracked separately — see the PR body for the diagnosis.
//
// Pure functions; jsPDF is only imported inside the builder, so importing the
// module here needs no DOM.

import {
  isOvernightArrivalFlight,
  sortDayItems,
  flightNoteContradictsSchedule,
} from "../src/pdf/itineraryPdf.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const flightItem = (time, depart, arrive) => ({
  time, type: "Flight", flight: { depart_time: depart, arrive_time: arrive },
});
const groundItem = (time, type = "Activity") => ({ time, type });

console.log("=== isOvernightArrivalFlight (RCA bug B) ===");
assert("overnight (arrive 6:00 AM < depart 3:35 PM) → true",
  isOvernightArrivalFlight(flightItem("3:35 PM", "3:35 PM", "6:00 AM")) === true);
assert("same-day return (arrive 8:30 PM > depart 5:05 PM) → false",
  isOvernightArrivalFlight(flightItem("5:05 PM", "5:05 PM", "8:30 PM")) === false);
assert("same-day morning hop → false",
  isOvernightArrivalFlight(flightItem("9:00 AM", "9:00 AM", "11:20 AM")) === false);
assert("missing arrive_time → false",
  isOvernightArrivalFlight({ flight: { depart_time: "3:35 PM" } }) === false);
assert("non-flight item → false", isOvernightArrivalFlight(groundItem("1:15 AM")) === false);

console.log("=== sortDayItems: numeric minute-of-day (RCA bug B) ===");
{
  // Lexicographic string sort ordered these wrong across AM/PM; numeric is right.
  const items = [
    groundItem("3:00 PM", "Dinner"),
    groundItem("9:00 AM", "Activity"),
    groundItem("11:30 AM", "Activity"),
    groundItem("1:00 PM", "Lunch"),
  ];
  sortDayItems(items);
  assert("ascending by real instant, not string",
    items.map((i) => i.time).join("|") === "9:00 AM|11:30 AM|1:00 PM|3:00 PM",
    items.map((i) => i.time).join("|"));
}
{
  // Midnight edge: 12:00 AM (0) < 12:15 AM (15) < 1:00 AM (60) < 12:00 PM (720).
  const items = [
    groundItem("12:00 PM"),
    groundItem("1:00 AM"),
    groundItem("12:15 AM"),
    groundItem("12:00 AM"),
  ];
  sortDayItems(items);
  assert("midnight/noon ordering correct",
    items.map((i) => i.time).join("|") === "12:00 AM|12:15 AM|1:00 AM|12:00 PM",
    items.map((i) => i.time).join("|"));
}
{
  // Unparseable times sort to the end, preserving relative order.
  const items = [
    groundItem("flexible", "Note"),
    groundItem("2:00 PM"),
    groundItem("", "Note"),
    groundItem("8:00 AM"),
  ];
  sortDayItems(items);
  assert("parseable first (8:00 AM, 2:00 PM) then unparseables in order",
    items.map((i) => i.time).join("|") === "8:00 AM|2:00 PM|flexible|",
    items.map((i) => i.time).join("|"));
}

console.log("=== sortDayItems: arrival vs departure day (RCA bug B) ===");
{
  // Overnight arrival day: flight departs 3:35 PM (prev calendar day), lands
  // 6:00 AM; ground steps follow the landing. The flight must lead the day even
  // though 3:35 PM is a later clock time than the morning ground steps.
  const flight = flightItem("3:35 PM", "3:35 PM", "6:00 AM");
  const items = [
    groundItem("8:30 AM", "Transport"),   // train after landing
    groundItem("3:00 PM", "Activity"),
    flight,
    groundItem("10:00 AM", "Hotel"),      // check-in after landing
  ];
  sortDayItems(items);
  assert("overnight arrival flight pinned FIRST", items[0] === flight, items.map((i) => i.type).join("|"));
  assert("ground steps follow in chronological order",
    items.slice(1).map((i) => i.time).join("|") === "8:30 AM|10:00 AM|3:00 PM",
    items.slice(1).map((i) => i.time).join("|"));
}
{
  // Departure day (Day 8): same-day flight is the LAST event — breakfast and
  // checkout precede it, and it must NOT be pinned first.
  const flight = flightItem("5:05 PM", "5:05 PM", "8:30 PM");
  const items = [
    flight,
    groundItem("8:00 AM", "Note"),        // breakfast
    groundItem("11:00 AM", "Note"),       // checkout
  ];
  sortDayItems(items);
  assert("departure-day flight sorts LAST", items[items.length - 1] === flight,
    items.map((i) => i.type).join("|"));
  assert("ground steps precede the departure",
    items.slice(0, 2).map((i) => i.time).join("|") === "8:00 AM|11:00 AM",
    items.slice(0, 2).map((i) => i.time).join("|"));
}

console.log("=== flightNoteContradictsSchedule (RCA bug C) ===");
{
  const fl = { depart_time: "3:35 PM", arrive_time: "6:00 AM" };
  assert("'arrives midnight' contradicts a 6:00 AM arrival → suppress",
    flightNoteContradictsSchedule("Overnight flight; arrives midnight (12:00 AM Sep 4).", fl) === true);
  assert("note stating the real 6:00 AM arrival → keep",
    flightNoteContradictsSchedule("Lands 6:00 AM local; immigration can be slow.", fl) === false);
  assert("booking guidance with no time claim → keep",
    flightNoteContradictsSchedule("Book directly on united.com for Polaris lounge access at EWR.", fl) === false);
  assert("note citing the real 3:35 PM departure → keep",
    flightNoteContradictsSchedule("Departs 3:35 PM from Terminal 4.", fl) === false);
  assert("'arrives at noon' contradicting a 6:00 AM arrival → suppress",
    flightNoteContradictsSchedule("Arrives at noon.", fl) === true);
}
assert("no resolved times → cannot contradict → keep",
  flightNoteContradictsSchedule("Arrives midnight.", { depart_time: "", arrive_time: "" }) === false);
assert("empty note → keep (nothing to render anyway)",
  flightNoteContradictsSchedule("", { depart_time: "3:35 PM", arrive_time: "6:00 AM" }) === false);
assert("null note → keep",
  flightNoteContradictsSchedule(null, { depart_time: "3:35 PM", arrive_time: "6:00 AM" }) === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
