// Unit tests for the "Find another restaurant / activity" swap helpers.
// These are pure functions in src/swapAlternatives.js (no network), so we
// import them directly rather than eval-extracting from App.jsx.

import {
  activityHeadName,
  itemVenueName,
  selectAlternatives,
  buildSwapItem,
  findRawItemIndex,
  resolveLegCity,
} from "../src/swapAlternatives.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== activityHeadName ===");
assert("splits on em-dash", activityHeadName("Loretto Chapel — see the staircase") === "Loretto Chapel");
assert("no dash returns whole", activityHeadName("Plaza walk") === "Plaza walk");
assert("non-string is empty", activityHeadName(null) === "");

console.log("\n=== itemVenueName ===");
assert("restaurant name lowercased", itemVenueName({ restaurant: { name: "Geronimo" } }, "restaurant") === "geronimo");
assert("activity head lowercased", itemVenueName({ text: "Vatican Museums — early entry" }, "activity") === "vatican museums");
assert("missing restaurant is empty", itemVenueName({}, "restaurant") === "");

console.log("\n=== selectAlternatives (restaurants) ===");
{
  const pool = [
    { name: "Geronimo", cuisine: "Contemporary" },   // current — excluded
    { name: "Coyote Cafe", cuisine: "Southwestern" },
    { name: "Sazon", cuisine: "Modern Mexican" },
    { name: "La Boca", cuisine: "Spanish" },          // same-day — excluded
    { name: "The Shed", cuisine: "New Mexican" },
    { name: "Coyote Cafe", cuisine: "dup" },          // duplicate — excluded
  ];
  const picks = selectAlternatives(pool, {
    currentItem: { restaurant: { name: "Geronimo" } },
    sameDayItems: [
      { restaurant: { name: "Geronimo" } },
      { restaurant: { name: "La Boca" } },
    ],
    kind: "restaurant",
    max: 3,
  });
  assert("caps at 3", picks.length === 3);
  assert("excludes current (Geronimo)", !picks.some(p => p.name === "Geronimo"));
  assert("excludes same-day (La Boca)", !picks.some(p => p.name === "La Boca"));
  assert("de-dupes Coyote Cafe", picks.filter(p => p.name === "Coyote Cafe").length === 1);
  assert("keeps order", picks[0].name === "Coyote Cafe" && picks[1].name === "Sazon" && picks[2].name === "The Shed");
}

console.log("\n=== selectAlternatives (activities, fewer than 3) ===");
{
  const pool = [
    { text: "Loretto Chapel — staircase" }, // current
    { text: "Meow Wolf — immersive art" },
  ];
  const picks = selectAlternatives(pool, {
    currentItem: { text: "Loretto Chapel — staircase" },
    sameDayItems: [],
    kind: "activity",
    max: 3,
  });
  assert("returns the 1 real alternative (no padding)", picks.length === 1);
  assert("it's Meow Wolf", activityHeadName(picks[0].text) === "Meow Wolf");
}

console.log("\n=== selectAlternatives defensive ===");
assert("non-array pool → []", Array.isArray(selectAlternatives(null, { kind: "restaurant" })) && selectAlternatives(null, { kind: "restaurant" }).length === 0);

console.log("\n=== selectAlternatives excludes closed candidates ===");
{
  const pool = [
    { name: "Closed One", verify_status: "permanently_closed" },
    { name: "Closed Alias", verify_status: "closed_permanently" },
    { name: "Gone", verify_status: "not_found" },
    { name: "Verify Me", verify_status: "verify_before_booking" }, // allowed
    { name: "Open Spot", verify_status: "" },
  ];
  const picks = selectAlternatives(pool, { kind: "restaurant", max: 5 });
  assert("drops permanently_closed", !picks.some(p => p.name === "Closed One"));
  assert("drops closed_permanently alias", !picks.some(p => p.name === "Closed Alias"));
  assert("drops not_found", !picks.some(p => p.name === "Gone"));
  assert("keeps verify_before_booking", picks.some(p => p.name === "Verify Me"));
  assert("keeps open", picks.some(p => p.name === "Open Spot"));
  assert("only the 2 operating survive", picks.length === 2);
}

console.log("\n=== buildSwapItem (restaurant) ===");
{
  const original = { type: "Dinner", time: "19:30", end_time: "21:00", restaurant: { name: "Geronimo", backup: { name: "Old Backup" } } };
  const chosen = {
    name: "Coyote Cafe", cuisine: "Southwestern", neighborhood: "Plaza", price_range: "$$$",
    why: "Rooftop cantina", contact: { phone: "505-555-1234" }, reservation: { platform: "opentable" },
    verify_status: "verify_before_booking", verify_url: "https://google.com/search?q=Coyote+Cafe",
  };
  const item = buildSwapItem(original, chosen, "restaurant");
  assert("keeps meal type", item.type === "Dinner");
  assert("keeps time", item.time === "19:30" && item.end_time === "21:00");
  assert("new restaurant name", item.restaurant.name === "Coyote Cafe");
  assert("carries cuisine/neighborhood", item.restaurant.cuisine === "Southwestern" && item.restaurant.neighborhood === "Plaza");
  assert("carries verify_status through", item.restaurant.verify_status === "verify_before_booking");
  assert("carries verify_url through", item.restaurant.verify_url === chosen.verify_url);
  assert("drops old backup", item.restaurant.backup === undefined);
  assert("not marked confirmed", item.restaurant._bookingConfirmed === undefined && item.restaurant._verified === undefined);
}

console.log("\n=== buildSwapItem (activity) ===");
{
  const original = { type: "Activity", time: "10:00", end_time: "12:00", text: "Old thing — gone", why: "stale", contact: { phone: "old" }, location: "old loc", duration: "1h" };
  const chosen = { text: "Meow Wolf — immersive art", type: "Cultural", duration: "2 hours", location: "Midtown", why: "Wild installation", contact: { website: "https://meowwolf.com" } };
  const item = buildSwapItem(original, chosen, "activity");
  assert("type forced to Activity (rich render)", item.type === "Activity");
  assert("keeps time", item.time === "10:00" && item.end_time === "12:00");
  assert("new text", item.text === "Meow Wolf — immersive art");
  assert("new why replaces stale", item.why === "Wild installation");
  assert("new location replaces stale", item.location === "Midtown");
  assert("new duration replaces stale", item.duration === "2 hours");
  assert("new contact replaces stale", item.contact && item.contact.website === "https://meowwolf.com" && item.contact.phone === undefined);
}

console.log("\n=== buildSwapItem (activity, sparse alternative clears stale fields) ===");
{
  const original = { type: "Activity", time: "10:00", text: "Old — x", location: "old", duration: "1h", contact: { phone: "old" }, why: "old why" };
  const chosen = { text: "Plaza stroll" }; // no location/duration/contact
  const item = buildSwapItem(original, chosen, "activity");
  assert("location cleared", item.location === undefined);
  assert("duration cleared", item.duration === undefined);
  assert("contact cleared", item.contact === undefined);
  assert("why blanked", item.why === "");
}

console.log("\n=== buildSwapItem strips stale provenance/coords/flags (restaurant) ===");
{
  const original = {
    type: "Dinner", time: "19:30", restaurant: { name: "Geronimo" },
    _verified: true, place_id: "OLD_PID", lat: 35.6, lng: -105.9,
    flags: [{ code: "OUTSIDE_HOURS", severity: "warn" }],
  };
  const chosen = { name: "Coyote Cafe", lat: 35.0, lng: -106.0, verify_status: "verify_before_booking" };
  const item = buildSwapItem(original, chosen, "restaurant");
  assert("strips old _verified", item._verified === undefined);
  assert("strips old place_id", item.place_id === undefined);
  assert("strips old flags", item.flags === undefined);
  assert("carries NEW coords (not old)", item.lat === 35.0 && item.lng === -106.0);
  assert("verify_status carried on restaurant", item.restaurant.verify_status === "verify_before_booking");
}

console.log("\n=== buildSwapItem strips stale provenance/coords/flags (activity) ===");
{
  const original = {
    type: "Activity", time: "10:00", text: "Old — gone",
    _verified: true, place_id: "OLD_PID", lat: 35.6, lng: -105.9,
    flags: [{ code: "PACING_CONFLICT", severity: "warn" }],
  };
  const chosen = { text: "Meow Wolf — art" }; // no coords
  const item = buildSwapItem(original, chosen, "activity");
  assert("strips old _verified", item._verified === undefined);
  assert("strips old place_id", item.place_id === undefined);
  assert("strips old flags", item.flags === undefined);
  assert("clears old coords when none on alt", item.lat === undefined && item.lng === undefined);
}

console.log("\n=== findRawItemIndex ===");
{
  const rawPlan = {
    days: [
      {
        items: [
          { type: "Activity", text: "Plaza walk — morning" },
          { type: "Lunch", restaurant: { name: "Cafe Pasqual's" } },
          { type: "Dinner", time: "19:30", restaurant: { name: "Geronimo" } },
        ],
      },
    ],
  };
  // Rendered (quality-layered) item may have lost the Lunch item; index differs.
  const renderedDinner = { type: "Dinner", time: "19:30", restaurant: { name: "Geronimo", _isReturnVisit: true } };
  assert("restaurant matched by name in raw plan (idx 2)", findRawItemIndex(rawPlan, 0, renderedDinner, "restaurant") === 2);
  const renderedActivity = { type: "Activity", text: "Plaza walk — morning" };
  assert("activity matched (idx 0)", findRawItemIndex(rawPlan, 0, renderedActivity, "activity") === 0);
  assert("no match → -1", findRawItemIndex(rawPlan, 0, { restaurant: { name: "Nowhere" } }, "restaurant") === -1);
  assert("bad day → -1", findRawItemIndex(rawPlan, 9, renderedActivity, "activity") === -1);
}

console.log("\n=== findRawItemIndex resolves quality-layer-renamed backup ===");
{
  // The closure gate promoted "Coyote Cafe" (the backup) over closed "Geronimo",
  // so the rendered card shows "Coyote Cafe" — which has NO primary-name match
  // in the raw plan. Must still resolve via the backup slot (+time).
  const rawPlan = { days: [{ items: [
    { type: "Activity", text: "Plaza walk — morning" },
    { type: "Dinner", time: "19:30", restaurant: { name: "Geronimo", backup: { name: "Coyote Cafe" } } },
  ] }] };
  const renderedPromoted = { type: "Dinner", time: "19:30", restaurant: { name: "Coyote Cafe" } };
  assert("matches via backup name (idx 1)", findRawItemIndex(rawPlan, 0, renderedPromoted, "restaurant") === 1);
}

console.log("\n=== findRawItemIndex falls back to unique time when name changed ===");
{
  // Name changed and no backup slot carries it, but the scheduled time is
  // unique within the kind — resolve positionally by time rather than no-op.
  const rawPlan = { days: [{ items: [
    { type: "Activity", text: "Plaza walk — morning" },
    { type: "Dinner", time: "19:30", restaurant: { name: "Geronimo" } },
  ] }] };
  const renamed = { type: "Dinner", time: "19:30", restaurant: { name: "Totally Different" } };
  assert("matches by unique time (idx 1)", findRawItemIndex(rawPlan, 0, renamed, "restaurant") === 1);
}

console.log("\n=== findRawItemIndex refuses ambiguous time match (handled error path) ===");
{
  // Two same-kind restaurants share the time and neither name nor backup
  // matches the renamed card — refuse rather than guess, so handleSwapItem
  // surfaces an honest error instead of swapping the wrong slot.
  const rawPlan = { days: [{ items: [
    { type: "Dinner", time: "19:30", restaurant: { name: "Alpha" } },
    { type: "Dinner", time: "19:30", restaurant: { name: "Beta" } },
  ] }] };
  const renamed = { type: "Dinner", time: "19:30", restaurant: { name: "Renamed Backup" } };
  assert("ambiguous time → -1 (handled error)", findRawItemIndex(rawPlan, 0, renamed, "restaurant") === -1);
}

console.log("\n=== findRawItemIndex disambiguates by time ===");
{
  const rawPlan = { days: [{ items: [
    { type: "Dinner", time: "12:30", restaurant: { name: "Same Spot" } },
    { type: "Dinner", time: "19:30", restaurant: { name: "Same Spot" } },
  ] }] };
  assert("matches the 19:30 instance", findRawItemIndex(rawPlan, 0, { type: "Dinner", time: "19:30", restaurant: { name: "Same Spot" } }, "restaurant") === 1);
}

console.log("\n=== replace_item integration (index from findRawItemIndex) ===");
{
  // Mirror applyPatchesToPlan's replace_item behavior to prove the resolved
  // index targets the right slot (applyPatchesToPlan itself is tested
  // separately in test_apply_patches.mjs).
  const rawPlan = { days: [{ items: [
    { type: "Activity", text: "Plaza walk — morning" },
    { type: "Dinner", time: "19:30", restaurant: { name: "Geronimo" } },
  ] }] };
  const idx = findRawItemIndex(rawPlan, 0, { type: "Dinner", time: "19:30", restaurant: { name: "Geronimo" } }, "restaurant");
  const newItem = buildSwapItem(rawPlan.days[0].items[idx], { name: "Coyote Cafe" }, "restaurant");
  assert("idx is 1", idx === 1);
  assert("new_item is restaurant Coyote Cafe", newItem.restaurant.name === "Coyote Cafe");
  assert("untouched activity still at 0", rawPlan.days[0].items[0].text === "Plaza walk — morning");
}

console.log("\n=== resolveLegCity ===");
{
  const plan = { destination: "Santa Fe", days: [
    { city: "Santa Fe" },
    { city: "Santa Fe → Taos" },
    {},
  ], cities: [{ name: "Santa Fe" }, { name: "Taos" }] };
  assert("single-city day", resolveLegCity(plan, 0, ["Santa Fe", "Taos"]) === "Santa Fe");
  assert("transit day uses destination end", resolveLegCity(plan, 1, ["Santa Fe", "Taos"]) === "Taos");
  assert("no day.city falls back to first leg", resolveLegCity(plan, 2, ["Santa Fe", "Taos"]) === "Santa Fe");
  assert("no legs falls back to destination", resolveLegCity({ destination: "Rome", days: [{}] }, 0, []) === "Rome");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
