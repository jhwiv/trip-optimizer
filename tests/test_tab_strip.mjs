// Tests for src/tabStrip.js — the pure helpers behind the post-build
// TripTabs partition (#11 B-prime). Locks in the 5-primary +
// overflow architecture and the active-state computation that
// drives the "More ▾" button styling.

import {
  partitionTabs,
  isActiveTabInOverflow,
  activeOverflowLabel,
  PRIMARY_ORDER,
  OVERFLOW_ORDER,
} from "../src/tabStrip.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== order constants ===");
{
  const primIds = PRIMARY_ORDER.map((t) => t.id);
  assert("PRIMARY_ORDER is exactly the 5 wiki-spec primaries in order",
    primIds.join(",") === "overview,flights,lodging,dining,activities");

  assert("PRIMARY_ORDER 'lodging' label displays as 'Hotels' (wiki rename)",
    PRIMARY_ORDER.find((t) => t.id === "lodging").label === "Hotels");

  const ofIds = OVERFLOW_ORDER.map((t) => t.id);
  assert("OVERFLOW_ORDER is exactly the 4 secondaries in order",
    ofIds.join(",") === "transport,category,providers,essentials");

  // Overview must never carry a count — the day-filter strip handles
  // day-level granularity below it.
  assert("overview has no count",
    PRIMARY_ORDER.find((t) => t.id === "overview").hasCount === false);
}

console.log("=== partitionTabs — full content build ===");
{
  const counts = { flights: 2, hotels: 1, transport: 3, dining: 12, activities: 7, essentials: 4 };
  const { primaries, overflow } = partitionTabs(counts, { showProviders: true });

  assert("5 primaries when every primary has content",
    primaries.length === 5);
  assert("primaries are in canonical order",
    primaries.map((t) => t.id).join(",") === "overview,flights,lodging,dining,activities");
  assert("Hotels label includes count from 'hotels' (the count key alias)",
    primaries.find((t) => t.id === "lodging").label === "Hotels · 1");
  assert("Dining label includes count",
    primaries.find((t) => t.id === "dining").label === "Dining · 12");
  assert("Activities label includes count",
    primaries.find((t) => t.id === "activities").label === "Activities · 7");
  assert("Overview label has no count appended",
    primaries.find((t) => t.id === "overview").label === "Overview");

  assert("4 overflow when transport > 0, essentials > 0, providers shown",
    overflow.length === 4);
  assert("overflow ordered: transport, category, providers, essentials",
    overflow.map((t) => t.id).join(",") === "transport,category,providers,essentials");
  assert("transport overflow label includes count",
    overflow.find((t) => t.id === "transport").label === "Transport · 3");
  assert("essentials overflow label includes count",
    overflow.find((t) => t.id === "essentials").label === "Essentials · 4");
  assert("by-category overflow label has no count",
    overflow.find((t) => t.id === "category").label === "By category");
  assert("local-providers overflow label has no count",
    overflow.find((t) => t.id === "providers").label === "Local providers");
}

console.log("=== partitionTabs — content gates ===");
{
  // No flights → flights primary disappears.
  const noFlights = partitionTabs(
    { flights: 0, hotels: 1, dining: 2, activities: 1, transport: 0, essentials: 0 },
    { showProviders: false },
  );
  assert("flights=0 removes flights from primaries",
    !noFlights.primaries.some((t) => t.id === "flights"));
  assert("flights=0 still keeps Overview + Hotels + Dining + Activities in primaries",
    noFlights.primaries.map((t) => t.id).join(",") === "overview,lodging,dining,activities");

  // Single-city trip with only the bare minimum.
  const minimal = partitionTabs(
    { flights: 0, hotels: 1, dining: 0, activities: 0, transport: 0, essentials: 0 },
    { showProviders: false },
  );
  assert("minimal trip (hotel only) has Overview + Hotels in primaries",
    minimal.primaries.map((t) => t.id).join(",") === "overview,lodging");
  // The legacy 'anyContent' gate for 'By category' fires as soon as ANY
  // content type is present, including hotel-only. Preserving the
  // existing behavior here — changing the gate would be a separate UX
  // decision out of scope for #11.
  assert("minimal trip overflow contains only 'category' (per legacy anyContent gate)",
    minimal.overflow.length === 1 && minimal.overflow[0].id === "category");

  // Transport > 0 but nothing else.
  const transportOnly = partitionTabs(
    { flights: 0, hotels: 0, dining: 0, activities: 0, transport: 4, essentials: 0 },
    { showProviders: false },
  );
  assert("transport-only trip surfaces transport in overflow",
    transportOnly.overflow.some((t) => t.id === "transport"));
  assert("transport-only trip surfaces 'category' in overflow (anyContent > 0)",
    transportOnly.overflow.some((t) => t.id === "category"));
}

console.log("=== partitionTabs — providers + category gating ===");
{
  // Local providers require showProviders even when content exists.
  const noProviders = partitionTabs(
    { flights: 1, hotels: 1, dining: 1, activities: 1, transport: 0, essentials: 0 },
    { showProviders: false },
  );
  assert("showProviders=false removes 'providers' from overflow",
    !noProviders.overflow.some((t) => t.id === "providers"));

  const withProviders = partitionTabs(
    { flights: 1, hotels: 1, dining: 1, activities: 1, transport: 0, essentials: 0 },
    { showProviders: true },
  );
  assert("showProviders=true surfaces 'providers' in overflow",
    withProviders.overflow.some((t) => t.id === "providers"));

  // 'category' tab requires anyContent > 0 (matches the legacy gate).
  const noContent = partitionTabs(
    { flights: 0, hotels: 0, dining: 0, activities: 0, transport: 0, essentials: 0 },
    { showProviders: false },
  );
  assert("no content at all removes 'category' from overflow",
    !noContent.overflow.some((t) => t.id === "category"));
  assert("no content at all leaves overflow empty",
    noContent.overflow.length === 0);
}

console.log("=== partitionTabs — defensive guards ===");
{
  // Bogus / missing inputs default to 0 / false and don't throw.
  const fromNull = partitionTabs(null, null);
  assert("null inputs return primaries=[Overview only]",
    fromNull.primaries.map((t) => t.id).join(",") === "overview");
  assert("null inputs return empty overflow",
    fromNull.overflow.length === 0);

  const fromUndefined = partitionTabs(undefined, undefined);
  assert("undefined inputs equivalent to null",
    fromUndefined.primaries.length === 1 && fromUndefined.overflow.length === 0);

  // String count gets coerced to a number; "garbage" → NaN → 0.
  const stringCounts = partitionTabs(
    { flights: "2", hotels: "bad", dining: "0", activities: "", transport: "", essentials: "" },
    { showProviders: false },
  );
  assert("numeric-string counts coerce ('2' flights → present)",
    stringCounts.primaries.some((t) => t.id === "flights"));
  assert("non-numeric strings coerce to 0 ('bad' hotels → absent)",
    !stringCounts.primaries.some((t) => t.id === "lodging"));
}

console.log("=== isActiveTabInOverflow + activeOverflowLabel ===");
{
  const partition = partitionTabs(
    { flights: 1, hotels: 1, transport: 2, dining: 1, activities: 1, essentials: 3 },
    { showProviders: true },
  );

  // Primary active → not in overflow.
  assert("active 'overview' is NOT in overflow",
    isActiveTabInOverflow("overview", partition) === false);
  assert("active 'flights' is NOT in overflow",
    isActiveTabInOverflow("flights", partition) === false);
  assert("active 'dining' is NOT in overflow",
    isActiveTabInOverflow("dining", partition) === false);

  // Overflow active → in overflow.
  assert("active 'transport' IS in overflow",
    isActiveTabInOverflow("transport", partition) === true);
  assert("active 'essentials' IS in overflow",
    isActiveTabInOverflow("essentials", partition) === true);
  assert("active 'category' IS in overflow",
    isActiveTabInOverflow("category", partition) === true);
  assert("active 'providers' IS in overflow",
    isActiveTabInOverflow("providers", partition) === true);

  // activeOverflowLabel returns the overflow tab's display label.
  assert("activeOverflowLabel returns 'Transport · 2' for active transport",
    activeOverflowLabel("transport", partition) === "Transport · 2");
  assert("activeOverflowLabel returns 'Essentials · 3' for active essentials",
    activeOverflowLabel("essentials", partition) === "Essentials · 3");
  assert("activeOverflowLabel returns null for a primary tab",
    activeOverflowLabel("overview", partition) === null);
  assert("activeOverflowLabel returns null for an unknown id",
    activeOverflowLabel("nonexistent", partition) === null);

  // Defensive: null / undefined inputs.
  assert("isActiveTabInOverflow with null partition returns false",
    isActiveTabInOverflow("transport", null) === false);
  assert("activeOverflowLabel with null partition returns null",
    activeOverflowLabel("transport", null) === null);
  assert("isActiveTabInOverflow with empty activeId returns false",
    isActiveTabInOverflow("", partition) === false);
  assert("isActiveTabInOverflow with null activeId returns false",
    isActiveTabInOverflow(null, partition) === false);
}

console.log("=== integration scenario — typical multi-city flagship trip ===");
{
  // Maritimes-style trip: dense content across the board.
  const counts = { flights: 4, hotels: 6, transport: 12, dining: 18, activities: 20, essentials: 5 };
  const partition = partitionTabs(counts, { showProviders: true });

  // 5 always-on primaries.
  assert("flagship: 5 primaries",
    partition.primaries.length === 5);

  // 4 overflow tabs.
  assert("flagship: 4 overflow tabs",
    partition.overflow.length === 4);

  // The Hotels label shows the count from the 'hotels' key but the id stays 'lodging'.
  const hotelsTab = partition.primaries.find((t) => t.id === "lodging");
  assert("flagship: Hotels tab label is 'Hotels · 6'",
    hotelsTab && hotelsTab.label === "Hotels · 6");

  // Active state ergonomics: tapping a category tab puts the More button into active styling.
  assert("flagship: when 'category' is active, the More button should glow",
    isActiveTabInOverflow("category", partition) === true);
  assert("flagship: when 'category' is active, More can display 'By category' as its label",
    activeOverflowLabel("category", partition) === "By category");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
