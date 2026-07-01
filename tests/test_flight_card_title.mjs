// Tests for src/flightCardTitle.js — the pure title-composition
// contract for FlightCard. This module was extracted (and this test
// file created) 2026-06-30 late-evening to close the SF-build
// recurrence where FlightCard's title showed "United · EWR → SFO"
// but the Overview card on the same plan showed "United UA 337 ·
// EWR → SFO". Two components on the same plan disagreed because
// FlightCard's title only read f.flight_number when
// _userSuppliedFlightNumber was true, and the resolver never sets
// that flag — it sets _scheduleVerified.
//
// The RECURRENCE GUARD assertion at the bottom locks in the exact
// user scenario so a future refactor can't accidentally regress it.

import { buildFlightCardTitle } from "../src/flightCardTitle.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== Precedence 1 — user-supplied number ===");
{
  const f = { carrier: "United", flight_number: "UA1039", _userSuppliedFlightNumber: true };
  assert("user-supplied UA1039 rendered with carrier prefix",
    buildFlightCardTitle({ flight: f, autoFlight: null, route: "EWR → SFO" })
      === "United UA1039 · EWR → SFO");

  // User-supplied wins even when autoFlight is present and _scheduleVerified is set.
  const f2 = { carrier: "United", flight_number: "UA1039", _userSuppliedFlightNumber: true, _scheduleVerified: true };
  const auto = { flightNumber: "UA9999" };
  assert("user-supplied wins over _scheduleVerified and autoFlight",
    buildFlightCardTitle({ flight: f2, autoFlight: auto, route: "EWR → SFO" })
      === "United UA1039 · EWR → SFO");

  // Digits-only stored (post-strip normalization) still work.
  const f3 = { carrier: "United", flight_number: "1039", _userSuppliedFlightNumber: true };
  assert("digits-only user-supplied rendered as carrier + digits",
    buildFlightCardTitle({ flight: f3, autoFlight: null, route: "EWR → SFO" })
      === "United 1039 · EWR → SFO");
}

console.log("=== Precedence 2 — _scheduleVerified (the recurrence gap this fix closes) ===");
{
  // Model emitted UA337 with times; resolver ran and confirmed it,
  // setting _scheduleVerified: true. _userSuppliedFlightNumber is NOT
  // set (user didn't dictate anything).
  const f = {
    carrier: "United",
    flight_number: "UA 337",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "8:00 AM",
    arrive_time: "11:20 AM",
    _scheduleVerified: true,
  };
  assert("PRECEDENCE 2: resolver-verified UA 337 shows with carrier prefix",
    buildFlightCardTitle({ flight: f, autoFlight: null, route: "EWR → SFO" })
      === "United UA 337 · EWR → SFO");

  // With _scheduleVerified but empty flight_number, we do NOT lie —
  // fall through to autoFlight or the fallback.
  const f2 = { carrier: "United", flight_number: "", _scheduleVerified: true };
  assert("empty flight_number even with _scheduleVerified → falls through",
    buildFlightCardTitle({ flight: f2, autoFlight: null, route: "EWR → SFO" })
      === "United · EWR → SFO");

  // _scheduleVerified + _autoResolvedFlightNumber (substitution case)
  // renders the schedule-supplied number.
  const f3 = {
    carrier: "United",
    flight_number: "UA1792",
    _scheduleVerified: true,
    _autoResolvedFlightNumber: true,
  };
  assert("substitution (auto-resolved) also renders via _scheduleVerified branch",
    buildFlightCardTitle({ flight: f3, autoFlight: null, route: "EWR → SFO" })
      === "United UA1792 · EWR → SFO");

  // _scheduleVerified without carrier just shows the number (defensive).
  const f4 = { flight_number: "UA337", _scheduleVerified: true };
  assert("no carrier + _scheduleVerified → number only, no prefix",
    buildFlightCardTitle({ flight: f4, autoFlight: null, route: "EWR → SFO" })
      === "UA337 · EWR → SFO");
}

console.log("=== Precedence 3 — autoFlight from card-local live-lookup ===");
{
  // Model omitted the number entirely, no _scheduleVerified. The
  // card's own useEffect lookup returned UA1234 from the schedule.
  const f = { carrier: "United" };
  const auto = { flightNumber: "UA1234" };
  assert("autoFlight shown when no user/verified number",
    buildFlightCardTitle({ flight: f, autoFlight: auto, route: "EWR → SFO" })
      === "UA1234 · EWR → SFO");

  // autoFlight.flightNumber already carries the IATA prefix; do NOT
  // double-prefix with f.carrier.
  const f2 = { carrier: "United Airlines" };
  const auto2 = { flightNumber: "UA1234" };
  assert("autoFlight is NOT prefixed with f.carrier (avoids 'United Airlines UA1234')",
    buildFlightCardTitle({ flight: f2, autoFlight: auto2, route: "EWR → SFO" })
      === "UA1234 · EWR → SFO");
}

console.log("=== Precedence 4 — honest fallback ===");
{
  // Nothing known: no user number, no verified number, no autoFlight.
  const f = { carrier: "United" };
  assert("carrier only → 'United · EWR → SFO'",
    buildFlightCardTitle({ flight: f, autoFlight: null, route: "EWR → SFO" })
      === "United · EWR → SFO");

  // No carrier either.
  const f2 = {};
  assert("no carrier → 'Carrier TBD · EWR → SFO'",
    buildFlightCardTitle({ flight: f2, autoFlight: null, route: "EWR → SFO" })
      === "Carrier TBD · EWR → SFO");
}

console.log("=== Defensive — malformed inputs ===");
{
  assert("null flight",
    buildFlightCardTitle({ flight: null, autoFlight: null, route: "EWR → SFO" })
      === "Carrier TBD · EWR → SFO");

  assert("null route",
    buildFlightCardTitle({ flight: { carrier: "United" }, autoFlight: null, route: null })
      === "United");

  assert("empty route",
    buildFlightCardTitle({ flight: { carrier: "United" }, autoFlight: null, route: "" })
      === "United");

  // _userSuppliedFlightNumber true but flight_number missing → falls through.
  assert("flag set but no number → fallback",
    buildFlightCardTitle({ flight: { carrier: "United", _userSuppliedFlightNumber: true }, autoFlight: null, route: "EWR → SFO" })
      === "United · EWR → SFO");

  // Whitespace-only flight_number treated as empty.
  assert("whitespace flight_number → fallback",
    buildFlightCardTitle({ flight: { carrier: "United", flight_number: "   ", _scheduleVerified: true }, autoFlight: null, route: "EWR → SFO" })
      === "United · EWR → SFO");
}

console.log("=== RECURRENCE GUARD — exact user scenario 2026-06-30 8:05 PM EDT ===");
{
  // The user built a 4-day SF trip. The resolver ran, wrote UA 337 to
  // f.flight_number and set _scheduleVerified: true. The trip Overview
  // showed "United UA 337 · EWR → SFO" (Overview reads f.flight_number
  // directly). The day-by-day FlightCard title showed
  // "United · EWR → SFO" (FlightCard's title code only read
  // f.flight_number when _userSuppliedFlightNumber was true, ignoring
  // _scheduleVerified). This assertion locks in that the day-by-day
  // card MUST match the Overview format going forward.
  const sfBuildFlight = {
    carrier: "United",
    flight_number: "UA 337",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "8:00 AM",
    arrive_time: "11:20 AM",
    duration: "6h 20m",
    nonstop: true,
    cabin: "Economy Plus",
    aircraft: "Boeing 787-9",
    _scheduleVerified: true,
    // Note: NO _userSuppliedFlightNumber flag — user's narrative did
    // not mention flight details. The resolver populated everything.
  };
  const title = buildFlightCardTitle({
    flight: sfBuildFlight,
    autoFlight: null,
    route: "EWR → SFO",
  });
  assert("RECURRENCE GUARD: SF build's day-by-day FlightCard title is 'United UA 337 · EWR → SFO'",
    title === "United UA 337 · EWR → SFO",
    `got "${title}"`);

  // Also verify the return leg.
  const returnFlight = {
    carrier: "United",
    flight_number: "UA 1986",
    _scheduleVerified: true,
  };
  const returnTitle = buildFlightCardTitle({
    flight: returnFlight,
    autoFlight: null,
    route: "SFO → EWR",
  });
  assert("RECURRENCE GUARD: return leg 'United UA 1986 · SFO → EWR'",
    returnTitle === "United UA 1986 · SFO → EWR",
    `got "${returnTitle}"`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
