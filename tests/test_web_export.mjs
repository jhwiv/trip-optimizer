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
  cost_estimate: {
    currency: "USD", low: 3200, high: 4800,
    breakdown: [
      { category: "Flights", low: 1200, high: 1600 },
      { category: "Lodging", low: 1400, high: 2000 },
    ],
    basis: "Based on the flights, hotel tier, and dining/activity picks in this plan.",
  },
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

console.log("\nCost estimate — the 'At a glance' Est. cost row\n");
assert("the formatted cost range appears", html.includes("$3,200") && html.includes("$4,800"));
assert("the 'not a quote' disclaimer appears", html.toLowerCase().includes("not a quote"));
{
  const htmlNoCost = buildWebApp({ ...PLAN, cost_estimate: undefined }, {});
  assert("no Est. cost row when the plan has no cost_estimate", !htmlNoCost.includes("Est. cost"));
}
{
  const htmlBadCost = buildWebApp({ ...PLAN, cost_estimate: { currency: "USD" } }, {});
  assert("a cost_estimate with no usable low/high renders no row (not '$NaN')", !htmlBadCost.includes("Est. cost") && !htmlBadCost.includes("NaN"));
}

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

console.log("\nFlight items — corrected carrier surfaces, not the model's stale raw text (2026-08-09 regression)\n");
{
  // applyQualityLayer's KNOWN_NONSTOPS carrier-correction (src/App.jsx)
  // rewrites item.flight.carrier/flight_number/confirmation_note when the
  // model's claimed carrier doesn't actually fly the route nonstop, but
  // never touches item.text — the model's own original prose. Real
  // observed case: the "At a glance" table (reads flight.carrier directly)
  // correctly said "United or British Airways or Virgin Atlantic" while the
  // Day 1 flight card (itemVenue's old fallback read item.text first)
  // still said "LOT nonstop Newark → London Heathrow" — the same flight,
  // disagreeing with itself.
  const correctedCarrierPlan = {
    destination: "London",
    meta: "1 night",
    introduction: { arc: "x", differentiators: "NONE_FLAGGED" },
    days: [
      {
        label: "Day 1 · Sat Oct 10 · Arrive London",
        city: "London",
        headline: "x",
        items: [
          {
            type: "Flight", time: "17:30", text: "LOT nonstop Newark → London Heathrow",
            flight: {
              carrier: "United or British Airways or Virgin Atlantic",
              flight_number: null,
              from_airport: "EWR", to_airport: "LHR",
              depart_time: "17:30", arrive_time: "05:50",
              nonstop: true,
              confirmation_note: "Book directly with United. Verify flight number, times and equipment at booking — schedules change.",
              _carrierOverride: true,
              _originalCarrier: "LOT Polish Airlines",
            },
          },
        ],
      },
    ],
  };
  const html = buildWebApp(correctedCarrierPlan, {});
  // The developer-handoff JSON embed at the bottom of the page carries the
  // real, raw plan data verbatim (including the model's original item.text)
  // by design — the assertion below checks only the VISIBLE rendered HTML,
  // not that embed, for the stale carrier text.
  const visibleHtml = html.slice(0, html.indexOf('<script id="trip-data"'));
  assert("the corrected carrier appears as the flight item's name",
    visibleHtml.includes("United or British Airways or Virgin Atlantic"));
  assert("the model's stale, uncorrected carrier text does not appear in the visible page",
    !visibleHtml.includes("LOT nonstop Newark"));
  assert("the corrected confirmation note (why to book with United instead) appears",
    visibleHtml.includes("Book directly with United"));

  // A Flight item with no carrier at all (should never happen in practice,
  // but itemVenue must not crash or produce an empty name) still falls back
  // to item.text.
  const noCarrierPlan = JSON.parse(JSON.stringify(correctedCarrierPlan));
  noCarrierPlan.days[0].items[0].flight.carrier = null;
  noCarrierPlan.days[0].items[0].flight.flight_number = null;
  const html2 = buildWebApp(noCarrierPlan, {});
  assert("falls back to item.text when the flight has neither carrier nor flight_number",
    html2.includes("LOT nonstop Newark"));
}

console.log("\nFlight times — depart_time/arrive_time already in 12-hour format is not re-flipped (2026-08-09 regression)\n");
{
  // formatTime used to assume 24-hour "HH:MM" input unconditionally, so a
  // flight.depart_time/arrive_time already written as "3:05 PM" (12-hour,
  // with AM/PM) got its hour re-read as if it were 24-hour: 3 is never
  // >= 12, so the recomputed AM/PM was always AM regardless of the real
  // value — "3:05 PM" silently became "3:05 AM". Real observed case: the
  // day header (from item.time="15:05", genuinely 24-hour) correctly showed
  // "3:05 PM" while the flight detail line right below it, built from the
  // already-12-hour depart_time/arrive_time, showed "3:05 AM"/"5:30 AM".
  const ampmFlightPlan = {
    destination: "Paris",
    meta: "1 night",
    introduction: { arc: "x", differentiators: "NONE_FLAGGED" },
    days: [
      {
        label: "Day 5 · Wed Oct 14 · Depart for Normandy",
        city: "Normandy",
        headline: "x",
        items: [
          {
            type: "Flight", time: "15:05", text: "British Airways nonstop London Heathrow → Paris Charles de Gaulle",
            flight: {
              carrier: "British Airways", flight_number: "BA308",
              from_airport: "LHR", to_airport: "CDG",
              depart_time: "3:05 PM", arrive_time: "5:30 PM",
              nonstop: true,
            },
          },
        ],
      },
    ],
  };
  const htmlAmpm = buildWebApp(ampmFlightPlan, {});
  assert("the flight detail line shows the correct PM departure, not flipped to AM",
    htmlAmpm.includes("Departs 3:05") && htmlAmpm.match(/Departs 3:05.PM/), htmlAmpm.match(/Departs[^<]*/)?.[0]);
  assert("the flight detail line shows the correct PM arrival, not flipped to AM",
    htmlAmpm.match(/Arrives 5:30.PM/), htmlAmpm.match(/Arrives[^<]*/)?.[0]);
  assert("no stray AM appears for either time (the actual reported bug)",
    !htmlAmpm.includes("3:05 AM") && !htmlAmpm.includes("5:30 AM"));

  // 24-hour input (the top-of-file PLAN fixture's own Day 1 flight,
  // depart_time="08:45"/arrive_time="11:20") must still convert correctly —
  // not a regression from adding the 12-hour branch above. Checked against
  // the module-level `html`, built from PLAN at the top of this file.
  assert("existing 24-hour depart_time (08:45) still converts to 8:45 AM",
    html.match(/Departs 8:45.AM/), html.match(/Departs[^<]*/)?.[0]);
  assert("existing 24-hour arrive_time (11:20) still converts to 11:20 AM",
    html.match(/Arrives 11:20.AM/), html.match(/Arrives[^<]*/)?.[0]);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
