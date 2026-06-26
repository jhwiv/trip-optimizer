// Pure helpers for the "Find another restaurant / activity" swap feature.
//
// The UI (src/App.jsx) calls POST /api/find to fetch real, currently-operating
// alternatives, then uses these helpers to (a) pick three distinct candidates
// that aren't the current item or already on the same day, (b) build a
// replacement item in the SAME shape the itinerary renderer expects, and
// (c) locate the item's real index in the un-quality-layered plan so the
// existing replace_item patch path swaps the correct slot.
//
// Network lives in App.jsx; everything here is pure so it's unit-testable.

// Activity titles use the form "Name — short description". The card renders
// the part before the em-dash as the bold venue name, so that's the identity
// we de-dupe and match on.
export function activityHeadName(text) {
  const s = typeof text === "string" ? text : "";
  const dash = s.indexOf(" — ");
  return (dash > 0 ? s.slice(0, dash) : s).trim();
}

// Canonical lowercase name for an itinerary item, used for de-dupe/exclusion.
export function itemVenueName(item, kind) {
  if (!item || typeof item !== "object") return "";
  if (kind === "restaurant") return (item.restaurant?.name || "").trim().toLowerCase();
  return activityHeadName(item.text).toLowerCase();
}

// Canonical lowercase name for a /api/find result entry.
function altName(entry, kind) {
  if (!entry || typeof entry !== "object") return "";
  if (kind === "restaurant") return (entry.name || "").trim().toLowerCase();
  return activityHeadName(entry.text || entry.name || "").toLowerCase();
}

// verify_status values that mean the place is not currently operating. Offering
// these as "alternatives" would violate the CLAUDE.md hard rule, so they're
// dropped from the picker entirely. verify_before_booking is NOT closed — it's
// allowed (just flagged for the traveler to confirm).
const CLOSED_VERIFY_STATUSES = new Set(["permanently_closed", "closed_permanently", "not_found"]);
function isClosedAlt(entry) {
  const s = (entry?.verify_status || "").trim().toLowerCase();
  return CLOSED_VERIFY_STATUSES.has(s);
}

// Pick up to `max` alternatives from a /api/find result pool, excluding:
//   - the item currently in the slot,
//   - anything already scheduled the same day (by name, same kind),
//   - duplicates within the pool itself.
// Returns whatever survives, capped at max — never pads with fabricated
// entries, so the caller can honestly say "only N found".
export function selectAlternatives(pool, { currentItem, sameDayItems = [], kind, max = 3 } = {}) {
  if (!Array.isArray(pool)) return [];
  const excluded = new Set();
  const cur = itemVenueName(currentItem, kind);
  if (cur) excluded.add(cur);
  for (const it of sameDayItems) {
    const n = itemVenueName(it, kind);
    if (n) excluded.add(n);
  }
  const seen = new Set();
  const out = [];
  for (const entry of pool) {
    if (isClosedAlt(entry)) continue;
    const name = altName(entry, kind);
    if (!name) continue;
    if (excluded.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

// Build a replacement itinerary item from a chosen /api/find alternative,
// preserving the original item's scheduling fields (type, time, end_time) so
// it renders in the same slot. Verification fields (verify_status/verify_url)
// are carried straight through from the alternative so the existing
// verification pipeline + UI surface them — we never mark a swapped venue as
// confirmed.
export function buildSwapItem(originalItem, chosen, kind) {
  // Strip the removed venue's provenance/verification/coordinate/flag fields so
  // the swapped-in venue never inherits stale truth. _verified, place_id, lat,
  // lng and item-level flags all describe the OLD venue; verify/pacing don't
  // re-run synchronously on swap, so carrying them would surface wrong
  // coordinates or stale warn flags on the NEW venue. We only carry the NEW
  // find result's coords (and verify_status/verify_url) below.
  const base = strippedBase(originalItem);
  const c = chosen && typeof chosen === "object" ? chosen : {};
  if (kind === "restaurant") {
    const restaurant = { name: (c.name || "").trim() };
    if (c.cuisine) restaurant.cuisine = c.cuisine;
    if (c.neighborhood) restaurant.neighborhood = c.neighborhood;
    if (c.price_range) restaurant.price_range = c.price_range;
    if (c.why) restaurant.why = c.why;
    if (c.contact) restaurant.contact = c.contact;
    if (c.reservation) restaurant.reservation = c.reservation;
    if (c.verify_status) restaurant.verify_status = c.verify_status;
    if (c.verify_url) restaurant.verify_url = c.verify_url;
    // Keep scheduling + meal type; drop the old venue's backup (it belonged
    // to the removed recommendation, not this one).
    const item = {
      ...base,
      type: base.type || "Dining",
      restaurant,
    };
    if (typeof c.lat === "number") item.lat = c.lat;
    if (typeof c.lng === "number") item.lng = c.lng;
    return item;
  }
  // Activity. Keep scheduling fields; replace all content fields so no stale
  // detail from the removed activity leaks through. Force type "Activity" so
  // the rich ActivityCard renders (DayBlock only upgrades type === "Activity").
  const next = {
    ...base,
    type: "Activity",
    text: c.text || c.name || "",
  };
  if (c.location) next.location = c.location; else delete next.location;
  if (c.duration) next.duration = c.duration; else delete next.duration;
  next.why = c.why || "";
  if (c.contact) next.contact = c.contact; else delete next.contact;
  if (typeof c.lat === "number") next.lat = c.lat;
  if (typeof c.lng === "number") next.lng = c.lng;
  return next;
}

// Copy an itinerary item without the removed venue's provenance/verification/
// coordinate/flag fields. These describe the OLD venue and must not be carried
// onto a swapped-in replacement (see buildSwapItem).
function strippedBase(originalItem) {
  const next = originalItem && typeof originalItem === "object" ? { ...originalItem } : {};
  delete next._verified;
  delete next.place_id;
  delete next.lat;
  delete next.lng;
  delete next.flags;
  return next;
}

// Locate an item's index within the ORIGINAL (un-quality-layered) plan day.
// The rendered plan runs through applyQualityLayer, which can drop items
// (e.g. unrequested breakfast/lunch), so positional indices from the rendered
// plan don't reliably map back to the raw plan that revisions persist against.
// We match by kind + venue name (+ time when present) instead. Returns -1 if
// no confident match.
export function findRawItemIndex(rawPlan, dayIndex, item, kind) {
  const day = rawPlan?.days?.[dayIndex];
  if (!day || !Array.isArray(day.items) || !item) return -1;
  const items = day.items;
  const wantName = itemVenueName(item, kind);
  const wantTime = typeof item.time === "string" ? item.time : null;
  const ofKind = (it) =>
    !!it && (kind === "restaurant" ? !!it.restaurant : it.type === "Activity");

  // Walk candidate slots, returning the first whose `nameOf` matches wantName,
  // disambiguating by time when the rendered item carries one. Returns the
  // first name-only match as a fallback if no time-exact match is found.
  const matchByName = (nameOf) => {
    let fallback = -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!ofKind(it)) continue;
      if (nameOf(it) !== wantName) continue;
      if (wantTime && typeof it.time === "string") {
        if (it.time === wantTime) return i;
        if (fallback === -1) fallback = i;
        continue;
      }
      return i;
    }
    return fallback;
  };

  if (wantName) {
    // Pass 1: the displayed venue name matches the raw venue name.
    const direct = matchByName((it) => itemVenueName(it, kind));
    if (direct !== -1) return direct;

    // Pass 2 (restaurants): the quality layer's closure gate promotes a backup
    // over a permanently-closed primary, RENAMING the card to the backup's
    // name. The raw item still carries the original primary name, so the
    // displayed name only matches the raw item's backup slot — match on that
    // so swap works in exactly the closed-venue case the user most wants.
    if (kind === "restaurant") {
      const viaBackup = matchByName((it) => (it.restaurant?.backup?.name || "").trim().toLowerCase());
      if (viaBackup !== -1) return viaBackup;
    }
  }

  // Pass 3: positional time match within the same kind. The quality layer can
  // drop/reorder items but preserves scheduled times, so a UNIQUE time within
  // the kind reliably identifies the slot even when the name was changed. If
  // two same-kind items share the time we refuse rather than guess.
  if (wantTime) {
    let timeMatch = -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!ofKind(it) || typeof it.time !== "string" || it.time !== wantTime) continue;
      if (timeMatch !== -1) return -1;
      timeMatch = i;
    }
    if (timeMatch !== -1) return timeMatch;
  }

  return -1;
}

// Resolve the city to search for alternatives on a given day. Multi-city trips
// label transit days "Origin → Destination"; the destination end is where the
// day's meals/activities happen, so we take the last segment. Falls back to the
// first leg city, then plan.destination.
export function resolveLegCity(plan, dayIndex, legCities = []) {
  const dayCity = plan?.days?.[dayIndex]?.city;
  if (typeof dayCity === "string" && dayCity.trim()) {
    const parts = dayCity.split(/\s*(?:→|->|–|-)\s*/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  if (Array.isArray(legCities) && legCities.length > 0) return legCities[0];
  if (typeof plan?.destination === "string" && plan.destination.trim()) return plan.destination.trim();
  return "";
}
