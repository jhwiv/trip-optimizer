// Pure helpers behind FlightNumberAutoResolver — the #12 follow-up fix
// (see docs/wiki/concepts/flight-resolver-gaps.md). Extracted so the
// per-flight resolve/retry/backfill decisions can be unit-tested without
// React, a DOM, or a live network. The React component in App.jsx
// composes these helpers + the fetch + the onPlanRevised commit.
//
// Two coverage gaps in PR #84's original fix this module exists to close:
//
//   Gap 1 — API miss on the airline-filtered query. The upstream worker
//   sometimes returns 0 rows for a real-and-scheduled route just because
//   the airline filter excluded valid options (codeshares, alliance
//   partners). A route-only retry recovers those misses.
//
//   Gap 2 — Resolver bailed entirely when the model emitted a number,
//   even if it omitted times. That left flight cards / PDF with carrier
//   + number but no clock times. Expanded targets[] to include those
//   flights in a "times-only backfill" mode, never overwriting the
//   model-emitted number.
//
// Honesty rule (kept from PR #84): never lift a *number* from a
// route-only retry result — carriers fly each other's metal under
// codeshare and we'd label the wrong airline. Route-only results only
// contribute times when the model already supplied the number. When
// route-only is used in number-resolve mode, the airline-filter pre-
// pool inside pickFromPool still constrains the carrier match before
// any number lift, so the rule still holds.

// Classify what a flight needs from the resolver:
//   "number" — no usable flight number AND not user-supplied. Run the
//              full airline-filtered resolve (number + times).
//   "times"  — has a flight number (or user supplied one) but missing
//              one or both clock times. Run a times-only backfill;
//              never overwrite the number.
//   null     — has number AND both times, or is user-supplied with
//              complete fields. Skip entirely.
//
// Also returns null for malformed inputs so the caller can treat the
// classification as a single "should-skip" check.
export function flightNeedsResolve(fl) {
  if (!fl || typeof fl !== "object") return null;
  const num = typeof fl.flight_number === "string" ? fl.flight_number.trim() : "";
  const hasNum = num.length > 0 || fl._userSuppliedFlightNumber === true;
  const depart = typeof fl.depart_time === "string" ? fl.depart_time.trim() : "";
  const arrive = typeof fl.arrive_time === "string" ? fl.arrive_time.trim() : "";
  const hasBothTimes = depart.length > 0 && arrive.length > 0;
  if (!hasNum) return "number";
  if (hasNum && !hasBothTimes) return "times";
  return null;
}

// Filter a flights[] response by airline IATA prefix on the flight
// number. Same logic the existing resolver used inline at App.jsx:6489,
// extracted so the airline-filter pool selection is testable and the
// route-only retry can reuse it.
//
// Behavior:
//   - airlineIata null/empty → returns the full list unchanged (caller
//     should treat the whole pool as eligible).
//   - airlineIata set → returns the subset whose flightNumber starts
//     with that prefix (case-insensitive). May return an empty array;
//     callers must decide how to handle that (see pickFromPool).
export function filterPoolByAirline(flights, airlineIata) {
  if (!Array.isArray(flights)) return [];
  if (!airlineIata || typeof airlineIata !== "string") return flights;
  const prefix = airlineIata.toUpperCase();
  return flights.filter((x) => {
    const fn = typeof x?.flightNumber === "string" ? x.flightNumber : "";
    return fn.toUpperCase().startsWith(prefix);
  });
}

// Given the raw response.flights[] + an airline IATA + an approximate
// departure clock-minutes value, pick a scheduled flight to lift fields
// from. Mirrors the existing resolver's inline pool/eligible/pick logic
// from App.jsx ~6489–6494:
//
//   1. Filter the pool by airline IATA prefix if provided.
//   2. If the filtered pool is empty, fall back to the full list as
//      eligible (the upstream worker sometimes returns codeshare/alliance
//      flights with the right route under a partner code; we still want
//      to be able to time-match against them).
//   3. Hand the eligible list to pickScheduledFlight, which uses
//      approxMinutes for time-of-day proximity and re-applies the
//      airline filter as a tiebreaker.
//
// Returns the pick or null. Caller decides what to do with null.
export function pickFromPool({ flights, airlineIata, approxMinutes, pickScheduledFlight }) {
  if (typeof pickScheduledFlight !== "function") return null;
  if (!Array.isArray(flights) || flights.length === 0) return null;
  const filtered = filterPoolByAirline(flights, airlineIata);
  const eligible = filtered.length > 0 ? filtered : flights;
  const pick = pickScheduledFlight(eligible, approxMinutes, airlineIata || null);
  return pick && pick.flightNumber ? pick : null;
}

// Build the merge payload that gets spread into the existing flight
// object on the canonical plan. The shape mirrors what PR #84 already
// wrote, with three additions:
//
//   1. mode === "times" never sets flight_number or _autoResolvedFlightNumber.
//      The number on disk is the model's; we only lift the matched
//      scheduled flight's clock times.
//   2. source === "route-only" in number mode is allowed BUT requires
//      that the picked flight's airline prefix matches the requested
//      airlineIata (already enforced by pickFromPool, but asserted here
//      defensively in case a caller bypasses the helper).
//   3. _timesUnconfirmed is set when the resolver gave up on a flight
//      that had no times to begin with — the PDF uses this to render
//      an honest "confirm at booking" line in place of a blank.
//
// Returns either a partial flight object to merge, or null if nothing
// should be written (e.g. mode mismatch). Never throws.
export function buildMergePayload({ mode, pick, currentFlight, source, airlineIata }) {
  if (!currentFlight || typeof currentFlight !== "object") return null;
  if (!pick || typeof pick !== "object") return null;
  if (mode !== "number" && mode !== "times") return null;

  const toT = (iso) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }) : undefined;

  // Honesty check: in number-resolve mode, never lift a number whose
  // carrier prefix disagrees with the requested airline. pickFromPool
  // already enforces this, but this second check makes the helper safe
  // even when a future caller hands us a pick from somewhere else.
  if (mode === "number" && airlineIata) {
    const pickPrefix =
      typeof pick.flightNumber === "string" ? pick.flightNumber.slice(0, 2).toUpperCase() : "";
    if (pickPrefix && pickPrefix !== airlineIata.toUpperCase()) {
      // Cross-carrier candidate — could be a codeshare we don't want to
      // mislabel. Fall back to times-only.
      mode = "times";
    }
  }

  if (mode === "number") {
    return {
      flight_number: pick.flightNumber,
      depart_time: currentFlight.depart_time || toT(pick.scheduledOut),
      arrive_time: currentFlight.arrive_time || toT(pick.scheduledIn),
      ...(pick.aircraft && !currentFlight.aircraft ? { aircraft: pick.aircraft } : {}),
      _scheduleVerified: true,
      _autoResolvedFlightNumber: true,
      // source captured so downstream tooling can audit how a number
      // was resolved if needed; PDF doesn't read this.
      _resolveSource: source || "airline",
    };
  }

  // mode === "times": fill missing times only. Never touch the number,
  // never set _autoResolvedFlightNumber (PDF only adds the qualifier
  // when we resolved the number too). _scheduleVerified is still set
  // because the times came from the live schedule API.
  return {
    depart_time: currentFlight.depart_time || toT(pick.scheduledOut),
    arrive_time: currentFlight.arrive_time || toT(pick.scheduledIn),
    ...(pick.aircraft && !currentFlight.aircraft ? { aircraft: pick.aircraft } : {}),
    _scheduleVerified: true,
    _resolveSource: source || "airline",
  };
}

// Build the merge payload for the case where every resolve attempt
// failed AND the model also omitted times. The PDF reads
// _timesUnconfirmed to render an honest "Times not yet confirmed —
// check with airline at booking" line in place of a blank.
//
// Returns null when the flight already has both times (no fallback
// needed) so callers can use this as a "should I commit?" check.
export function buildUnconfirmedTimesPayload(currentFlight) {
  if (!currentFlight || typeof currentFlight !== "object") return null;
  const depart = typeof currentFlight.depart_time === "string" ? currentFlight.depart_time.trim() : "";
  const arrive = typeof currentFlight.arrive_time === "string" ? currentFlight.arrive_time.trim() : "";
  if (depart.length > 0 && arrive.length > 0) return null;
  return { _timesUnconfirmed: true };
}
