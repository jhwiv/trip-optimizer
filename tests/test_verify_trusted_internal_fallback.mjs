// Test: buildMergePayload must set _verifyTrusted whenever the shipped
// depart_time or arrive_time came from the model (currentFlight.*) rather
// than from the schedule API pick. Previously only App.jsx's total-miss
// fallback set the flag; the resolver-internal fallback silently preserved
// model times without any downstream signal, which meant the PDF rendered
// them as "schedule-confirmed" even though they weren't.
//
// This guards the fix at fix/verify-trusted-internal-fallback.
import { buildMergePayload } from "../src/flightResolver.js";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
function it(label, fn) {
  try { fn(); console.log("  ✓", label); pass++; }
  catch (e) { console.log("  ✗", label, "\n     ", e.message); fail++; }
}

console.log("test_verify_trusted_internal_fallback.mjs");

// Case 1: schedule pick has BOTH times → _verifyTrusted must NOT be set
// (the shipped times are authoritative from the schedule).
it("verify-mode, schedule provides both times → no _verifyTrusted", () => {
  const merge = buildMergePayload({
    mode: "verify",
    pick: {
      flightNumber: "DL70",
      scheduledOut: "2026-09-03T19:35:00Z",   // 15:35 ATL local
      scheduledIn:  "2026-09-04T04:00:00Z",   // 06:00 AMS local
      origin: "ATL",
      destination: "AMS",
    },
    currentFlight: {
      flight_number: "DL70",
      depart_time: "3:35 PM",
      arrive_time: "6:00 AM",
    },
    source: "airline",
    airlineIata: "DL",
  });
  assert.equal(merge._scheduleVerified, true);
  assert.equal(merge._verifyTrusted, undefined, "must NOT set _verifyTrusted");
});

// Case 2: schedule pick has NEITHER time → resolver falls back to model
// times → _verifyTrusted must be set so PDF renders concierge tone.
it("verify-mode, schedule missing both times → _verifyTrusted set", () => {
  const merge = buildMergePayload({
    mode: "verify",
    pick: {
      flightNumber: "DL9374",
      scheduledOut: null,
      scheduledIn: null,
      origin: "AMS",
      destination: "ATL",
    },
    currentFlight: {
      flight_number: "DL9374",
      depart_time: "5:05 PM",
      arrive_time: "8:25 PM",
    },
    source: "airline",
    airlineIata: "DL",
  });
  assert.equal(merge._scheduleVerified, true);
  assert.equal(merge._verifyTrusted, true, "MUST set _verifyTrusted (times from model)");
});

// Case 3: schedule pick has ONLY depart time → arrival came from model
// → _verifyTrusted must be set (any-time-from-model rule).
it("verify-mode, schedule has depart but not arrive → _verifyTrusted set", () => {
  const merge = buildMergePayload({
    mode: "verify",
    pick: {
      flightNumber: "DL70",
      scheduledOut: "2026-09-03T19:35:00Z",
      scheduledIn: null,
      origin: "ATL",
      destination: "AMS",
    },
    currentFlight: {
      flight_number: "DL70",
      depart_time: "3:35 PM",
      arrive_time: "6:00 AM",
    },
    source: "airline",
    airlineIata: "DL",
  });
  assert.equal(merge._verifyTrusted, true, "arrive came from model → _verifyTrusted");
});

// Case 4: number-mode (model gave no times) → shipping model times when
// schedule pick lacks them is the same honesty risk. Flag must be set.
it("number-mode, schedule missing both times, model has both → _verifyTrusted", () => {
  const merge = buildMergePayload({
    mode: "number",
    pick: {
      flightNumber: "DL70",
      scheduledOut: null,
      scheduledIn: null,
      origin: "ATL",
      destination: "AMS",
    },
    currentFlight: {
      depart_time: "3:35 PM",
      arrive_time: "6:00 AM",
    },
    source: "airline",
    airlineIata: "DL",
  });
  assert.equal(merge._verifyTrusted, true);
});

// Case 5: number-mode, schedule provides both times, model had none →
// authoritative schedule times, no _verifyTrusted.
it("number-mode, schedule provides both times → no _verifyTrusted", () => {
  const merge = buildMergePayload({
    mode: "number",
    pick: {
      flightNumber: "DL70",
      scheduledOut: "2026-09-03T19:35:00Z",
      scheduledIn: "2026-09-04T04:00:00Z",
      origin: "ATL",
      destination: "AMS",
    },
    currentFlight: {},
    source: "airline",
    airlineIata: "DL",
  });
  assert.equal(merge._scheduleVerified, true);
  assert.equal(merge._verifyTrusted, undefined);
});

// Case 6: times-mode fallback path. Model had number but no times;
// schedule pick has times → authoritative, no flag.
it("times-mode, schedule provides both times → no _verifyTrusted", () => {
  const merge = buildMergePayload({
    mode: "times",
    pick: {
      flightNumber: "DL70",
      scheduledOut: "2026-09-03T19:35:00Z",
      scheduledIn: "2026-09-04T04:00:00Z",
      origin: "ATL",
      destination: "AMS",
    },
    currentFlight: { flight_number: "DL70" },
    source: "airline",
    airlineIata: "DL",
  });
  assert.equal(merge._scheduleVerified, true);
  assert.equal(merge._verifyTrusted, undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
