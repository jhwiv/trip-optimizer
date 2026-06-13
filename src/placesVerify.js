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

  // Apply Places data to a single (restaurant or backup) restaurant object.
  // Returns either the updated restaurant or null if it should be dropped.
  const applyToRestaurant = (r) => {
    if (!r || typeof r.name !== "string") return r;
    const v = byKey.get(`restaurant|${normName(r.name)}`);
    if (!v) return r;
    const isBlocked = Array.isArray(v.flags) && v.flags.some((f) => f.severity === "block");
    if (isBlocked && dropBlocked) {
      blocked += 1;
      return null;
    }
    return decorateVenue(r, v, (n) => { if (n === "verified") verified += 1; else if (n === "warn") warnings += 1; else if (n === "block") blocked += 1; });
  };

  // Apply Places data to an Activity item. Returns the updated item or
  // null if blocked.
  const applyToActivity = (item) => {
    if (!item || typeof item.name !== "string") return item;
    const v = byKey.get(`activity|${normName(item.name)}`);
    if (!v) return item;
    const isBlocked = Array.isArray(v.flags) && v.flags.some((f) => f.severity === "block");
    if (isBlocked && dropBlocked) {
      blocked += 1;
      return null;
    }
    return decorateVenue(item, v, (n) => { if (n === "verified") verified += 1; else if (n === "warn") warnings += 1; else if (n === "block") blocked += 1; });
  };

  const nextDays = plan.days.map((day) => {
    if (!Array.isArray(day?.items)) return day;
    const nextItems = [];
    for (const item of day.items) {
      if (!item || typeof item !== "object") {
        nextItems.push(item);
        continue;
      }

      if (item.type === "Activity") {
        const next = applyToActivity(item);
        if (next !== null) nextItems.push(next);
        continue;
      }

      // Non-Activity items may still carry a restaurant object (e.g. a
      // Dinner item has type:'Dinner' and a nested .restaurant). Verify
      // and decorate the restaurant + its backup; drop the whole item
      // if the primary restaurant is blocked.
      if (item.restaurant && typeof item.restaurant === "object") {
        const nextR = applyToRestaurant(item.restaurant);
        if (nextR === null) {
          // Primary restaurant blocked — drop the entire item.
          continue;
        }
        // Try to apply the backup; if it's blocked, just remove the
        // backup field. A primary survives without a backup.
        if (nextR.backup && typeof nextR.backup === "object") {
          const nextBackup = applyToRestaurant(nextR.backup);
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

// Apply Places fields to a venue (restaurant or activity item) and
// attach flags. Pure, side-effect free except for the supplied `tally`
// callback which lets the caller count outcomes.
function decorateVenue(venue, v, tally) {
  const isOperational = v.found && (!v.business_status || v.business_status === "OPERATIONAL");
  const hasWarn = Array.isArray(v.flags) && v.flags.some((f) => f.severity === "warn");

  const prevContact = venue.contact && typeof venue.contact === "object" ? venue.contact : {};
  const nextContact = { ...prevContact };
  const extraFlags = [];

  if (isOperational) {
    if (v.address) nextContact.address = v.address;
    if (v.phone) nextContact.phone = v.phone;
    if (v.website) nextContact.website = v.website;
    if (Array.isArray(v.hours) && v.hours.length) {
      nextContact.hours_verified = v.hours;
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
