// Tests for extractPrimaryHotel / extractRestaurantNames / extractActivityNames
// in src/App.jsx — the functions that feed /api/review-retrieve's
// hotel_name/restaurants/activities params, which in turn drive the Expert
// Review's live Perplexity/Reddit grounding queries.
//
// Found 2026-08-03 auditing the same "item.name doesn't exist on
// DAY_ITEM_SCHEMA" bug class as placesVerify.js's collectPlanVenues (see
// docs/wiki/learnings/2026-08-03.md): all three functions read item.name
// (Activity/meal items) or item.name instead of item.hotel.name (Hotel
// items) — fields that are always undefined on a real plan — so every
// Expert Review that has ever run received hotel_name: null,
// restaurants: [], activities: [] and its live-retrieval step degraded to
// generic destination-only search queries, never anything about the
// specific venues in the plan being reviewed.
//
// applyQualityLayer's three extractors are closures inside src/App.jsx and
// can't be imported directly here (jsdom-free tests) — following the
// convention in tests/test_day_completeness_and_city_normalization.mjs,
// each is mirrored locally and tested against that mirror. Keep these
// mirrors in sync if the App.jsx implementations change shape.

import { activityName } from "../src/placesVerify.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function extractPrimaryHotel(plan) {
  if (!plan?.days) return null;
  for (const day of plan.days) {
    if (!Array.isArray(day?.items)) continue;
    for (const item of day.items) {
      if (item?.type === "Hotel" && item.hotel?.name) return String(item.hotel.name);
    }
  }
  return null;
}

function extractRestaurantNames(plan, limit = 6) {
  if (!plan?.days) return [];
  const out = [];
  const seen = new Set();
  const restaurantTypes = new Set(["Breakfast", "Brunch", "Lunch", "Dinner", "Dining"]);
  for (const day of plan.days) {
    if (!Array.isArray(day?.items)) continue;
    for (const item of day.items) {
      if (!restaurantTypes.has(item?.type)) continue;
      const name = String(item?.restaurant?.name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function extractActivityNames(plan, limit = 4) {
  if (!plan?.days) return [];
  const out = [];
  const seen = new Set();
  for (const day of plan.days) {
    if (!Array.isArray(day?.items)) continue;
    for (const item of day.items) {
      if (item?.type !== "Activity") continue;
      const name = activityName(item?.text);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const PLAN = {
  destination: "Sedona, AZ",
  days: [
    {
      items: [
        { type: "Hotel", time: "15:00", text: "Check in", hotel: { name: "Residence Inn Sedona" } },
        { type: "Dinner", time: "19:00", text: "Dinner", restaurant: { name: "Mariposa" } },
      ],
    },
    {
      items: [
        { type: "Activity", time: "07:30", text: "Bell Rock Pathway — easy 1-mile interpretive loop" },
        { type: "Activity", time: "13:00", text: "Pink Jeep Broken Arrow backcountry tour" },
        { type: "Dinner", time: "18:30", text: "Dinner", restaurant: { name: "Elote Cafe" } },
      ],
    },
  ],
};

console.log("\nextractPrimaryHotel\n");
assert("finds the real hotel name via item.hotel.name (was: item.name, always undefined)",
  extractPrimaryHotel(PLAN) === "Residence Inn Sedona");
assert("returns null when there's no Hotel item", extractPrimaryHotel({ days: [{ items: [] }] }) === null);
assert("returns null for a plan with no days", extractPrimaryHotel({}) === null);

console.log("\nextractRestaurantNames\n");
{
  const names = extractRestaurantNames(PLAN);
  assert("finds both real restaurant names via item.restaurant.name (was: item.name, always undefined)",
    names.includes("Mariposa") && names.includes("Elote Cafe"), JSON.stringify(names));
  assert("returns them in day order", names[0] === "Mariposa" && names[1] === "Elote Cafe", JSON.stringify(names));
}

console.log("\nextractActivityNames\n");
{
  const names = extractActivityNames(PLAN);
  assert("finds both activities, name-only (not the full descriptive text)",
    names.includes("Bell Rock Pathway") && names.includes("Pink Jeep Broken Arrow backcountry tour"),
    JSON.stringify(names));
  assert("does NOT include the full sentence for the dashed entry (bad search query otherwise)",
    !names.some(n => n.includes("easy 1-mile interpretive loop")), JSON.stringify(names));
}

function itemDisplayName(item) {
  if (item?.restaurant?.name) return String(item.restaurant.name).trim();
  if (item?.hotel?.name) return String(item.hotel.name).trim();
  if (item?.type === "Activity") return activityName(item?.text);
  return "";
}

console.log("\nitemDisplayName (chunk-mode wrapper-pass summary)\n");
assert("restaurant item resolves to the restaurant's name",
  itemDisplayName({ type: "Dinner", restaurant: { name: "Elote Cafe" } }) === "Elote Cafe");
assert("hotel item resolves to the hotel's name",
  itemDisplayName({ type: "Hotel", hotel: { name: "Residence Inn Sedona" } }) === "Residence Inn Sedona");
assert("activity item resolves to the clean name, not the full descriptive text",
  itemDisplayName({ type: "Activity", text: "Bell Rock Pathway — easy 1-mile interpretive loop" }) === "Bell Rock Pathway");
assert("a Note/Transport item with no restaurant/hotel and non-Activity type resolves to empty",
  itemDisplayName({ type: "Note", text: "Return to hotel" }) === "");

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
