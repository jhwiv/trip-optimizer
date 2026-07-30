// Tests for src/placesVerify.js — pure helpers, no fetch, no React.

import { collectPlanVenues, collectPlanLegCities, mergePlacesVerifications, findBlockingIssues } from "../src/placesVerify.js";

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

// Sample plan with a restaurant, a backup restaurant, an activity, and
// a bare hotel item. That hotel item carries no .hotel object, so the
// venue collector still skips it — only Hotel items with a named .hotel
// property are verifiable.
function makePlan() {
  return {
    destination: "Santa Fe, NM",
    cities: [{ name: "Santa Fe, NM" }],
    days: [
      {
        label: "Day 1",
        items: [
          { type: "Hotel", text: "Check in", time: "15:00" },
          {
            type: "Activity",
            name: "Loretto Chapel",
            text: "Visit the Miraculous Staircase",
            time: "16:00",
            contact: { address: "OLD ADDR" },
          },
          {
            type: "Dinner",
            text: "Dinner at Geronimo",
            time: "19:00",
            restaurant: {
              name: "Geronimo",
              contact: { address: "WRONG", phone: "WRONG" },
              backup: { name: "The Compound" },
            },
          },
        ],
      },
      {
        label: "Day 2",
        items: [
          {
            type: "Activity",
            name: "Meow Wolf",
            text: "House of Eternal Return",
            time: "13:00",
          },
          {
            type: "Lunch",
            text: "Lunch at ClosedSpot",
            time: "12:30",
            restaurant: {
              name: "ClosedSpot",
            },
          },
        ],
      },
    ],
  };
}

// =========================================================
// collectPlanVenues
// =========================================================
console.log("\n[collectPlanVenues]");
{
  const plan = makePlan();
  const venues = collectPlanVenues(plan);
  const names = venues.map((v) => v.name);
  assert("collected 5 venues", venues.length === 5, `got ${venues.length}: ${names.join(", ")}`);
  assert("includes Geronimo", names.includes("Geronimo"));
  assert("includes The Compound (backup)", names.includes("The Compound"));
  assert("includes Loretto Chapel", names.includes("Loretto Chapel"));
  assert("includes Meow Wolf", names.includes("Meow Wolf"));
  assert("includes ClosedSpot", names.includes("ClosedSpot"));
  assert("Geronimo kind=restaurant", venues.find((v) => v.name === "Geronimo").kind === "restaurant");
  assert("Loretto Chapel kind=activity", venues.find((v) => v.name === "Loretto Chapel").kind === "activity");
  assert("city from destination", venues.every((v) => v.city === "Santa Fe, NM"));
}

console.log("\n[collectPlanVenues — dedup]");
{
  const plan = {
    destination: "X",
    days: [
      { items: [
        { type: "Dinner", restaurant: { name: "Same" } },
        { type: "Dinner", restaurant: { name: "same" } }, // case variant
        { type: "Activity", name: "Same" }, // same name, different kind — kept
      ] },
      { items: [
        { type: "Dinner", restaurant: { name: "  Same  " } }, // whitespace variant
      ] },
    ],
  };
  const venues = collectPlanVenues(plan);
  // 1 restaurant (3 collapsed) + 1 activity = 2
  assert("deduped within kind", venues.length === 2, `got ${venues.length}: ${venues.map(v => `${v.kind}:${v.name}`).join(", ")}`);
}

console.log("\n[collectPlanVenues — empty plan]");
{
  assert("empty days → []", collectPlanVenues({ days: [] }).length === 0);
  assert("no days → []", collectPlanVenues({}).length === 0);
  assert("null → []", collectPlanVenues(null).length === 0);
}

console.log("\n[collectPlanLegCities — multi-city]");
{
  const plan = {
    cities: [{ name: "Rovinj" }, { name: "Plitvice" }, { name: "Split" }],
    days: [
      { city: "Rovinj" },
      { city: "Rovinj → Plitvice" }, // transit day, splits
      { city: "Split" },
    ],
  };
  const cities = collectPlanLegCities(plan);
  assert("3 unique cities", cities.length === 3, cities.join(","));
  assert("order preserved", cities[0] === "Rovinj" && cities[2] === "Split");
}

console.log("\n[collectPlanLegCities — single-city falls back to destination]");
{
  const plan = { destination: "Santa Fe, NM" };
  const cities = collectPlanLegCities(plan);
  assert("falls back", cities.length === 1 && cities[0] === "Santa Fe, NM");
}

console.log("\n[collectPlanLegCities — dedup case-insensitive]");
{
  const plan = {
    days: [{ city: "Rovinj" }, { city: "rovinj" }, { city: "  ROVINJ  " }],
  };
  const cities = collectPlanLegCities(plan);
  assert("deduped to 1", cities.length === 1);
  assert("first-seen casing kept", cities[0] === "Rovinj");
}

console.log("\n[collectPlanLegCities — empty plan]");
{
  assert("null → []", collectPlanLegCities(null).length === 0);
  assert("empty → []", collectPlanLegCities({}).length === 0);
}

console.log("\n[collectPlanVenues — multi-city falls back to cities[0]]");
{
  const plan = {
    destination: "",
    cities: [{ name: "Taos, NM" }, { name: "Santa Fe, NM" }],
    days: [{ items: [{ type: "Activity", name: "Pueblo" }] }],
  };
  const venues = collectPlanVenues(plan);
  assert("city = Taos, NM", venues[0]?.city === "Taos, NM");
}

// =========================================================
// mergePlacesVerifications
// =========================================================
console.log("\n[mergePlacesVerifications — block drops items]");
{
  const plan = makePlan();
  const verifications = [
    {
      name: "Geronimo",
      kind: "restaurant",
      found: true,
      business_status: "OPERATIONAL",
      address: "724 Canyon Rd",
      phone: "+1 505-982-1500",
      website: "https://geronimo.example/",
      hours: ["Monday: 5–9 PM"],
      flags: [],
    },
    {
      name: "The Compound",
      kind: "restaurant",
      found: true,
      business_status: "OPERATIONAL",
      flags: [],
    },
    {
      name: "Loretto Chapel",
      kind: "activity",
      found: true,
      business_status: "OPERATIONAL",
      address: "207 Old Santa Fe Trail",
      flags: [],
    },
    {
      name: "Meow Wolf",
      kind: "activity",
      found: true,
      business_status: "OPERATIONAL",
      flags: [],
    },
    {
      name: "ClosedSpot",
      kind: "restaurant",
      found: true,
      business_status: "CLOSED_PERMANENTLY",
      flags: [{ code: "CLOSED_PERMANENTLY", severity: "block" }],
    },
  ];
  const next = mergePlacesVerifications(plan, verifications);

  // ClosedSpot's lunch item should be gone
  const day2items = next.days[1].items;
  assert("ClosedSpot dinner dropped from day 2", day2items.length === 1, `day 2 has ${day2items.length} items`);
  assert("Meow Wolf preserved", day2items[0].name === "Meow Wolf");

  // Day 1 should keep all 3 items
  assert("day 1 unchanged length", next.days[0].items.length === 3);

  // Geronimo should be overwritten
  const dinnerItem = next.days[0].items.find((it) => it.type === "Dinner");
  assert("Geronimo address overwritten", dinnerItem.restaurant.contact.address === "724 Canyon Rd");
  assert("Geronimo phone overwritten", dinnerItem.restaurant.contact.phone === "+1 505-982-1500");
  assert("Geronimo website set", dinnerItem.restaurant.contact.website === "https://geronimo.example/");
  assert("hours_verified added", Array.isArray(dinnerItem.restaurant.contact.hours_verified));
  assert("Geronimo _verified", dinnerItem.restaurant._verified === true);
  assert("Backup preserved", dinnerItem.restaurant.backup.name === "The Compound");

  // Loretto Chapel address overwritten
  const loretto = next.days[0].items.find((it) => it.type === "Activity" && it.name === "Loretto Chapel");
  assert("Loretto address overwritten", loretto.contact.address === "207 Old Santa Fe Trail");
  assert("Loretto _verified", loretto._verified === true);

  // Summary populated
  assert("summary.checked === 5", next._verificationSummary.checked === 5);
  assert("summary.blocked === 1", next._verificationSummary.blocked === 1);
  assert("summary.verified === 4", next._verificationSummary.verified === 4);
}

console.log("\n[mergePlacesVerifications — backup blocked but primary OK]");
{
  const plan = {
    destination: "City",
    days: [{
      items: [{
        type: "Dinner",
        restaurant: { name: "Main", backup: { name: "BadBackup" } },
      }],
    }],
  };
  const verifications = [
    { name: "Main", kind: "restaurant", found: true, flags: [] },
    { name: "BadBackup", kind: "restaurant", found: true, business_status: "CLOSED_PERMANENTLY", flags: [{ code: "CLOSED_PERMANENTLY", severity: "block" }] },
  ];
  const next = mergePlacesVerifications(plan, verifications);
  const item = next.days[0].items[0];
  assert("item preserved", item !== undefined);
  assert("primary preserved", item.restaurant.name === "Main");
  assert("backup removed", item.restaurant.backup === undefined);
  assert("blocked count 1", next._verificationSummary.blocked === 1);
}

console.log("\n[mergePlacesVerifications — UNVERIFIED keeps item + flags]");
{
  const plan = {
    destination: "City",
    days: [{
      items: [
        { type: "Activity", name: "Unknown Activity" },
        { type: "Dinner", restaurant: { name: "Unverified Spot" } },
      ],
    }],
  };
  const verifications = [
    { name: "Unknown Activity", kind: "activity", found: false, flags: [{ code: "UNVERIFIED", severity: "warn", message: "no-key" }] },
    { name: "Unverified Spot", kind: "restaurant", found: false, flags: [{ code: "UNVERIFIED", severity: "warn", message: "no-key" }] },
  ];
  const next = mergePlacesVerifications(plan, verifications);
  assert("both items preserved", next.days[0].items.length === 2);
  const activity = next.days[0].items[0];
  const dinner = next.days[0].items[1];
  assert("activity flags attached", activity.flags?.[0]?.code === "UNVERIFIED");
  assert("activity NOT _verified", activity._verified !== true);
  assert("restaurant flags attached", dinner.restaurant.flags?.[0]?.code === "UNVERIFIED");
  assert("warnings === 2", next._verificationSummary.warnings === 2);
}

console.log("\n[mergePlacesVerifications — empty verifications → identity]");
{
  const plan = makePlan();
  const next = mergePlacesVerifications(plan, []);
  assert("returns original plan when no verifications", next === plan);
}

console.log("\n[mergePlacesVerifications — name match is case-insensitive]");
{
  const plan = {
    destination: "X",
    days: [{ items: [{ type: "Activity", name: "  MEOW WOLF  " }] }],
  };
  const verifications = [
    { name: "meow wolf", kind: "activity", found: true, business_status: "OPERATIONAL", address: "Real St", flags: [] },
  ];
  const next = mergePlacesVerifications(plan, verifications);
  assert("address overwritten despite case/whitespace", next.days[0].items[0].contact.address === "Real St");
}

console.log("\n[verify-or-strip — UNVERIFIED venue gets hard specifics stripped]");
{
  const plan = {
    destination: "X",
    days: [{
      items: [
        {
          type: "Activity",
          name: "Unverified Activity",
          contact: {
            address: "123 Fake Street",  // numbered — strip
            phone: "555-0100",            // strip
            website: "https://realsite.com",  // keep (URL verifier handles separately)
            hours: "Mon–Fri 9–5",          // strip
            booking_url: "https://book.com", // strip
          },
        },
        {
          type: "Activity",
          name: "Neighborhood Only",
          contact: { address: "Downtown" }, // no digit — keep
        },
      ],
    }],
  };
  const verifications = [
    { name: "Unverified Activity", kind: "activity", found: false, flags: [{ code: "UNVERIFIED", severity: "warn", message: "no-key" }] },
    { name: "Neighborhood Only", kind: "activity", found: false, flags: [{ code: "UNVERIFIED", severity: "warn", message: "no-key" }] },
  ];
  const next = mergePlacesVerifications(plan, verifications);
  const a = next.days[0].items[0];
  assert("phone stripped", a.contact.phone === undefined);
  assert("numbered address stripped", a.contact.address === undefined);
  assert("hours stripped", a.contact.hours === undefined);
  assert("booking_url stripped", a.contact.booking_url === undefined);
  assert("website kept (URL verifier handles)", a.contact.website === "https://realsite.com");
  assert("UNVERIFIED_SPECIFIC flag added", a.flags?.some((f) => f.code === "UNVERIFIED_SPECIFIC"));
  assert("original UNVERIFIED flag still there", a.flags?.some((f) => f.code === "UNVERIFIED"));

  const b = next.days[0].items[1];
  assert("non-numbered address kept", b.contact.address === "Downtown");
  assert("no UNVERIFIED_SPECIFIC since nothing stripped", !b.flags?.some((f) => f.code === "UNVERIFIED_SPECIFIC"));
}

console.log("\n[verify-or-strip — OPERATIONAL venues are NOT stripped]");
{
  const plan = {
    destination: "X",
    days: [{ items: [{ type: "Dinner", restaurant: { name: "Good", contact: { phone: "old-phone", address: "old addr 1" } } }] }],
  };
  const verifications = [
    { name: "Good", kind: "restaurant", found: true, business_status: "OPERATIONAL", phone: "+1 555-0200", address: "200 Real St", flags: [] },
  ];
  const next = mergePlacesVerifications(plan, verifications);
  const r = next.days[0].items[0].restaurant;
  assert("phone overwritten not stripped", r.contact.phone === "+1 555-0200");
  assert("address overwritten", r.contact.address === "200 Real St");
  assert("no UNVERIFIED_SPECIFIC flag", !r.flags?.some((f) => f.code === "UNVERIFIED_SPECIFIC"));
}

console.log("\n[mergePlacesVerifications — dropBlocked:false keeps blocked items with flags]");
{
  const plan = {
    destination: "X",
    days: [{ items: [{ type: "Activity", name: "Closed Activity" }] }],
  };
  const verifications = [
    { name: "Closed Activity", kind: "activity", found: true, business_status: "CLOSED_PERMANENTLY", flags: [{ code: "CLOSED_PERMANENTLY", severity: "block" }] },
  ];
  const next = mergePlacesVerifications(plan, verifications, { dropBlocked: false });
  assert("item kept when dropBlocked:false", next.days[0].items.length === 1);
  assert("flags attached", next.days[0].items[0].flags?.[0]?.code === "CLOSED_PERMANENTLY");
}

console.log("\n[findBlockingIssues — clean plan]");
{
  const plan = makePlan();
  assert("no flags → no issues", findBlockingIssues(plan).length === 0);
}

console.log("\n[findBlockingIssues — blocked activity is detected]");
{
  const plan = {
    destination: "X",
    days: [{
      items: [
        { type: "Activity", name: "Bad", flags: [{ code: "NOT_FOUND", severity: "block" }] },
        { type: "Activity", name: "Good", flags: [] },
      ],
    }],
  };
  const issues = findBlockingIssues(plan);
  assert("1 issue surfaced", issues.length === 1);
  assert("correct name", issues[0].name === "Bad");
  assert("correct kind", issues[0].kind === "activity");
  assert("correct flag", issues[0].flag.code === "NOT_FOUND");
  assert("correct dayIdx", issues[0].dayIdx === 0);
}

console.log("\n[findBlockingIssues — blocked restaurant + blocked backup]");
{
  const plan = {
    destination: "X",
    days: [{
      items: [{
        type: "Dinner",
        restaurant: {
          name: "BadPrimary",
          flags: [{ code: "CLOSED_PERMANENTLY", severity: "block" }],
          backup: { name: "BadBackup", flags: [{ code: "CLOSED_TEMPORARILY", severity: "block" }] },
        },
      }],
    }],
  };
  const issues = findBlockingIssues(plan);
  assert("both surfaced", issues.length === 2);
  assert("first is restaurant", issues[0].kind === "restaurant");
  assert("second is backup", issues[1].kind === "backup");
}

console.log("\n[findBlockingIssues — warn flags do NOT block]");
{
  const plan = {
    destination: "X",
    days: [{ items: [{ type: "Activity", name: "Warn", flags: [{ code: "UNVERIFIED", severity: "warn" }] }] }],
  };
  assert("warn does not surface", findBlockingIssues(plan).length === 0);
}

console.log("\n[findBlockingIssues — null / empty plan]");
{
  assert("null plan → []", findBlockingIssues(null).length === 0);
  assert("no days → []", findBlockingIssues({}).length === 0);
  assert("empty days → []", findBlockingIssues({ days: [] }).length === 0);
}


// =========================================================
// OPEN_ON_THIS_DAY / OUTSIDE_HOURS integration (Spec 1, 2026-06-14)
// =========================================================
// Verifies the end-to-end wiring: when the plan has a startDate, items
// get day-context-aware flags from the hours parser. Anchor:
// Aug 25 2027 = Wednesday.

console.log("\n[hours check — CLOSED_ON_THIS_DAY (Joseph Restaurant, Monday)]");
{
  // Aug 25 2027 = Wed. Day 1 = Wed, ... Day 6 = Mon.
  const plan = {
    startDate: "2027-08-25",
    destination: "Santa Fe, NM",
    days: [
      { items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] },
      { items: [{ type: "Dinner", time: "19:00", restaurant: { name: "Joseph" } }] },
    ],
  };
  const verifications = [{
    name: "Joseph", kind: "restaurant", found: true, business_status: "OPERATIONAL",
    hours: [
      "Monday: Closed", "Tuesday: Closed",
      "Wednesday: 5:00 – 9:00 PM", "Thursday: 5:00 – 9:00 PM",
      "Friday: 5:00 – 9:00 PM", "Saturday: 5:00 – 9:00 PM", "Sunday: 5:00 – 9:00 PM",
    ],
    flags: [],
  }];
  const next = mergePlacesVerifications(plan, verifications);
  const r = next.days[5].items[0].restaurant;
  assert("Joseph still in plan (warn, not block)", next.days[5].items.length === 1);
  assert("CLOSED_ON_THIS_DAY flag on Joseph", r.flags?.some((f) => f.code === "CLOSED_ON_THIS_DAY"));
  assert("flag is warn", r.flags?.find((f) => f.code === "CLOSED_ON_THIS_DAY")?.severity === "warn");
}

console.log("\n[hours check — OUTSIDE_HOURS (Geronimo at lunch)]");
{
  const plan = {
    startDate: "2027-08-25",
    destination: "Santa Fe, NM",
    days: [{ items: [{ type: "Lunch", time: "12:30", restaurant: { name: "Geronimo" } }] }],
  };
  const verifications = [{
    name: "Geronimo", kind: "restaurant", found: true, business_status: "OPERATIONAL",
    hours: [
      "Monday: 4:45 – 11:00 PM", "Tuesday: 4:45 – 11:00 PM",
      "Wednesday: 4:45 – 11:00 PM", "Thursday: 4:45 – 11:00 PM",
      "Friday: 4:45 – 11:00 PM", "Saturday: 4:45 – 11:00 PM", "Sunday: 4:45 – 11:00 PM",
    ],
    flags: [],
  }];
  const next = mergePlacesVerifications(plan, verifications);
  const r = next.days[0].items[0].restaurant;
  assert("OUTSIDE_HOURS flag", r.flags?.some((f) => f.code === "OUTSIDE_HOURS"));
  assert("warn severity", r.flags?.find((f) => f.code === "OUTSIDE_HOURS")?.severity === "warn");
}

console.log("\n[hours check — in-hours dinner produces no flag]");
{
  const plan = {
    startDate: "2027-08-25",
    destination: "Santa Fe, NM",
    days: [{ items: [{ type: "Dinner", time: "19:00", restaurant: { name: "Geronimo" } }] }],
  };
  const verifications = [{
    name: "Geronimo", kind: "restaurant", found: true, business_status: "OPERATIONAL",
    hours: [
      "Monday: 4:45 – 11:00 PM", "Tuesday: 4:45 – 11:00 PM",
      "Wednesday: 4:45 – 11:00 PM", "Thursday: 4:45 – 11:00 PM",
      "Friday: 4:45 – 11:00 PM", "Saturday: 4:45 – 11:00 PM", "Sunday: 4:45 – 11:00 PM",
    ],
    flags: [],
  }];
  const next = mergePlacesVerifications(plan, verifications);
  const r = next.days[0].items[0].restaurant;
  assert("no CLOSED_ON_THIS_DAY", !r.flags?.some((f) => f.code === "CLOSED_ON_THIS_DAY"));
  assert("no OUTSIDE_HOURS", !r.flags?.some((f) => f.code === "OUTSIDE_HOURS"));
  assert("_verified still true", r._verified === true);
}

console.log("\n[hours check — Activity items get the check too]");
{
  const plan = {
    startDate: "2027-08-25",
    destination: "Santa Fe, NM",
    days: [{ items: [{ type: "Activity", name: "Loretto Chapel", time: "18:00" }] }],
  };
  const verifications = [{
    name: "Loretto Chapel", kind: "activity", found: true, business_status: "OPERATIONAL",
    hours: [
      "Monday: 9:00 AM – 5:00 PM", "Tuesday: 9:00 AM – 5:00 PM",
      "Wednesday: 9:00 AM – 5:00 PM", "Thursday: 9:00 AM – 5:00 PM",
      "Friday: 9:00 AM – 5:00 PM", "Saturday: 9:00 AM – 5:00 PM", "Sunday: 9:00 AM – 5:00 PM",
    ],
    flags: [],
  }];
  const next = mergePlacesVerifications(plan, verifications);
  const a = next.days[0].items[0];
  assert("OUTSIDE_HOURS on activity", a.flags?.some((f) => f.code === "OUTSIDE_HOURS"));
}

console.log("\n[hours check — missing plan.startDate skips check (graceful)]");
{
  const plan = {
    destination: "Santa Fe, NM",
    days: [{ items: [{ type: "Dinner", time: "19:00", restaurant: { name: "Joseph" } }] }],
  };
  const verifications = [{
    name: "Joseph", kind: "restaurant", found: true, business_status: "OPERATIONAL",
    hours: ["Monday: Closed", "Tuesday: Closed", "Wednesday: 5:00 – 9:00 PM",
            "Thursday: 5:00 – 9:00 PM", "Friday: 5:00 – 9:00 PM",
            "Saturday: 5:00 – 9:00 PM", "Sunday: 5:00 – 9:00 PM"],
    flags: [],
  }];
  const next = mergePlacesVerifications(plan, verifications);
  const r = next.days[0].items[0].restaurant;
  assert("no CLOSED_ON_THIS_DAY (no startDate)", !r.flags?.some((f) => f.code === "CLOSED_ON_THIS_DAY"));
}

console.log("\n[hours check — missing item.time still catches closed_all_day]");
{
  const plan = {
    startDate: "2027-08-25",
    days: [
      { items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] },
      { items: [{ type: "Dinner", restaurant: { name: "Joseph" } }] },
    ],
  };
  const verifications = [{
    name: "Joseph", kind: "restaurant", found: true, business_status: "OPERATIONAL",
    hours: ["Monday: Closed", "Tuesday: Closed", "Wednesday: 5:00 – 9:00 PM",
            "Thursday: 5:00 – 9:00 PM", "Friday: 5:00 – 9:00 PM",
            "Saturday: 5:00 – 9:00 PM", "Sunday: 5:00 – 9:00 PM"],
    flags: [],
  }];
  const next = mergePlacesVerifications(plan, verifications);
  const r = next.days[5].items[0].restaurant;
  assert("CLOSED_ON_THIS_DAY still fires without item.time", r.flags?.some((f) => f.code === "CLOSED_ON_THIS_DAY"));
}

console.log("\n[hours check — Hotel items are exempt]");
{
  // Defensive: Hotel items shouldn't have .restaurant per schema, but
  // belt-and-braces guard.
  const plan = {
    startDate: "2027-08-25",
    days: [{ items: [{ type: "Hotel", time: "23:00", restaurant: { name: "Joseph" } }] }],
  };
  const verifications = [{
    name: "Joseph", kind: "restaurant", found: true, business_status: "OPERATIONAL",
    hours: ["Monday: Closed", "Tuesday: Closed", "Wednesday: Closed",
            "Thursday: Closed", "Friday: Closed", "Saturday: Closed", "Sunday: Closed"],
    flags: [],
  }];
  const next = mergePlacesVerifications(plan, verifications);
  const r = next.days[0].items[0].restaurant;
  assert("Hotel + .restaurant: no CLOSED_ON_THIS_DAY", !r.flags?.some((f) => f.code === "CLOSED_ON_THIS_DAY"));
}
// ---------------------------------------------------------------------------
// Hotels. Until now a permanently-closed or nonexistent hotel shipped in the
// PDF untouched: hotels were never collected, never verified, and the export
// gate never looked at them.
// ---------------------------------------------------------------------------

function hotelItem(name, address, extra = {}) {
  return { type: "Hotel", text: `Check in — ${name}`, time: "15:00", hotel: { name, address, ...extra } };
}

console.log("\n[collectPlanVenues — hotels]");
{
  const plan = {
    destination: "Bayeux → Amsterdam",
    days: [
      { city: "Bayeux, Normandy", items: [hotelItem("Villa Lara", "6 Place de Quebec, Bayeux")] },
      { city: "Bayeux, Normandy", items: [hotelItem("Villa Lara", "6 Place de Quebec, Bayeux")] },
      { city: "Bayeux → Amsterdam", items: [hotelItem("Amsterdam Marriott", "Stadhouderskade 12")] },
    ],
  };
  const venues = collectPlanVenues(plan);
  const hotels = venues.filter((v) => v.kind === "hotel");
  assert("hotels are collected", hotels.length === 2, JSON.stringify(hotels));
  assert("a property repeated across days costs one Places call",
    hotels.filter((h) => h.name === "Villa Lara").length === 1, JSON.stringify(hotels));
  assert("hotel city comes from the day, not plan.destination",
    hotels[0].city === "Bayeux, Normandy", JSON.stringify(hotels[0]));
  assert("a transit day resolves to the arrival city",
    hotels[1].city === "Amsterdam", JSON.stringify(hotels[1]));
}
{
  // Same brand, two properties: distinct addresses must survive dedup or the
  // second city's hotel silently inherits the first city's verification.
  const plan = {
    destination: "London",
    days: [
      { city: "London", items: [hotelItem("Marriott", "Marble Arch, London")] },
      { city: "Amsterdam", items: [hotelItem("Marriott", "Stadhouderskade, Amsterdam")] },
    ],
  };
  const hotels = collectPlanVenues(plan).filter((v) => v.kind === "hotel");
  assert("same name + different address = two venues", hotels.length === 2, JSON.stringify(hotels));
}
{
  const plan = { destination: "Santa Fe", days: [{ items: [{ type: "Hotel", text: "Check in", time: "15:00" }] }] };
  assert("a Hotel item with no .hotel object is skipped",
    collectPlanVenues(plan).filter((v) => v.kind === "hotel").length === 0);
}

console.log("\n[hotels — closed and missing properties reach the gate]");
{
  const plan = {
    destination: "Bayeux",
    days: [{ city: "Bayeux", items: [hotelItem("Villa Lara", "6 Place de Quebec, Bayeux")] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Villa Lara", kind: "hotel", found: true, business_status: "CLOSED_PERMANENTLY",
    flags: [{ code: "CLOSED_PERMANENTLY", severity: "block", message: "Permanently closed per Google Places" }],
  }]);
  const item = next.days[0].items[0];
  assert("a closed hotel is NOT dropped from the day", !!item && item.type === "Hotel", JSON.stringify(item));
  assert("the block flag lands on item.hotel.flags",
    item.hotel.flags.some((f) => f.code === "CLOSED_PERMANENTLY" && f.severity === "block"),
    JSON.stringify(item.hotel.flags));
  assert("a closed hotel is never marked _verified", item.hotel._verified !== true);

  const issues = findBlockingIssues(next);
  assert("the export gate reports it", issues.length === 1, JSON.stringify(issues));
  assert("reported as kind:hotel", issues[0]?.kind === "hotel", JSON.stringify(issues[0]));
  assert("reported with the property name", issues[0]?.name === "Villa Lara", JSON.stringify(issues[0]));
}
{
  const plan = {
    destination: "Bayeux",
    days: [{ city: "Bayeux", items: [hotelItem("Hotel Nonexistent", "12 Rue Imaginaire, Bayeux")] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Hotel Nonexistent", kind: "hotel", found: false, error: "not-found",
    flags: [{ code: "NOT_FOUND", severity: "block", message: "Google Places returned zero matches for this name + city" }],
  }]);
  assert("a nonexistent hotel blocks the export",
    findBlockingIssues(next).some((i) => i.flag.code === "NOT_FOUND" && i.kind === "hotel"));
}

console.log("\n[hotels — a confident match is written through]");
{
  const plan = {
    destination: "Santa Fe, NM",
    days: [{ city: "Santa Fe, NM", items: [hotelItem("Hotel Santa Fe", "OLD ADDR", { phone: "WRONG", website: "https://old.example" })] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Hotel Santa Fe", kind: "hotel", found: true, business_status: "OPERATIONAL",
    resolved_name: "Hotel Santa Fe", address: "1501 Paseo de Peralta, Santa Fe, NM 87501",
    phone: "+1 505-982-1200", website: "https://hotelsantafe.com", place_id: "abc", lat: 35.68, lng: -105.95,
    flags: [],
  }]);
  const h = next.days[0].items[0].hotel;
  assert("address overwritten with the Places value", h.address === "1501 Paseo de Peralta, Santa Fe, NM 87501", h.address);
  assert("phone overwritten with the Places value", h.phone === "+1 505-982-1200", h.phone);
  assert("website overwritten with the Places value", h.website === "https://hotelsantafe.com", h.website);
  assert("marked _verified", h._verified === true);
  assert("coordinates carried through", h.lat === 35.68 && h.lng === -105.95);
  assert("no flags on a clean match", !h.flags, JSON.stringify(h.flags));
}

console.log("\n[hotels — an uncertain match warns, never blocks]");
{
  // The chain-sibling case: Places returns a real Marriott, just not this one.
  const plan = {
    destination: "London",
    days: [{ city: "London", items: [hotelItem("Marriott London Marble Arch", "1 Marble Arch, London", { phone: "+44 20 7000 0000" })] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Marriott London Marble Arch", kind: "hotel", found: true, business_status: "OPERATIONAL",
    resolved_name: "Marriott Regents Park", address: "128 King Henry's Road, London",
    phone: "+44 20 7722 7711", flags: [],
  }]);
  const h = next.days[0].items[0].hotel;
  assert("uncertain match warns", h.flags.some((f) => f.code === "HOTEL_MATCH_UNCERTAIN" && f.severity === "warn"),
    JSON.stringify(h.flags));
  assert("uncertain match does NOT block the export", findBlockingIssues(next).length === 0);
  assert("uncertain match is not marked _verified", h._verified !== true);
  assert("the wrong property's phone is not written onto the hotel", h.phone !== "+44 20 7722 7711");
  assert("the model's unconfirmed phone is stripped", !h.phone, h.phone);
  assert("stripping is disclosed", h.flags.some((f) => f.code === "UNVERIFIED_SPECIFIC"), JSON.stringify(h.flags));
}
{
  // Places likes to append venue-class words, and it answers in the local
  // language. Neither makes it a different property. An earlier draft of
  // this check string-matched the plan's city against the returned address
  // and warned on "Venice" vs "Venezia" — a false alarm on a correct hotel.
  const plan = {
    destination: "Venice",
    days: [{ city: "Venice", items: [hotelItem("Aman Venice", "Calle Tiepolo 1364, Venice")] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Aman Venice", kind: "hotel", found: true, business_status: "OPERATIONAL",
    resolved_name: "Aman Venice Hotel", address: "Calle Tiepolo 1364, 30125 Venezia VE, Italy", flags: [],
  }]);
  const h = next.days[0].items[0].hotel;
  assert("a venue-class suffix is still a confident match", h._verified === true, JSON.stringify(h.flags));
  assert("an exonym in the address raises no flag", !h.flags, JSON.stringify(h.flags));
}
{
  // Wrong region is caught geographically, not lexically: App.jsx runs the
  // per-leg location check over the verifications (hotels included) and
  // attaches WRONG_LOCATION before the merge. Simulate that hand-off.
  const plan = {
    destination: "Santa Fe, NM",
    days: [{ city: "Santa Fe, NM", items: [hotelItem("Grand Plaza", "100 Plaza, Santa Fe")] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Grand Plaza", kind: "hotel", found: true, business_status: "OPERATIONAL",
    resolved_name: "Grand Plaza", address: "12 Boylston St, Boston, MA",
    flags: [{ code: "WRONG_LOCATION", severity: "block", message: "3,000 km from any trip city" }],
  }]);
  assert("a wrong-region hotel blocks the export",
    findBlockingIssues(next).some((i) => i.kind === "hotel" && i.flag.code === "WRONG_LOCATION"));
  assert("a wrong-region hotel is not marked _verified",
    next.days[0].items[0].hotel._verified !== true);
}

console.log("\n[hotels — the 2026-06-14 hours exemption survives]");
{
  const plan = {
    startDate: "2026-10-05", // a Monday
    destination: "Bayeux",
    days: [{ city: "Bayeux", items: [hotelItem("Villa Lara", "6 Place de Quebec, Bayeux")] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Villa Lara", kind: "hotel", found: true, business_status: "OPERATIONAL",
    resolved_name: "Villa Lara", address: "6 Place de Quebec, Bayeux",
    hours: ["Monday: Closed", "Tuesday: Closed", "Wednesday: Closed", "Thursday: Closed",
            "Friday: Closed", "Saturday: Closed", "Sunday: Closed"],
    flags: [],
  }]);
  const h = next.days[0].items[0].hotel;
  assert("hotels never get CLOSED_ON_THIS_DAY", !(h.flags || []).some((f) => f.code === "CLOSED_ON_THIS_DAY"),
    JSON.stringify(h.flags));
  assert("hotels never get OUTSIDE_HOURS", !(h.flags || []).some((f) => f.code === "OUTSIDE_HOURS"),
    JSON.stringify(h.flags));
  assert("hotels with all-closed posted hours still verify", h._verified === true);
}

console.log("\n[hotels — an unverifiable lookup strips specifics]");
{
  const plan = {
    destination: "Lisbon",
    days: [{ city: "Lisbon", items: [hotelItem("Hotel Avenida", "45 Avenida da Liberdade", { phone: "+351 21 000 0000" })] }],
  };
  const next = mergePlacesVerifications(plan, [{
    name: "Hotel Avenida", kind: "hotel", found: false, error: "no-key",
    flags: [{ code: "UNVERIFIED", severity: "warn", message: "no-key" }],
  }]);
  const h = next.days[0].items[0].hotel;
  assert("UNVERIFIED hotel keeps its place in the day", next.days[0].items.length === 1);
  assert("UNVERIFIED hotel does not block", findBlockingIssues(next).length === 0);
  assert("its phone is stripped", !h.phone);
  assert("its numbered address is stripped", !h.address, h.address);
  assert("UNVERIFIED_SPECIFIC discloses the strip", h.flags.some((f) => f.code === "UNVERIFIED_SPECIFIC"));
}
{
  const plan = { destination: "Lisbon", days: [{ city: "Lisbon", items: [hotelItem("Unknown Inn", "Alfama")] }] };
  const next = mergePlacesVerifications(plan, [{ name: "Some Other Hotel", kind: "hotel", found: true, flags: [] }]);
  assert("a hotel with no matching verification is left alone",
    next.days[0].items[0].hotel.address === "Alfama");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
