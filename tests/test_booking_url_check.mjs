// Tests for src/bookingUrlCheck.js (report bug 5, validator V5).
//
// The 2026-07-28 build shipped a Viator "Book ↗" button pointing at
//   https://www.viator.com/tours/Lisbon/…/d538-123456LISBONWW2
// Real host, nearly-right path, 404. The liveness probe only rewrote the
// on-screen href to a Google search; the plan object kept the fabricated link
// and the PDF printed it.
//
// Two things are proven here: the structural check catches the fabrication
// with no network at all, and a dead-link verdict strips the URL out of the
// plan object rather than only out of the DOM.

import { classifyBookingUrl, findImplausibleBookingUrls, stripDeadBookingUrls } from "../src/bookingUrlCheck.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const FABRICATED = "https://www.viator.com/tours/Lisbon/Lisbon-WWII-History-Tour/d538-123456LISBONWW2";
const REAL_VIATOR = "https://www.viator.com/tours/London/Tower-of-London/d737-25289P1";

console.log("=== classifyBookingUrl — the three brief cases ===");
{
  assert("a real Viator product code is ok",
    classifyBookingUrl(REAL_VIATOR).status === "ok", JSON.stringify(classifyBookingUrl(REAL_VIATOR)));
  assert("the fabricated Viator code is implausible",
    classifyBookingUrl(FABRICATED).status === "implausible", JSON.stringify(classifyBookingUrl(FABRICATED)));
  assert("an operator we have no rule for is unknown, never implausible",
    classifyBookingUrl("https://example.com/tour").status === "unknown",
    JSON.stringify(classifyBookingUrl("https://example.com/tour")));
  assert("the implausible verdict explains the expected shape",
    /d538-25289P1|d<destination>/.test(classifyBookingUrl(FABRICATED).reason || ""),
    classifyBookingUrl(FABRICATED).reason);
  assert("the host is reported back", classifyBookingUrl(FABRICATED).host === "www.viator.com");
}

console.log("\n=== classifyBookingUrl — per-vendor grammar ===");
{
  const ok = (url) => classifyBookingUrl(url).status === "ok";
  const bad = (url) => classifyBookingUrl(url).status === "implausible";

  assert("Viator with a trailing slash is ok", ok("https://www.viator.com/tours/Paris/Louvre/d479-5657P1/"));
  assert("Viator with a query string is ok", ok("https://www.viator.com/tours/Rome/Colosseum/d511-3731?mcid=1"));
  assert("Viator missing the product segment is implausible", bad("https://www.viator.com/tours/Lisbon/wwii-history-tour"));

  assert("GetYourGuide tour id is ok", ok("https://www.getyourguide.com/london-l57/tower-of-london-t23644"));
  assert("GetYourGuide location id alone is ok", ok("https://www.getyourguide.com/london-l57"));
  assert("GetYourGuide .co.uk domain is recognized", ok("https://www.getyourguide.co.uk/lisbon-l42/fado-night-t99"));
  assert("GetYourGuide with no id is implausible", bad("https://www.getyourguide.com/lisbon/wwii-tour"));

  assert("Tiqets -p id is ok", ok("https://www.tiqets.com/en/lisbon-attractions/oceanario-p974116"));
  assert("Tiqets numeric path is ok", ok("https://www.tiqets.com/en/products/974116"));
  assert("Tiqets with no id is implausible", bad("https://www.tiqets.com/en/lisbon/oceanario"));

  assert("OpenTable /r/ slug is ok", ok("https://www.opentable.com/r/la-rapiere-bayeux"));
  assert("OpenTable restref query is ok", ok("https://www.opentable.com/booking/view?restref=123456"));
  assert("OpenTable bare host is implausible", bad("https://www.opentable.com/reserve"));

  assert("Resy city/venue path is ok", ok("https://resy.com/cities/ams/de-kas"));
  assert("Resy legacy venues path is ok", ok("https://resy.com/cities/ny/venues/lilia"));
  assert("Resy bare host is implausible", bad("https://resy.com/reserve-a-table"));
}

console.log("\n=== classifyBookingUrl — degenerate input is never implausible ===");
{
  const unknown = (v) => classifyBookingUrl(v).status === "unknown";
  assert("null is unknown", unknown(null));
  assert("empty string is unknown", unknown("   "));
  assert("non-string is unknown", unknown(42));
  assert("garbage is unknown", unknown("not a url at all"));
  assert("a non-http scheme is unknown", unknown("javascript:alert(1)"));
  assert("a mailto link is unknown", unknown("mailto:book@restaurant.example"));
  // Blocking export on a link we can't even parse would be the wrong remedy:
  // the point of the flag is "this looks fabricated", not "this looks odd".
  assert("no degenerate input produces a block",
    findImplausibleBookingUrls({ days: [{ items: [{ type: "Activity", contact: { booking_url: "not a url" } }] }] }).length === 0);
}

console.log("\n=== findImplausibleBookingUrls ===");
{
  const plan = {
    days: [
      { day: 1, items: [{ type: "Activity", text: "Tower of London", contact: { booking_url: REAL_VIATOR } }] },
      { day: 2, items: [{ type: "Activity", text: "Lisbon WWII History Tour", contact: { booking_url: FABRICATED } }] },
    ],
  };
  const hits = findImplausibleBookingUrls(plan);
  assert("only the fabricated link is flagged", hits.length === 1, JSON.stringify(hits));
  assert("code is BOOKING_URL_IMPLAUSIBLE", hits[0]?.code === "BOOKING_URL_IMPLAUSIBLE");
  assert("severity is block — a fabricated link is a fabricated fact", hits[0]?.severity === "block");
  assert("dayIdx is 0-based", hits[0]?.dayIdx === 1);
  assert("day is 1-based and numeric", hits[0]?.day === 2, JSON.stringify(hits[0]?.day));
  assert("target names the item", hits[0]?.target === "Lisbon WWII History Tour", hits[0]?.target);
  assert("message quotes the URL", (hits[0]?.message || "").includes(FABRICATED));

  const everywhere = {
    days: [{
      day: 1,
      items: [
        { type: "Flight", text: "UA934", flight: { booking_url: FABRICATED } },
        { type: "Dinner", restaurant: { name: "La Rapiere", contact: { booking_url: "https://www.opentable.com/reserve" }, reservation: { url: "https://resy.com/book-now" }, backup: { name: "Le Petit Normand", reservation: { url: "https://resy.com/also-fake" } } } },
      ],
    }],
  };
  const all = findImplausibleBookingUrls(everywhere);
  assert("flight, restaurant, reservation and backup links are all walked",
    all.length === 4, JSON.stringify(all.map(f => f.target)));
  assert("the backup restaurant is named as its own target",
    all.some(f => f.target === "Le Petit Normand"), JSON.stringify(all.map(f => f.target)));

  assert("null plan → []", findImplausibleBookingUrls(null).length === 0);
  assert("no days → []", findImplausibleBookingUrls({}).length === 0);
  assert("items without contacts → []",
    findImplausibleBookingUrls({ days: [{ items: [{ type: "Activity", text: "Walk" }] }] }).length === 0);
}

console.log("\n=== stripDeadBookingUrls ===");
{
  const DEAD = "https://www.opentable.com/r/la-rapiere-bayeux";
  const LIVE = "https://resy.com/cities/ams/de-kas";
  const plan = {
    days: [{
      day: 1,
      items: [
        { type: "Dinner", text: "Dinner", restaurant: { name: "La Rapiere", contact: { booking_url: DEAD, phone: "+33 2 31 21 05 45" } } },
        { type: "Dinner", text: "Dinner", restaurant: { name: "De Kas", reservation: { url: LIVE, platform: "resy" } } },
      ],
    }],
  };
  const status = new Map([[DEAD, "dead"], [LIVE, "ok"]]);
  const { data, flags, removed } = stripDeadBookingUrls(plan, status);

  assert("the dead link is gone from the plan object",
    data.days[0].items[0].restaurant.contact.booking_url === undefined,
    JSON.stringify(data.days[0].items[0].restaurant.contact));
  assert("the rest of the contact survives",
    data.days[0].items[0].restaurant.contact.phone === "+33 2 31 21 05 45");
  assert("the live link is untouched", data.days[0].items[1].restaurant.reservation.url === LIVE);
  assert("the input plan is not mutated", plan.days[0].items[0].restaurant.contact.booking_url === DEAD);
  assert("the removal is reported", removed.length === 1 && removed[0] === DEAD, JSON.stringify(removed));

  assert("one BOOKING_URL_DEAD flag", flags.length === 1, JSON.stringify(flags));
  assert("severity is warn — stripping is the remedy", flags[0]?.severity === "warn");
  assert("code is BOOKING_URL_DEAD", flags[0]?.code === "BOOKING_URL_DEAD");
  assert("day is 1-based and numeric", flags[0]?.day === 1);
  assert("the flag names the venue", flags[0]?.target === "La Rapiere");

  const untouched = stripDeadBookingUrls(plan, new Map([[DEAD, "ok"], [LIVE, "ok"]]));
  assert("nothing dead → the same object reference back", untouched.data === plan);
  assert("nothing dead → no flags", untouched.flags.length === 0);

  const pending = stripDeadBookingUrls(plan, new Map());
  assert("an unknown verdict is not treated as dead", pending.data === plan, JSON.stringify(pending.removed));

  assert("null status is safe", stripDeadBookingUrls(plan, null).data === plan);
  assert("null plan is safe", stripDeadBookingUrls(null, status).data === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
