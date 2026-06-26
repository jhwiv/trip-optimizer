// categoryGroups.js
// =====================================================================
// Pure, framework-free helper that buckets a plan's chronological
// days[].items[] into category groups (flights / lodging / ground
// transport / activities / dining) for the "By category" views.
//
// ONE source of truth, consumed by BOTH the on-screen tab (src/App.jsx)
// and the PDF section (src/pdf/itineraryPdf.js) so the two views can
// never drift. It does NOT format times or render anything — each
// consumer formats with its own existing 12-hour helper (formatTime in
// App.jsx, to12h in the PDF). It only attaches the day/time context an
// item needs to stay useful once it's pulled out of its day.
//
// HONESTY: this is a pure re-projection of plan data that has already
// been through the verification pipeline. It invents nothing — every
// item, flag, and field is carried through verbatim. Classification
// mirrors the existing type checks in TripTabs / the section views so
// the category buckets match what those tabs already count.
//
// Pure (no React, no network) so it's unit-tested directly in
// tests/test_category_groups.mjs.
// =====================================================================

// Ordered category metadata. Order is intentional and fixed; the views
// render groups in exactly this sequence and skip any that are empty.
export const CATEGORY_ORDER = [
  { id: "flights", label: "Flights" },
  { id: "lodging", label: "Hotels & Lodging" },
  { id: "transport", label: "Rental Car & Ground Transport" },
  { id: "activities", label: "Activities" },
  { id: "dining", label: "Dining" },
];

/**
 * Classify a single plan item into one of the category ids, or null when
 * it isn't a card-bearing item (free time, generic notes, unknown types).
 *
 * Mirrors the existing classification used by TripTabs.counts and the
 * per-section views (FlightsView / LodgingView / TransportView /
 * ActivitiesView / DiningView) so buckets line up with those tabs.
 *
 * @param {object} item  a plan day item
 * @returns {"flights"|"lodging"|"transport"|"activities"|"dining"|null}
 */
export function classifyItemCategory(item) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type || "").trim();
  if (type === "Flight" && item.flight) return "flights";
  if (type === "Hotel" && item.hotel) return "lodging";
  if (type === "Transport") return "transport";
  if (item.restaurant && /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/.test(type)) return "dining";
  if (type === "Activity") return "activities";
  return null;
}

// Sort key: '08:30' -> 830, '14:05' -> 1405. Items without a parseable
// time sort last (Infinity). Mirrors timeKey() in App.jsx but local so
// this module stays dependency-free.
function timeSortKey(t) {
  if (!t || typeof t !== "string") return Infinity;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return Infinity;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

/**
 * Group a plan's items by category for the "By category" views.
 *
 * Walks every day in order, classifies each item, and buckets it with
 * its day/time context attached. Returns groups in CATEGORY_ORDER,
 * omitting any category that has no items. Within a group, items are
 * ordered chronologically (day index, then start time). Lodging is
 * de-duplicated by name+address (a hotel item repeats on every night of
 * a stay) to match LodgingView's behaviour.
 *
 * @param {object} plan  plan-like object with days[]
 * @returns {Array<{category:string, label:string, items:Array<{
 *   item:object, dayIndex:number, dayLabel:string, time:string
 * }>}>}
 */
export function groupItemsByCategory(plan) {
  const days = plan && Array.isArray(plan.days) ? plan.days : [];

  const buckets = new Map(CATEGORY_ORDER.map((c) => [c.id, []]));
  const lodgingSeen = new Set();

  days.forEach((day, dayIndex) => {
    const items = day && Array.isArray(day.items) ? day.items : [];
    items.forEach((item) => {
      const category = classifyItemCategory(item);
      if (!category) return;
      if (category === "lodging") {
        const key = `${item.hotel?.name || ""}|${item.hotel?.address || ""}`;
        if (lodgingSeen.has(key)) return;
        lodgingSeen.add(key);
      }
      buckets.get(category).push({
        item,
        dayIndex,
        dayLabel: String(day?.label || ""),
        time: typeof item.time === "string" ? item.time : "",
      });
    });
  });

  const groups = [];
  for (const { id, label } of CATEGORY_ORDER) {
    const entries = buckets.get(id);
    if (!entries || entries.length === 0) continue;
    // Stable chronological sort: day first, then start time. Index is the
    // tiebreaker so equal-time items keep their original walk order.
    entries.forEach((e, i) => { e._i = i; });
    entries.sort((a, b) =>
      a.dayIndex - b.dayIndex ||
      timeSortKey(a.time) - timeSortKey(b.time) ||
      a._i - b._i,
    );
    entries.forEach((e) => { delete e._i; });
    groups.push({ category: id, label, items: entries });
  }
  return groups;
}
