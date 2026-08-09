// Tests for two new pre-build clarification checks added to
// functions/api/extract-trip.js (2026-08-09, user-requested after tracing
// why "LOT Polish Airlines" kept appearing broken across many rebuilds of
// the same trip — the model was faithfully honoring a user-typed preference
// for an airline that doesn't serve the route, and separately, a must-visit
// venue (Nuremberg Trials Memorial) implied a country (Germany) the
// traveler's own destination list never named):
//
//   1. AIRLINE ROUTE PLAUSIBILITY — extends the existing name_checks
//      mechanism (previously spelling/identity only) to also flag a real,
//      correctly-spelled airline that doesn't plausibly serve any leg of
//      the itinerary. Reuses the existing kind:"airline" UI/resolution path
//      end-to-end — no new UI needed.
//   2. DESTINATION CONSISTENCY — a new destination_notes[] field: when a
//      must-visit implies an unlisted country, the extractor adds it to
//      basics.destinations AND explains the addition here.
//
// This module is a Cloudflare Pages Function with no exported pure
// functions (only the request handler), so — per this file's established
// convention for prompt/schema content — these are source-text assertions
// against the actual system prompt and tool schema, not import-based tests.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "functions", "api", "extract-trip.js"), "utf8");
const APP_SRC = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== AIRLINE ROUTE PLAUSIBILITY — schema + instructions ===");
{
  assert("name_checks description covers route-plausibility, not just spelling",
    SRC.includes("does not plausibly operate on the route(s) this itinerary implies"));
  assert("the reason field's example distinguishes route-plausibility from spelling",
    SRC.includes("route-plausibility issue, not a spelling issue"));
  assert("the candidates field's description covers real carriers for a route-implausible airline",
    SRC.includes("up to 4 real carriers that DO plausibly operate the route(s) instead"));
  assert("a dedicated instruction bullet teaches the check",
    SRC.includes("AIRLINE ROUTE PLAUSIBILITY — CRITICAL, a DIFFERENT check from spelling"));
  assert("the instruction's worked example is the actual reported case (LOT / Newark-London)",
    SRC.includes("LOT Polish Airlines does not operate Newark") && SRC.includes("candidates:['United','British Airways','Virgin Atlantic']"));
  assert("kind enum still includes 'airline' (the check reuses the existing resolution path)",
    /enum:\s*\["hotel",\s*"restaurant",\s*"airline",\s*"activity",\s*"other"\]/.test(SRC));
}

console.log("\n=== DESTINATION CONSISTENCY — schema + instructions ===");
{
  assert("destination_notes field exists in the tool schema",
    SRC.includes("destination_notes: {"));
  assert("destination_notes is a string array",
    /destination_notes:\s*\{\s*type:\s*"array",\s*items:\s*\{\s*type:\s*"string"\s*\}/.test(SRC));
  assert("the field description explains WHEN an entry is added (implied, unlisted country)",
    SRC.includes("clearly located somewhere outside every stop already named"));
  assert("a dedicated instruction bullet teaches the check",
    SRC.includes("DESTINATION CONSISTENCY — CRITICAL"));
  assert("the instruction says to ADD the stop to basics.destinations, not just flag it",
    SRC.includes("ADD that place to basics.destinations in the correct visiting-order position"));
  assert("the instruction's worked example is the actual reported case (Nuremberg / Germany)",
    SRC.includes("Nuremberg Trials Memorial") && SRC.includes("basics.destinations must include Germany"));
}

console.log("\n=== Client-side wiring (src/App.jsx) ===");
{
  assert("destinationNotes state exists",
    APP_SRC.includes("const [destinationNotes, setDestinationNotes] = useState([]);"));
  assert("the extraction response's destination_notes field is read and stored",
    APP_SRC.includes("const exDestinationNotes = Array.isArray(ex.destination_notes)"));
  assert("setDestinationNotes is called with the extracted notes",
    APP_SRC.includes("setDestinationNotes(exDestinationNotes);"));
  assert("destinationNotes is cleared on Reset (does not persist stale notes into a new trip)",
    /setPendingNameChecks\(null\);\s*\n\s*setDestinationNotes\(\[\]\);/.test(APP_SRC));
  assert("PreBuildScreen accepts a destinationNotes prop",
    APP_SRC.includes("destinationNotes,\n}) {") || /function PreBuildScreen\(\{[\s\S]{0,400}destinationNotes,/.test(APP_SRC));
  assert("the banner is informational, not a build gate (renders unconditionally alongside onBuild, not before it)",
    APP_SRC.includes("Added to your destinations"));
  assert("the banner only renders once extraction has actually finished",
    APP_SRC.includes("{!extractingFromGuidelines && Array.isArray(destinationNotes) && destinationNotes.length > 0 && ("));
  assert("the call site passes destinationNotes through to PreBuildScreen",
    /<PreBuildScreen[\s\S]{0,1200}destinationNotes=\{destinationNotes\}/.test(APP_SRC));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
