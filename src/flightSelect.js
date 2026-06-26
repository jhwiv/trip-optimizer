// Pure flight-schedule selection helpers.
//
// Used by FlightCard to AUTO-SURFACE a real, schedule-sourced flight number
// without the user having to tap a pill. Honesty rule (CLAUDE.md): we only
// ever return an entry that came from the live schedule API — never a
// fabricated or model-guessed number. The caller passes the schedule list
// already filtered to the leg's route + carrier; this module only chooses
// WHICH real scheduled flight best matches the planned departure time.

// Minutes-of-day (0..1439) for an ISO timestamp, or null. Uses the local
// Date reading so it lines up with the time-of-day buckets the card renders
// elsewhere (hourToBucket also reads local hours).
export function isoToMinutes(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

// Parse a clock string ("8:45 AM", "13:30") or an ISO timestamp into
// minutes-of-day (0..1439), or null. Mirrors parseHour() in App.jsx but
// keeps minute precision so the closest-match selection is accurate.
export function parseClockToMinutes(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (/^\d{4}-/.test(s)) return isoToMinutes(s);
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Choose the best-matching scheduled flight from `flights`.
//
// Inputs:
//   flights        array of schedule entries { flightNumber, scheduledOut, ... }
//                  ALREADY filtered to the leg's route + carrier by the caller.
//   approxMinutes  minutes-of-day of the plan item's approximate departure,
//                  or null when the plan carries no time hint.
//
// Rules (deliberately simple, documented for honesty / traceability):
//   1. Only entries with a real `flightNumber` are eligible — a returned
//      flight is always traceable to a live schedule row, never invented.
//   2. With an approx departure time: pick the eligible flight whose
//      scheduledOut is closest to it (absolute minute difference). Ties
//      break toward the earlier departure.
//   3. Without a time hint: pick the earliest scheduledOut; if no entry has
//      a parseable time, fall back to the first eligible entry.
// Returns the chosen entry object (a reference into `flights`), or null when
// nothing is eligible.
export function pickScheduledFlight(flights, approxMinutes = null) {
  if (!Array.isArray(flights)) return null;
  const eligible = flights.filter((f) => f && f.flightNumber);
  if (eligible.length === 0) return null;

  if (approxMinutes === null || approxMinutes === undefined) {
    let best = null;
    let bestMin = Infinity;
    for (const f of eligible) {
      const m = isoToMinutes(f.scheduledOut);
      if (m === null) continue;
      if (m < bestMin) {
        bestMin = m;
        best = f;
      }
    }
    return best || eligible[0];
  }

  let best = null;
  let bestDiff = Infinity;
  let bestMin = Infinity;
  for (const f of eligible) {
    const m = isoToMinutes(f.scheduledOut);
    if (m === null) continue;
    const diff = Math.abs(m - approxMinutes);
    if (diff < bestDiff || (diff === bestDiff && m < bestMin)) {
      bestDiff = diff;
      bestMin = m;
      best = f;
    }
  }
  return best || eligible[0];
}
