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
  const base = originalItem && typeof originalItem === "object" ? originalItem : {};
  if (kind === "restaurant") {
    const c = chosen && typeof chosen === "object" ? chosen : {};
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
    return {
      ...base,
      type: base.type || "Dining",
      restaurant,
    };
  }
  // Activity. Keep scheduling fields; replace all content fields so no stale
  // detail from the removed activity leaks through. Force type "Activity" so
  // the rich ActivityCard renders (DayBlock only upgrades type === "Activity").
  const c = chosen && typeof chosen === "object" ? chosen : {};
  const next = {
    ...base,
    type: "Activity",
    text: c.text || c.name || "",
  };
  if (c.location) next.location = c.location; else delete next.location;
  if (c.duration) next.duration = c.duration; else delete next.duration;
  next.why = c.why || "";
  if (c.contact) next.contact = c.contact; else delete next.contact;
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
  const wantName = itemVenueName(item, kind);
  if (!wantName) return -1;
  const wantTime = typeof item.time === "string" ? item.time : null;
  let fallback = -1;
  for (let i = 0; i < day.items.length; i++) {
    const it = day.items[i];
    if (!it) continue;
    if (kind === "restaurant" && !it.restaurant) continue;
    if (kind === "activity" && it.type !== "Activity") continue;
    if (itemVenueName(it, kind) !== wantName) continue;
    if (wantTime && typeof it.time === "string") {
      if (it.time === wantTime) return i;
      if (fallback === -1) fallback = i;
      continue;
    }
    return i;
  }
  return fallback;
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
