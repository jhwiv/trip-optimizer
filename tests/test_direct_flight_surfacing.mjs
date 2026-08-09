// Tests for explicit "no direct flights" surfacing across all three plan
// renderers (live app FlightCard, PDF, web export). User-requested
// (2026-08-09): "the app should attempt to find direct flights [already
// true — see the CARRIER SELECTION / route-search rules in the build
// prompt]. If no direct flights available, it should surface that in the
// itinerary information to specifically say no direct flights."
//
// Before this fix, a connecting flight was labeled only "Connecting" (live
// app) or "· via LHR" (PDF) — true but not explicit — and webExport didn't
// show stop status at all. All three now say "No direct flights" plainly
// when flight.nonstop is false.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildWebApp } from "../src/webExport.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== FlightCard (src/App.jsx) — source wiring ===");
{
  assert("stopLabel says 'No direct flights' when a connection airport is known",
    APP_SRC.includes('`No direct flights — connect via ${f.connection}`'));
  assert("stopLabel says 'No direct flights' when no connection airport is known",
    APP_SRC.includes('"No direct flights — connecting"'));
  assert("Nonstop label is unchanged", APP_SRC.includes('f.nonstop ? "Nonstop"'));
}

console.log("\n=== PDF (src/pdf/itineraryPdf.js) — mirror of the headline stop-status segment ===");
{
  // renderFlightBlock draws to a jsPDF context, so (per this file's
  // established convention — see tests/test_flight_verify_trusted.mjs) the
  // stop-status segment is tested as a pure mirror rather than rendered.
  function stopSegment(fl) {
    return fl.nonstop ? "· nonstop" : (fl.connection ? `· no direct flights, via ${fl.connection}` : "· no direct flights");
  }
  assert("nonstop flight says '· nonstop'", stopSegment({ nonstop: true }) === "· nonstop");
  assert("connecting flight with a known connection airport names it",
    stopSegment({ nonstop: false, connection: "FRA" }) === "· no direct flights, via FRA");
  assert("connecting flight with no known connection airport still says 'no direct flights'",
    stopSegment({ nonstop: false, connection: null }) === "· no direct flights");

  const PDF_SRC = readFileSync(join(HERE, "..", "src", "pdf", "itineraryPdf.js"), "utf8");
  assert("the actual source matches the mirror above",
    PDF_SRC.includes('fl.nonstop ? "· nonstop" : (fl.connection ? `· no direct flights, via ${fl.connection}` : "· no direct flights")'));
}

console.log("\n=== Web export (src/webExport.js) — buildWebApp output ===");
{
  const basePlan = {
    destination: "Nuremberg",
    meta: "1 night",
    introduction: { arc: "x", differentiators: "NONE_FLAGGED" },
    days: [
      {
        label: "Day 1 · Sat Oct 10 · Arrive Nuremberg",
        city: "Nuremberg",
        headline: "x",
        items: [
          {
            type: "Flight", time: "10:40", text: "Fly Nuremberg → Porto",
            flight: {
              carrier: "TAP Air Portugal", flight_number: "TP123",
              from_airport: "NUE", to_airport: "OPO",
              depart_time: "10:40", arrive_time: "14:15",
              nonstop: false, connection: "FRA",
            },
          },
        ],
      },
    ],
  };
  const htmlConnecting = buildWebApp(basePlan, {});
  assert("a connecting flight explicitly says 'No direct flights' in the export",
    htmlConnecting.includes("No direct flights — connect via FRA"));

  const noConnectionKnown = JSON.parse(JSON.stringify(basePlan));
  noConnectionKnown.days[0].items[0].flight.connection = null;
  const htmlNoConn = buildWebApp(noConnectionKnown, {});
  assert("a connecting flight with no known connection airport still says 'No direct flights'",
    htmlNoConn.includes("No direct flights") && !htmlNoConn.includes("connect via null"));

  const nonstopPlan = JSON.parse(JSON.stringify(basePlan));
  nonstopPlan.days[0].items[0].flight.nonstop = true;
  nonstopPlan.days[0].items[0].flight.connection = null;
  const htmlNonstop = buildWebApp(nonstopPlan, {});
  assert("a nonstop flight says 'Nonstop', not 'No direct flights'",
    htmlNonstop.includes("Nonstop") && !htmlNonstop.includes("No direct flights"));

  const noFlightObjectPlan = JSON.parse(JSON.stringify(basePlan));
  noFlightObjectPlan.days[0].items[0].flight = null;
  const htmlNoFlight = buildWebApp(noFlightObjectPlan, {});
  assert("an item with no flight object at all doesn't crash and shows no stop status",
    !htmlNoFlight.includes("No direct flights") && !htmlNoFlight.includes("undefined"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
