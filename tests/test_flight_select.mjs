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
  resolveAirlineIata,
  normalizeAirportCode,
  IATA_TO_CARRIER_NAME,
  carrierCodeConflict,
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

console.log("=== resolveAirlineIata: known names ===");
assert("United → UA", resolveAirlineIata("United") === "UA");
assert("United Airlines → UA", resolveAirlineIata("United Airlines") === "UA");
assert("Delta → DL", resolveAirlineIata("Delta") === "DL");
assert("JetBlue → B6", resolveAirlineIata("JetBlue") === "B6");
assert("case-insensitive (jetblue) → B6", resolveAirlineIata("jetblue") === "B6");
// Carriers PR #59's hardcoded 17-name map did NOT cover — the gap that left
// real flights unsurfaced. These must resolve now.
assert("Hawaiian → HA (was uncovered)", resolveAirlineIata("Hawaiian Airlines") === "HA");
assert("Air Canada → AC (was uncovered)", resolveAirlineIata("Air Canada") === "AC");
assert("Avelo → XP (was uncovered)", resolveAirlineIata("Avelo") === "XP");
assert("TAP Air Portugal → TP (was uncovered)", resolveAirlineIata("TAP Air Portugal") === "TP");
assert("Emirates → EK (was uncovered)", resolveAirlineIata("Emirates") === "EK");

console.log("=== resolveAirlineIata: direct IATA codes ===");
assert("bare code UA → UA", resolveAirlineIata("UA") === "UA");
assert("bare code B6 → B6", resolveAirlineIata("B6") === "B6");
assert("bare code U2 (easyJet) → U2", resolveAirlineIata("U2") === "U2");
assert("lowercase bare code ua → UA", resolveAirlineIata("ua") === "UA");

console.log("=== resolveAirlineIata: honesty / unresolved → null ===");
assert("empty → null", resolveAirlineIata("") === null);
assert("null → null", resolveAirlineIata(null) === null);
assert("'Carrier TBD' → null", resolveAirlineIata("Carrier TBD") === null);
assert("unknown name → null", resolveAirlineIata("Some Regional Air") === null);
// Multi-carrier strings MUST NOT resolve to one carrier — picking, say, UA for
// "United or Delta" then surfacing a UA number under a card the model labeled
// ambiguously would imply a specificity we don't have.
assert("'United or Delta' → null (ambiguous)", resolveAirlineIata("United or Delta") === null);
assert("'SAS / Delta' → null (ambiguous)", resolveAirlineIata("SAS / Delta") === null);
assert("'United, Lufthansa' → null (ambiguous)", resolveAirlineIata("United, Lufthansa") === null);

console.log("=== normalizeAirportCode: build item from/to → IATA ===");
assert("EWR → EWR", normalizeAirportCode("EWR") === "EWR");
assert("lowercase ewr → EWR", normalizeAirportCode("ewr") === "EWR");
assert("trims whitespace ' DEN ' → DEN", normalizeAirportCode(" DEN ") === "DEN");
assert("decorated 'Newark (EWR)' → EWR", normalizeAirportCode("Newark (EWR)") === "EWR");
assert("leading-code 'EWR - Newark Liberty' → EWR", normalizeAirportCode("EWR - Newark Liberty") === "EWR");
assert("null → null", normalizeAirportCode(null) === null);
assert("empty → null", normalizeAirportCode("") === null);
assert("no code present → null", normalizeAirportCode("see itinerary") === null);

console.log("=== unresolved carrier: surface a real flight, never mislabel ===");
// The route returned BOTH a marketing codeshare (TP) and the operating carrier
// (UA) at the same time — the real-world EWR→DEN case. With carrier unresolved
// (airlineIata=null) we must still surface a REAL entry (not show nothing)…
const codeshare = [
  { flightNumber: "TP8470", scheduledOut: "2027-08-25T00:59:00Z" },
  { flightNumber: "UA1792", scheduledOut: "2027-08-25T00:59:00Z" },
];
assert(
  "unresolved carrier + real rows → returns a real entry (not null)",
  codeshare.includes(pickScheduledFlight(codeshare, 59, null)),
);
assert(
  "…and the entry is one of the actual schedule rows (no invented number)",
  ["TP8470", "UA1792"].includes(pickScheduledFlight(codeshare, 59, null).flightNumber),
);
// …but a RESOLVED carrier must never be paired with the other carrier's row.
assert(
  "resolved UA filters to the UA row even when a same-time TP codeshare exists",
  pickScheduledFlight(codeshare, 59, "UA").flightNumber === "UA1792",
);
assert(
  "resolved TP filters to the TP row (no UA leak)",
  pickScheduledFlight(codeshare, 59, "TP").flightNumber === "TP8470",
);

console.log("=== P3: widened carrier map ===");
// LOT's absence is what let a "LOT" leg resolve to null and pick up UA940.
assert("LOT → LO", resolveAirlineIata("LOT") === "LO", String(resolveAirlineIata("LOT")));
assert("LOT Polish → LO", resolveAirlineIata("LOT Polish") === "LO");
assert("LOT Polish Airlines → LO", resolveAirlineIata("LOT Polish Airlines") === "LO");
assert("Air Europa → UX", resolveAirlineIata("Air Europa") === "UX");
assert("Vueling → VY", resolveAirlineIata("Vueling") === "VY");
assert("Wizz → W6", resolveAirlineIata("Wizz") === "W6");
assert("WizzAir → W6", resolveAirlineIata("WizzAir") === "W6");
assert("Wizz Air → W6", resolveAirlineIata("Wizz Air") === "W6");
assert("Brussels Airlines → SN", resolveAirlineIata("Brussels Airlines") === "SN");
assert("Eurowings → EW", resolveAirlineIata("Eurowings") === "EW");
assert("Azul → AD", resolveAirlineIata("Azul") === "AD");
assert("Azul Brazilian Airlines → AD", resolveAirlineIata("Azul Brazilian Airlines") === "AD");
// Pre-existing entries must not have shifted.
assert("United still → UA", resolveAirlineIata("United") === "UA");
assert("TAP Portugal still → TP", resolveAirlineIata("TAP Portugal") === "TP");

console.log("=== P3: IATA_TO_CARRIER_NAME ===");
assert("LO → 'LOT'", IATA_TO_CARRIER_NAME.LO === "LOT", String(IATA_TO_CARRIER_NAME.LO));
assert("UA → 'United'", IATA_TO_CARRIER_NAME.UA === "United", String(IATA_TO_CARRIER_NAME.UA));
assert("first-listed alias wins for TP", IATA_TO_CARRIER_NAME.TP === "TAP Air", String(IATA_TO_CARRIER_NAME.TP));
assert("first-listed alias wins for W6", IATA_TO_CARRIER_NAME.W6 === "Wizz", String(IATA_TO_CARRIER_NAME.W6));
assert("acronym casing preserved (SK → 'SAS')", IATA_TO_CARRIER_NAME.SK === "SAS", String(IATA_TO_CARRIER_NAME.SK));
assert("multi-word title-cased (BA → 'British Airways')",
  IATA_TO_CARRIER_NAME.BA === "British Airways", String(IATA_TO_CARRIER_NAME.BA));
assert("unknown code absent", IATA_TO_CARRIER_NAME.ZZ === undefined);

console.log("=== P3: carrierCodeConflict ===");
{
  // The shipped failure: Day 1 said "LOT flight via Warsaw" over UA940.
  const out = carrierCodeConflict("LOT", "UA940");
  assert("LOT + UA940 → conflict",
    out && out.claimed === "LO" && out.actual === "UA" && out.actualName === "United",
    JSON.stringify(out));
}
{
  // Day 15's variant, with the space the sample PDF prints.
  const out = carrierCodeConflict("LOT", "LH 2224");
  assert("space between prefix and digits still parses",
    out && out.claimed === "LO" && out.actual === "LH" && out.actualName === "Lufthansa",
    JSON.stringify(out));
}
assert("agreement → null", carrierCodeConflict("United", "UA940") === null,
  JSON.stringify(carrierCodeConflict("United", "UA940")));
assert("LOT + LO123 agreement → null", carrierCodeConflict("LOT", "LO123") === null,
  JSON.stringify(carrierCodeConflict("LOT", "LO123")));
assert("multi-carrier string claims nothing → null",
  carrierCodeConflict("Delta / KLM", "DL100") === null,
  JSON.stringify(carrierCodeConflict("Delta / KLM", "DL100")));
assert("unresolvable carrier → null (no claim to contradict)",
  carrierCodeConflict("SomeUnknownAirline", "UA940") === null,
  JSON.stringify(carrierCodeConflict("SomeUnknownAirline", "UA940")));
assert("unparseable flight number → null", carrierCodeConflict("LOT", "see itinerary") === null);
assert("empty flight number → null", carrierCodeConflict("LOT", "") === null);
assert("empty carrier → null", carrierCodeConflict("", "UA940") === null);
assert("conflict on an unmapped actual code still reports, actualName null", (() => {
  const out = carrierCodeConflict("LOT", "ZZ100");
  return out && out.claimed === "LO" && out.actual === "ZZ" && out.actualName === null;
})(), JSON.stringify(carrierCodeConflict("LOT", "ZZ100")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
