// Tests for src/flightNumberStrip.js — the universal number strip +
// schedule-verified exemption. This module is a faithful extraction of
// the strip block at src/App.jsx ~2906-2972 (applyQualityLayer).
//
// Why this test file exists: the EWR-SFO recurrence (2026-06-30 PM)
// happened because the strip's exemption was hard-gated on
// _scheduleVerified, but the resolver (FlightNumberAutoResolver) only
// wrote _scheduleVerified for incomplete flights. Complete-looking
// model output (number + both times) never reached the resolver,
// never got _scheduleVerified, and the strip nulled the number.
//
// These tests lock in the contract between the strip and the resolver:
//
//   A. _scheduleVerified === true MUST cause the strip to leave the
//      number alone. This is the resolver's promise.
//   B. user-supplied flight numbers (matching userFlightNumbers built
//      from inputs.narrative + inputs.guidelines) MUST be kept.
//   C. Every other model-emitted number MUST be stripped, with
//      _originalFlightNumber preserved + _flightNumberStripped = true.
//   D. When the model omitted the number AND the user named one, the
//      strip back-fills the user's number with _userSuppliedFlightNumber.
//
// Any future change that breaks A-D will surface here.

import { applyFlightNumberStrip, buildUserFlightNumbers } from "../src/flightNumberStrip.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== buildUserFlightNumbers — narrative extraction ===");
{
  const ufn = buildUserFlightNumbers({
    narrative: "We're on UA1039 outbound and Delta 47 home",
    guidelines: "",
  });
  assert("extracts UA1039 (airline code + number)", ufn.has("UA1039"));
  assert("extracts bare 1039 for cross-checking", ufn.has("1039"));
  assert("extracts 47 from 'Delta 47'", ufn.has("47"));

  const ufn2 = buildUserFlightNumbers({
    narrative: "flight 1234 outbound, flight #5678 return",
    guidelines: "",
  });
  assert("extracts 1234 from 'flight 1234'", ufn2.has("1234"));
  assert("extracts 5678 from 'flight #5678'", ufn2.has("5678"));

  const ufnEmpty = buildUserFlightNumbers({ narrative: "Just a Denver trip", guidelines: "" });
  assert("no flight numbers in plain prose → empty set", ufnEmpty.size === 0);

  assert("safe on null inputs", buildUserFlightNumbers(null).size === 0);
}

console.log("=== Contract A — _scheduleVerified exemption ===");
{
  // The canonical recurrence case: model emitted a complete EWR-SFO UA
  // flight, resolver wrote _scheduleVerified, strip MUST keep the number.
  const days = [{
    label: "Thu Aug 15",
    items: [{
      type: "Flight",
      flight: {
        carrier: "United",
        flight_number: "UA1792",
        from_airport: "EWR",
        to_airport: "SFO",
        depart_time: "11:00 AM",
        arrive_time: "2:30 PM",
        _scheduleVerified: true,
      },
    }],
  }];
  const { days: out } = applyFlightNumberStrip(days, { narrative: "", guidelines: "" });
  const f = out[0].items[0].flight;
  assert("Contract A: _scheduleVerified flight keeps its number",
    f.flight_number === "UA1792");
  assert("Contract A: _scheduleVerified flight is NOT marked stripped",
    f._flightNumberStripped === undefined);
  assert("Contract A: _scheduleVerified flag survives",
    f._scheduleVerified === true);
}

console.log("=== Contract A negative — WITHOUT _scheduleVerified the same flight is stripped ===");
{
  // The exact same flight, but no _scheduleVerified flag. This is the
  // BUG case: pre-fix, the resolver never wrote the flag for complete
  // flights, and the strip nulled the number. We lock the bad behavior
  // in deliberately so future code can't accidentally invert the
  // exemption semantics.
  const days = [{
    label: "Thu Aug 15",
    items: [{
      type: "Flight",
      flight: {
        carrier: "United",
        flight_number: "UA1792",
        from_airport: "EWR",
        to_airport: "SFO",
        depart_time: "11:00 AM",
        arrive_time: "2:30 PM",
        // NO _scheduleVerified
      },
    }],
  }];
  const { days: out } = applyFlightNumberStrip(days, { narrative: "", guidelines: "" });
  const f = out[0].items[0].flight;
  assert("Contract A neg: without _scheduleVerified, number is stripped to null",
    f.flight_number === null);
  assert("Contract A neg: _flightNumberStripped = true",
    f._flightNumberStripped === true);
  assert("Contract A neg: original number preserved in _originalFlightNumber",
    f._originalFlightNumber === "UA1792");
}

console.log("=== Contract B — user-supplied number is kept ===");
{
  const days = [{
    label: "Thu Aug 15",
    items: [{
      type: "Flight",
      flight: {
        carrier: "United",
        flight_number: "UA1039",
        from_airport: "EWR",
        to_airport: "SFO",
      },
    }],
  }];
  const { days: out } = applyFlightNumberStrip(days, {
    narrative: "We're booked on UA1039",
    guidelines: "",
  });
  const f = out[0].items[0].flight;
  assert("Contract B: user-supplied number kept (normalized to digits)",
    f.flight_number === "1039");
  assert("Contract B: _userSuppliedFlightNumber set",
    f._userSuppliedFlightNumber === true);
}

console.log("=== Contract C — model-only number is stripped ===");
{
  const days = [{
    label: "Thu Aug 15",
    items: [{
      type: "Flight",
      flight: {
        carrier: "United",
        flight_number: "UA9999",  // fabricated
        from_airport: "EWR",
        to_airport: "SFO",
      },
    }],
  }];
  const { days: out, fixes } = applyFlightNumberStrip(days, { narrative: "", guidelines: "" });
  const f = out[0].items[0].flight;
  assert("Contract C: model-only number stripped to null",
    f.flight_number === null);
  assert("Contract C: _flightNumberStripped = true",
    f._flightNumberStripped === true);
  assert("Contract C: _originalFlightNumber preserved",
    f._originalFlightNumber === "UA9999");
  assert("Contract C: fixes log includes the strip line",
    fixes.some((s) => s.includes("removed model-supplied flight number")));
}

console.log("=== Contract D — back-fill user number when model omits ===");
{
  const days = [
    {
      label: "Thu Aug 15",
      items: [{
        type: "Flight",
        flight: { carrier: "United", from_airport: "EWR", to_airport: "SFO" },
      }],
    },
    {
      label: "Sun Aug 18",
      items: [{
        type: "Flight",
        flight: { carrier: "United", from_airport: "SFO", to_airport: "EWR" },
      }],
    },
  ];
  const { days: out } = applyFlightNumberStrip(days, {
    narrative: "Outbound on UA1039, return on UA1040",
    guidelines: "",
    flights: { homeAirport: "EWR" },
  });
  const outbound = out[0].items[0].flight;
  const return_ = out[1].items[0].flight;
  assert("Contract D: outbound back-fills first user number",
    outbound.flight_number === "1039");
  assert("Contract D: return back-fills second user number (route-direction detected)",
    return_.flight_number === "1040");
  assert("Contract D: both flagged _userSuppliedFlightNumber",
    outbound._userSuppliedFlightNumber === true && return_._userSuppliedFlightNumber === true);
}

console.log("=== Edge — no flights in plan ===");
{
  const days = [{ label: "Thu Aug 15", items: [{ type: "Hotel", hotel: { name: "Foo" } }] }];
  const { days: out, fixes } = applyFlightNumberStrip(days, { narrative: "", guidelines: "" });
  assert("Edge: non-flight items pass through untouched",
    out[0].items[0].type === "Hotel" && out[0].items[0].hotel.name === "Foo");
  assert("Edge: no fixes for non-flight items",
    fixes.length === 0);
}

console.log("=== Edge — malformed input ===");
{
  const { days: out1 } = applyFlightNumberStrip(null, { narrative: "" });
  assert("Edge: null days passes through", out1 === null);
  const { days: out2 } = applyFlightNumberStrip([], {});
  assert("Edge: empty days returns empty array", Array.isArray(out2) && out2.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
