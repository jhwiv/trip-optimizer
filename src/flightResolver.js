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

import { formatAirportLocalTime } from "./airportTz.js";
import { normalizeClock } from "./flightTimeConsistency.js";

// Classify what a flight needs from the resolver:
//   "number" — no usable flight number AND not user-supplied. Run the
//              full airline-filtered resolve (number + times).
//   "times"  — has a flight number (or user supplied one) but missing
//              one or both clock times. Run a times-only backfill;
//              never overwrite the number.
//   "verify" — has number AND both times. The model emitted a complete-
//              looking flight, but applyQualityLayer strips ALL model-
//              emitted numbers unless _scheduleVerified is set. Without
//              this mode the resolver skips the flight, the strip nulls
//              the number, and the user sees nothing on screen or PDF.
//              See docs/wiki/concepts/flight-resolver-gaps.md § the
//              EWR-SFO recurrence for the full diagnosis. The verify-
//              mode resolver call confirms the number against the live
//              schedule (passes through unchanged + _scheduleVerified)
//              OR substitutes the schedule's number if the model's was
//              fabricated OR falls back to _timesUnconfirmed if the
//              schedule API can't help.
//   null     — skip entirely. Two cases:
//              • user-supplied with complete fields (user facts always
//                win; the strip's _userSuppliedFlightNumber exemption
//                already keeps the number safe).
//              • _scheduleVerified === true (flight was already confirmed
//                by a prior resolver run; skipping prevents the infinite
//                cleanup→restart loop that the resolver's own
//                onPlanRevised call would otherwise trigger).
//
// Also returns null for malformed inputs so the caller can treat the
// classification as a single "should-skip" check.
export function flightNeedsResolve(fl) {
  if (!fl || typeof fl !== "object") return null;
  // Already confirmed against the live schedule — skip so the resolver's own
  // onPlanRevised write doesn't kick off an infinite cleanup→restart loop.
  // The flag is cleared when the plan is replaced (auto-apply, ReviewPanel
  // revision), letting the resolver re-run on the fresh plan.
  if (fl._scheduleVerified === true) return null;
  const num = typeof fl.flight_number === "string" ? fl.flight_number.trim() : "";
  const hasNum = num.length > 0 || fl._userSuppliedFlightNumber === true;
  const depart = typeof fl.depart_time === "string" ? fl.depart_time.trim() : "";
  const arrive = typeof fl.arrive_time === "string" ? fl.arrive_time.trim() : "";
  const hasBothTimes = depart.length > 0 && arrive.length > 0;
  // User-supplied flights with complete fields skip entirely — the
  // applyQualityLayer user-supplied exception keeps the number.
  if (fl._userSuppliedFlightNumber === true && hasBothTimes) return null;
  if (!hasNum) return "number";
  if (hasNum && !hasBothTimes) return "times";
  // Has number AND both times AND not user-supplied → verify against
  // live schedule. This is the case that caused the EWR-SFO recurrence:
  // model emitted a complete flight, resolver used to skip, strip nulled
  // the number, screen + PDF showed nothing.
  return "verify";
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
//   4. A falsy airlineIata means the carrier never resolved to an IATA
//      code, so the schedule pool was never filtered by airline and the
//      pick may be some other carrier's flight. Those payloads refresh
//      times only, keep the model's number, carry _carrierUnresolved, and
//      never set _scheduleVerified.
//
// Returns either a partial flight object to merge, or null if nothing
// should be written (e.g. mode mismatch). Never throws.
export function buildMergePayload({ mode, pick, currentFlight, source, airlineIata }) {
  if (!currentFlight || typeof currentFlight !== "object") return null;
  if (!pick || typeof pick !== "object") return null;
  if (mode !== "number" && mode !== "times" && mode !== "verify") return null;

  // Format schedule timestamps in the AIRPORT's local timezone, not the JS
  // runtime's (UTC on Cloudflare Workers). Departures localize to the origin
  // airport, arrivals to the destination — otherwise an overnight arrival
  // prints its UTC wall-clock and reads as landing before/after the wrong
  // day (bug #3a). pick.origin/pick.destination are IATA codes from the
  // schedules worker; when either is missing or unmapped, formatAirportLocalTime
  // falls back to a UTC render rather than inventing an offset.
  const toDepart = (iso) => formatAirportLocalTime(iso, pick.origin);
  const toArrive = (iso) => formatAirportLocalTime(iso, pick.destination);

  // Honesty check: in number-resolve mode, never lift a number whose
  // carrier prefix disagrees with the requested airline. pickFromPool
  // already enforces this, but this second check makes the helper safe
  // even when a future caller hands us a pick from somewhere else.
  //
  // A null airlineIata is the more dangerous case: the pool was never
  // filtered by carrier, so the pick can belong to any airline that flies
  // the route (a "LOT" leg picking up UA940). Downgrade to times-only and
  // record _carrierUnresolved so the times tail withholds _scheduleVerified
  // — the model's number stays subject to the number-strip pass.
  let carrierUnresolved = false;
  if (mode === "number") {
    if (!airlineIata) {
      carrierUnresolved = true;
      mode = "times";
    } else {
      const pickPrefix =
        typeof pick.flightNumber === "string" ? pick.flightNumber.slice(0, 2).toUpperCase() : "";
      if (pickPrefix && pickPrefix !== airlineIata.toUpperCase()) {
        // Cross-carrier candidate — could be a codeshare we don't want to
        // mislabel. Fall back to times-only.
        mode = "times";
      }
    }
  }

  if (mode === "number") {
    // Time provenance: pickDepart/pickArrive come from the schedule API
    // (authoritative when present). currentFlight.* is the model's guess.
    // If we end up shipping a model-time (because the schedule row lacked
    // the field), mark _verifyTrusted so the PDF renders concierge tone
    // rather than presenting the model guess as schedule-confirmed.
    const pickDepart = toDepart(pick.scheduledOut);
    const pickArrive = toArrive(pick.scheduledIn);
    const departFromModel = !!currentFlight.depart_time && !pickDepart;
    const arriveFromModel = !!currentFlight.arrive_time && !pickArrive;
    const anyTimeFromModel = departFromModel || arriveFromModel;
    return {
      flight_number: pick.flightNumber,
      depart_time: currentFlight.depart_time || pickDepart,
      arrive_time: currentFlight.arrive_time || pickArrive,
      ...(pick.aircraft && !currentFlight.aircraft ? { aircraft: pick.aircraft } : {}),
      _scheduleVerified: true,
      _autoResolvedFlightNumber: true,
      ...(anyTimeFromModel ? { _verifyTrusted: true } : {}),
      // source captured so downstream tooling can audit how a number
      // was resolved if needed; PDF doesn't read this.
      _resolveSource: source || "airline",
    };
  }

  if (mode === "verify") {
    // verify-mode: model emitted a complete flight (number + both times).
    // The pick must already be carrier-matched (App.jsx pre-filters by
    // IATA in route-only retry; airline-filtered pool naturally matches).
    // Defensive prefix re-check: if the pick disagrees with the requested
    // airline, do NOT lift the number — refresh times only, keep model's
    // number, but still mark _scheduleVerified so applyQualityLayer's
    // exemption keeps the model's number safe.
    //
    // Same treatment when the carrier couldn't be resolved to an IATA code
    // at all, with one difference: an unresolved carrier means the pool was
    // never filtered by airline, so nothing here confirms the model's number
    // and _scheduleVerified is withheld.
    const pickPrefix =
      typeof pick.flightNumber === "string" ? pick.flightNumber.slice(0, 2).toUpperCase() : "";
    const crossCarrier = !!airlineIata && !!pickPrefix && pickPrefix !== airlineIata.toUpperCase();
    if (!airlineIata || crossCarrier) {
      const pickDepart = toDepart(pick.scheduledOut);
      const pickArrive = toArrive(pick.scheduledIn);
      // We're keeping the model's number and only refreshing times where the
      // schedule has them. If neither time came from the schedule (or the
      // schedule field was empty), the shipped time is the model's guess —
      // tag _verifyTrusted.
      const departFromModel = !pickDepart && !!currentFlight.depart_time;
      const arriveFromModel = !pickArrive && !!currentFlight.arrive_time;
      const anyTimeFromModel = departFromModel || arriveFromModel;
      return {
        depart_time: pickDepart || currentFlight.depart_time,
        arrive_time: pickArrive || currentFlight.arrive_time,
        ...(pick.aircraft && !currentFlight.aircraft ? { aircraft: pick.aircraft } : {}),
        ...(airlineIata ? { _scheduleVerified: true } : { _carrierUnresolved: true }),
        ...(anyTimeFromModel ? { _verifyTrusted: true } : {}),
        _resolveSource: source || "airline",
      };
    }
    // The pick's number may be identical to the model's (the API confirmed
    // it) or different (the model fabricated, the schedule corrected). In
    // both cases the schedule is authoritative — lift the schedule's number
    // and refresh times. _autoResolvedFlightNumber is set ONLY when the
    // schedule overrode the model, so the PDF renders the "Verify at
    // booking" qualifier only on substitutions, not on confirmations.
    const currentNum =
      typeof currentFlight.flight_number === "string"
        ? currentFlight.flight_number.trim().toUpperCase()
        : "";
    const pickNum =
      typeof pick.flightNumber === "string" ? pick.flightNumber.toUpperCase() : "";
    const overrode = currentNum !== pickNum;
    // Time provenance same as number-mode above: prefer the schedule's
    // authoritative times. If we fall back to the model's time because
    // the schedule row was missing that field, tag _verifyTrusted so the
    // PDF renders concierge tone rather than schedule-confirmed styling.
    const pickDepart = toDepart(pick.scheduledOut);
    const pickArrive = toArrive(pick.scheduledIn);
    const departFromModel = !pickDepart && !!currentFlight.depart_time;
    const arriveFromModel = !pickArrive && !!currentFlight.arrive_time;
    const anyTimeFromModel = departFromModel || arriveFromModel;
    return {
      flight_number: pick.flightNumber,
      depart_time: pickDepart || currentFlight.depart_time,
      arrive_time: pickArrive || currentFlight.arrive_time,
      ...(pick.aircraft && !currentFlight.aircraft ? { aircraft: pick.aircraft } : {}),
      _scheduleVerified: true,
      ...(overrode ? { _autoResolvedFlightNumber: true } : {}),
      ...(anyTimeFromModel ? { _verifyTrusted: true } : {}),
      _resolveSource: source || "airline",
    };
  }

  // mode === "times": fill missing times only. Never touch the number,
  // never set _autoResolvedFlightNumber (PDF only adds the qualifier
  // when we resolved the number too). _scheduleVerified is set because
  // the pick came from the live schedule API — except when we arrived here
  // by downgrading an unresolved-carrier number-resolve, where the pick
  // can't be attributed to this airline at all. But if the schedule row
  // lacked one of the times and we ended up preserving the model's,
  // tag _verifyTrusted so the PDF renders concierge tone.
  const pickDepart = toDepart(pick.scheduledOut);
  const pickArrive = toArrive(pick.scheduledIn);
  const departFromModel = !!currentFlight.depart_time && !pickDepart;
  const arriveFromModel = !!currentFlight.arrive_time && !pickArrive;
  const anyTimeFromModel = departFromModel || arriveFromModel;
  return {
    depart_time: currentFlight.depart_time || pickDepart,
    arrive_time: currentFlight.arrive_time || pickArrive,
    ...(pick.aircraft && !currentFlight.aircraft ? { aircraft: pick.aircraft } : {}),
    ...(carrierUnresolved ? { _carrierUnresolved: true } : { _scheduleVerified: true }),
    ...(anyTimeFromModel ? { _verifyTrusted: true } : {}),
    _resolveSource: source || "airline",
  };
}

// Commit a merge payload onto a Flight item, keeping the item-level header
// clock equal to the flight's departure time.
//
// buildMergePayload can only describe the flight object; item.time is its
// sibling, so the two clocks used to drift apart every time the resolver
// replaced a model-guessed depart_time with the live schedule's — the day
// header kept the model's number and the flight row got the real one (report
// bug 4). Doing the sync here rather than in the merge payload keeps
// buildMergePayload a pure flight→flight function and still gives the
// propagation its own unit test.
//
// The header is normalized to 24h "HH:MM" per the item schema, even though
// depart_time may arrive from Intl as "8:20 AM".
export function withFlightMerge(item, merge) {
  if (!item || typeof item !== "object") return item;
  const flight = { ...(item.flight || {}), ...(merge || {}) };
  const next = { ...item, flight };
  const depart = normalizeClock(flight.depart_time);
  if (depart !== null) next.time = depart;
  return next;
}

// Build the merge payload for the case where the resolver could not confirm
// the flight against a live schedule at all.
//
// _timesUnconfirmed used to be the only marker, and it was scoped to the
// narrow case where the model ALSO omitted times. That left the worst variant
// silent: the model invents a complete-looking regional flight (report bug 6 —
// AF7652 Caen→CDG→AMS, a route Air France does not fly), the schedule API
// can't confirm it, and because the times were present nothing was written.
// The card and PDF then rendered it exactly like a confirmed flight.
//
// _flightUnverified is the general marker: set whenever both resolve attempts
// came back empty, times or no times. _timesUnconfirmed is still emitted
// alongside it when the clocks are actually missing, so the existing PDF
// fallback line and any in-flight plan objects keep working for one release.
//
// `routeExists` distinguishes the two failure shapes the route-only retry can
// tell apart, and is what makes that retry consequential rather than just a
// second chance:
//   true      — the route is scheduled, this carrier isn't on it
//   false     — no scheduled service on this route at all
//   undefined — the schedule API never answered
export function buildUnverifiedFlightPayload(currentFlight, opts = {}) {
  if (!currentFlight || typeof currentFlight !== "object") return null;
  const depart = typeof currentFlight.depart_time === "string" ? currentFlight.depart_time.trim() : "";
  const arrive = typeof currentFlight.arrive_time === "string" ? currentFlight.arrive_time.trim() : "";
  const hasBothTimes = depart.length > 0 && arrive.length > 0;
  const reason =
    opts.routeExists === true ? "carrier-not-on-route"
      : opts.routeExists === false ? "no-scheduled-route"
        : "schedule-unavailable";
  return {
    _flightUnverified: true,
    _unverifiedReason: reason,
    ...(hasBothTimes ? {} : { _timesUnconfirmed: true }),
  };
}

// Plan walk over the marker above, for applyQualityLayer. Severity depends on
// WHICH failure it was, mirroring the venue precedent in CLAUDE.md: NOT_FOUND
// (the API answered and knew nothing) blocks, UNVERIFIED (the lookup could not
// run) warns.
//
// An unconfirmable regional hop is usually still the right plan — the traveller
// just has to call the airline, so those stay warns. A route the schedule API
// affirmatively reports no service on is the LH2224 CDG→NUE shape: a flight
// nobody operates, printed in 11pt beside a one-line caveat. That is a
// fabricated fact and must not reach the PDF.
const UNVERIFIED_SEVERITY = {
  "no-scheduled-route": "block",       // API answered, zero service on this route
  "carrier-not-on-route": "warn",      // API answered; route exists but not via this carrier
  "schedule-unavailable": "warn",      // API never answered / horizon exceeded
};

const UNVERIFIED_REASON_COPY = {
  "carrier-not-on-route": "the schedule shows service on this route but not by this carrier",
  "no-scheduled-route": "the schedule shows no service on this route",
  "schedule-unavailable": "the schedule lookup could not be completed",
};

export function findUnverifiedFlights(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const out = [];
  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    items.forEach((item, itemIdx) => {
      const fl = item?.type === "Flight" ? item.flight : null;
      if (!fl || fl._flightUnverified !== true) return;
      const label = [fl.carrier, fl.flight_number].filter(Boolean).join(" ").trim() || item.text || `Day ${dayIdx + 1} flight`;
      const route = fl.from_airport && fl.to_airport ? ` ${fl.from_airport}→${fl.to_airport}` : "";
      const why = UNVERIFIED_REASON_COPY[fl._unverifiedReason] || UNVERIFIED_REASON_COPY["schedule-unavailable"];
      // Unknown or absent reason → warn. Plans built before the reason was
      // recorded must not start blocking export retroactively.
      const severity = UNVERIFIED_SEVERITY[fl._unverifiedReason] || "warn";
      out.push({
        code: "FLIGHT_UNVERIFIED",
        severity,
        dayIdx,
        itemIdx,
        day: dayIdx + 1,
        target: label,
        message: `${label}${route}: not confirmed against a live schedule — ${why}. Verify with the airline before booking.`,
      });
    });
  });
  return out;
}

// Narrow legacy wrapper: the "model omitted times too" case. Returns null when
// the flight already has both times so callers can use it as a "should I
// commit?" check. Prefer buildUnverifiedFlightPayload for new call sites.
export function buildUnconfirmedTimesPayload(currentFlight) {
  const payload = buildUnverifiedFlightPayload(currentFlight);
  if (!payload || !payload._timesUnconfirmed) return null;
  return { _timesUnconfirmed: true };
}
