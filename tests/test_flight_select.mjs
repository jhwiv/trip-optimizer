// Tests for src/flightSelect.js — the pure helper that auto-selects a REAL
// scheduled flight to surface on the card without a manual tap.
//
// Honesty contract (CLAUDE.md): the picker may only ever return an entry that
// exists in the schedule list; it must never fabricate a flight number. These
// tests pin that contract plus the closest-departure heuristic.
//
// TZ is forced to UTC so the local-hour math in isoToMinutes is deterministic
// regardless of the machine running CI. Set before any Date is constructed.
process.env.TZ = "UTC";

import {
  isoToMinutes,
  parseClockToMinutes,
  pickScheduledFlight,
} from "../src/flightSelect.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== parseClockToMinutes ===");
assert("8:45 AM → 525", parseClockToMinutes("8:45 AM") === 525);
assert("12:00 AM → 0 (midnight)", parseClockToMinutes("12:00 AM") === 0);
assert("12:30 PM → 750 (noon+30)", parseClockToMinutes("12:30 PM") === 750);
assert("1:15 PM → 795", parseClockToMinutes("1:15 PM") === 795);
assert("13:30 (24h) → 810", parseClockToMinutes("13:30") === 810);
assert("ISO string → minutes (UTC)", parseClockToMinutes("2027-08-25T06:15:00Z") === 375);
assert("null → null", parseClockToMinutes(null) === null);
assert("garbage → null", parseClockToMinutes("not a time") === null);
assert("out-of-range hour → null", parseClockToMinutes("25:00") === null);

console.log("=== isoToMinutes ===");
assert("UTC 06:15 → 375", isoToMinutes("2027-08-25T06:15:00Z") === 375);
assert("null → null", isoToMinutes(null) === null);
assert("invalid → null", isoToMinutes("nope") === null);

console.log("=== pickScheduledFlight: honesty / eligibility ===");
assert("empty array → null", pickScheduledFlight([], 500) === null);
assert("non-array → null", pickScheduledFlight(null, 500) === null);
assert(
  "all entries missing flightNumber → null (never invents one)",
  pickScheduledFlight([{ scheduledOut: "2027-08-25T08:00:00Z" }, { scheduledOut: "2027-08-25T09:00:00Z" }], 500) === null,
);
assert(
  "returned flight is a real entry from the input list",
  (() => {
    const list = [{ flightNumber: "UA100", scheduledOut: "2027-08-25T08:00:00Z" }];
    return pickScheduledFlight(list, 480) === list[0];
  })(),
);

console.log("=== pickScheduledFlight: closest-departure heuristic ===");
const sched = [
  { flightNumber: "UA100", scheduledOut: "2027-08-25T06:00:00Z" }, // 360
  { flightNumber: "UA200", scheduledOut: "2027-08-25T09:30:00Z" }, // 570
  { flightNumber: "UA300", scheduledOut: "2027-08-25T14:00:00Z" }, // 840
  { flightNumber: "UA400", scheduledOut: "2027-08-25T19:45:00Z" }, // 1185
];
assert("approx 9:45 AM (585) picks UA200 (570)", pickScheduledFlight(sched, parseClockToMinutes("9:45 AM")).flightNumber === "UA200");
assert("approx 7:00 PM (1140) picks UA400 (1185)", pickScheduledFlight(sched, parseClockToMinutes("7:00 PM")).flightNumber === "UA400");
assert("approx 5:30 AM (330) picks UA100 (360)", pickScheduledFlight(sched, parseClockToMinutes("5:30 AM")).flightNumber === "UA100");
assert("approx 12:00 PM (720) picks UA300 (840) over UA200 (570)", pickScheduledFlight(sched, 720).flightNumber === "UA300");

console.log("=== pickScheduledFlight: tie-break toward earlier ===");
const tie = [
  { flightNumber: "UA900", scheduledOut: "2027-08-25T10:00:00Z" }, // 600, diff 60
  { flightNumber: "UA800", scheduledOut: "2027-08-25T08:00:00Z" }, // 480, diff 60
];
assert("equidistant (540) → earlier UA800", pickScheduledFlight(tie, 540).flightNumber === "UA800");

console.log("=== pickScheduledFlight: no time hint → earliest ===");
assert("null approx → earliest scheduledOut (UA100)", pickScheduledFlight(sched, null).flightNumber === "UA100");
assert("undefined approx → earliest scheduledOut (UA100)", pickScheduledFlight(sched).flightNumber === "UA100");

console.log("=== pickScheduledFlight: unparseable times fall back to first eligible ===");
const noTimes = [
  { flightNumber: "UA111" },
  { flightNumber: "UA222" },
];
assert("no parseable times, with hint → first eligible", pickScheduledFlight(noTimes, 600).flightNumber === "UA111");
assert("no parseable times, no hint → first eligible", pickScheduledFlight(noTimes, null).flightNumber === "UA111");

console.log("=== pickScheduledFlight: airlineIata carrier guard (honesty) ===");
// Mixed-carrier schedule list, as the fetch can return when the IATA filter
// yields zero matches and the caller falls back to the full result set.
const mixed = [
  { flightNumber: "BA810", scheduledOut: "2027-08-25T09:30:00Z" }, // 570
  { flightNumber: "BA920", scheduledOut: "2027-08-25T10:00:00Z" }, // 600
];
assert(
  "requested SK but only BA flights present → null (no foreign carrier surfaced)",
  pickScheduledFlight(mixed, 580, "SK") === null,
);
assert(
  "requested SK, prefix mismatch → never returns a BA flight",
  (() => {
    const r = pickScheduledFlight(mixed, 580, "SK");
    return r === null; // must NOT be mixed[0] (BA810) — that would be "SAS BA810"
  })(),
);
const mixedMatch = [
  { flightNumber: "BA810", scheduledOut: "2027-08-25T09:30:00Z" },
  { flightNumber: "SK501", scheduledOut: "2027-08-25T09:40:00Z" }, // 580
  { flightNumber: "SK777", scheduledOut: "2027-08-25T18:00:00Z" },
];
assert(
  "requested SK, an SK flight exists → picks the SK flight closest to time",
  pickScheduledFlight(mixedMatch, 580, "SK").flightNumber === "SK501",
);
assert(
  "case-insensitive prefix match (sk)",
  pickScheduledFlight(mixedMatch, 580, "sk").flightNumber === "SK501",
);
assert(
  "no airlineIata → unchanged behavior (closest overall)",
  pickScheduledFlight(mixedMatch, 580).flightNumber === "SK501",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
