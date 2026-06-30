// End-to-end test of the flight-number pipeline. This is the test
// file that, if it had existed when PR #84/#106/#108 shipped, would
// have caught the EWR-SFO recurrence.
//
// Composes the full sequence:
//
//   1. Model emits a `rawData` plan with various flight shapes.
//   2. FlightNumberAutoResolver runs — simulated by stepping through
//      target collection + per-flight API simulation + merge.
//   3. The resolver's merges are applied to rawData via the same
//      immutable-update pattern App.jsx uses (onPlanRevised).
//   4. applyFlightNumberStrip runs (the strip + exemption logic).
//   5. We assert the final rendered plan has the right flight numbers,
//      times, and flags.
//
// The pipeline contract this locks in:
//
//   A. A complete-looking flight with airline-confirmed schedule →
//      renders the model's number with _scheduleVerified.
//   B. A complete-looking flight where the model fabricated the
//      number → renders the schedule's substituted number with
//      _autoResolvedFlightNumber + _scheduleVerified.
//   C. A complete-looking flight on a carrier that doesn't serve
//      the route → renders the model's number with _scheduleVerified
//      + _verifyTrusted (the safe fallback).
//   D. A complete-looking flight where preconditions fail (bad
//      airport code, unparseable date) → renders the model's number
//      with _scheduleVerified + _verifyTrusted.
//   E. An incomplete flight (no number) gets the full resolver +
//      _scheduleVerified + _autoResolvedFlightNumber.
//   F. A user-supplied number always survives intact regardless of
//      resolver behavior.

import { flightNeedsResolve, pickFromPool, buildMergePayload, buildUnconfirmedTimesPayload } from "../src/flightResolver.js";
import { pickScheduledFlight, resolveAirlineIata, normalizeAirportCode, parseClockToMinutes } from "../src/flightSelect.js";
import { applyFlightNumberStrip } from "../src/flightNumberStrip.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Mirror of the App.jsx parseDayLabelToISODate helper. Inlined here so
// the e2e simulation matches what production runs.
function parseDayLabelToISODate(label) {
  if (!label || typeof label !== "string") return null;
  const m = label.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:[, ]+(\d{4}))?/i);
  if (!m) return null;
  const monthIdx = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[1].toLowerCase().slice(0, 3));
  if (monthIdx < 0) return null;
  const day = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Simulates the FlightNumberAutoResolver effect (App.jsx ~6557-6735),
// composing target collection + per-flight verify-mode/number/times
// resolution + onPlanRevised commit. The `mockApi` map is keyed by
// `${origin}-${destination}-${airline || 'ROUTE'}` and returns the
// rows the API would return. Missing key = empty response (true miss).
async function simulateResolver(plan, mockApi) {
  if (!plan || !Array.isArray(plan.days)) return plan;

  const targets = [];
  const verifyTrustOnly = [];
  plan.days.forEach((d, di) => {
    (Array.isArray(d.items) ? d.items : []).forEach((it, ii) => {
      if (it?.type !== "Flight" || !it.flight) return;
      const mode = flightNeedsResolve(it.flight);
      if (!mode) return;
      const fromCode = normalizeAirportCode(it.flight.from_airport);
      const toCode = normalizeAirportCode(it.flight.to_airport);
      const isoDate = parseDayLabelToISODate(d.label);
      if (!fromCode || !toCode || !isoDate) {
        if (mode === "verify") verifyTrustOnly.push({ di, ii });
        return;
      }
      targets.push({ di, ii, fl: it.flight, fromCode, toCode, isoDate, mode });
    });
  });

  if (targets.length === 0 && verifyTrustOnly.length === 0) return plan;

  const resolved = [];
  for (const vt of verifyTrustOnly) {
    resolved.push({
      di: vt.di,
      ii: vt.ii,
      merge: { _scheduleVerified: true, _verifyTrusted: true, _resolveSource: "verify-precondition-skipped" },
    });
  }

  for (const t of targets) {
    const iata = resolveAirlineIata(t.fl.carrier);
    const approx = parseClockToMinutes(t.fl.depart_time);
    let pick = null;
    let source = null;

    // Attempt 1: airline-filtered.
    if (iata) {
      const key = `${t.fromCode}-${t.toCode}-${iata}`;
      const rows = mockApi[key] || [];
      if (rows.length > 0) {
        if (t.mode === "verify" && t.fl.flight_number) {
          const wanted = String(t.fl.flight_number).trim().toUpperCase();
          const exact = rows.find((x) => x.flightNumber.toUpperCase() === wanted);
          pick = exact || pickFromPool({ flights: rows, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
        } else {
          pick = pickFromPool({ flights: rows, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
        }
        if (pick) source = "airline";
      }
    }

    // Attempt 2: route-only retry.
    if (!pick) {
      const key = `${t.fromCode}-${t.toCode}-ROUTE`;
      const rows = mockApi[key] || [];
      if (rows.length > 0) {
        if (t.mode === "times" && t.fl.flight_number) {
          const wanted = String(t.fl.flight_number).trim().toUpperCase();
          pick = rows.find((x) => x.flightNumber.toUpperCase() === wanted) || null;
        } else if (t.mode === "verify" && t.fl.flight_number && iata) {
          const wanted = String(t.fl.flight_number).trim().toUpperCase();
          const exact = rows.find((x) => x.flightNumber.toUpperCase() === wanted);
          if (exact) {
            pick = exact;
          } else {
            const filtered = rows.filter((x) => x.flightNumber.toUpperCase().startsWith(iata.toUpperCase()));
            if (filtered.length > 0) {
              pick = pickFromPool({ flights: filtered, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
            }
          }
        } else if (t.mode === "number" && iata) {
          const filtered = rows.filter((x) => x.flightNumber.toUpperCase().startsWith(iata.toUpperCase()));
          if (filtered.length > 0) {
            pick = pickFromPool({ flights: filtered, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
          }
        } else {
          pick = pickFromPool({ flights: rows, airlineIata: null, approxMinutes: approx, pickScheduledFlight });
        }
        if (pick) source = "route-only";
      }
    }

    if (pick) {
      const merge = buildMergePayload({ mode: t.mode, pick, currentFlight: t.fl, source, airlineIata: iata });
      if (merge) {
        resolved.push({ di: t.di, ii: t.ii, merge });
        continue;
      }
    }

    if (t.mode === "verify" && t.fl.flight_number) {
      resolved.push({
        di: t.di,
        ii: t.ii,
        merge: { _scheduleVerified: true, _verifyTrusted: true, _resolveSource: "verify-fallback" },
      });
      continue;
    }

    const fallback = buildUnconfirmedTimesPayload(t.fl);
    if (fallback) resolved.push({ di: t.di, ii: t.ii, merge: fallback });
  }

  // Mirror App.jsx's onPlanRevised commit pattern.
  const nextDays = plan.days.map((d, di) => {
    const hits = resolved.filter((r) => r.di === di);
    if (hits.length === 0) return d;
    const items = d.items.map((it, ii) => {
      const hit = hits.find((h) => h.ii === ii);
      if (!hit) return it;
      return { ...it, flight: { ...it.flight, ...hit.merge } };
    });
    return { ...d, items };
  });
  return { ...plan, days: nextDays };
}

// Helper that composes the full pipeline: resolver → strip → return.
async function runPipeline(plan, inputs, mockApi) {
  const resolved = await simulateResolver(plan, mockApi);
  const { days } = applyFlightNumberStrip(resolved.days, inputs);
  return { ...resolved, days };
}

console.log("=== Contract A — complete EWR-SFO UA, airline-confirmed ===");
{
  const plan = {
    days: [{
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
        },
      }],
    }],
  };
  const mockApi = {
    "EWR-SFO-UA": [
      { flightNumber: "UA1792", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" },
      { flightNumber: "UA205", scheduledOut: "2026-08-15T18:00:00Z", scheduledIn: "2026-08-15T21:00:00Z" },
    ],
  };
  const out = await runPipeline(plan, { narrative: "", guidelines: "" }, mockApi);
  const f = out.days[0].items[0].flight;
  assert("Contract A: final flight_number is UA1792",
    f.flight_number === "UA1792");
  assert("Contract A: _scheduleVerified = true",
    f._scheduleVerified === true);
  assert("Contract A: NOT _autoResolvedFlightNumber (confirmation)",
    f._autoResolvedFlightNumber === undefined);
  assert("Contract A: NOT _flightNumberStripped (exemption worked)",
    f._flightNumberStripped === undefined);
}

console.log("=== Contract B — complete EWR-SFO UA, model fabricated ===");
{
  const plan = {
    days: [{
      label: "Thu Aug 15",
      items: [{
        type: "Flight",
        flight: {
          carrier: "United",
          flight_number: "UA9999",
          from_airport: "EWR",
          to_airport: "SFO",
          depart_time: "11:00 AM",
          arrive_time: "2:30 PM",
        },
      }],
    }],
  };
  const mockApi = {
    "EWR-SFO-UA": [
      { flightNumber: "UA1792", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" },
    ],
  };
  const out = await runPipeline(plan, { narrative: "", guidelines: "" }, mockApi);
  const f = out.days[0].items[0].flight;
  assert("Contract B: final flight_number substituted to UA1792",
    f.flight_number === "UA1792");
  assert("Contract B: _scheduleVerified = true",
    f._scheduleVerified === true);
  assert("Contract B: _autoResolvedFlightNumber = true (PDF shows 'Verify at booking')",
    f._autoResolvedFlightNumber === true);
}

console.log("=== Contract C — complete EWR-LAX AA, carrier doesn't serve route ===");
{
  // Production probe today: EWR-LAX with airline=AA returns 0 rows;
  // route-only returns 15 rows from UA/TP/NH/VA/NZ with ZERO AA. The
  // pipeline MUST keep the model's AA200 number, not lift NH7235 times.
  const plan = {
    days: [{
      label: "Thu Aug 15",
      items: [{
        type: "Flight",
        flight: {
          carrier: "American",
          flight_number: "AA200",
          from_airport: "EWR",
          to_airport: "LAX",
          depart_time: "10:00 AM",
          arrive_time: "1:30 PM",
        },
      }],
    }],
  };
  const mockApi = {
    "EWR-LAX-AA": [],
    "EWR-LAX-ROUTE": [
      { flightNumber: "UA100", scheduledOut: "2026-08-15T14:00:00Z", scheduledIn: "2026-08-15T17:00:00Z" },
      { flightNumber: "NH7235", scheduledOut: "2026-08-15T04:10:00Z", scheduledIn: "2026-08-15T10:15:00Z" },
      { flightNumber: "TP200", scheduledOut: "2026-08-15T13:00:00Z", scheduledIn: "2026-08-15T16:00:00Z" },
    ],
  };
  const out = await runPipeline(plan, { narrative: "", guidelines: "" }, mockApi);
  const f = out.days[0].items[0].flight;
  assert("Contract C: AA200 survives (not stripped)",
    f.flight_number === "AA200");
  assert("Contract C: depart_time NOT NH7235 redeye",
    f.depart_time === "10:00 AM");
  assert("Contract C: _scheduleVerified set (saves number from strip)",
    f._scheduleVerified === true);
  assert("Contract C: _verifyTrusted set (audit flag)",
    f._verifyTrusted === true);
}

console.log("=== Contract D — preconditions fail (no airport code) ===");
{
  const plan = {
    days: [{
      label: "Thu Aug 15",
      items: [{
        type: "Flight",
        flight: {
          carrier: "United",
          flight_number: "UA1792",
          from_airport: "Newark",  // no code parseable
          to_airport: "San Francisco",
          depart_time: "11:00 AM",
          arrive_time: "2:30 PM",
        },
      }],
    }],
  };
  const out = await runPipeline(plan, { narrative: "", guidelines: "" }, {});
  const f = out.days[0].items[0].flight;
  assert("Contract D: UA1792 survives precondition failure",
    f.flight_number === "UA1792");
  assert("Contract D: _scheduleVerified + _verifyTrusted set via verifyTrustOnly path",
    f._scheduleVerified === true && f._verifyTrusted === true);
}

console.log("=== Contract E — incomplete (no number) → full resolve ===");
{
  const plan = {
    days: [{
      label: "Thu Aug 15",
      items: [{
        type: "Flight",
        flight: {
          carrier: "United",
          from_airport: "EWR",
          to_airport: "SFO",
        },
      }],
    }],
  };
  const mockApi = {
    "EWR-SFO-UA": [
      { flightNumber: "UA1792", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" },
    ],
  };
  const out = await runPipeline(plan, { narrative: "", guidelines: "" }, mockApi);
  const f = out.days[0].items[0].flight;
  assert("Contract E: incomplete flight resolved to UA1792",
    f.flight_number === "UA1792");
  assert("Contract E: _scheduleVerified set",
    f._scheduleVerified === true);
  assert("Contract E: _autoResolvedFlightNumber set",
    f._autoResolvedFlightNumber === true);
}

console.log("=== Contract F — user-supplied number always survives ===");
{
  // User dictated UA1039 in narrative. With verify-mode the resolver
  // sees an unstripped rawData flight (no _userSuppliedFlightNumber
  // flag yet — that gets set on the strip's CLONE in `data`, not on
  // rawData), classifies it as 'verify', and either confirms via API
  // or hits the verify-trusted fallback. Either way the strip's Rule A
  // _scheduleVerified exemption keeps UA1039 intact.
  //
  // We test the API-empty / verify-fallback branch here — most
  // conservative case for user-supplied flights.
  const plan = {
    days: [{
      label: "Thu Aug 15",
      items: [{
        type: "Flight",
        flight: {
          carrier: "United",
          flight_number: "UA1039",
          from_airport: "EWR",
          to_airport: "SFO",
          depart_time: "11:00 AM",
          arrive_time: "2:30 PM",
        },
      }],
    }],
  };
  const out = await runPipeline(plan, {
    narrative: "We're on UA1039",
    guidelines: "",
  }, {});
  const f = out.days[0].items[0].flight;
  // The user's UA1039 survives the pipeline. The display form is
  // "UA1039" rather than the strip's digits-only "1039" because
  // _scheduleVerified shortcuts the strip's normalization — but
  // parseFlightIdent at App.jsx:1023 handles both forms identically
  // (case 1: direct "UA1039" match → returns "UA1039").
  assert("Contract F: user-supplied UA1039 survives the pipeline",
    f.flight_number === "UA1039");
  assert("Contract F: _scheduleVerified set (saves number from strip)",
    f._scheduleVerified === true);
  assert("Contract F: number is NOT null (the bug we are closing)",
    f.flight_number !== null);
}

console.log("=== Recurrence guard — EWR-SFO UA does NOT regress to null ===");
{
  // The EXACT bug that surfaced 2026-06-30 PM. This single assertion
  // is the canary. If anyone in the future re-introduces the
  // "complete flight skips resolver → strip nulls number" pattern,
  // this fails.
  const plan = {
    days: [{
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
        },
      }],
    }],
  };
  // Empty API response simulates a "true miss" — even then the verify
  // fallback MUST keep the number.
  const out = await runPipeline(plan, { narrative: "", guidelines: "" }, {});
  const f = out.days[0].items[0].flight;
  assert("RECURRENCE GUARD: EWR-SFO UA1792 final number is NOT null",
    f.flight_number !== null);
  assert("RECURRENCE GUARD: EWR-SFO UA1792 number === 'UA1792'",
    f.flight_number === "UA1792");
  assert("RECURRENCE GUARD: NOT _flightNumberStripped",
    f._flightNumberStripped === undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
