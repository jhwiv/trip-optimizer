// Flight header/departure consistency (report bug 4, validator V4).
//
// A Flight item carries two clocks: the item-level `time` that drives the
// day's chronological header, and `flight.depart_time` that the flight row
// renders. The build shipped 2026-07-28 had Day 1 headed "9:30 AM · FLIGHT"
// above a row reading "UA934 EWR 8:20 AM → LHR 8:40 PM" — the model had
// written `time` as a leave-for-the-airport hint while `depart_time` was the
// actual wheels-up.
//
// Convention, decided by the maintainer and enforced here:
//   item.time == flight.depart_time, ALWAYS.
// There is no "leave for the airport" semantics in `time`. Pre-departure
// guidance belongs in note text (see `airport_arrival_buffer`).
//
// The real fix is propagation in flightResolver.js — whenever the resolver
// writes depart_time it also rewrites the parent item.time. This module is
// the safety belt: if propagation ever regresses, or a plan reaches the
// exporter without passing through the resolver, the mismatch blocks export
// rather than shipping two contradictory clocks.

// Normalize any clock string the pipeline can produce to 24h "HH:MM".
//
// Three shapes reach us:
//   - "08:45"    the model's schema-conformant 24h time
//   - "8:20 AM"  what formatAirportLocalTime / Intl produce for resolver times
//   - "2026-10-01T08:45:00Z"  raw ISO, occasionally passed through
// Returns null for anything unparseable so callers can skip rather than
// invent a comparison.
export function normalizeClock(t) {
  if (t == null) return null;
  const s = String(t).trim();
  if (!s) return null;

  const iso = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(s);
  if (iso) return `${iso[1]}:${iso[2]}`;

  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?\s*$/i.exec(s);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!Number.isInteger(h) || h > 23) return null;
  if (parseInt(mm, 10) > 59) return null;
  return `${String(h).padStart(2, "0")}:${mm}`;
}

// True when the two clocks disagree. Unparseable on either side is not a
// mismatch — we only flag a real, decidable contradiction.
export function clocksAgree(a, b) {
  const na = normalizeClock(a);
  const nb = normalizeClock(b);
  if (na === null || nb === null) return true;
  return na === nb;
}

// Walk every Flight item and report where the day header contradicts the
// departure row. Emits placesVerify.js's flag shape so applyQualityLayer can
// attach findings alongside the continuity flags from PR #145.
//
// Severity is "block": two clocks on the same flight is the kind of error a
// traveler acts on (arriving at the airport an hour after wheels-up), and
// unlike a closure gap there is no data-quality excuse for it — both numbers
// are ours.
export function findFlightTimeMismatches(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const out = [];
  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    items.forEach((item, itemIdx) => {
      if (item?.type !== "Flight" || !item.flight) return;
      const header = normalizeClock(item.time);
      const depart = normalizeClock(item.flight.depart_time);
      if (header === null || depart === null) return;
      if (header === depart) return;
      const label =
        [item.flight.carrier, item.flight.flight_number].filter(Boolean).join(" ").trim() ||
        item.text ||
        `Day ${dayIdx + 1} flight`;
      out.push({
        code: "FLIGHT_TIME_MISMATCH",
        severity: "block",
        dayIdx,
        itemIdx,
        day: dayIdx + 1,
        target: label,
        message: `${label}: day header says ${item.time} but the flight departs at ${item.flight.depart_time}. The header must equal the departure time.`,
      });
    });
  });
  return out;
}
