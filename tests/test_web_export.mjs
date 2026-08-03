// Regression test for src/webExport.js, which had NO test coverage at all
// before this — the exact reason five separate field-name bugs (item.name,
// item.address/phone/website/notes, day.date/title/theme, and data.introduction
// treated as a string) shipped and stayed silently broken: nothing exercised
// buildWebApp() against a plan shaped like a real one. Found 2026-08-03
// auditing the same "item.name doesn't exist" bug class as placesVerify.js's
// collectPlanVenues (see tests/test_itinerary_quality_fixes.mjs and
// docs/wiki/learnings/2026-08-03.md).
//
// Uses one realistic plan fixture, matching DAY_SCHEMA/DAY_ITEM_SCHEMA/
// RESTAURANT_SCHEMA/HOTEL_ITEM_SCHEMA/FLIGHT_SCHEMA field names exactly (see
// src/App.jsx), and asserts the real venue names/addresses/etc. actually
// appear in the rendered HTML — not just that the function doesn't throw.

import { buildWebApp } from "../src/webExport.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const PLAN = {
  destination: "Sedona, AZ",
  meta: "Aug 25 – 28, 2027",
  introduction: {
    arc: "Four days moving from red-rock trails to backcountry jeep tracks, anchored by two dinners worth building a day around.",
    differentiators: "The Pink Jeep Broken Arrow tour and the Elote Cafe waitlist ritual are the two things a first-timer wouldn't find without local knowledge.",
  },
  logistics: ["EWR-PHX nonstop", "Residence Inn Sedona", "Hertz rental"],
  days: [
    {
      label: "Day 1 · Wed Aug 25 · Arrive Sedona",
      city: "Sedona, AZ",
      headline: "Settle in and watch the light change on the red rocks",
      weather: "High 88°F / low 60°F · clear",
      items: [
        {
          type: "Flight", time: "08:45", text: "Fly to Phoenix",
          flight: { carrier: "American", flight_number: "AA 1234", from_airport: "EWR", to_airport: "PHX", depart_time: "08:45", arrive_time: "11:20", nonstop: true },
        },
        {
          type: "Hotel", time: "15:00", text: "Check in",
          hotel: { name: "Residence Inn Sedona", address: "90 Ridge Trail Dr, Sedona, AZ 86351", phone: "+1-928-284-5484", website: "https://www.marriott.com/sedona", confirmation_note: "Ask for a canyon-view room" },
        },
      ],
    },
    {
      label: "Day 3 · Fri Aug 27 · Bell Rock & Pink-Jeep backcountry",
      city: "Sedona, AZ",
      headline: "Pink Jeep off-road tour — broken-arrow trail at midday",
      weather: "High 80°F / low 52°F · clear skies",
      items: [
        {
          type: "Activity", time: "07:30", end_time: "09:00",
          text: "Bell Rock Pathway — easy 1-mile interpretive loop (marquee sight, morning light)",
          location: "Bell Rock Pathway Trailhead, AZ-179, Sedona, AZ 86351",
          why: "The most photographed formation in Sedona.",
          contact: { phone: "+1-928-203-2900", website: "https://www.fs.usda.gov/recarea/coconino", price: "$5 Red Rock Pass" },
        },
        {
          type: "Activity", time: "13:00",
          text: "Pink Jeep Broken Arrow backcountry tour",
          location: "Pink Jeep Tours, 204 N AZ-89A, Sedona, AZ 86336",
          why: "The signature Sedona experience — a real off-road vehicle over slickrock.",
          contact: { phone: "+1-928-282-5000", website: "https://www.pinkjeep.com", price: "$149/adult" },
        },
        {
          type: "Dinner", time: "18:30",
          text: "Dinner",
          restaurant: {
            name: "Elote Cafe", cuisine: "Mexican (Mexico City-inspired)", why: "Arrive by 6:30 PM to join the no-reservations waitlist.",
            contact: { phone: "+1-928-203-0105", website: "https://www.elotecafe.com", address: "771 AZ-179 #C, Sedona, AZ 86336" },
          },
        },
      ],
    },
  ],
};

console.log("\nbuildWebApp() against a realistic Sedona-shaped plan\n");
const html = buildWebApp(PLAN, {});

assert("produces a non-empty HTML document", typeof html === "string" && html.includes("<!DOCTYPE html>"));

console.log("\nItem names/addresses/phones/websites — the item.name/.address/.phone/.website/.notes bug\n");
assert("the hotel's real name appears (was: item.name, always undefined)",
  html.includes("Residence Inn Sedona"));
assert("the hotel's address appears (was: item.address, always undefined)",
  html.includes("90 Ridge Trail Dr"));
assert("the hotel's confirmation note appears as item notes (was: item.notes/item.description, neither exists)",
  html.includes("Ask for a canyon-view room"));
assert("the Activity's full headline appears as its item name (Pink Jeep tour)",
  html.includes("Pink Jeep Broken Arrow backcountry tour"));
assert("the Activity's contact phone appears (was: item.phone, always undefined)",
  html.includes("+1-928-282-5000"));
assert("the Activity's contact website appears (was: item.website, always undefined)",
  html.includes("pinkjeep.com"));
assert("the Activity's insider reason appears as item notes (was: item.notes, doesn't exist — item.why does)",
  html.includes("signature Sedona experience"));
assert("the restaurant's real name appears (was: item.name, always undefined — real field is item.restaurant.name)",
  html.includes("Elote Cafe"));
assert("the restaurant's contact address appears (was: item.address, always undefined — real field is item.restaurant.contact.address)",
  html.includes("771 AZ-179"));
assert("the restaurant's 'why' reason appears as item notes",
  html.includes("waitlist"));
assert("the flight detail line still renders (this path was already correct)",
  html.includes("EWR") && html.includes("PHX"));

console.log("\nDay date/title — the day.date/day.title/day.theme bug (real fields: label/headline)\n");
assert("Day 1's computed date stamp appears (was: day.date, always undefined — real source is day.label)",
  html.includes("Wed Aug 25"));
assert("Day 3's headline appears as the day subtitle (was: day.title || day.theme, neither exists)",
  html.includes("Pink Jeep off-road tour"));
assert("the day-nav button shows the date stamp, not a bare 'Day N' fallback",
  html.includes(`>Fri Aug 27<`));

console.log("\nIntroduction — data.introduction is {arc, differentiators}, not a string\n");
assert("the introduction's arc paragraph appears",
  html.includes("red-rock trails to backcountry jeep tracks"));
assert("the introduction's differentiators paragraph appears",
  html.includes("Elote Cafe waitlist ritual"));
assert("the literal string \"[object Object]\" never appears (esc(introObject) used to produce this)",
  !html.includes("[object Object]"));

console.log("\nNONE_FLAGGED sentinel handled honestly, not shown literally\n");
{
  const planNoneFlagged = { ...PLAN, introduction: { arc: PLAN.introduction.arc, differentiators: "NONE_FLAGGED" } };
  const html2 = buildWebApp(planNoneFlagged, {});
  assert("the literal sentinel text is never shown to the user",
    !html2.includes(">NONE_FLAGGED<") && !/NONE_FLAGGED/.test(html2.replace(/"differentiators":\s*"NONE_FLAGGED"/, "")),
    "sentinel leaked into visible HTML");
  assert("the honest fallback copy is shown instead",
    html2.includes("no off-the-beaten-path differentiators"));
}

console.log("\nDeveloper-handoff JSON embed carries the real schema fields\n");
{
  const match = html.match(/<script id="trip-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert("the embedded JSON block exists", !!match);
  const embedded = match ? JSON.parse(match[1]) : null;
  assert("the embedded JSON's restaurant name matches the real field (was always null)",
    embedded?.days?.[1]?.items?.[2]?.restaurant?.name === "Elote Cafe", JSON.stringify(embedded?.days?.[1]?.items?.[2]));
  assert("the embedded JSON's day headline matches the real field",
    embedded?.days?.[1]?.headline === "Pink Jeep off-road tour — broken-arrow trail at midday");
  assert("the embedded JSON's introduction is the real object, not stringified",
    embedded?.introduction?.arc === PLAN.introduction.arc);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
