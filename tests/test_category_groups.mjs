// Tests for src/categoryGroups.js — the shared "By category" grouping
// helper used by both the on-screen tab and the PDF section. Repo
// convention: custom assert, prints "N passed, M failed", exits non-zero
// on failure. Auto-discovered by tests/run-all.mjs.

import {
  groupItemsByCategory,
  classifyItemCategory,
  CATEGORY_ORDER,
} from "../src/categoryGroups.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// A small plan exercising every category, multiple days, an unmatched
// item, and a hotel repeated across nights (should de-dupe).
const plan = {
  days: [
    {
      label: "Day 1 · Thu Jun 4 · Arrive",
      items: [
        { type: "Flight", time: "08:45", flight: { carrier: "United", flight_number: "UA1" } },
        { type: "Transport", time: "12:00", text: "Rental car pickup" },
        { type: "Hotel", time: "15:00", hotel: { name: "Hotel Alpha", address: "1 Main St" } },
        { type: "Dinner", time: "19:30", restaurant: { name: "Cafe Uno" } },
        { type: "Note", time: "21:00", text: "Free time" }, // unmatched
      ],
    },
    {
      label: "Day 2 · Fri Jun 5 · Explore",
      items: [
        { type: "Activity", time: "09:00", text: "Museum tour" },
        { type: "Hotel", time: "15:00", hotel: { name: "Hotel Alpha", address: "1 Main St" } }, // dup
        { type: "Lunch", time: "13:00", restaurant: { name: "Bistro Due" } },
        { type: "Activity", time: "08:00", text: "Sunrise hike" }, // earlier — ordering check
      ],
    },
  ],
};

const groups = groupItemsByCategory(plan);
const byId = Object.fromEntries(groups.map((g) => [g.category, g]));

console.log("=== classifyItemCategory: bucketing by type ===");
assert("Flight + flight -> flights", classifyItemCategory({ type: "Flight", flight: {} }) === "flights");
assert("Hotel + hotel -> lodging", classifyItemCategory({ type: "Hotel", hotel: {} }) === "lodging");
assert("Transport -> transport", classifyItemCategory({ type: "Transport" }) === "transport");
assert("Activity -> activities", classifyItemCategory({ type: "Activity" }) === "activities");
assert("Dinner + restaurant -> dining", classifyItemCategory({ type: "Dinner", restaurant: {} }) === "dining");
assert("Breakfast + restaurant -> dining", classifyItemCategory({ type: "Breakfast", restaurant: {} }) === "dining");
assert("Flight without flight obj -> null", classifyItemCategory({ type: "Flight" }) === null);
assert("Hotel without hotel obj -> null", classifyItemCategory({ type: "Hotel" }) === null);
assert("Dinner without restaurant -> null", classifyItemCategory({ type: "Dinner" }) === null);
assert("unknown type -> null", classifyItemCategory({ type: "Note", text: "x" }) === null);
assert("null item -> null", classifyItemCategory(null) === null);

console.log("=== groupItemsByCategory: presence + counts ===");
assert("flights group has 1 item", byId.flights?.items.length === 1, JSON.stringify(byId.flights?.items.length));
assert("lodging group has 1 item (deduped)", byId.lodging?.items.length === 1, JSON.stringify(byId.lodging?.items.length));
assert("transport group has 1 item", byId.transport?.items.length === 1);
assert("activities group has 2 items", byId.activities?.items.length === 2);
assert("dining group has 2 items", byId.dining?.items.length === 2);

console.log("=== empty-category omission ===");
const flightsOnly = groupItemsByCategory({ days: [{ label: "D1", items: [{ type: "Flight", flight: {} }] }] });
assert("only non-empty categories returned", flightsOnly.length === 1 && flightsOnly[0].category === "flights");
assert("empty plan -> []", groupItemsByCategory({ days: [] }).length === 0);
assert("missing days -> []", groupItemsByCategory({}).length === 0);
assert("null plan -> []", groupItemsByCategory(null).length === 0);
assert("unmatched-only day -> []", groupItemsByCategory({ days: [{ items: [{ type: "Note" }] }] }).length === 0);

console.log("=== ordering: categories follow CATEGORY_ORDER ===");
const order = groups.map((g) => g.category);
const expectedOrder = CATEGORY_ORDER.map((c) => c.id).filter((id) => order.includes(id));
assert("group order matches CATEGORY_ORDER", JSON.stringify(order) === JSON.stringify(expectedOrder), JSON.stringify(order));
assert("flights before dining", order.indexOf("flights") < order.indexOf("dining"));
assert("activities before dining", order.indexOf("activities") < order.indexOf("dining"));

console.log("=== ordering: within group chronological (day then time) ===");
const acts = byId.activities.items;
assert("activities sorted: earlier time first within day", acts[0].time === "08:00" && acts[1].time === "09:00", JSON.stringify(acts.map((a) => a.time)));

console.log("=== day/time attribution ===");
const flight = byId.flights.items[0];
assert("flight carries dayIndex 0", flight.dayIndex === 0);
assert("flight carries dayLabel", flight.dayLabel === "Day 1 · Thu Jun 4 · Arrive", flight.dayLabel);
assert("flight carries raw time", flight.time === "08:45", flight.time);
assert("activity dayIndex is 1 (day 2)", acts[0].dayIndex === 1);
assert("dining item carries restaurant ref", byId.dining.items[0].item.restaurant?.name === "Cafe Uno");

console.log("=== honesty: helper carries items verbatim, no fabrication ===");
assert("flight object passed through unchanged", flight.item.flight.carrier === "United");
const allOut = groups.flatMap((g) => g.items.length);
assert("total grouped items = 7 (8 matches minus 1 deduped hotel)", allOut.reduce((a, b) => a + b, 0) === 7, JSON.stringify(allOut));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
