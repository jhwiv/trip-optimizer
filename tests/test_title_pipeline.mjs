// Integration test: strip output → FlightCard title composition.
//
// The specific gap this file closes:
//
//   PR #114 root cause — FlightCard rendered "United · EWR → SFO" while the
//   trip Overview showed "United UA 337 · EWR → SFO". Both components read
//   from the same plan, but FlightCard's inline title code only checked
//   _userSuppliedFlightNumber; _scheduleVerified was never read there.
//
//   PR #114 extracted buildFlightCardTitle and fixed the precedence. The
//   existing unit tests (test_flight_card_title.mjs, test_flight_number_strip.mjs,
//   test_flight_pipeline_e2e.mjs) each cover ONE layer. This file tests the
//   INTERFACE between the strip and the title function — the exact seam that
//   failed: "strip preserved the number, does the title function read it?"
//
// Without this test, the prior failure pattern was:
//   1. Strip tests: pass (data has the right value).
//   2. Title tests: pass (helper returns correct output for given input).
//   3. Integration: fail (FlightCard passed wrong input to helper / ignored output).
//
// With this test, any regression to that pattern breaks here explicitly.

import { applyFlightNumberStrip } from "../src/flightNumberStrip.js";
import { buildFlightCardTitle } from "../src/flightCardTitle.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail ? `— ${detail}` : ""); }
}

// Helper: run a raw flight object through applyFlightNumberStrip (simulating
// applyQualityLayer step 2b), then through buildFlightCardTitle. Returns
// { flight, title } where flight is the post-strip object and title is the
// string that FlightCard would render.
function pipelineTitle(rawFlight, dayLabel, inputs = {}, autoFlight = null) {
  const plan = {
    days: [{ label: dayLabel, items: [{ type: "Flight", flight: rawFlight }] }],
  };
  const { days } = applyFlightNumberStrip(plan.days, inputs);
  const f = days[0].items[0].flight;
  const route = [f.from_airport, f.to_airport].filter(Boolean).join(" → ");
  const title = buildFlightCardTitle({ flight: f, autoFlight, route });
  return { flight: f, title };
}

// ---------------------------------------------------------------------------
// Scenario 1 — RECURRENCE GUARD (the exact EWR-SFO SF build case)
// The resolver ran, wrote _scheduleVerified + flight_number = "UA 337" to
// rawData. applyQualityLayer re-runs → strip exempts via _scheduleVerified.
// FlightCard title must include "UA 337", not just "United".
// ---------------------------------------------------------------------------
console.log("=== Scenario 1 — RECURRENCE GUARD: _scheduleVerified → title shows flight number ===");
{
  const { flight, title } = pipelineTitle(
    {
      carrier: "United",
      flight_number: "UA 337",
      _scheduleVerified: true,
      from_airport: "EWR",
      to_airport: "SFO",
      depart_time: "8:00 AM",
      arrive_time: "11:20 AM",
    },
    "Thu Jun 5",
    { narrative: "", guidelines: "" },
  );
  assert("RECURRENCE GUARD: _scheduleVerified flight NOT stripped",
    flight.flight_number === "UA 337");
  assert("RECURRENCE GUARD: _flightNumberStripped NOT set",
    flight._flightNumberStripped === undefined);
  assert("RECURRENCE GUARD: title contains UA 337",
    title.includes("UA 337"),
    `got: "${title}"`);
  assert("RECURRENCE GUARD: title contains United",
    title.includes("United"),
    `got: "${title}"`);
  assert("RECURRENCE GUARD: title contains route",
    title.includes("EWR → SFO"),
    `got: "${title}"`);
  assert("RECURRENCE GUARD: full title matches expected",
    title === "United UA 337 · EWR → SFO",
    `got: "${title}"`);
}

// ---------------------------------------------------------------------------
// Scenario 2 — user-supplied number survives strip and appears in title
// ---------------------------------------------------------------------------
console.log("=== Scenario 2 — user-supplied number: _userSuppliedFlightNumber → title ===");
{
  const { flight, title } = pipelineTitle(
    {
      carrier: "United",
      flight_number: "UA1039",
      from_airport: "EWR",
      to_airport: "SFO",
      depart_time: "11:00 AM",
      arrive_time: "2:30 PM",
    },
    "Thu Aug 15",
    { narrative: "We're flying UA1039", guidelines: "" },
  );
  assert("User-supplied: number survives strip",
    flight.flight_number !== null);
  assert("User-supplied: _userSuppliedFlightNumber set",
    flight._userSuppliedFlightNumber === true);
  assert("User-supplied: NOT _flightNumberStripped",
    flight._flightNumberStripped === undefined);
  assert("User-supplied: title includes flight number",
    title.includes("1039"),
    `got: "${title}"`);
}

// ---------------------------------------------------------------------------
// Scenario 3 — model-only number (no _scheduleVerified, not user-supplied)
// Strip marks it estimated → title shows number with "~" prefix as badge.
// ---------------------------------------------------------------------------
console.log("=== Scenario 3 — model-only number: strip marks estimated → ~prefix title ===");
{
  const { flight, title } = pipelineTitle(
    {
      carrier: "United",
      flight_number: "UA9999",
      from_airport: "EWR",
      to_airport: "SFO",
      depart_time: "11:00 AM",
      arrive_time: "2:30 PM",
    },
    "Thu Aug 15",
    { narrative: "", guidelines: "" },
  );
  assert("Model-only: number is KEPT (not nulled)",
    flight.flight_number === "UA9999");
  assert("Model-only: _modelEstimatedFlightNumber = true",
    flight._modelEstimatedFlightNumber === true);
  assert("Model-only: title contains model's number with ~ prefix",
    title.includes("~UA9999"),
    `got: "${title}"`);
  assert("Model-only: title includes carrier",
    title.includes("United"),
    `got: "${title}"`);
}

// ---------------------------------------------------------------------------
// Scenario 4 — no number at all → no strip mutation, carrier-only title
// ---------------------------------------------------------------------------
console.log("=== Scenario 4 — no number emitted by model → carrier-only title ===");
{
  const { flight, title } = pipelineTitle(
    {
      carrier: "Delta",
      from_airport: "JFK",
      to_airport: "LAX",
    },
    "Fri Aug 16",
    { narrative: "", guidelines: "" },
  );
  assert("No number: flight_number still null",
    flight.flight_number == null);
  assert("No number: _flightNumberStripped NOT set (no number to strip)",
    flight._flightNumberStripped === undefined);
  assert("No number: title is carrier + route",
    title === "Delta · JFK → LAX",
    `got: "${title}"`);
}

// ---------------------------------------------------------------------------
// Scenario 5 — _scheduleVerified + autoFlight available.
// Schedule-verified should WIN over autoFlight (higher precedence).
// ---------------------------------------------------------------------------
console.log("=== Scenario 5 — _scheduleVerified beats autoFlight fallback ===");
{
  const autoFlight = { flightNumber: "UA999" }; // would be shown if verified path ignored
  const { flight, title } = pipelineTitle(
    {
      carrier: "United",
      flight_number: "UA 337",
      _scheduleVerified: true,
      from_airport: "EWR",
      to_airport: "SFO",
    },
    "Thu Jun 5",
    { narrative: "", guidelines: "" },
    autoFlight,
  );
  assert("Verified beats autoFlight: title shows UA 337 (not UA999)",
    title.includes("UA 337") && !title.includes("UA999"),
    `got: "${title}"`);
}

// ---------------------------------------------------------------------------
// Scenario 6 — return leg: user supplied two numbers, back-fill picks return
// ---------------------------------------------------------------------------
console.log("=== Scenario 6 — user-supplied two numbers, return leg picks second ===");
{
  const { flight, title } = pipelineTitle(
    {
      carrier: "United",
      from_airport: "SFO",
      to_airport: "EWR",
      depart_time: "1:00 PM",
      arrive_time: "9:30 PM",
    },
    "Mon Jun 9",
    {
      narrative: "outbound UA 337 return UA 1986",
      guidelines: "",
      flights: { homeAirport: "EWR" },
    },
  );
  assert("Return leg backfill: _userSuppliedFlightNumber set",
    flight._userSuppliedFlightNumber === true);
  assert("Return leg backfill: title includes 1986",
    title.includes("1986"),
    `got: "${title}"`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
