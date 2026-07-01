// Pure helper for FlightCard's title composition. Extracted from
// App.jsx so the title-precedence contract can be unit-tested without
// React or a DOM.
//
// The recurrence this module was extracted to close:
//
//   User reported 2026-06-30 ~8:05 PM EDT that a fresh San Francisco
//   build showed flight numbers in the trip Overview card
//   ("United UA 337 · EWR → SFO") but NOT in the day-by-day FlightCard
//   ("United · EWR → SFO"). Two components rendering the same plan
//   disagreed.
//
//   Root cause: FlightCard's title code (App.jsx:1313, 1323-1327 as
//   originally written) read f.flight_number ONLY when
//   _userSuppliedFlightNumber === true. The resolver
//   (FlightNumberAutoResolver) sets _scheduleVerified when it confirms
//   or substitutes a number from the live schedule, but does NOT set
//   _userSuppliedFlightNumber (which is a user-fact flag, not a
//   resolver-fact flag). Therefore verifiedFn was null, the title fell
//   through to autoFlight (if the card's own useEffect lookup ran) or
//   to "carrier · route" (no number).
//
//   The Overview card at App.jsx:4047 reads outbound.flight_number
//   directly with no gating, which is why it always showed the number.
//   FlightCard was the one lying.
//
// The contract this module locks in — the precedence for FlightCard's
// title, in order:
//
//   1. User-supplied number (f._userSuppliedFlightNumber === true)
//      → `${carrier} ${flight_number} · ${route}` (carrier prefix kept
//        because the user typed the carrier and expects to see it back)
//   2. Resolver schedule-verified number (f._scheduleVerified === true)
//      → `${carrier} ${flight_number} · ${route}` (same format —
//        matches the Overview card)
//   3. Card-local autoFlight from schedFlights (live-lookup fallback,
//      shown only if the two above don't apply)
//      → `${autoFlight.flightNumber} · ${route}` (no carrier prefix
//        because autoFlight.flightNumber already carries the IATA
//        prefix and doubling it would produce "United UA1040")
//   4. Nothing known — bare carrier + route or "Carrier TBD"
//      → `${carrier || "Carrier TBD"} · ${route}` (honest fallback;
//        the Google Flights CTA in the card body picks up the load)
//
// Pure function; never throws. Missing carrier / flight_number /
// autoFlight / route all handled defensively.

// Extract a trimmed non-empty flight_number when the corresponding
// flag is set. Returns null when the flag is off, the field is
// missing/empty, or the input is malformed.
function fnWhen(flight, flagName) {
  if (!flight || typeof flight !== "object") return null;
  if (flight[flagName] !== true) return null;
  const raw = flight.flight_number;
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Build the FlightCard title string. The `autoFlight` argument is the
// card-local schedule-lookup result (can be null). `route` is the
// carrier-neutral route string, typically `"EWR → SFO"` composed by
// FlightCard from f.from_airport + f.to_airport.
//
// Callers should pass the raw `f` flight object from `item.flight` and
// the derived `route`, `autoFlight` values — this helper does no
// additional derivation to keep testable behavior narrow.
export function buildFlightCardTitle({ flight, autoFlight, route }) {
  const carrier = flight && typeof flight === "object" && typeof flight.carrier === "string"
    ? flight.carrier.trim()
    : "";
  const routeStr = typeof route === "string" && route.trim().length > 0 ? route.trim() : "";
  const routeSuffix = routeStr.length > 0 ? ` · ${routeStr}` : "";

  const userFn = fnWhen(flight, "_userSuppliedFlightNumber");
  if (userFn) {
    return `${carrier} ${userFn}`.trim() + routeSuffix;
  }
  const verifiedFn = fnWhen(flight, "_scheduleVerified");
  if (verifiedFn) {
    return `${carrier} ${verifiedFn}`.trim() + routeSuffix;
  }
  if (autoFlight && typeof autoFlight === "object" && typeof autoFlight.flightNumber === "string" && autoFlight.flightNumber.trim().length > 0) {
    return `${autoFlight.flightNumber.trim()}${routeSuffix}`;
  }
  // Model-estimated number: not yet schedule-verified. Show with a "~" prefix
  // so the user sees a plausible number and knows to verify before booking.
  // The resolver replaces it with a clean verified number once the schedule
  // API confirms or substitutes it (at which point the verifiedFn branch above
  // fires and the "~" disappears).
  const estimatedFn = fnWhen(flight, "_modelEstimatedFlightNumber");
  if (estimatedFn) {
    return `${carrier} ~${estimatedFn}`.trim() + routeSuffix;
  }
  const fallbackCarrier = carrier || "Carrier TBD";
  return `${fallbackCarrier}${routeSuffix}`;
}
