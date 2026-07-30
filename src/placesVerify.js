import { parseWeekdayDescriptions, isOpenAt } from "./hoursParser.js";
import { addDays, weekdayOf } from "./dateFacts.js";

// Re-export the leg helpers so a single placesVerify.js import covers
// both venue verification and location checking on the client.
export { findVenuesOutsideRadius, computeLegRadii } from "./locationCheck.js";

// Client-side helpers for the post-build Places verification pass.
//
// Two pure functions:
//   - collectPlanVenues(plan)         walks days[].items[] and pulls
//                                     every named venue (restaurants,
//                                     their backups, activities) into
//                                     a deduplicated list shaped for
//                                     /api/places-verify-batch.
//   - mergePlacesVerifications(plan,
//                              verifications, options)
//                                     returns a NEW plan object with:
//                                       - CLOSED_PERMANENTLY,
//                                         CLOSED_TEMPORARILY, NOT_FOUND
//                                         items REMOVED from days[].items[]
//                                       - OPERATIONAL items' contact
//                                         fields overwritten with Places
//                                         values + hours_verified added
//                                       - UNVERIFIED venues kept and
//                                         decorated with flags
//                                       - top-level plan._verificationSummary
//                                         set to { checked, blocked, warnings }
//
// Why a separate file: lets us unit-test these pure helpers without
// loading App.jsx (no React, no Vite). The existing test_findview_helpers
// re-implements logic to avoid that import cost — extracting to a real
// module lets us assert against the same code the app ships.
//
// Naming consistency: in /api responses the "kind" field uses
// 'restaurant' | 'activity' | 'hotel'. We stick to that vocabulary
// here too so client + server speak the same language.

// Normalize a name for case-insensitive lookup. Mirrors the server-side
// rule in places-verify.js cacheKeyFor() but is a plain function — no
// crypto, no async — because we only need it for in-memory map keys.
function normName(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Walk a parsed plan and collect every named venue. Returns a list of
// { name, city, kind } objects, deduplicated by (kind, normName(name)).
// Both restaurants and their backup restaurants are included.
//
// City fallback chain (best to worst):
//   1. plan.destination (luxury single-city plans usually fill this)
//   2. First cities[].name on a multi-city plan
//   3. Empty string — Places will still try, but disambiguation is weaker
//
// We do NOT use per-item neighborhood as the city — Places' Text Search
// works better with the broader city/region than with a sub-area string
// that may not be a recognized locality.
export function collectPlanVenues(plan) {
  if (!plan || !Array.isArray(plan.days)) return [];
  const cityHint = String(
    plan.destination ||
    (Array.isArray(plan.cities) && plan.cities[0]?.name) ||
    "",
  ).trim();

  const seen = new Set();
  const out = [];

  const push = (rawName, kind) => {
    if (typeof rawName !== "string") return;
    const name = rawName.trim();
    if (!name) return;
    const key = `${kind}|${normName(name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, city: cityHint, kind });
  };

  for (const day of plan.days) {
    if (!Array.isArray(day?.items)) continue;
    for (const item of day.items) {
      if (!item || typeof item !== "object") continue;
      if (item.restaurant && typeof item.restaurant === "object") {
        push(item.restaurant.name, "restaurant");
        if (item.restaurant.backup && typeof item.restaurant.backup === "object") {
          push(item.restaurant.backup.name, "restaurant");
        }
      }
      if (item.type === "Activity") {
        push(item.name, "activity");
      }
    }
  }
  return out;
}

// Collect the distinct leg city names from a plan. Used for per-leg
// location checking — we geocode each leg city once to get a centroid,
// then Haversine venues against the appropriate centroid.
//
// Returns an ordered array of unique city names. Order follows the
// trip's chronological progression. Multi-city plans use plan.cities[]
// when populated; single-city plans fall back to plan.destination.
//
// Transit-day labels like "Rovinj → Plitvice" are split on the arrow so
// both endpoints become candidate leg cities (already covered if both
// appear elsewhere; the dedup makes this safe).
export function collectPlanLegCities(plan) {
  if (!plan) return [];
  const seen = new Set();
  const out = [];
  const push = (name) => {
    if (typeof name !== "string") return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  // Preferred source: plan.cities[].name (multi-city trips).
  if (Array.isArray(plan.cities) && plan.cities.length > 0) {
    for (const c of plan.cities) {
      if (c && typeof c.name === "string") push(c.name);
    }
  }

  // Fallback / supplement: plan.days[].city. Splits transit-day
  // "From → To" labels on arrows / hyphens so both ends are added.
  if (Array.isArray(plan.days)) {
    for (const day of plan.days) {
      if (!day || typeof day.city !== "string") continue;
      const parts = day.city.split(/\s*(?:→|->|\u2013|-)\s*/);
      for (const part of parts) push(part);
    }
  }

  // Last resort: plan.destination (single-city trips that don't populate
  // cities[] or days[].city).
  if (out.length === 0 && typeof plan.destination === "string") {
    push(plan.destination);
  }
  return out;
}

// Apply Places verifications to a plan. Returns a NEW plan object.
//
// Rules:
//   1. Any item whose venue has a severity=block flag (CLOSED_PERMANENTLY,
//      CLOSED_TEMPORARILY, NOT_FOUND) is REMOVED from its day's items[].
//   2. For OPERATIONAL items, overwrite contact.address / phone / website
//      with Places values where Places provided them. Add
//      contact.hours_verified when Places returned hours. Mark with
//      ._verified = true so the UI can show a verified checkmark.
//   3. For UNVERIFIED items, leave the data untouched but attach
//      flags[] so the client can render a "couldn't verify" banner.
//   4. Set plan._verificationSummary so the UI / pre-export gate can
//      query overall state in O(1).
//   5. Backups receive the same treatment as their primary restaurant.
//      A backup whose venue is blocked is set to null on the parent.
//
// `verifications` is the array returned by /api/places-verify-batch:
//   [{ name, kind, found, business_status?, address?, phone?, website?,
//      hours?, flags: [{code, severity, ...}], ... }]
//
// `options.dropBlocked` (default true) — set false to keep blocked items
// in place and rely on per-item flags. We default true because the
// CLAUDE.md hard rule says blocked venues are replaced, never shipped.
export function mergePlacesVerifications(plan, verifications, options = {}) {
  if (!plan || !Array.isArray(plan.days)) return plan;
  if (!Array.isArray(verifications) || verifications.length === 0) return plan;

  const dropBlocked = options.dropBlocked !== false;

  // Index verifications by kind + normName. /api/places-verify-batch
  // echoes one row per ORIGINAL request entry, so duplicates within
  // verifications resolve to the same (kind, normName) anyway.
  const byKey = new Map();
  for (const v of verifications) {
    if (!v || typeof v.name !== "string") continue;
    const key = `${v.kind || "restaurant"}|${normName(v.name)}`;
    byKey.set(key, v);
  }
  if (byKey.size === 0) return plan;

  let blocked = 0;
  let warnings = 0;
  let verified = 0;

  // Bookkeeping for the day/hours check (Spec 1, 2026-06-14). Runs only
  // when the plan has a startDate — without it we can't compute a per-day
  // weekday. Items missing a `time` field still get a partial check
  // (closed_all_day still fires).
  const startDate = typeof plan.startDate === "string" ? plan.startDate : null;

  // Apply Places data to a single (restaurant or backup) restaurant object.
  // Returns either the updated restaurant or null if it should be dropped.
  // dayContext = { weekday, time } when known — drives the OPEN_ON_THIS_DAY
  // hours check inside decorateVenue.
  const applyToRestaurant = (r, dayContext) => {
    if (!r || typeof r.name !== "string") return r;
    const v = byKey.get(`restaurant|${normName(r.name)}`);
    if (!v) return r;
    const isBlocked = Array.isArray(v.flags) && v.flags.some((f) => f.severity === "block");
    if (isBlocked && dropBlocked) {
      blocked += 1;
      return null;
    }
    return decorateVenue(r, v, (n) => { if (n === "verified") verified += 1; else if (n === "warn") warnings += 1; else if (n === "block") blocked += 1; }, dayContext);
  };

  // Apply Places data to an Activity item. Returns the updated item or
  // null if blocked.
  const applyToActivity = (item, dayContext) => {
    if (!item || typeof item.name !== "string") return item;
    const v = byKey.get(`activity|${normName(item.name)}`);
    if (!v) return item;
    const isBlocked = Array.isArray(v.flags) && v.flags.some((f) => f.severity === "block");
    if (isBlocked && dropBlocked) {
      blocked += 1;
      return null;
    }
    return decorateVenue(item, v, (n) => { if (n === "verified") verified += 1; else if (n === "warn") warnings += 1; else if (n === "block") blocked += 1; }, dayContext);
  };

  const nextDays = plan.days.map((day, dayIdx) => {
    if (!Array.isArray(day?.items)) return day;
    // Compute this day's weekday from start date + day index. Null when
    // startDate missing/unparseable; downstream check degrades to no-op.
    const dayISO = startDate ? addDays(startDate, dayIdx) : null;
    const dayWeekday = dayISO ? weekdayOf(dayISO) : null;
    const nextItems = [];
    for (const item of day.items) {
      if (!item || typeof item !== "object") {
        nextItems.push(item);
        continue;
      }

      // Per user decision 2026-06-14: hours-check runs on Activity,
      // Dinner, Breakfast/Brunch/Lunch items. Hotels are excluded.
      const itemTime = typeof item.time === "string" ? item.time : null;
      // `anchor` rides along in dayContext because decorateVenue receives the
      // restaurant object, not its parent item, and the reservation signal
      // lives on the item.
      const dayContext = dayWeekday ? { weekday: dayWeekday, time: itemTime, anchor: classifyAnchor(item) } : null;

      if (item.type === "Activity") {
        const next = applyToActivity(item, dayContext);
        if (next !== null) nextItems.push(next);
        continue;
      }

      // Non-Activity items may still carry a restaurant object (e.g. a
      // Dinner item has type:'Dinner' and a nested .restaurant). Verify
      // and decorate the restaurant + its backup; drop the whole item
      // if the primary restaurant is blocked.
      if (item.restaurant && typeof item.restaurant === "object") {
        // Hotels are excluded from the hours-check; their items don't
        // have .restaurant in the schema, but guard explicitly anyway.
        const isHotel = item.type === "Hotel";
        const rDayContext = isHotel ? null : dayContext;
        const nextR = applyToRestaurant(item.restaurant, rDayContext);
        if (nextR === null) {
          // Primary restaurant blocked — drop the entire item.
          continue;
        }
        // Try to apply the backup; if it's blocked, just remove the
        // backup field. A primary survives without a backup.
        if (nextR.backup && typeof nextR.backup === "object") {
          // A backup is a suggestion, never a booking — it must not inherit
          // the primary's anchor status and block the export.
          const backupContext = rDayContext ? { ...rDayContext, anchor: false } : null;
          const nextBackup = applyToRestaurant(nextR.backup, backupContext);
          if (nextBackup === null) {
            const { backup: _drop, ...rest } = nextR;
            nextItems.push({ ...item, restaurant: rest });
            continue;
          }
          nextItems.push({ ...item, restaurant: { ...nextR, backup: nextBackup } });
          continue;
        }
        nextItems.push({ ...item, restaurant: nextR });
        continue;
      }

      // Item has no restaurant and isn't an Activity — pass through.
      nextItems.push(item);
    }
    return { ...day, items: nextItems };
  });

  return {
    ...plan,
    days: nextDays,
    _verificationSummary: {
      checked: byKey.size,
      verified,
      warnings,
      blocked,
    },
  };
}

// Pre-export gate: walk a plan and return an array of blocking issues
// (severity:'block' flags). Returns [] when the plan is safe to render.
//
// Shape per issue:
//   { dayIdx, itemIdx, kind: 'restaurant' | 'activity' | 'backup',
//     name, flag: { code, severity, message } }
//
// The PDF export path MUST call this before invoking the itinerary
// builder. If it returns a non-empty array, refuse to render and
// surface the issues to the user.
//
// The merge helper already DROPS blocked items — so this gate should
// normally find nothing. Its job is to be the last line of defense
// against:
//   - block-severity flags added by a future code path that bypasses
//     mergePlacesVerifications
//   - manual user edits that re-introduce a blocked venue
//   - bugs in this very module
export function findBlockingIssues(plan) {
  if (!plan || !Array.isArray(plan.days)) return [];
  const issues = [];
  for (let dayIdx = 0; dayIdx < plan.days.length; dayIdx++) {
    const items = plan.days[dayIdx]?.items;
    if (!Array.isArray(items)) continue;
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx];
      if (!item || typeof item !== "object") continue;
      if (item.type === "Activity") {
        addBlockingFlags(item.flags, { dayIdx, itemIdx, kind: "activity", name: item.name || item.text || "(unnamed activity)" }, issues);
        continue;
      }
      if (item.restaurant && typeof item.restaurant === "object") {
        addBlockingFlags(item.restaurant.flags, { dayIdx, itemIdx, kind: "restaurant", name: item.restaurant.name || "(unnamed restaurant)" }, issues);
        if (item.restaurant.backup && typeof item.restaurant.backup === "object") {
          addBlockingFlags(item.restaurant.backup.flags, { dayIdx, itemIdx, kind: "backup", name: item.restaurant.backup.name || "(unnamed backup)" }, issues);
        }
      }
    }
  }
  return issues;
}

function addBlockingFlags(flags, location, issues) {
  if (!Array.isArray(flags)) return;
  for (const flag of flags) {
    if (flag && flag.severity === "block") {
      issues.push({ ...location, flag });
    }
  }
}

// Hard-specific contact fields. When a venue is UNVERIFIED (Places
// couldn't resolve it — missing key / network / soft "not-found"
// downgraded to warn), the model's claimed values for these fields
// are exactly the kind of high-confidence hallucination the venue
// verification framework exists to prevent. Strip them and tag the
// venue UNVERIFIED_SPECIFIC so the UI can render "phone unavailable"
// instead of a fake number a traveler might dial.
//
// We keep `address` IFF it has at least a street number; otherwise we
// strip. Neighborhood / city-only strings are safe to leave.
// (Heuristic: presence of any digit.)
const HARD_SPECIFIC_FIELDS = ["phone", "hours", "booking_url"];

// Is this item an ANCHOR — something the traveller has committed to, where
// arriving to a locked door costs them the slot rather than five minutes?
//
// Drives the severity of CLOSED_ON_THIS_DAY. The 2026-07-28 build put a
// reserved Monday dinner at a Monday-closed restaurant and shipped it, because
// the flag was warn for everything. Blanket-blocking is not the answer either:
// Places closure data has known gaps (seasonal hours, holiday overrides), and
// a false block on a walk-in cafe would stop the export of an otherwise good
// itinerary. So: block the bookings, warn the walk-ins.
//
// Ambiguous cases return false (warn) by design — per the maintainer's call
// 2026-07-30, an unclear classification must not escalate to a block.
const RESERVATION_PROSE = /\breservations?\s+(?:are\s+)?(?:required|essential|recommended|only)\b|\bbooking\s+(?:is\s+)?(?:required|essential)\b|\bbook\s+(?:well\s+)?(?:in\s+)?advance\b/i;
const TIMED_ENTRY_PROSE = /\badvance booking\b|\btimed[\s-]?entry\b|\bmust book\b|\bpre[\s-]?book\b|\bticket(?:ed|s)? in advance\b/i;
const MEAL_TYPES = /^(Breakfast|Brunch|Lunch|Dinner)$/i;

export function classifyAnchor(item) {
  if (!item || typeof item !== "object") return false;
  const type = String(item.type || "");

  // A hotel check-in is the hardest anchor there is — there is no walk-in
  // alternative at 11pm in a city you just flew into.
  if (/^Hotel$/i.test(type)) return true;

  if (MEAL_TYPES.test(type)) {
    if (item.contact?.reserve) return true;
    const r = item.restaurant;
    if (!r || typeof r !== "object") return false;
    if (r.reservations_required) return true;
    const platform = String(r.reservation?.platform || "").toLowerCase();
    const hasBooking = !!(r.reservation?.url || r.reservation?.phone);
    if (platform && platform !== "walkin" && hasBooking) return true;
    return RESERVATION_PROSE.test(`${r.why || ""} ${r.hours_note || ""} ${r.closure_note || ""}`);
  }

  if (/^Activity$/i.test(type)) {
    if (item.contact?.booking_url) return true;
    if (item.timed_entry === true) return true;
    return TIMED_ENTRY_PROSE.test(`${item.contact?.hours || ""} ${item.contact?.booking_note || ""}`);
  }

  return false;
}

// Apply Places fields to a venue (restaurant or activity item) and
// attach flags. Pure, side-effect free except for the supplied `tally`
// callback which lets the caller count outcomes.
//
// dayContext (optional) = { weekday: 'Monday', time: '19:00', anchor: true }
// drives the OPEN_ON_THIS_DAY hours check added in Spec 1 (2026-06-14).
// weekday/time are optional; missing fields degrade the check gracefully.
// `anchor` (see classifyAnchor) decides whether CLOSED_ON_THIS_DAY blocks the
// export or merely warns.
function decorateVenue(venue, v, tally, dayContext) {
  const isOperational = v.found && (!v.business_status || v.business_status === "OPERATIONAL");
  const hasWarn = Array.isArray(v.flags) && v.flags.some((f) => f.severity === "warn");

  const prevContact = venue.contact && typeof venue.contact === "object" ? venue.contact : {};
  const nextContact = { ...prevContact };
  const extraFlags = [];

  if (isOperational) {
    if (v.address) nextContact.address = v.address;
    if (v.phone) nextContact.phone = v.phone;
    // When Places confirms the venue is operational, prefer its websiteUri.
    // If Places has no websiteUri, null out any model-generated URL — a
    // verified "no website" is better than an unverified (potentially wrong)
    // model URL. NOT_FOUND/UNVERIFIED venues keep their model URL (untouched).
    nextContact.website = v.website || null;
    if (Array.isArray(v.hours) && v.hours.length) {
      nextContact.hours_verified = v.hours;
    }
    // Day/hours check (Spec 1, 2026-06-14). Parse the venue's weekly
    // hours and ask: is this venue open on the item's weekday at the
    // item's time? Both surfaced flags are warn-severity per user
    // decision — they surface a banner without blocking the PDF.
    if (dayContext && dayContext.weekday && Array.isArray(v.hours) && v.hours.length) {
      const parsed = parseWeekdayDescriptions(v.hours);
      const check = isOpenAt(parsed, dayContext.weekday, dayContext.time || null);
      if (check.status === "closed_all_day") {
        // Anchor-scoped severity (2026-07-30). A booked table or a timed-entry
        // ticket on a closed day is a wasted slot the traveller can't recover,
        // so it blocks; a walk-in stop stays a warning.
        const anchored = dayContext.anchor === true;
        extraFlags.push({
          code: "CLOSED_ON_THIS_DAY",
          severity: anchored ? "block" : "warn",
          // Carried so the card can render a chip-sized "Closed Mon" without
          // re-parsing the prose message.
          weekday: dayContext.weekday,
          message: anchored
            ? `Closed on ${dayContext.weekday}s per Google Places hours — and this is a booked slot. Move it or replace the venue.`
            : `Closed on ${dayContext.weekday}s per Google Places hours.`,
        });
      } else if (check.status === "outside_hours") {
        extraFlags.push({
          code: "OUTSIDE_HOURS",
          severity: "warn",
          message: `Scheduled at ${dayContext.time} on ${dayContext.weekday}, but the venue's posted hours don't cover that time.`,
        });
      }
      // open / open24 / unknown → no flag.
    }
  } else if (hasWarn) {
    // Verify-or-strip: an UNVERIFIED venue's model-supplied phone /
    // hours / booking_url are unsafe to ship. Strip them and tag
    // UNVERIFIED_SPECIFIC. Address is kept only when it lacks a street
    // number (neighborhood / city-only strings); a numbered address
    // could be a hallucination.
    let stripped = false;
    for (const field of HARD_SPECIFIC_FIELDS) {
      if (nextContact[field]) {
        delete nextContact[field];
        stripped = true;
      }
    }
    if (nextContact.address && /\d/.test(nextContact.address)) {
      delete nextContact.address;
      stripped = true;
    }
    if (stripped) {
      extraFlags.push({
        code: "UNVERIFIED_SPECIFIC",
        severity: "info",
        message: "Phone, exact address, and hours stripped — Places couldn't verify these specifics.",
      });
    }
  }

  const next = { ...venue, contact: nextContact };
  if (isOperational) {
    next._verified = true;
    if (v.place_id) next.place_id = v.place_id;
    if (typeof v.lat === "number") next.lat = v.lat;
    if (typeof v.lng === "number") next.lng = v.lng;
    tally("verified");
  } else if (hasWarn) {
    tally("warn");
  }

  // Always attach flags so the UI can render badges. Empty flag arrays
  // are omitted to keep the payload small.
  const allFlags = [
    ...(Array.isArray(venue.flags) ? venue.flags : []),
    ...(Array.isArray(v.flags) ? v.flags : []),
    ...extraFlags,
  ];
  if (allFlags.length) {
    next.flags = allFlags;
  }
  return next;
}
