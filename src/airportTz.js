// Airport IATA → IANA timezone, plus a formatter that renders a UTC schedule
// timestamp in the airport's LOCAL wall-clock time.
//
// Why this exists (bug #3a, Amsterdam→Bruges report): the FlightAware-backed
// worker returns scheduledOut/scheduledIn as UTC ISO strings ("…Z"). The
// resolver formatted them with `toLocaleTimeString([])`, which uses the JS
// RUNTIME timezone — UTC on Cloudflare Workers. A DL70 ATL→AMS arrival was
// therefore printed as its UTC wall-clock (e.g. "12:00 AM") instead of the
// Amsterdam-local time (~7:15 AM), which then read as landing AFTER the
// ground transport that follows it. Localizing to the destination airport's
// timezone fixes the displayed clock and the apparent ground-before-landing
// contradiction.
//
// The map is intentionally scoped to the airports this app actually routes
// through (the carrier network in flightSelect.js: North America, Europe,
// Middle East, Asia, Oceania hubs). Unknown codes fall back to a best-effort
// UTC render — never a fabricated offset.

export const AIRPORT_TZ = {
  // ---- United States ----
  ATL: "America/New_York", JFK: "America/New_York", EWR: "America/New_York",
  LGA: "America/New_York", BOS: "America/New_York", DCA: "America/New_York",
  IAD: "America/New_York", PHL: "America/New_York", MIA: "America/New_York",
  FLL: "America/New_York", MCO: "America/New_York", CLT: "America/New_York",
  ORD: "America/Chicago", MDW: "America/Chicago", DFW: "America/Chicago",
  IAH: "America/Chicago", MSP: "America/Chicago", STL: "America/Chicago",
  MCI: "America/Chicago", AUS: "America/Chicago", NSH: "America/Chicago",
  BNA: "America/Chicago", MSY: "America/Chicago", HOU: "America/Chicago",
  DEN: "America/Denver", SLC: "America/Denver", PHX: "America/Phoenix",
  LAX: "America/Los_Angeles", SFO: "America/Los_Angeles", SAN: "America/Los_Angeles",
  SEA: "America/Los_Angeles", PDX: "America/Los_Angeles", LAS: "America/Los_Angeles",
  SJC: "America/Los_Angeles", OAK: "America/Los_Angeles", SMF: "America/Los_Angeles",
  HNL: "Pacific/Honolulu", ANC: "America/Anchorage",
  // ---- Canada ----
  YYZ: "America/Toronto", YUL: "America/Toronto", YOW: "America/Toronto",
  YVR: "America/Vancouver", YYC: "America/Edmonton", YEG: "America/Edmonton",
  // ---- Mexico ----
  MEX: "America/Mexico_City", CUN: "America/Cancun", GDL: "America/Mexico_City",
  // ---- Europe ----
  LHR: "Europe/London", LGW: "Europe/London", STN: "Europe/London",
  LTN: "Europe/London", MAN: "Europe/London", EDI: "Europe/London",
  DUB: "Europe/Dublin", CDG: "Europe/Paris", ORY: "Europe/Paris",
  NCE: "Europe/Paris", AMS: "Europe/Amsterdam", BRU: "Europe/Brussels",
  FRA: "Europe/Berlin", MUC: "Europe/Berlin", BER: "Europe/Berlin",
  DUS: "Europe/Berlin", HAM: "Europe/Berlin", ZRH: "Europe/Zurich",
  GVA: "Europe/Zurich", VIE: "Europe/Vienna", CPH: "Europe/Copenhagen",
  OSL: "Europe/Oslo", ARN: "Europe/Stockholm", HEL: "Europe/Helsinki",
  KEF: "Atlantic/Reykjavik", MAD: "Europe/Madrid", BCN: "Europe/Madrid",
  LIS: "Europe/Lisbon", OPO: "Europe/Lisbon", FCO: "Europe/Rome",
  MXP: "Europe/Rome", LIN: "Europe/Rome", VCE: "Europe/Rome",
  NAP: "Europe/Rome", ATH: "Europe/Athens", IST: "Europe/Istanbul",
  WAW: "Europe/Warsaw", PRG: "Europe/Prague", BUD: "Europe/Budapest",
  // ---- Middle East ----
  DXB: "Asia/Dubai", AUH: "Asia/Dubai", DOH: "Asia/Qatar",
  // ---- Asia ----
  SIN: "Asia/Singapore", HKG: "Asia/Hong_Kong", NRT: "Asia/Tokyo",
  HND: "Asia/Tokyo", KIX: "Asia/Tokyo", ICN: "Asia/Seoul",
  PVG: "Asia/Shanghai", PEK: "Asia/Shanghai", BKK: "Asia/Bangkok",
  // ---- Oceania ----
  SYD: "Australia/Sydney", MEL: "Australia/Melbourne", BNE: "Australia/Brisbane",
  AKL: "Pacific/Auckland",
};

// Look up the IANA timezone for an airport code (case-insensitive, tolerant of
// decorated forms like "Newark (EWR)"). Returns null when unknown.
export function airportTimeZone(code) {
  if (!code || typeof code !== "string") return null;
  const up = code.trim().toUpperCase();
  if (AIRPORT_TZ[up]) return AIRPORT_TZ[up];
  const paren = up.match(/\(([A-Z]{3})\)/);
  if (paren && AIRPORT_TZ[paren[1]]) return AIRPORT_TZ[paren[1]];
  const lead = up.match(/^([A-Z]{3})\b/);
  if (lead && AIRPORT_TZ[lead[1]]) return AIRPORT_TZ[lead[1]];
  return null;
}

// Format a UTC ISO timestamp as a "h:mm AM/PM" clock string in the given
// airport's local timezone. When the airport timezone is unknown we fall back
// to a UTC render (honest best effort — never invents an offset). Returns
// undefined for empty/invalid input so callers can use `|| existing`.
export function formatAirportLocalTime(iso, airportCode) {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const tz = airportTimeZone(airportCode);
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(tz ? { timeZone: tz } : { timeZone: "UTC" }),
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
    }).format(d);
  }
}
