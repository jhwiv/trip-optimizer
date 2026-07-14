// Arrival-day ordering validator (bug #3b, Amsterdam→Bruges report).
//
// The report surfaced a plan where the inbound flight was shown landing at
// the destination AFTER the ground transport and hotel check-in that were
// supposed to follow it — a physically impossible "ground before landing"
// ordering caused by a bad arrival-time computation (see airportTz.js for
// the timezone half of the fix, bug #3a).
//
// This module is the enforcement half: given a built plan, it flags any day
// where a non-flight step (ground transport, hotel check-in, activity, meal)
// is scheduled EARLIER than the day's flight landing plus a minimum
// connection buffer. It is pure (no React / DOM / network) so it can run at
// generation time, inside the pre-export gate, and in a unit test.
//
// Time parsing reuses parseClockToMinutes from flightSelect.js so "8:45 AM",
// "13:30", and ISO timestamps are all understood, and comparisons happen in
// minutes-of-day. Days with no landing time, or items with no parseable
// clock time, are simply skipped — the validator only speaks when it is sure.

import { parseClockToMinutes } from "./flightSelect.js";

// International-arrival connection buffer: immigration + baggage + reaching
// ground transport realistically eats ~60 min minimum. The spec allows
// 60–90; 60 is the conservative floor used for BLOCKING so we never flag a
// borderline-but-possible plan.
export const DEFAULT_ARRIVAL_BUFFER_MIN = 60;

function toStr(v) {
  return v == null ? "" : String(v);
}

// Best-effort human label for an offending step, for the error message.
function stepLabel(item) {
  const type = toStr(item?.type).trim();
  const text = toStr(item?.text).trim();
  if (type && text) return `${type} — ${text}`;
  return text || type || "step";
}

// The day's landing time = the latest flight arrival among the day's flight
// items (the flight that actually puts the traveler on the ground that day).
// Returns { minutes, label } or null when the day has no timed flight arrival.
function dayLanding(items) {
  let minutes = null;
  let label = "";
  for (const it of items) {
    const fl = it?.flight;
    if (!fl) continue;
    const arr = parseClockToMinutes(fl.arrive_time);
    if (arr === null) continue;
    if (minutes === null || arr > minutes) {
      minutes = arr;
      label = toStr(fl.arrive_time);
    }
  }
  return minutes === null ? null : { minutes, label };
}

// Scan the plan for arrival-day ordering violations.
//
// Returns an array of issue objects (empty when the plan is clean):
//   {
//     dayIndex, dayDate, step, stepTime, landingTime, bufferMin, message
//   }
export function findArrivalOrderIssues(data, { bufferMin = DEFAULT_ARRIVAL_BUFFER_MIN } = {}) {
  const issues = [];
  const days = Array.isArray(data?.days) ? data.days : [];
  days.forEach((day, di) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    const landing = dayLanding(items);
    if (!landing) return;
    const threshold = landing.minutes + bufferMin;
    for (const it of items) {
      if (it?.flight) continue; // the flight itself is not a ground step
      const t = parseClockToMinutes(it?.time);
      if (t === null) continue;
      if (t < threshold) {
        issues.push({
          dayIndex: di,
          dayDate: day?.date || null,
          step: stepLabel(it),
          stepTime: toStr(it.time),
          landingTime: landing.label,
          bufferMin,
          message:
            `Day ${di + 1}${day?.date ? ` (${day.date})` : ""}: "${stepLabel(it)}" is ` +
            `scheduled at ${toStr(it.time)}, before the flight lands at ${landing.label} ` +
            `(needs at least ${bufferMin} min after landing).`,
        });
      }
    }
  });
  return issues;
}

// Throwing wrapper for use at generation time / in the pre-export gate where a
// violation must hard-stop rather than be collected. Throws an Error naming
// the first offending step and time; the full list is attached as err.issues.
export function assertArrivalDayOrdering(data, opts = {}) {
  const issues = findArrivalOrderIssues(data, opts);
  if (issues.length === 0) return;
  const err = new Error(
    `Arrival-day ordering violation: ${issues[0].message}` +
      (issues.length > 1 ? ` (+${issues.length - 1} more)` : "")
  );
  err.code = "ARRIVAL_ORDER";
  err.issues = issues;
  throw err;
}

// Pre-export gate decision (bug: "Could not save PDF" on legacy plans).
//
// The arrival-order validator belongs at itinerary GENERATION, where a fresh
// plan can be rejected and rebuilt. Running it as a hard block at PDF-export
// time strands users on a plan built BEFORE the PR #133 timezone fix: those
// legacy itineraries can still carry the old physically-impossible arrival
// times, so blocking export leaves them with an itinerary they can never save.
//
// Callers exporting a previously-built plan pass skipValidationForExistingPlans
// to bypass the block. Returns { error, issues }: `error` is a throwable Error
// (code ARRIVAL_ORDER) only when the plan should be BLOCKED; it is null when
// the plan is clean OR when the block is skipped. `issues` is always the full
// list so the caller can still log a diagnostic warning when skipping.
export function arrivalOrderExportError(data, { skipValidationForExistingPlans = false, bufferMin = DEFAULT_ARRIVAL_BUFFER_MIN } = {}) {
  const issues = findArrivalOrderIssues(data, { bufferMin });
  if (issues.length === 0 || skipValidationForExistingPlans) {
    return { error: null, issues };
  }
  const summary = issues.slice(0, 3).map((iss) => iss.message).join(" ");
  const more = issues.length > 3 ? ` … and ${issues.length - 3} more` : "";
  const error = new Error(`Cannot export: ${summary}${more}`);
  error.code = "ARRIVAL_ORDER";
  error.issues = issues;
  return { error, issues };
}

// Pure helper: return a shallow-cloned plan whose arrival-day ground steps are
// pushed to at least (landing + bufferMin) when they were scheduled earlier.
// Only clock-time strings are rewritten; items without a parseable time or on
// days without a landing are left untouched. Callers that prefer to REPAIR a
// plan (instead of blocking it) can run this before re-validating. Never
// mutates the input.
export function cascadeArrivalDayTimes(data, { bufferMin = DEFAULT_ARRIVAL_BUFFER_MIN } = {}) {
  const days = Array.isArray(data?.days) ? data.days : [];
  const newDays = days.map((day) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    const landing = dayLanding(items);
    if (!landing) return day;
    const threshold = landing.minutes + bufferMin;
    let changed = false;
    const newItems = items.map((it) => {
      if (it?.flight) return it;
      const t = parseClockToMinutes(it?.time);
      if (t === null || t >= threshold) return it;
      changed = true;
      return { ...it, time: minutesToClock(threshold), _timeCascaded: true };
    });
    return changed ? { ...day, items: newItems } : day;
  });
  return { ...data, days: newDays };
}

// minutes-of-day → "h:mm AM/PM". Local helper so this module has no dependency
// on the PDF layer's formatter.
function minutesToClock(min) {
  const m = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${mm} ${ampm}`;
}
