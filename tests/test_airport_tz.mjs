// Tests for src/airportTz.js — the airport-local time formatter (bug #3a).
//
// The resolver used to format schedule timestamps with the JS runtime tz
// (UTC on Cloudflare Workers), so an overnight ATL→AMS arrival printed its
// UTC wall-clock instead of Amsterdam-local time. These tests pin that a UTC
// ISO renders in the destination airport's local zone, and that unknown
// airports fall back to a UTC render rather than inventing an offset.
//
// TZ forced to a NON-UTC zone so a bug that silently uses the runtime tz
// would produce a wrong answer here (guards against "works only because CI
// happens to be UTC").
process.env.TZ = "America/Chicago";

import { airportTimeZone, formatAirportLocalTime } from "../src/airportTz.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== airportTimeZone ===");
assert("AMS → Europe/Amsterdam", airportTimeZone("AMS") === "Europe/Amsterdam");
assert("ATL → America/New_York", airportTimeZone("ATL") === "America/New_York");
assert("case-insensitive (ams)", airportTimeZone("ams") === "Europe/Amsterdam");
assert("decorated 'Newark (EWR)'", airportTimeZone("Newark (EWR)") === "America/New_York");
assert("leading-code 'AMS - Schiphol'", airportTimeZone("AMS - Schiphol") === "Europe/Amsterdam");
assert("unknown → null", airportTimeZone("ZZZ") === null);
assert("empty → null", airportTimeZone("") === null);

console.log("=== formatAirportLocalTime ===");
// ATL→AMS: 2026-07-14T05:15:00Z is 07:15 in Amsterdam (CEST, UTC+2).
assert(
  "UTC 05:15Z renders 7:15 AM at AMS (not runtime tz)",
  formatAirportLocalTime("2026-07-14T05:15:00Z", "AMS") === "7:15 AM",
  formatAirportLocalTime("2026-07-14T05:15:00Z", "AMS"),
);
// Departure ATL local: 2026-07-14T19:35:00Z is 3:35 PM in Atlanta (EDT, UTC-4).
assert(
  "UTC 19:35Z renders 3:35 PM at ATL",
  formatAirportLocalTime("2026-07-14T19:35:00Z", "ATL") === "3:35 PM",
  formatAirportLocalTime("2026-07-14T19:35:00Z", "ATL"),
);
// Unknown airport → UTC fallback (05:15Z stays 5:15 AM).
assert(
  "unknown airport falls back to UTC render",
  formatAirportLocalTime("2026-07-14T05:15:00Z", "ZZZ") === "5:15 AM",
  formatAirportLocalTime("2026-07-14T05:15:00Z", "ZZZ"),
);
assert("empty iso → undefined", formatAirportLocalTime("", "AMS") === undefined);
assert("invalid iso → undefined", formatAirportLocalTime("not-a-date", "AMS") === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
