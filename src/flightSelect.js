// Pure flight-schedule selection helpers.
//
// Used by FlightCard to AUTO-SURFACE a real, schedule-sourced flight number
// without the user having to tap a pill. Honesty rule (CLAUDE.md): we only
// ever return an entry that came from the live schedule API — never a
// fabricated or model-guessed number. The caller passes the schedule list
// already filtered to the leg's route + carrier; this module only chooses
// WHICH real scheduled flight best matches the planned departure time.

// Airline name → IATA code. Matched case-insensitively on word boundaries (see
// resolveAirlineIata) so it tolerates the full names the build emits ("United",
// "United Airlines") without short keys ("ana", "sas") colliding inside longer
// words. This is the single source of truth for carrier→IATA resolution;
// FlightCard and the live-status path both go through resolveAirlineIata().
const CARRIER_NAME_TO_IATA = {
  united: "UA", delta: "DL", american: "AA", jetblue: "B6", southwest: "WN",
  alaska: "AS", frontier: "F9", spirit: "NK", hawaiian: "HA",
  "sun country": "SY", allegiant: "G4", avelo: "XP", breeze: "MX",
  "air canada": "AC", westjet: "WS", aeromexico: "AM",
  lufthansa: "LH", swiss: "LX", austrian: "OS",
  "air france": "AF", klm: "KL", "british airways": "BA", virgin: "VS",
  iberia: "IB", "aer lingus": "EI", "tap air": "TP", "tap portugal": "TP",
  sas: "SK", scandinavian: "SK", finnair: "AY", norse: "N0",
  icelandair: "FI", ryanair: "FR", easyjet: "U2", "ita airways": "AZ",
  emirates: "EK", qatar: "QR", etihad: "EY", turkish: "TK",
  "singapore airlines": "SQ", cathay: "CX",
  "japan airlines": "JL", jal: "JL", ana: "NH", "all nippon": "NH",
  "korean air": "KE", asiana: "OZ", qantas: "QF", "air new zealand": "NZ",
};

// True when the carrier string names more than one airline ("United or Delta",
// "SAS / Delta", "United, Lufthansa"). We must NOT auto-pick one carrier's
// number for an ambiguous string — that would risk presenting it as the other.
function isMultiCarrier(s) {
  return / or | \/ |,|\//.test(String(s));
}

// Resolve a carrier string to a 2-letter IATA code, or null when it can't be
// resolved unambiguously.
//
// Honesty contract (CLAUDE.md): the returned code is used to filter schedule
// rows to a single carrier before auto-surfacing a flight number. A wrong or
// over-eager resolution would let us label another carrier's real flight under
// this card. So we resolve ONLY when we're confident:
//   - a known airline name substring ("United" → "UA"), or
//   - a bare 2-character IATA/IATA-like code the build emitted directly
//     ("UA", "B6", "U2").
// Multi-carrier strings ("United or Delta") resolve to null so the caller falls
// back to an unattributed schedule display rather than claiming one carrier.
export function resolveAirlineIata(carrier) {
  if (!carrier) return null;
  const raw = String(carrier).trim();
  if (!raw) return null;
  if (isMultiCarrier(raw)) return null;
  const lower = raw.toLowerCase();
  // Word-boundary match (not raw includes) so short keys like "ana" or "sas"
  // don't collide inside longer words ("Canada" contains "ana", "Asiana" too).
  for (const [name, code] of Object.entries(CARRIER_NAME_TO_IATA)) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) return code;
  }
  // Bare 2-char code emitted directly as the carrier ("UA", "B6", "U2").
  // Require it to be the WHOLE string so we don't pull two letters out of a
  // longer unknown name.
  if (/^[A-Z][A-Z0-9]$/.test(raw.toUpperCase())) return raw.toUpperCase();
  return null;
}

// Extract a clean 3-letter IATA airport code from a build field, or null.
//
// The build schema asks for bare IATA codes ("EWR"), but the model occasionally
// decorates them ("Newark (EWR)", "EWR – Newark Liberty", lowercase). The
// schedule fetch passes this value straight to the API as origin/destination,
// so a decorated value silently breaks the lookup (and therefore the whole
// auto-surface). Normalize before using it as a query param.
export function normalizeAirportCode(v) {
  if (!v) return null;
  const up = String(v).trim().toUpperCase();
  const paren = up.match(/\(([A-Z]{3})\)/);
  if (paren) return paren[1];
  if (/^[A-Z]{3}$/.test(up)) return up;
  // "EWR - Newark", "EWR / Newark Liberty": a leading 3-letter code followed by
  // a separator. We require a real separator (not just a space) so prose like
  // "SEE ITINERARY" or "NEW YORK" doesn't get mistaken for a code.
  const lead = up.match(/^([A-Z]{3})\s*[-–—/(·,|]/);
  if (lead) return lead[1];
  return null;
}

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
//   airlineIata    optional 2-letter IATA code (e.g. "UA"). When provided, an
//                  entry is only eligible if its flightNumber starts with this
//                  code (case-insensitive). This is the HONESTY guard: it stops
//                  us auto-surfacing another carrier's real flight number under
//                  this card's carrier. If no entry matches, returns null rather
//                  than falling back to a different airline.
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
export function pickScheduledFlight(flights, approxMinutes = null, airlineIata = null) {
  if (!Array.isArray(flights)) return null;
  let eligible = flights.filter((f) => f && f.flightNumber);
  if (airlineIata) {
    const prefix = String(airlineIata).toUpperCase();
    eligible = eligible.filter((f) => String(f.flightNumber).toUpperCase().startsWith(prefix));
  }
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
