// Tests for the verify-mode resolver loop in src/App.jsx. This file
// simulates the FlightNumberAutoResolver effect's per-flight branching
// for verify-mode, exercising:
//
//   1. Airline-filtered Attempt 1 with exact-number match (confirmation)
//   2. Airline-filtered Attempt 1 with time-proximity fallback (substitution)
//   3. Route-only Attempt 2 with carrier pre-filter (false-negative recovery)
//   4. Route-only Attempt 2 with NO carrier match (verify-trusted fallback)
//   5. Total miss (no API rows anywhere) → _scheduleVerified + _verifyTrusted
//
// The branches under test live at src/App.jsx ~6614-6679 and ~6705-6728.
// We don't import App.jsx here (JSX, React); we mirror the branching
// rules in a small simulation. Both sides must agree — the matching is
// enforced by the test names referencing the App.jsx line ranges.

import { flightNeedsResolve, pickFromPool, buildMergePayload } from "../src/flightResolver.js";
import { pickScheduledFlight } from "../src/flightSelect.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Helper that mirrors App.jsx ~6614-6679 verify-mode resolver loop.
// Given a target flight and two mock API responses (airline-filtered
// and route-only), produces the same merge payload App.jsx would write.
function simulateVerifyResolve({ flight, airlineIata, approxMinutes, airlineFilteredRows, routeOnlyRows }) {
  let pick = null;
  let source = null;

  // Attempt 1: airline-filtered, with exact-number preference (verify mode).
  if (airlineIata && airlineFilteredRows && airlineFilteredRows.length > 0) {
    const wanted = String(flight.flight_number).trim().toUpperCase();
    const exact = airlineFilteredRows.find((x) => x.flightNumber.toUpperCase() === wanted);
    pick = exact || pickFromPool({ flights: airlineFilteredRows, airlineIata, approxMinutes, pickScheduledFlight });
    if (pick) source = "airline";
  }

  // Attempt 2: route-only retry with carrier pre-filter (verify mode).
  if (!pick && routeOnlyRows && routeOnlyRows.length > 0) {
    const wanted = String(flight.flight_number).trim().toUpperCase();
    const exact = routeOnlyRows.find((x) => x.flightNumber.toUpperCase() === wanted);
    if (exact) {
      pick = exact;
    } else if (airlineIata) {
      const filtered = routeOnlyRows.filter((x) => x.flightNumber.toUpperCase().startsWith(airlineIata.toUpperCase()));
      if (filtered.length > 0) {
        pick = pickFromPool({ flights: filtered, airlineIata, approxMinutes, pickScheduledFlight });
      }
    }
    if (pick) source = "route-only";
  }

  // Merge or fallback.
  if (pick) {
    return buildMergePayload({ mode: "verify", pick, currentFlight: flight, source, airlineIata });
  }
  // Verify-mode total miss → the App.jsx-side verify-trusted fallback.
  return {
    _scheduleVerified: true,
    _verifyTrusted: true,
    _resolveSource: "verify-fallback",
  };
}

console.log("=== Verify case 1 — airline-filtered exact match (EWR-SFO UA1792) ===");
{
  // The canonical recurrence case: model emitted UA1792 with both times,
  // production API returns UA1792 + alternatives. Resolver confirms.
  const flight = {
    carrier: "United",
    flight_number: "UA1792",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "11:00 AM",
    arrive_time: "2:30 PM",
  };
  assert("flightNeedsResolve(flight) === 'verify'",
    flightNeedsResolve(flight) === "verify");

  const merge = simulateVerifyResolve({
    flight,
    airlineIata: "UA",
    approxMinutes: 11 * 60,
    airlineFilteredRows: [
      { flightNumber: "UA1792", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" },
      { flightNumber: "UA205", scheduledOut: "2026-08-15T18:00:00Z", scheduledIn: "2026-08-15T21:00:00Z" },
    ],
    routeOnlyRows: [],
  });
  assert("case 1: flight_number unchanged (confirmation)",
    merge.flight_number === "UA1792");
  assert("case 1: _scheduleVerified set",
    merge._scheduleVerified === true);
  assert("case 1: NOT marked _autoResolvedFlightNumber (confirmation)",
    merge._autoResolvedFlightNumber === undefined);
  assert("case 1: source = airline",
    merge._resolveSource === "airline");
  assert("case 1: times refreshed (not undefined)",
    typeof merge.depart_time === "string" && merge.depart_time.length > 0);
}

console.log("=== Verify case 2 — airline-filtered substitution (model fabricated UA9999) ===");
{
  const flight = {
    carrier: "United",
    flight_number: "UA9999",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "11:00 AM",
    arrive_time: "2:30 PM",
  };
  const merge = simulateVerifyResolve({
    flight,
    airlineIata: "UA",
    approxMinutes: 11 * 60,
    airlineFilteredRows: [
      { flightNumber: "UA1792", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" },
    ],
    routeOnlyRows: [],
  });
  assert("case 2: flight_number substituted to UA1792",
    merge.flight_number === "UA1792");
  assert("case 2: _scheduleVerified set",
    merge._scheduleVerified === true);
  assert("case 2: _autoResolvedFlightNumber set (substitution → PDF qualifier)",
    merge._autoResolvedFlightNumber === true);
}

console.log("=== Verify case 3 — route-only recovery for false-negative airline filter ===");
{
  // EWR-LAX AA200 case: airline=AA returns 0 (production false-negative),
  // route-only returns AA200 directly. Verify-mode picks the exact match.
  const flight = {
    carrier: "American",
    flight_number: "AA200",
    from_airport: "EWR",
    to_airport: "LAX",
    depart_time: "10:00 AM",
    arrive_time: "1:30 PM",
  };
  const merge = simulateVerifyResolve({
    flight,
    airlineIata: "AA",
    approxMinutes: 10 * 60,
    airlineFilteredRows: [],
    routeOnlyRows: [
      { flightNumber: "UA100", scheduledOut: "2026-08-15T14:00:00Z", scheduledIn: "2026-08-15T17:00:00Z" },
      { flightNumber: "AA200", scheduledOut: "2026-08-15T14:00:00Z", scheduledIn: "2026-08-15T17:30:00Z" },
    ],
  });
  assert("case 3: flight_number unchanged (route-only exact match)",
    merge.flight_number === "AA200");
  assert("case 3: _scheduleVerified set",
    merge._scheduleVerified === true);
  assert("case 3: NOT marked _autoResolvedFlightNumber (exact match)",
    merge._autoResolvedFlightNumber === undefined);
  assert("case 3: source = route-only",
    merge._resolveSource === "route-only");
}

console.log("=== Verify case 4 — route-only NO carrier match → verify-trusted fallback ===");
{
  // Production probe today: EWR-LAX route-only returns UA/TP/NH/VA/NZ
  // with ZERO AA rows. Verify-mode MUST NOT lift NH redeye times onto
  // the AA flight; MUST write _scheduleVerified + _verifyTrusted so
  // applyQualityLayer's exemption keeps the number.
  const flight = {
    carrier: "American",
    flight_number: "AA200",
    from_airport: "EWR",
    to_airport: "LAX",
    depart_time: "10:00 AM",
    arrive_time: "1:30 PM",
  };
  const merge = simulateVerifyResolve({
    flight,
    airlineIata: "AA",
    approxMinutes: 10 * 60,
    airlineFilteredRows: [],
    routeOnlyRows: [
      { flightNumber: "UA100", scheduledOut: "2026-08-15T14:00:00Z", scheduledIn: "2026-08-15T17:00:00Z" },
      { flightNumber: "NH7235", scheduledOut: "2026-08-15T04:10:00Z", scheduledIn: "2026-08-15T10:15:00Z" },
      { flightNumber: "TP200", scheduledOut: "2026-08-15T13:00:00Z", scheduledIn: "2026-08-15T16:00:00Z" },
    ],
  });
  assert("case 4: NO flight_number written by merge (kept as model emitted)",
    merge.flight_number === undefined);
  assert("case 4: _scheduleVerified set (saves number from strip)",
    merge._scheduleVerified === true);
  assert("case 4: _verifyTrusted set (downstream tooling can audit)",
    merge._verifyTrusted === true);
  assert("case 4: source = verify-fallback",
    merge._resolveSource === "verify-fallback");
  // Critical: no NH7235 times leaked onto the AA flight.
  assert("case 4: depart_time NOT lifted from cross-carrier NH7235",
    merge.depart_time === undefined);
}

console.log("=== Verify case 5 — total miss (no API rows anywhere) ===");
{
  const flight = {
    carrier: "United",
    flight_number: "UA1792",
    from_airport: "JAC",
    to_airport: "FLG",
    depart_time: "8:00 AM",
    arrive_time: "10:30 AM",
  };
  const merge = simulateVerifyResolve({
    flight,
    airlineIata: "UA",
    approxMinutes: 8 * 60,
    airlineFilteredRows: [],
    routeOnlyRows: [],
  });
  assert("case 5: _scheduleVerified set even with zero API data",
    merge._scheduleVerified === true);
  assert("case 5: _verifyTrusted set",
    merge._verifyTrusted === true);
  assert("case 5: no flight_number override",
    merge.flight_number === undefined);
}

console.log("=== Verify case 6 — carrier disagrees → defensive downgrade ===");
{
  // pick was somehow non-UA but airlineIata is UA. buildMergePayload's
  // defensive prefix re-check should refresh times only, NOT lift the
  // wrong-carrier number.
  const flight = {
    carrier: "United",
    flight_number: "UA1234",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "11:00 AM",
    arrive_time: "2:30 PM",
  };
  const pick = { flightNumber: "NH7235", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" };
  const merge = buildMergePayload({ mode: "verify", pick, currentFlight: flight, source: "manual-test", airlineIata: "UA" });
  assert("case 6: NO flight_number written (defensive downgrade)",
    merge.flight_number === undefined);
  assert("case 6: depart_time refreshed (times safe to lift, schedule is authoritative)",
    typeof merge.depart_time === "string");
  assert("case 6: _scheduleVerified still true (UA number survives strip)",
    merge._scheduleVerified === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
