// Universal flight-number strip + exemption logic, extracted from
// applyQualityLayer (App.jsx) so the contract between the strip and
// the resolver can be unit-tested in isolation.
//
// The contract this module locks in:
//
//   1. If a flight has _scheduleVerified === true AND a non-empty
//      flight_number, the strip MUST NOT touch it. This is the
//      resolver's promise: "I checked this against the live schedule."
//   2. If a flight has a number that matches userFlightNumbers (the
//      user dictated it in their narrative/guidelines), KEEP it and
//      normalize to bare digits + _userSuppliedFlightNumber = true.
//   3. Otherwise the model emitted the number and we cannot trust it.
//      Strip the number (null it), set _flightNumberStripped = true,
//      preserve the original in _originalFlightNumber for later audit.
//   4. If the model emitted NO number but the user named some in their
//      narrative, back-fill the user-supplied number (outbound vs
//      return chosen by route direction first, day index as fallback).
//
// The recurrence this module was extracted to test:
//
//   The model emits a "complete" flight (number + both times). The
//   FlightNumberAutoResolver USED to skip such flights (Scenario C
//   returned null from flightNeedsResolve), so _scheduleVerified was
//   never written, so rule 1 above never triggered, so rule 3 nulled
//   the number, so the user saw nothing on screen or PDF.
//
//   The fix on the resolver side is the new "verify" mode. The fix on
//   THIS side is the contract: as long as the resolver writes
//   _scheduleVerified for every flight it touches (success OR safe
//   fallback), the strip leaves verified numbers alone.
//
// Pure function: never throws, never mutates the input plan, returns
// a new days[] array. The QC fixes array is returned alongside so
// callers can surface it (App.jsx does in `qc.fixes`).

// Build a Set of flight numbers the user explicitly stated in their
// narrative or guidelines. Matches:
//   - airline code + number (UA1039 / UA 1039)
//   - "flight 1039", "flight #1039"
//   - airline name + number ("United 1039", "Delta 47")
export function buildUserFlightNumbers(inputs) {
  const userFlightNumbers = new Set();
  const blob = `${inputs?.narrative || ""}\n${inputs?.guidelines || ""}`;
  for (const m of blob.matchAll(/\b([A-Z]{2})\s*0*(\d{1,4})\b/g)) {
    userFlightNumbers.add(`${m[1]}${m[2]}`);
    userFlightNumbers.add(m[2]);
  }
  for (const m of blob.matchAll(/\bflight\s*#?\s*0*(\d{1,4})\b/gi)) {
    userFlightNumbers.add(m[1]);
  }
  for (const m of blob.matchAll(/\b(united|delta|american|jetblue|southwest|alaska|air\s*france|klm|lufthansa|swiss|british\s*airways|virgin|iberia|ana|japan\s*airlines|jal|cathay|korean|aer\s*lingus|ita|sas|scandinavian)\s+#?\s*0*(\d{1,4})\b/gi)) {
    userFlightNumbers.add(m[2]);
  }
  return userFlightNumbers;
}

// Apply the universal flight-number strip to a plan. Returns the
// new days array (cloned shallowly to the flight level) plus a fixes
// log. Never throws. Never mutates input.
export function applyFlightNumberStrip(days, inputs) {
  const userFlightNumbers = buildUserFlightNumbers(inputs);
  const fixes = [];
  if (!Array.isArray(days)) return { days, fixes };
  const homeCode = (inputs?.flights?.homeAirport || "")
    .toUpperCase()
    .match(/\b([A-Z]{3})\b/)?.[1];
  const out = days.map((day, dayIdx) => {
    const items = Array.isArray(day.items)
      ? day.items.map((it) => {
          if (it?.type !== "Flight" || !it.flight) return it;
          const f = { ...it.flight };
          // Rule 1: schedule-verified exemption.
          if (f._scheduleVerified && f.flight_number && String(f.flight_number).trim() !== "") {
            return { ...it, flight: f };
          }
          if (f.flight_number != null && String(f.flight_number).trim() !== "") {
            const digitsMatch = String(f.flight_number).match(/(\d{1,4})/);
            const digits = digitsMatch ? String(parseInt(digitsMatch[1], 10)) : null;
            const matchesUser = digits && (
              userFlightNumbers.has(digits) ||
              (f.carrier && userFlightNumbers.has(
                `${(f.carrier.match(/\b([A-Z]{2})\b/) || [])[1] || ""}${digits}`
              ))
            );
            if (matchesUser) {
              f.flight_number = digits;
              f._userSuppliedFlightNumber = true;
              fixes.push(`Day ${dayIdx + 1} flight: kept user-supplied flight number ${f.carrier || ""}${digits}`);
            } else {
              f._originalFlightNumber = f.flight_number;
              f.flight_number = null;
              f._flightNumberStripped = true;
              fixes.push(`Day ${dayIdx + 1} flight: removed model-supplied flight number — look up live schedule`);
            }
          } else if (userFlightNumbers.size > 0) {
            const userNums = Array.from(userFlightNumbers).filter((n) => /^\d+$/.test(n));
            if (userNums.length >= 1 && userNums.length <= 2) {
              let isReturnLeg;
              if (homeCode && f.to_airport) {
                isReturnLeg = String(f.to_airport).toUpperCase() === homeCode;
              } else if (homeCode && f.from_airport) {
                isReturnLeg = String(f.from_airport).toUpperCase() !== homeCode;
              } else {
                isReturnLeg = dayIdx === (days.length - 1);
              }
              const chosen = isReturnLeg && userNums.length > 1
                ? userNums[userNums.length - 1]
                : userNums[0];
              f.flight_number = chosen;
              f._userSuppliedFlightNumber = true;
              fixes.push(`Day ${dayIdx + 1} flight: filled in user-supplied flight number ${f.carrier || ""}${chosen}`);
            }
          }
          return { ...it, flight: f };
        })
      : day.items;
    return { ...day, items };
  });
  return { days: out, fixes };
}
