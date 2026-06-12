// Unit tests for collectPlanRestaurants and mergeBookingConfirmations.
// These live inside src/App.jsx (not exported), so we extract them via a
// regex and eval() into the test scope. Same pattern as the existing
// /tmp/test_findview_helpers.mjs.

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf-8");

// Extract collectPlanRestaurants
const collectMatch = src.match(/function collectPlanRestaurants\(plan\) \{[\s\S]*?\n\}/);
if (!collectMatch) throw new Error("collectPlanRestaurants not found");
// Extract mergeBookingConfirmations
const mergeMatch = src.match(/function mergeBookingConfirmations\(plan, confirmations\) \{[\s\S]*?\n\}/);
if (!mergeMatch) throw new Error("mergeBookingConfirmations not found");

// eslint-disable-next-line no-eval
eval(`${collectMatch[0]}; globalThis.collectPlanRestaurants = collectPlanRestaurants;`);
// eslint-disable-next-line no-eval
eval(`${mergeMatch[0]}; globalThis.mergeBookingConfirmations = mergeBookingConfirmations;`);

const { collectPlanRestaurants, mergeBookingConfirmations } = globalThis;

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// ============================================================
// collectPlanRestaurants
// ============================================================
console.log("\n[A] collectPlanRestaurants");
{
  const plan = {
    destination: "Santa Fe",
    days: [
      { items: [
        { type: "Dinner", restaurant: { name: "Geronimo", neighborhood: "Canyon Road", backup: { name: "The Compound" } } },
        { type: "Activity", text: "Walk Canyon Road" },
      ] },
      { items: [
        { type: "Lunch", restaurant: { name: "Coyote Cafe" } },
        { type: "Dinner", restaurant: { name: "Geronimo" } }, // duplicate
      ] },
    ],
  };
  const out = collectPlanRestaurants(plan);
  const names = out.map(r => r.name);
  assert("collects all unique restaurants", out.length === 3, `got ${out.length}: ${names.join(",")}`);
  assert("includes backup", names.includes("The Compound"));
  assert("dedupes Geronimo", names.filter(n => n === "Geronimo").length === 1);
  assert("city hint set", out[0].city === "Santa Fe");
  assert("neighborhood preserved", out.find(r => r.name === "Geronimo")?.neighborhood === "Canyon Road");
}

console.log("\n[B] collectPlanRestaurants — null safety");
{
  assert("null plan → []", collectPlanRestaurants(null).length === 0);
  assert("no days → []", collectPlanRestaurants({}).length === 0);
  assert("empty days → []", collectPlanRestaurants({ days: [] }).length === 0);
  assert("day with no items", collectPlanRestaurants({ days: [{}] }).length === 0);
  assert("item with no restaurant", collectPlanRestaurants({ days: [{ items: [{ type: "Activity" }] }] }).length === 0);
  assert("restaurant with no name", collectPlanRestaurants({ days: [{ items: [{ restaurant: { neighborhood: "x" } }] }] }).length === 0);
}

// ============================================================
// mergeBookingConfirmations
// ============================================================
console.log("\n[C] mergeBookingConfirmations — happy path");
{
  const plan = {
    days: [{ items: [
      { type: "Dinner", restaurant: {
        name: "Geronimo",
        reservation: { platform: "opentable", url: "https://www.opentable.com/wrong" },
        contact: { phone: "(505) 982-1500" },
      } },
    ] }],
  };
  const confs = [{
    name: "Geronimo",
    platform: "phone",
    url: "(505) 982-1500",
    website: "https://geronimorestaurant.com",
    confidence: "high",
  }];
  const next = mergeBookingConfirmations(plan, confs);
  const r = next.days[0].items[0].restaurant;
  assert("platform overwritten", r.reservation.platform === "phone");
  assert("url overwritten", r.reservation.url === "(505) 982-1500");
  assert("website filled in", r.contact.website === "https://geronimorestaurant.com");
  assert("existing phone preserved", r.contact.phone === "(505) 982-1500");
  assert("flag set", r._bookingConfirmed === true);
  assert("immutable — original plan untouched", plan.days[0].items[0].restaurant.reservation.platform === "opentable");
}

console.log("\n[D] mergeBookingConfirmations — walk-in clears url");
{
  const plan = { days: [{ items: [
    { type: "Lunch", restaurant: { name: "Shake Shack", reservation: { platform: "opentable", url: "https://wrong" } } },
  ] }] };
  const confs = [{ name: "Shake Shack", platform: "walkin", url: null, website: "https://shake.com", confidence: "high" }];
  const next = mergeBookingConfirmations(plan, confs);
  const r = next.days[0].items[0].restaurant;
  assert("walkin platform", r.reservation.platform === "walkin");
  assert("url cleared", !r.reservation.url);
}

console.log("\n[E] mergeBookingConfirmations — unknown skipped");
{
  const plan = { days: [{ items: [
    { type: "Dinner", restaurant: { name: "Mystery", reservation: { platform: "opentable", url: "https://existing" } } },
  ] }] };
  const confs = [{ name: "Mystery", platform: "unknown", url: null, website: null, confidence: "low" }];
  const next = mergeBookingConfirmations(plan, confs);
  const r = next.days[0].items[0].restaurant;
  assert("unknown leaves platform untouched", r.reservation.platform === "opentable");
  assert("unknown leaves url untouched", r.reservation.url === "https://existing");
  assert("no _bookingConfirmed flag", !r._bookingConfirmed);
}

console.log("\n[F] mergeBookingConfirmations — backup gets merged too");
{
  const plan = { days: [{ items: [
    { type: "Dinner", restaurant: {
      name: "Main",
      reservation: { platform: "opentable" },
      backup: { name: "Backup Spot", reservation: { platform: "opentable" } },
    } },
  ] }] };
  const confs = [
    { name: "Main", platform: "resy", url: "https://resy.com/main", website: "", confidence: "high" },
    { name: "Backup Spot", platform: "tock", url: "https://exploretock.com/backup", website: "", confidence: "high" },
  ];
  const next = mergeBookingConfirmations(plan, confs);
  const r = next.days[0].items[0].restaurant;
  assert("main platform resy", r.reservation.platform === "resy");
  assert("backup platform tock", r.backup.reservation.platform === "tock");
  assert("backup url set", r.backup.reservation.url === "https://exploretock.com/backup");
}

console.log("\n[G] mergeBookingConfirmations — case-insensitive name match");
{
  const plan = { days: [{ items: [
    { type: "Dinner", restaurant: { name: "  The Compound  ", reservation: { platform: "opentable" } } },
  ] }] };
  const confs = [{ name: "the compound", platform: "resy", url: "https://resy.com/x", website: "", confidence: "high" }];
  const next = mergeBookingConfirmations(plan, confs);
  assert("matched case-insensitively", next.days[0].items[0].restaurant.reservation.platform === "resy");
}

console.log("\n[H] mergeBookingConfirmations — preserves existing website if model supplied one");
{
  const plan = { days: [{ items: [
    { type: "Dinner", restaurant: {
      name: "Has Website",
      reservation: { platform: "opentable" },
      contact: { website: "https://model-supplied.com" },
    } },
  ] }] };
  const confs = [{ name: "Has Website", platform: "resy", url: "https://resy.com/x", website: "https://sonar-supplied.com", confidence: "high" }];
  const next = mergeBookingConfirmations(plan, confs);
  assert("model's website wins", next.days[0].items[0].restaurant.contact.website === "https://model-supplied.com");
}

console.log("\n[I] mergeBookingConfirmations — null/empty safety");
{
  assert("null plan", mergeBookingConfirmations(null, []) === null);
  assert("empty confs returns same plan", mergeBookingConfirmations({ days: [] }, []).days.length === 0);
  assert("plan with no matching confirmations returns same shape",
    mergeBookingConfirmations({ days: [{ items: [{ restaurant: { name: "X", reservation: { platform: "opentable" } } }] }] }, [{ name: "Y", platform: "resy" }])
      .days[0].items[0].restaurant.reservation.platform === "opentable");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
