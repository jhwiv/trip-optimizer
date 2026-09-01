// Tests for src/wazeLinks.js — the ROUTESMITH ITINERARY-QUALITY UPGRADE
// spec's §10 "clickable Waze routing" links.

import { buildWazeUrl, collectWazeLinks } from "../src/wazeLinks.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("\n=== buildWazeUrl ===");
{
  assert("builds a waze.com/ul deep link with the destination URL-encoded",
    buildWazeUrl("Nuremberg, Germany") === "https://waze.com/ul?q=Nuremberg%2C%20Germany&navigate=yes");
  assert("empty string → empty (no link)", buildWazeUrl("") === "");
  assert("null/undefined → empty", buildWazeUrl(null) === "" && buildWazeUrl(undefined) === "");
  assert("whitespace-only → empty", buildWazeUrl("   ") === "");
}

console.log("\n=== collectWazeLinks ===");
{
  const plan = {
    days: [
      {
        items: [
          { time: "08:00", type: "Flight", text: "Fly EWR → LHR nonstop" },
          { time: "10:00", type: "Transport", text: "Drive Bayeux → Nuremberg — 9h 20m via A6" },
          { time: "19:00", type: "Note", text: "Drive to the coast if you have time — 40 min" },
        ],
      },
      {
        items: [
          { time: "09:00", type: "Transport", text: "Taxi hotel → Porto Campanhã station — 10 min" },
          { time: "14:00", type: "Transport", text: "Rental car pickup PMI airport → Santanyí villa — 1h drive (55 km) via Ma-19" },
        ],
      },
    ],
  };
  const links = collectWazeLinks(plan);
  assert("returns a Map", links instanceof Map);
  assert("a real 9h20m drive leg gets a Waze link keyed by day/item index",
    links.has("0:1") && links.get("0:1").includes("waze.com/ul?q="));
  assert("a Flight item never gets a Waze link", !links.has("0:0"));
  assert("a Note item (not Transport) never gets a Waze link", !links.has("0:2"));
  assert("a trivial 10-minute taxi hop is excluded (not 'meaningful')", !links.has("1:0"));
  assert("a second real drive leg on a different day also gets a link",
    links.has("1:1") && links.get("1:1").includes("waze.com/ul?q="));
  assert("only the meaningful legs produce links (2 total across this plan)", links.size === 2);

  const withHint = collectWazeLinks(plan, "France");
  const url = withHint.get("0:1");
  assert("cityHint is folded into the destination text the same way collectDriveLegs already does",
    typeof url === "string" && url.includes(encodeURIComponent("France").slice(0, 3)));

  assert("empty plan is safe", collectWazeLinks({}).size === 0);
  assert("null plan is safe", collectWazeLinks(null).size === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
