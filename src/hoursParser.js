// Parse Google Places (New) weekdayDescriptions hours strings into
// structured open-windows and answer "is this venue open on day X at
// time T?".
//
// This is the data shape we receive (captured from live API, 2026-06-14):
//   "Monday: 4:45 – 11:00 PM"                          (single window)
//   "Sunday: Closed"                                   (whole day closed)
//   "Monday: 12:00 – 2:00 PM, 5:00 – 7:30 PM"          (split shift)
//   "Friday: 8:00 AM – 3:00 PM, 5:30 – 10:00 PM"       (lunch + dinner)
//   "Saturday: 5:00 – 11:00 PM"                        (PM-only)
//   "Tuesday: 9:00 AM – 5:00 PM"                       (AM start + PM end)
//
// Critical format notes verified against live data:
//   - Separator is an en-dash (U+2013), NOT a hyphen.
//   - When only the END has an AM/PM suffix, both times inherit it.
//   - "Closed" is the literal string (not "closed", not "CLOSED").
//   - Hours are local-to-venue, not local-to-traveler. Per user
//     decision 2026-06-14.
//
// Less-common shapes we defensively handle (not seen in our sample but
// documented by Google):
//   - "Open 24 hours"
//   - "9:00 AM – 12:00 AM" (midnight close)
//   - "10:00 PM – 2:00 AM" (midnight-crossing — start > end)
//
// What we deliberately DON'T do:
//   - Handle 3+ windows per day. None observed; would be defensive code
//     that's never exercised.
//   - Parse holiday hours. Places returns these in a separate field
//     (specialOpeningHours) which we don't request.
//   - Handle non-English day names. The endpoint sets no language hint
//     and Google defaults to English for our use case.

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Convert "4:45 PM" → minutes since midnight (16*60 + 45 = 1005).
// Returns null on garbage. Handles "12:00 AM" = 0, "12:00 PM" = 720.
function parseTimeOfDay(timeStr, defaultPeriod) {
  if (typeof timeStr !== "string") return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  const period = (m[3] || defaultPeriod || "").toUpperCase();
  if (!period) return null; // ambiguous without inherited period
  if (period === "AM") {
    if (hour === 12) hour = 0;
  } else if (period === "PM") {
    if (hour !== 12) hour += 12;
  } else {
    return null;
  }
  return hour * 60 + minute;
}

// Parse one window like "4:45 – 11:00 PM" or "12:00 – 2:00 PM" or
// "8:00 AM – 3:00 PM" into { start_min, end_min } or null.
// Both values are minutes-since-venue-midnight. End < start indicates
// a midnight-crossing window; the caller handles that.
export function parseWindow(windowStr) {
  if (typeof windowStr !== "string") return null;
  const s = windowStr.trim();
  if (!s) return null;
  // Split on en-dash. Some sources use the hyphen-minus; accept both
  // defensively though we have not observed the hyphen variant.
  const parts = s.split(/[\u2013\u2014-]/);
  if (parts.length !== 2) return null;
  const left = parts[0].trim();
  const right = parts[1].trim();
  // Figure out the END period first; if the END has no AM/PM, we
  // cannot interpret the window.
  const rightMatch = right.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!rightMatch) return null;
  const endPeriod = rightMatch[3].toUpperCase();
  const end_min = parseTimeOfDay(right, endPeriod);
  if (end_min === null) return null;
  // For the START: if it has its own AM/PM, use it. Otherwise inherit
  // the END's period. ("4:45 – 11:00 PM" → start inherits PM.)
  const leftHasPeriod = /\b(AM|PM)\b/i.test(left);
  const start_min = parseTimeOfDay(left, leftHasPeriod ? null : endPeriod);
  if (start_min === null) return null;
  return { start_min, end_min };
}

// Parse a full day's spec — everything after "Monday: " — into an
// array of windows. Returns:
//   - { closed: true }          if the literal "Closed"
//   - { open24: true }          if "Open 24 hours"
//   - { windows: [...] }        otherwise
//   - { error: "..." }          on unparseable input
export function parseDaySpec(spec) {
  if (typeof spec !== "string") return { error: "non-string" };
  const trimmed = spec.trim();
  if (!trimmed) return { error: "empty" };
  if (/^closed$/i.test(trimmed)) return { closed: true };
  if (/^open\s+24\s+hours$/i.test(trimmed)) return { open24: true };
  // Multiple windows are comma-separated.
  const windowStrs = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const windows = [];
  for (const w of windowStrs) {
    const parsed = parseWindow(w);
    if (!parsed) return { error: `unparseable window: '${w}'` };
    windows.push(parsed);
  }
  if (windows.length === 0) return { error: "no windows" };
  return { windows };
}

// Parse one full weekdayDescriptions entry like
// "Monday: 4:45 – 11:00 PM" → { weekday: "Monday", windows: [...] }.
// Returns null on unparseable input.
export function parseWeekdayLine(line) {
  if (typeof line !== "string") return null;
  const m = line.match(/^([A-Za-z]+):\s*(.+)$/);
  if (!m) return null;
  const weekday = m[1];
  if (!WEEKDAY_NAMES.includes(weekday)) return null;
  const day = parseDaySpec(m[2]);
  if (day.error) return null;
  return { weekday, ...day };
}

// Parse all 7 entries from Places' weekdayDescriptions into a map keyed
// by weekday name. Missing or unparseable days are dropped (we'll fall
// back to "we don't know" semantics in the caller).
export function parseWeekdayDescriptions(descriptions) {
  if (!Array.isArray(descriptions)) return {};
  const result = {};
  for (const line of descriptions) {
    const parsed = parseWeekdayLine(line);
    if (parsed) result[parsed.weekday] = parsed;
  }
  return result;
}

// The question we actually need to answer.
//
// Args:
//   parsedHours: result of parseWeekdayDescriptions
//   weekday:     "Monday" | "Tuesday" | ... (English, full word)
//   timeOfDay:   "19:00" (24h string, local-to-venue) OR null/undefined
//                if the caller doesn't know
//
// Returns one of:
//   { status: "open" }             venue open at this time
//   { status: "closed_all_day" }   venue closed all day
//   { status: "outside_hours" }    venue open today but not at this time
//   { status: "unknown" }          missing data, can't decide
//   { status: "open24" }           always open
//
// Midnight-crossing windows (e.g., "5:00 PM – 1:00 AM" → start 1020,
// end 60) are handled: the window covers [start_min, 24*60) ∪
// [0, end_min) on that calendar day, with the understanding that the
// 0 → end_min portion is technically "the next day" but for the
// itinerary's purposes, an item at "23:30" on Friday should be checked
// against Friday's hours (the late-night side of the venue's Friday).
export function isOpenAt(parsedHours, weekday, timeOfDay) {
  if (!parsedHours || typeof parsedHours !== "object") return { status: "unknown" };
  const day = parsedHours[weekday];
  if (!day) return { status: "unknown" };
  if (day.closed) return { status: "closed_all_day" };
  if (day.open24) return { status: "open24" };
  if (!Array.isArray(day.windows) || day.windows.length === 0) {
    return { status: "unknown" };
  }
  // Can't answer outside-hours without a time.
  if (!timeOfDay) {
    // Best we can do: the day has hours, so it's not closed_all_day.
    return { status: "open" };
  }
  const tMatch = String(timeOfDay).match(/^(\d{1,2}):(\d{2})/);
  if (!tMatch) return { status: "unknown" };
  const t = parseInt(tMatch[1], 10) * 60 + parseInt(tMatch[2], 10);
  if (!Number.isFinite(t) || t < 0 || t >= 24 * 60) return { status: "unknown" };
  for (const w of day.windows) {
    if (w.end_min > w.start_min) {
      // Same-day window.
      if (t >= w.start_min && t < w.end_min) return { status: "open" };
    } else if (w.end_min < w.start_min) {
      // Midnight-crossing. t is on this calendar day, so we treat the
      // window as [start_min, 24*60). The cross-midnight tail is the
      // NEXT calendar day's pre-dawn — out of scope for a same-day check.
      if (t >= w.start_min) return { status: "open" };
    } else {
      // Equal start/end — degenerate, treat as closed.
      continue;
    }
  }
  return { status: "outside_hours" };
}

// Exported helper for callers that have the weekday as a 0-6 integer
// (e.g., new Date().getUTCDay()).
export function weekdayNameFromIndex(i) {
  return WEEKDAY_NAMES[i] || null;
}
