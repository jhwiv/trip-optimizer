// Tests for src/flightResolver.js — the pure helpers behind the #12
// follow-up fix (FlightNumberAutoResolver). Locks in the four cases
// the user authorized in docs/wiki/concepts/flight-resolver-gaps.md:
//
//   A. Model omits both number and times → API miss (both attempts) →
//      _timesUnconfirmed fallback persists so the PDF can render an
//      honest line.
//   B. Model emits number only → resolver hits the API in "times" mode
//      and backfills times without overwriting the number.
//   C. Model emits everything → flightNeedsResolve returns null; no
//      resolver call needed.
//   D. Model omits both → airline-filter API miss → route-only retry
//      hits → number + times backfilled (carrier-match enforced so we
//      never mislabel a codeshare).
//
// The "API" is mocked. The pickScheduledFlight selector is the real
// pure helper from src/flightSelect.js, so this also exercises the
// existing time-match logic.

import {
  flightNeedsResolve,
  filterPoolByAirline,
  pickFromPool,
  buildMergePayload,
  buildUnconfirmedTimesPayload,
} from "../src/flightResolver.js";
import { pickScheduledFlight } from "../src/flightSelect.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== flightNeedsResolve — classification ===");
{
  // No number, no times → full resolve in "number" mode.
  assert("model omits everything → 'number'",
    flightNeedsResolve({ carrier: "United" }) === "number");

  // Has number, missing both times → "times".
  assert("model emits number only → 'times'",
    flightNeedsResolve({ carrier: "United", flight_number: "UA1792" }) === "times");

  // Has number + only depart_time → still 'times' (need arrive too).
  assert("model emits number + depart_time only → 'times'",
    flightNeedsResolve({ carrier: "UA", flight_number: "UA1792", depart_time: "8:30 AM" }) === "times");

  // Has number + only arrive_time → still 'times'.
  assert("model emits number + arrive_time only → 'times'",
    flightNeedsResolve({ carrier: "UA", flight_number: "UA1792", arrive_time: "11:30 AM" }) === "times");

  // Everything present → "verify". The model emitted a complete-looking
  // flight; we MUST verify it against the live schedule because
  // applyQualityLayer's universal number strip would otherwise null the
  // model's number when _scheduleVerified is missing. This was the
  // EWR-SFO recurrence root cause — the old behavior returned null and
  // let the strip nuke the number silently.
  assert("model emits everything → 'verify' (must confirm against live schedule)",
    flightNeedsResolve({ flight_number: "UA1792", depart_time: "8:30 AM", arrive_time: "11:30 AM" }) === "verify");

  // User-supplied with both times → null (skip; trust the user even if number is blank).
  assert("user supplied + both times → null (skip)",
    flightNeedsResolve({ _userSuppliedFlightNumber: true, depart_time: "8:30 AM", arrive_time: "11:30 AM" }) === null);

  // User-supplied but missing times → 'times' (still backfill).
  assert("user supplied + missing times → 'times'",
    flightNeedsResolve({ _userSuppliedFlightNumber: true }) === "times");

  // Whitespace-only string is not a valid number.
  assert("whitespace-only flight_number is treated as missing → 'number'",
    flightNeedsResolve({ flight_number: "   " }) === "number");

  // Defensive: garbage inputs don't throw.
  assert("null input → null (safe)", flightNeedsResolve(null) === null);
  assert("non-object input → null (safe)", flightNeedsResolve("UA1792") === null);
  assert("undefined input → null (safe)", flightNeedsResolve(undefined) === null);
}

console.log("=== filterPoolByAirline ===");
{
  const pool = [
    { flightNumber: "UA1792" },
    { flightNumber: "AA100" },
    { flightNumber: "UA205" },
    { flightNumber: "LH404" },
    { flightNumber: "" },          // missing number — gets filtered out by prefix mismatch
    { /* no flightNumber field */ },
  ];

  const ua = filterPoolByAirline(pool, "UA");
  assert("filters to UA flights only",
    ua.length === 2 && ua.every((x) => x.flightNumber.startsWith("UA")));

  const dl = filterPoolByAirline(pool, "DL");
  assert("filter with no matches returns empty array (not the original pool)",
    Array.isArray(dl) && dl.length === 0);

  const noFilter = filterPoolByAirline(pool, "");
  assert("empty airline returns pool unchanged",
    noFilter === pool);

  const nullFilter = filterPoolByAirline(pool, null);
  assert("null airline returns pool unchanged",
    nullFilter === pool);

  assert("non-array input returns empty array",
    Array.isArray(filterPoolByAirline(null, "UA")) && filterPoolByAirline(null, "UA").length === 0);

  // Case-insensitive prefix match.
  assert("airline matching is case-insensitive",
    filterPoolByAirline([{ flightNumber: "ua500" }], "UA").length === 1);
}

console.log("=== pickFromPool — airline-filtered selection ===");
{
  // Pool simulating an 8-AM departure with a 10:30 alternate. Pick the
  // closest match to a 8:00 target.
  const pool = [
    { flightNumber: "UA100", scheduledOut: "2026-08-15T08:00:00Z", scheduledIn: "2026-08-15T11:00:00Z" },
    { flightNumber: "UA200", scheduledOut: "2026-08-15T10:30:00Z", scheduledIn: "2026-08-15T13:30:00Z" },
    { flightNumber: "AA300", scheduledOut: "2026-08-15T08:15:00Z", scheduledIn: "2026-08-15T11:15:00Z" },
  ];

  const pickUA = pickFromPool({ flights: pool, airlineIata: "UA", approxMinutes: 8 * 60, pickScheduledFlight });
  assert("airline-filtered pick honors UA prefix",
    !!pickUA && pickUA.flightNumber === "UA100");

  // Empty pool returns null.
  assert("empty flights → null",
    pickFromPool({ flights: [], airlineIata: "UA", approxMinutes: 8 * 60, pickScheduledFlight }) === null);

  // Missing pickScheduledFlight returns null (defensive).
  assert("missing pickScheduledFlight → null",
    pickFromPool({ flights: pool, airlineIata: "UA", approxMinutes: 480, pickScheduledFlight: null }) === null);

  // No airline filter falls back to the whole pool.
  const pickAny = pickFromPool({ flights: pool, airlineIata: null, approxMinutes: 8 * 60, pickScheduledFlight });
  assert("null airline picks closest of full pool (UA100 at 08:00 wins vs AA300 at 08:15)",
    !!pickAny && pickAny.flightNumber === "UA100");
}

console.log("=== buildMergePayload — number mode (airline-filter happy path) ===");
{
  const currentFlight = { carrier: "United", from_airport: "EWR", to_airport: "SFO" };
  const pick = {
    flightNumber: "UA1792",
    scheduledOut: "2026-08-15T13:00:00Z",
    scheduledIn: "2026-08-15T16:00:00Z",
    aircraft: "Boeing 737",
  };
  const merged = buildMergePayload({ mode: "number", pick, currentFlight, source: "airline", airlineIata: "UA" });
  assert("number-mode merge writes flight_number",
    merged && merged.flight_number === "UA1792");
  assert("number-mode merge fills depart_time when missing",
    typeof merged.depart_time === "string" && merged.depart_time.length > 0);
  assert("number-mode merge fills arrive_time when missing",
    typeof merged.arrive_time === "string" && merged.arrive_time.length > 0);
  assert("number-mode merge sets _scheduleVerified",
    merged._scheduleVerified === true);
  assert("number-mode merge sets _autoResolvedFlightNumber",
    merged._autoResolvedFlightNumber === true);
  assert("number-mode merge captures _resolveSource",
    merged._resolveSource === "airline");
  assert("number-mode merge writes aircraft when missing",
    merged.aircraft === "Boeing 737");

  // Preserve a model-emitted depart_time over the API's value.
  const withModelTime = { carrier: "United", depart_time: "1:15 PM" };
  const merged2 = buildMergePayload({ mode: "number", pick, currentFlight: withModelTime, source: "airline", airlineIata: "UA" });
  assert("number-mode does NOT overwrite a model-emitted depart_time",
    merged2.depart_time === "1:15 PM");
}

console.log("=== buildMergePayload — number mode + cross-carrier safety (route-only) ===");
{
  // A route-only retry returned an AA flight when the model said United.
  // Honesty rule: never lift the *number* across carriers; the helper
  // should silently downgrade to times-only.
  const currentFlight = { carrier: "United", from_airport: "EWR", to_airport: "LAX" };
  const crossPick = {
    flightNumber: "AA200",
    scheduledOut: "2026-08-15T13:00:00Z",
    scheduledIn: "2026-08-15T16:00:00Z",
  };
  const merged = buildMergePayload({ mode: "number", pick: crossPick, currentFlight, source: "route-only", airlineIata: "UA" });
  assert("cross-carrier pick in number mode does NOT write the wrong flight_number",
    merged && merged.flight_number === undefined);
  assert("cross-carrier pick still writes times (safe to backfill schedule)",
    typeof merged.depart_time === "string" && typeof merged.arrive_time === "string");
  assert("cross-carrier pick does NOT set _autoResolvedFlightNumber (no number was resolved)",
    merged._autoResolvedFlightNumber === undefined);
  assert("cross-carrier pick still sets _scheduleVerified (times came from live schedule)",
    merged._scheduleVerified === true);
}

console.log("=== buildMergePayload — times mode (Gap 2 fix) ===");
{
  const currentFlight = {
    carrier: "UA",
    flight_number: "UA1792",
    from_airport: "EWR",
    to_airport: "SFO",
    // No times — the model omitted them and Gap 2 used to bail entirely.
  };
  const pick = {
    flightNumber: "UA1792",
    scheduledOut: "2026-08-15T13:00:00Z",
    scheduledIn: "2026-08-15T16:00:00Z",
  };
  const merged = buildMergePayload({ mode: "times", pick, currentFlight, source: "airline", airlineIata: "UA" });
  assert("times-mode merge fills depart_time",
    typeof merged.depart_time === "string" && merged.depart_time.length > 0);
  assert("times-mode merge fills arrive_time",
    typeof merged.arrive_time === "string" && merged.arrive_time.length > 0);
  assert("times-mode merge does NOT overwrite flight_number",
    merged.flight_number === undefined);
  assert("times-mode merge does NOT set _autoResolvedFlightNumber (PDF qualifier is only for number-resolves)",
    merged._autoResolvedFlightNumber === undefined);
  assert("times-mode merge still sets _scheduleVerified",
    merged._scheduleVerified === true);
}

console.log("=== buildMergePayload — defensive guards ===");
{
  assert("null currentFlight → null",
    buildMergePayload({ mode: "number", pick: { flightNumber: "UA1" }, currentFlight: null, airlineIata: "UA" }) === null);
  assert("null pick → null",
    buildMergePayload({ mode: "number", pick: null, currentFlight: {}, airlineIata: "UA" }) === null);
  assert("bogus mode → null",
    buildMergePayload({ mode: "bogus", pick: { flightNumber: "UA1" }, currentFlight: {}, airlineIata: "UA" }) === null);
}

console.log("=== buildUnconfirmedTimesPayload — Gap 1 fallback ===");
{
  // Model omitted times AND every API attempt missed → flag for PDF.
  const noTimes = { carrier: "United", flight_number: "UA1792" };
  const payload = buildUnconfirmedTimesPayload(noTimes);
  assert("missing-times flight → _timesUnconfirmed flag",
    payload && payload._timesUnconfirmed === true);

  // Has both times → no fallback needed.
  const withTimes = { carrier: "UA", flight_number: "UA1", depart_time: "8:30 AM", arrive_time: "11:30 AM" };
  assert("has both times → null (no fallback needed)",
    buildUnconfirmedTimesPayload(withTimes) === null);

  // Has one time only → still flag (partial info is honest fallback territory).
  const halfTimes = { carrier: "UA", flight_number: "UA1", depart_time: "8:30 AM" };
  assert("has only one time → still flagged",
    buildUnconfirmedTimesPayload(halfTimes) && buildUnconfirmedTimesPayload(halfTimes)._timesUnconfirmed === true);

  assert("null input → null (safe)",
    buildUnconfirmedTimesPayload(null) === null);
}

// ---------------------------------------------------------------------
// The four authorized scenarios from concepts/flight-resolver-gaps.md
// ---------------------------------------------------------------------

console.log("=== Scenario A — model omits both → API miss → fallback ===");
{
  const currentFlight = { carrier: "United", from_airport: "JAC", to_airport: "FLG" };
  // Both API attempts returned 0 flights (JAC-FLG has no UA service).
  const airlineHit = pickFromPool({ flights: [], airlineIata: "UA", approxMinutes: 480, pickScheduledFlight });
  const routeOnlyHit = pickFromPool({ flights: [], airlineIata: null, approxMinutes: 480, pickScheduledFlight });
  assert("airline pool empty → no pick",
    airlineHit === null);
  assert("route-only pool empty → no pick",
    routeOnlyHit === null);

  // No pick means we fall through to buildUnconfirmedTimesPayload.
  const fallback = buildUnconfirmedTimesPayload(currentFlight);
  assert("Scenario A: total miss → _timesUnconfirmed payload built",
    fallback && fallback._timesUnconfirmed === true);
}

console.log("=== Scenario B — model emits number only → times backfill ===");
{
  const currentFlight = {
    carrier: "UA",
    flight_number: "UA1792",
    from_airport: "EWR",
    to_airport: "SFO",
    // Model omitted depart_time and arrive_time.
  };
  // flightNeedsResolve correctly classifies this as 'times' mode.
  assert("Scenario B: classified as 'times'",
    flightNeedsResolve(currentFlight) === "times");

  const pool = [
    { flightNumber: "UA1792", scheduledOut: "2026-08-15T13:00:00Z", scheduledIn: "2026-08-15T16:00:00Z" },
    { flightNumber: "UA205", scheduledOut: "2026-08-15T18:00:00Z", scheduledIn: "2026-08-15T21:00:00Z" },
  ];
  const pick = pickFromPool({ flights: pool, airlineIata: "UA", approxMinutes: 13 * 60, pickScheduledFlight });
  assert("Scenario B: airline-filter pick lands on the correct UA flight",
    !!pick && pick.flightNumber === "UA1792");

  const merge = buildMergePayload({ mode: "times", pick, currentFlight, source: "airline", airlineIata: "UA" });
  assert("Scenario B: merge fills both times",
    typeof merge.depart_time === "string" && typeof merge.arrive_time === "string");
  assert("Scenario B: merge does NOT touch flight_number",
    merge.flight_number === undefined);
}

console.log("=== Scenario C — model emits everything → verify against live schedule ===");
{
  // This scenario was REWRITTEN. The original Scenario C asserted that a
  // complete-looking flight returned null and triggered NO resolver call.
  // That behavior caused the EWR-SFO recurrence: applyQualityLayer's
  // universal number strip nulled the model's number because
  // _scheduleVerified was never set. New behavior: complete flights enter
  // verify-mode and the resolver MUST run.
  const currentFlight = {
    carrier: "UA",
    flight_number: "UA1792",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "9:00 AM",
    arrive_time: "12:30 PM",
  };
  assert("Scenario C: flightNeedsResolve returns 'verify' (NOT null)",
    flightNeedsResolve(currentFlight) === "verify");
}

console.log("=== Scenario D — airline-filter miss → route-only retry recovers ===");
{
  // Model emits the AA flight number but no times. The airline-filter
  // API call returns 0 rows (the EWR-LAX-AA false-negative case from
  // the production probe). The route-only retry returns 15 rows
  // including the model's AA200.
  const currentFlight = { carrier: "American", flight_number: "AA200", from_airport: "EWR", to_airport: "LAX" };
  assert("Scenario D: classified as 'times' (number present, times missing)",
    flightNeedsResolve(currentFlight) === "times");

  // Airline-filter API call: 0 rows (the false-negative).
  const airlineFiltered = [];
  const airlinePick = pickFromPool({ flights: airlineFiltered, airlineIata: "AA", approxMinutes: 600, pickScheduledFlight });
  assert("Scenario D: airline-filter API miss → no pick",
    airlinePick === null);

  // Route-only retry returns flights from multiple carriers.
  const routeOnly = [
    { flightNumber: "UA100", scheduledOut: "2026-08-15T08:00:00Z", scheduledIn: "2026-08-15T11:00:00Z" },
    { flightNumber: "AA200", scheduledOut: "2026-08-15T10:00:00Z", scheduledIn: "2026-08-15T13:00:00Z" },
    { flightNumber: "UA300", scheduledOut: "2026-08-15T14:00:00Z", scheduledIn: "2026-08-15T17:00:00Z" },
  ];

  // In times-mode after route-only retry, the caller's intent is "find
  // the row whose number matches the model's number and lift its times."
  // We test by filtering route-only to the exact emitted number and
  // re-picking — this mirrors what the React component does.
  const exactMatch = routeOnly.find((f) => f.flightNumber === currentFlight.flight_number);
  assert("Scenario D: route-only retry contains the model's emitted number",
    !!exactMatch);

  const merge = buildMergePayload({ mode: "times", pick: exactMatch, currentFlight, source: "route-only", airlineIata: "AA" });
  assert("Scenario D: route-only times backfill writes depart_time",
    typeof merge.depart_time === "string" && merge.depart_time.length > 0);
  assert("Scenario D: route-only times backfill writes arrive_time",
    typeof merge.arrive_time === "string" && merge.arrive_time.length > 0);
  assert("Scenario D: route-only times backfill does NOT overwrite flight_number",
    merge.flight_number === undefined);
  assert("Scenario D: _resolveSource captures the retry path",
    merge._resolveSource === "route-only");
}

console.log("=== Scenario E — route-only retry with NO carrier match → fallback ===");
{
  // Real production case from 2026-06-30 probe: EWR-LAX with AA200
  // emitted by the model. Airline-filter API returns 0 rows. Route-only
  // retry returns 15 rows from UA/TP/NH/VA/NZ — zero AA rows. The route-
  // only retry MUST NOT lift any of those cross-carrier times onto the
  // AA flight; instead it must leave pick=null so _timesUnconfirmed
  // fires and the PDF renders an honest "check with airline" line.
  const currentFlight = { carrier: "American", flight_number: "AA200", from_airport: "EWR", to_airport: "LAX" };
  assert("Scenario E: classified as 'times' (number present, times missing)",
    flightNeedsResolve(currentFlight) === "times");

  // The route-only response shape from the production probe — ZERO AA rows.
  const routeOnly = [
    { flightNumber: "UA100", scheduledOut: "2026-08-15T08:00:00Z", scheduledIn: "2026-08-15T11:00:00Z" },
    { flightNumber: "TP200", scheduledOut: "2026-08-15T09:00:00Z", scheduledIn: "2026-08-15T12:00:00Z" },
    { flightNumber: "NH7235", scheduledOut: "2026-08-15T04:10:00Z", scheduledIn: "2026-08-15T10:15:00Z" },
    { flightNumber: "VA100", scheduledOut: "2026-08-15T11:00:00Z", scheduledIn: "2026-08-15T14:00:00Z" },
    { flightNumber: "NZ100", scheduledOut: "2026-08-15T13:00:00Z", scheduledIn: "2026-08-15T16:00:00Z" },
  ];

  // Mirror what the React component now does in times-mode after a
  // route-only retry: ONLY accept an exact flightNumber match. No
  // cross-carrier fallback. (Previously this line was `exact || pickFromPool(...)`.)
  const wanted = currentFlight.flight_number.toUpperCase();
  const exact = routeOnly.find(x => typeof x.flightNumber === "string" && x.flightNumber.toUpperCase() === wanted);
  const pick = exact || null;
  assert("Scenario E: no exact carrier-match in route-only → pick is null",
    pick === null);

  // Because pick is null, the resolver falls through to the unconfirmed
  // payload — honest fallback instead of wrong-carrier times.
  const fallback = buildUnconfirmedTimesPayload(currentFlight);
  assert("Scenario E: falls through to _timesUnconfirmed payload",
    fallback && fallback._timesUnconfirmed === true);

  // Sanity: NH7235 (the redeye that the old code would have lifted)
  // would have produced bogus times — confirm the test is meaningful.
  const nh = routeOnly.find(x => x.flightNumber === "NH7235");
  const wouldHaveBeenWrong = buildMergePayload({ mode: "times", pick: nh, currentFlight, source: "route-only", airlineIata: "AA" });
  assert("Scenario E (sanity): old behavior would have written NH times to the AA flight",
    typeof wouldHaveBeenWrong.depart_time === "string" && wouldHaveBeenWrong.depart_time.length > 0);

  // Same case in number-mode: pre-filter to AA-prefix → empty → pick
  // remains null → fallback fires.
  const aaOnly = routeOnly.filter(x => x.flightNumber.toUpperCase().startsWith("AA"));
  assert("Scenario E (number-mode): pre-filter to AA prefix yields empty pool",
    aaOnly.length === 0);
  const numberModePick = aaOnly.length > 0
    ? pickFromPool({ flights: aaOnly, airlineIata: "AA", approxMinutes: 600, pickScheduledFlight })
    : null;
  assert("Scenario E (number-mode): empty filtered pool → no pick",
    numberModePick === null);
}

console.log("=== Scenario F — verify mode confirmation (model right, schedule agrees) ===");
{
  // EWR-SFO UA1792 — the canonical recurrence case. Model emitted a
  // complete flight with depart/arrive times. API returns the same
  // UA1792 in the carrier-filtered pool. Result: _scheduleVerified set,
  // _autoResolvedFlightNumber NOT set (confirmation, not substitution),
  // number unchanged, times refreshed from the live schedule.
  const currentFlight = {
    carrier: "United",
    flight_number: "UA1792",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "11:00 AM",
    arrive_time: "2:30 PM",
  };
  assert("Scenario F: classified as 'verify'",
    flightNeedsResolve(currentFlight) === "verify");

  const airlinePool = [
    { flightNumber: "UA1792", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" },
    { flightNumber: "UA205",  scheduledOut: "2026-08-15T18:00:00Z", scheduledIn: "2026-08-15T21:00:00Z" },
  ];

  // Mirror App.jsx's verify-mode airline-filtered pick: prefer exact
  // flightNumber match.
  const wanted = currentFlight.flight_number.toUpperCase();
  const exact = airlinePool.find(x => x.flightNumber.toUpperCase() === wanted);
  assert("Scenario F: exact match found in airline-filtered pool",
    !!exact && exact.flightNumber === "UA1792");

  const merge = buildMergePayload({ mode: "verify", pick: exact, currentFlight, source: "airline", airlineIata: "UA" });
  assert("Scenario F: merge writes the same flight_number (confirmation)",
    merge.flight_number === "UA1792");
  assert("Scenario F: merge sets _scheduleVerified",
    merge._scheduleVerified === true);
  assert("Scenario F: confirmation does NOT set _autoResolvedFlightNumber",
    merge._autoResolvedFlightNumber === undefined);
  assert("Scenario F: merge refreshes depart_time from the live schedule",
    typeof merge.depart_time === "string" && merge.depart_time.length > 0);
}

console.log("=== Scenario G — verify mode substitution (model fabricated, schedule corrects) ===");
{
  // Model emitted UA9999 (a fabricated number not in the live schedule),
  // both times present. API returns UA1792 at the model's time slot.
  // Result: _scheduleVerified + _autoResolvedFlightNumber set, number
  // substituted to UA1792, times refreshed.
  const currentFlight = {
    carrier: "United",
    flight_number: "UA9999",
    from_airport: "EWR",
    to_airport: "SFO",
    depart_time: "11:00 AM",
    arrive_time: "2:30 PM",
  };
  assert("Scenario G: classified as 'verify'",
    flightNeedsResolve(currentFlight) === "verify");

  const airlinePool = [
    { flightNumber: "UA1792", scheduledOut: "2026-08-15T15:00:00Z", scheduledIn: "2026-08-15T18:30:00Z" },
    { flightNumber: "UA205",  scheduledOut: "2026-08-15T18:00:00Z", scheduledIn: "2026-08-15T21:00:00Z" },
  ];

  // No exact match → fall back to time-proximity carrier-matched pick.
  const wanted = currentFlight.flight_number.toUpperCase();
  const exact = airlinePool.find(x => x.flightNumber.toUpperCase() === wanted);
  assert("Scenario G: no exact match for UA9999 in pool",
    !exact);

  const pick = pickFromPool({ flights: airlinePool, airlineIata: "UA", approxMinutes: 11 * 60, pickScheduledFlight });
  assert("Scenario G: time-proximity pick lands on UA1792",
    pick && pick.flightNumber === "UA1792");

  const merge = buildMergePayload({ mode: "verify", pick, currentFlight, source: "airline", airlineIata: "UA" });
  assert("Scenario G: merge substitutes the schedule's number",
    merge.flight_number === "UA1792");
  assert("Scenario G: merge sets _scheduleVerified",
    merge._scheduleVerified === true);
  assert("Scenario G: substitution sets _autoResolvedFlightNumber (PDF qualifier)",
    merge._autoResolvedFlightNumber === true);
}

console.log("=== Scenario H — verify mode total miss (route not served by carrier) ===");
{
  // Model emitted AA200 EWR-LAX with full times. API returns 0 for AA on
  // both airline-filtered AND no carrier-matching rows in route-only.
  // The resolver MUST still write _scheduleVerified (with _verifyTrusted
  // tagging the fallback) so applyQualityLayer's strip doesn't null the
  // number. The full App.jsx-side fallback is covered by the integration
  // tests; here we lock the helper-level invariants.
  const currentFlight = {
    carrier: "American",
    flight_number: "AA200",
    from_airport: "EWR",
    to_airport: "LAX",
    depart_time: "10:00 AM",
    arrive_time: "1:30 PM",
  };
  assert("Scenario H: classified as 'verify'",
    flightNeedsResolve(currentFlight) === "verify");

  const airlineFiltered = [];
  const routeOnly = [
    { flightNumber: "UA100", scheduledOut: "2026-08-15T14:00:00Z", scheduledIn: "2026-08-15T17:00:00Z" },
  ];
  const pickFromAirline = airlineFiltered.length > 0
    ? pickFromPool({ flights: airlineFiltered, airlineIata: "AA", approxMinutes: 600, pickScheduledFlight })
    : null;
  assert("Scenario H: airline-filtered pool empty → no pick",
    pickFromAirline === null);

  const aaOnly = routeOnly.filter(x => x.flightNumber.toUpperCase().startsWith("AA"));
  assert("Scenario H: route-only carrier-filtered pool empty → no pick",
    aaOnly.length === 0);

  // buildUnconfirmedTimesPayload returns null because the flight has
  // both times — proving the App.jsx-side fallback is the ONLY safe path.
  const wouldFallback = buildUnconfirmedTimesPayload(currentFlight);
  assert("Scenario H: buildUnconfirmedTimesPayload returns null (flight has both times)",
    wouldFallback === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
