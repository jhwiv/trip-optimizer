// Pure helpers behind the post-build TripTabs strip (#11). The strip used
// to be a single flat row of 9 pills (Overview / Flights / Lodging /
// Transport / Dining / Activities / By category / Local providers /
// Essentials). On phone it wrapped into 2–3 rows of pills, muddying the
// visual hierarchy and burying the high-use tabs the user actually
// reaches for. B-prime architecture: split into 5 always-visible
// primaries (Overview · Flights · Hotels · Dining · Activities) + a
// "More ▾" overflow popover holding the rest.
//
// Logic lives here so the partition and active-state decisions are
// unit-testable without React or a DOM.

// The five primary tabs in display order. Each entry is { id, label }
// where label is the user-facing string WITHOUT count (counts are
// appended at render time).
//
// Notes:
//   - "lodging" id is preserved (matches the existing per-tab view in
//     TripSectionView and the existing tab-state plumbing) but its
//     display label flips to "Hotels" per the wiki entry and the
//     B-prime decision.
//   - "overview" has no count.
const PRIMARY_ORDER = [
  { id: "overview", label: "Overview", hasCount: false },
  { id: "flights", label: "Flights", hasCount: true, countKey: "flights" },
  { id: "lodging", label: "Hotels", hasCount: true, countKey: "hotels" },
  { id: "dining", label: "Dining", hasCount: true, countKey: "dining" },
  { id: "activities", label: "Activities", hasCount: true, countKey: "activities" },
];

// The overflow tabs in display order, surfaced via the "More ▾" popover.
const OVERFLOW_ORDER = [
  { id: "transport", label: "Transport", hasCount: true, countKey: "transport" },
  { id: "category", label: "By category", hasCount: false, requires: "anyContent" },
  { id: "providers", label: "Local providers", hasCount: false, requires: "providers" },
  { id: "essentials", label: "Essentials", hasCount: true, countKey: "essentials" },
];

// Build the partitioned tab arrays for a given counts payload + flags.
// counts shape: { flights, hotels, transport, dining, activities, essentials }.
// flags shape: { showProviders }.
//
// Returns { primaries, overflow } — each is an array of
// { id, label, count? } where:
//   - "Overview" is always present in primaries.
//   - Other primaries are present only if their count > 0 (matches the
//     old TABS array's filter behavior).
//   - Overflow tabs follow their per-entry guard (transport > 0,
//     essentials > 0, providers via the flag, category when any
//     content-tab count > 0).
//
// Defensive: out-of-range / missing counts treated as 0; missing flags
// treated as false. Never throws.
export function partitionTabs(counts, flags) {
  const c = {
    flights: Number(counts?.flights) || 0,
    hotels: Number(counts?.hotels) || 0,
    transport: Number(counts?.transport) || 0,
    dining: Number(counts?.dining) || 0,
    activities: Number(counts?.activities) || 0,
    essentials: Number(counts?.essentials) || 0,
  };
  const anyContent = c.flights + c.hotels + c.transport + c.dining + c.activities > 0;
  const showProviders = !!flags?.showProviders;

  const primaries = PRIMARY_ORDER
    .filter((spec) => {
      if (spec.id === "overview") return true;
      return spec.hasCount && c[spec.countKey] > 0;
    })
    .map((spec) => spec.hasCount
      ? { id: spec.id, label: `${spec.label} · ${c[spec.countKey]}` }
      : { id: spec.id, label: spec.label });

  const overflow = OVERFLOW_ORDER
    .filter((spec) => {
      if (spec.id === "transport") return c.transport > 0;
      if (spec.id === "category") return anyContent;
      if (spec.id === "providers") return showProviders;
      if (spec.id === "essentials") return c.essentials > 0;
      return false;
    })
    .map((spec) => spec.hasCount
      ? { id: spec.id, label: `${spec.label} · ${c[spec.countKey]}` }
      : { id: spec.id, label: spec.label });

  return { primaries, overflow };
}

// True when the currently-active tab id lives in the overflow group.
// Used to give the "More ▾" button the active-pill styling so the user
// can see at a glance that the current tab lives behind the menu.
// Falls back to false when the tab id isn't in either group (safety
// net for legacy tab ids; the existing TABS array already filters
// these out before render, but the helper stays defensive).
export function isActiveTabInOverflow(activeId, partition) {
  if (!activeId || !partition || !Array.isArray(partition.overflow)) return false;
  return partition.overflow.some((t) => t.id === activeId);
}

// Returns the label of the active overflow tab, or null when the
// active tab isn't in overflow. Lets the More button display the
// actual section name when overflow is the active group (e.g.
// "Essentials · 3 ▾" instead of just "More ▾").
export function activeOverflowLabel(activeId, partition) {
  if (!isActiveTabInOverflow(activeId, partition)) return null;
  const match = partition.overflow.find((t) => t.id === activeId);
  return match ? match.label : null;
}

// Export the raw order arrays for tests that want to assert the
// canonical order without re-deriving it from partitionTabs. Keep
// these read-only by convention; the helper is the public surface.
export { PRIMARY_ORDER, OVERFLOW_ORDER };
