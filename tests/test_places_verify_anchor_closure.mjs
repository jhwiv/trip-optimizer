// Anchor-scoped CLOSED_ON_THIS_DAY (report bug 3, second half).
//
// Day 5 of the 2026-07-28 build booked a table at La Rapiere on a Monday. The
// restaurant closes Mondays, Places said so, and the plan exported anyway —
// CLOSED_ON_THIS_DAY was a warn for everything.
//
// Blanket-blocking is not the fix. Places closure data has known gaps
// (seasonal hours, holiday overrides), and a false block on a walk-in cafe
// would stop the export of an otherwise sound itinerary. So the severity is
// scoped to whether the traveller has committed to the slot: a reserved table
// or a timed-entry ticket blocks, a walk-in warns. Ambiguous → warn, by the
// maintainer's call (2026-07-30).
//
// 2026-10-05 is a Monday; every plan below starts on it, so day index 0 is
// the closed day.

import { mergePlacesVerifications, findBlockingIssues, classifyAnchor } from "../src/placesVerify.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const MONDAY = "2026-10-05";
const CLOSED_MONDAYS = [
  "Monday: Closed",
  "Tuesday: 12:00 – 2:00 PM, 7:00 – 9:30 PM",
  "Wednesday: 12:00 – 2:00 PM, 7:00 – 9:30 PM",
  "Thursday: 12:00 – 2:00 PM, 7:00 – 9:30 PM",
  "Friday: 12:00 – 2:00 PM, 7:00 – 9:30 PM",
  "Saturday: 12:00 – 2:00 PM, 7:00 – 9:30 PM",
  "Sunday: 12:00 – 2:00 PM",
];

const verification = (name, kind) => ({
  name, kind, found: true, business_status: "OPERATIONAL", hours: CLOSED_MONDAYS, flags: [],
});

// Run one item through the real merge and return its CLOSED_ON_THIS_DAY flag.
function closureFlag(item, kind = "restaurant", name = "La Rapiere") {
  const plan = { startDate: MONDAY, days: [{ day: 1, city: "Bayeux", items: [item] }] };
  const next = mergePlacesVerifications(plan, [verification(name, kind)]);
  const merged = next.days[0].items[0];
  const flags = kind === "activity" ? merged?.flags : merged?.restaurant?.flags;
  return (flags || []).find((f) => f.code === "CLOSED_ON_THIS_DAY") || null;
}

const dinner = (extra = {}, restaurantExtra = {}) => ({
  type: "Dinner",
  time: "19:30",
  text: "Dinner at La Rapiere",
  restaurant: { name: "La Rapiere", ...restaurantExtra },
  ...extra,
});

console.log("=== the shipped failure: a reserved Monday dinner blocks ===");
{
  const flag = closureFlag(dinner({ contact: { reserve: "https://www.opentable.com/r/la-rapiere-bayeux" } }));
  assert("CLOSED_ON_THIS_DAY raised", !!flag, JSON.stringify(flag));
  assert("severity is block", flag?.severity === "block", flag?.severity);
  assert("message says it is a booked slot", /booked slot/.test(flag?.message || ""), flag?.message);
  assert("message still names the weekday", /Monday/.test(flag?.message || ""), flag?.message);
}

console.log("\n=== a walk-in stop only warns ===");
{
  const flag = closureFlag(dinner());
  assert("CLOSED_ON_THIS_DAY still raised", !!flag);
  assert("severity is warn", flag?.severity === "warn", flag?.severity);
  assert("message is the plain closure note", !/booked slot/.test(flag?.message || ""), flag?.message);
}

console.log("\n=== which meals count as reserved ===");
{
  const anchored = (item) => closureFlag(item)?.severity === "block";

  assert("contact.reserve blocks", anchored(dinner({ contact: { reserve: "tel:+33231210545" } })));
  assert("reservations_required blocks", anchored(dinner({}, { reservations_required: true })));
  assert("a resy reservation with a url blocks",
    anchored(dinner({}, { reservation: { platform: "resy", url: "https://resy.com/cities/bayeux/la-rapiere" } })));
  assert("an opentable reservation with a phone blocks",
    anchored(dinner({}, { reservation: { platform: "opentable", phone: "+33 2 31 21 05 45" } })));
  assert("'reservations essential' in the venue prose blocks",
    anchored(dinner({}, { why: "Tiny room; reservations are essential." })));
  assert("'book well in advance' in the hours note blocks",
    anchored(dinner({}, { hours_note: "Book well in advance for the terrace." })));

  assert("platform 'walkin' does not block",
    !anchored(dinner({}, { reservation: { platform: "walkin", url: "https://example.com" } })));
  assert("a platform with no booking handle does not block",
    !anchored(dinner({}, { reservation: { platform: "opentable" } })));
  assert("a bare restaurant object does not block", !anchored(dinner()));
  assert("prose merely mentioning a reservation desk does not block",
    !anchored(dinner({}, { why: "The reservation book is a leather ledger — charming." })));

  assert("lunch follows the same rule",
    closureFlag({ ...dinner({ contact: { reserve: "x" } }), type: "Lunch", time: "12:30" })?.severity === "block");
  assert("breakfast follows the same rule",
    closureFlag({ ...dinner(), type: "Breakfast", time: "08:30" })?.severity === "warn");
}

console.log("\n=== activities ===");
{
  const activity = (extra = {}) => ({
    type: "Activity",
    time: "10:00",
    name: "Bayeux Tapestry Museum",
    text: "Bayeux Tapestry Museum",
    ...extra,
  });
  const sev = (item) => closureFlag(item, "activity", "Bayeux Tapestry Museum")?.severity;

  assert("a booking_url makes it an anchor",
    sev(activity({ contact: { booking_url: "https://www.getyourguide.com/bayeux-l1/tapestry-t2" } })) === "block");
  assert("timed_entry:true makes it an anchor", sev(activity({ timed_entry: true })) === "block");
  assert("'timed entry' in the hours text makes it an anchor",
    sev(activity({ contact: { hours: "Timed entry, 9:00–18:00" } })) === "block");
  assert("'advance booking' in the booking note makes it an anchor",
    sev(activity({ contact: { booking_note: "Advance booking required in summer." } })) === "block");
  assert("a self-guided stop only warns", sev(activity()) === "warn");
  assert("a phone number alone does not make it an anchor",
    sev(activity({ contact: { phone: "+33 2 31 51 25 50" } })) === "warn");
}

console.log("\n=== a backup is a suggestion, never a booking ===");
{
  // findBlockingIssues walks restaurant.backup.flags, so without the explicit
  // downgrade an anchored primary would block export on its own fallback.
  const plan = {
    startDate: MONDAY,
    days: [{
      day: 1,
      city: "Bayeux",
      items: [{
        type: "Dinner",
        time: "19:30",
        contact: { reserve: "https://www.opentable.com/r/le-pommier-bayeux" },
        restaurant: { name: "Le Pommier", backup: { name: "La Rapiere" } },
      }],
    }],
  };
  const next = mergePlacesVerifications(plan, [verification("La Rapiere", "restaurant")]);
  const backup = next.days[0].items[0].restaurant.backup;
  const flag = (backup.flags || []).find((f) => f.code === "CLOSED_ON_THIS_DAY");

  assert("the backup's closure is still surfaced", !!flag, JSON.stringify(backup.flags));
  assert("but it is a warn, not a block", flag?.severity === "warn", flag?.severity);
  assert("so it does not block the export", findBlockingIssues(next).length === 0, JSON.stringify(findBlockingIssues(next)));
}

console.log("\n=== the block reaches the pre-export gate ===");
{
  const plan = {
    startDate: MONDAY,
    days: [{
      day: 1,
      city: "Bayeux",
      items: [dinner({ contact: { reserve: "https://www.opentable.com/r/la-rapiere-bayeux" } })],
    }],
  };
  const next = mergePlacesVerifications(plan, [verification("La Rapiere", "restaurant")]);
  const issues = findBlockingIssues(next);
  assert("one blocking issue", issues.length === 1, JSON.stringify(issues));
  assert("it names the venue", issues[0]?.name === "La Rapiere", issues[0]?.name);
  assert("it carries the closure flag", issues[0]?.flag?.code === "CLOSED_ON_THIS_DAY");

  const walkIn = mergePlacesVerifications(
    { startDate: MONDAY, days: [{ day: 1, city: "Bayeux", items: [dinner()] }] },
    [verification("La Rapiere", "restaurant")],
  );
  assert("the walk-in version exports fine", findBlockingIssues(walkIn).length === 0);
}

console.log("\n=== an open day is never flagged, anchored or not ===");
{
  const tuesday = { startDate: "2026-10-06", days: [{ day: 1, city: "Bayeux", items: [dinner({ contact: { reserve: "x" } })] }] };
  const next = mergePlacesVerifications(tuesday, [verification("La Rapiere", "restaurant")]);
  const flags = next.days[0].items[0].restaurant.flags || [];
  assert("no closure flag on a Tuesday", !flags.some((f) => f.code === "CLOSED_ON_THIS_DAY"), JSON.stringify(flags));
}

console.log("\n=== classifyAnchor directly ===");
{
  assert("a hotel check-in is always an anchor", classifyAnchor({ type: "Hotel", text: "Check in" }) === true);
  assert("a transport leg is not", classifyAnchor({ type: "Transport", text: "Drive to Bayeux" }) === false);
  assert("a flight is not (its own validators cover it)", classifyAnchor({ type: "Flight", text: "UA934" }) === false);
  assert("a free-text note is not", classifyAnchor({ type: "Note", text: "Pack an umbrella" }) === false);
  assert("null is not", classifyAnchor(null) === false);
  assert("a non-object is not", classifyAnchor("Dinner") === false);
  assert("an unknown type is not", classifyAnchor({ type: "Mystery", contact: { reserve: "x" } }) === false);
  // Hotels classify as anchors, but the hours check itself skips Hotel items
  // (decision 2026-06-14), so this only matters if that exemption is lifted.
  assert("a hotel item still produces no closure flag today",
    closureFlag({ type: "Hotel", time: "16:00", restaurant: { name: "La Rapiere" } }) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
