// Carrier-name vs flight-number cross-check (report §1, validator P4).
//
// The 2026-07-28 build shipped a Day 1 card reading "LOT flight from Newark to
// London Heathrow" over the number UA940, with a "Book directly on lot.com"
// note underneath. LOT was absent from the carrier map, so resolveAirlineIata
// returned null, the airline-filtered schedule query was skipped, and the
// route-only retry handed back a United row whose number was written onto a
// flight the model had labelled LOT. Every downstream honesty guard was gated
// on that null.
//
// PR #150 closed the hole at the source (buildMergePayload no longer lifts a
// number when the carrier didn't resolve) and taught the map about LOT. This
// module is the suspenders: a plan walk that catches the disagreement wherever
// it came from — an older plan, a codeshare row, or a model that simply typed
// two contradictory things.
//
// Policy is repair-first, and which repair depends on where the number came
// from:
//
//   A. The number came off a live schedule row (_resolveSource "airline" or
//      "route-only"). The IATA code is ground truth and the carrier name is
//      model prose, so rename the carrier to match the code.
//   B. The number is model-authored and nothing confirmed it. There is no
//      ground truth to repair toward, so strip the number and BLOCK export.
//      This is the shape that shipped.
//   C. No conflict could be computed because the carrier name doesn't resolve
//      to an IATA code at all. Nothing is repaired; the flag records that the
//      cross-check could not run.

import { carrierCodeConflict, resolveAirlineIata } from "./flightSelect.js";

// _resolveSource values written by buildMergePayload after a schedule row was
// actually picked. The other values in circulation ("verify-fallback",
// "times-fallback", "verify-precondition-skipped") all describe a MISS and
// ride alongside _flightUnverified, so they fall through to Case B — which is
// also where any future/legacy value lands. Fail safe: only a value we know
// means "a schedule row backed this number" earns the repair path.
const SCHEDULE_SOURCES = new Set(["airline", "route-only"]);

const nonEmpty = (v) => (typeof v === "string" ? v.trim() : "");

// Whole-word, case-insensitive test for a brand name inside free prose.
// "lot" matches "Book directly on lot.com" (the "." is a word boundary) but
// not "allotment".
function mentionsBrand(text, brand) {
  const needle = nonEmpty(brand);
  const hay = nonEmpty(text);
  if (!needle || !hay) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(hay);
}

// Drop any prose that still tells the traveller to deal with the carrier we
// just renamed away from. carrierBookUrl() in the PDF has no LOT entry, so a
// stale "Book directly on lot.com" would survive the repair and print beside a
// United flight number. Returns the number of strings removed.
function scrubCarrierProse(flight, oldCarrier) {
  let removed = 0;
  if (mentionsBrand(flight.confirmation_note, oldCarrier)) {
    flight.confirmation_note = null;
    removed++;
  }
  if (Array.isArray(flight.notes)) {
    const kept = flight.notes.filter((n) => !mentionsBrand(n, oldCarrier));
    removed += flight.notes.length - kept.length;
    flight.notes = kept;
  }
  return removed;
}

export function findCarrierCodeMismatches(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const out = [];

  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    items.forEach((item, itemIdx) => {
      const fl = item?.type === "Flight" ? item.flight : null;
      if (!fl || typeof fl !== "object") return;

      const number = nonEmpty(fl.flight_number);
      const carrier = nonEmpty(fl.carrier);
      // Nothing to cross-check without both halves of the claim.
      if (!number || !carrier) return;

      const at = { dayIdx, itemIdx, day: dayIdx + 1 };
      const route = fl.from_airport && fl.to_airport ? ` ${fl.from_airport}→${fl.to_airport}` : "";
      const conflict = carrierCodeConflict(carrier, number);

      // Case C — the two can't be compared because the carrier name never
      // resolved. carrierCodeConflict also returns null for a multi-carrier
      // string ("United or Delta"), which is a deliberate non-claim rather
      // than an unresolvable one, so resolveAirlineIata is re-checked here.
      if (!conflict) {
        if (resolveAirlineIata(carrier) === null) {
          out.push({
            code: "CARRIER_CODE_UNRESOLVED",
            severity: "warn",
            ...at,
            target: `${carrier} ${number}`,
            carrier,
            message: `${carrier} ${number}${route}: "${carrier}" could not be matched to an airline code, so the flight number could not be cross-checked against the carrier. Verify with the airline before booking.`,
          });
        }
        return;
      }

      const scheduleSourced = SCHEDULE_SOURCES.has(fl._resolveSource) && fl._flightUnverified !== true;

      // Case A — a live schedule row produced this number. The code wins.
      if (scheduleSourced) {
        if (!conflict.actualName) {
          // The code is real but we have no display name for it, so there is
          // nothing honest to rename the carrier to. Leave the flight alone
          // and say so.
          out.push({
            code: "CARRIER_CODE_UNRESOLVED",
            severity: "warn",
            ...at,
            target: `${carrier} ${number}`,
            carrier,
            message: `${carrier} ${number}${route}: the schedule confirmed flight ${number}, operated by ${conflict.actual}, but the itinerary calls the carrier "${carrier}" and ${conflict.actual} has no known airline name. Verify with the airline before booking.`,
          });
          return;
        }
        fl._originalCarrier = carrier;
        fl.carrier = conflict.actualName;
        const scrubbed = scrubCarrierProse(fl, carrier);
        out.push({
          code: "CARRIER_CODE_REPAIRED",
          severity: "warn",
          ...at,
          target: `${conflict.actualName} ${number}`,
          originalCarrier: carrier,
          carrier: conflict.actualName,
          message: `${number}${route} is operated by ${conflict.actualName}, not ${carrier} — the schedule confirmed the number, so the carrier name was corrected${scrubbed > 0 ? " and the booking note that named the old carrier was removed" : ""}.`,
        });
        return;
      }

      // Case B — model-authored number, nothing confirmed it, and it
      // contradicts the carrier the model named. One of the two is invented
      // and there is no ground truth to pick between them. Strip the number
      // and block: this is the UA940-labelled-LOT failure.
      fl.flight_number = null;
      delete fl._scheduleVerified;
      fl._flightUnverified = true;
      out.push({
        code: "CARRIER_CODE_MISMATCH",
        severity: "block",
        ...at,
        target: `${carrier} ${number}`,
        carrier,
        flightNumber: number,
        message: `${carrier} ${number}${route}: flight number ${number} belongs to ${conflict.actualName || conflict.actual}, not ${carrier}, and no live schedule confirmed it. The number has been removed — confirm the flight with the airline.`,
      });
    });
  });

  return out;
}
