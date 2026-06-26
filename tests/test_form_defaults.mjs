// Tests for the wizard form's BLANK default state in src/App.jsx.
//
// Why source-text assertions instead of importing the value?
//   BLANK is a local `const` inside the wizard React component in a .jsx
//   file (App.jsx imports react). There is no test harness that can import
//   App.jsx in a plain node script, and the spec explicitly forbids
//   restructuring App.jsx to export it. So we read the source, isolate the
//   `flights: { ... }` literal inside BLANK, and assert on it directly.
//
// What this locks in:
//   1. The home airport default is "EWR" (the change this suite guards).
//   2. The default is a plain string the real airport-code parser accepts.
//   3. NO other flight field default changed (scope guard — spec said touch
//      only the default value of homeAirport).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// --- Isolate the BLANK.flights object literal -----------------------------
// Matches: flights: { homeAirport: "EWR", airline: "", cabin: "", flex: "", noFlight: false },
const flightsMatch = SRC.match(/\bflights:\s*\{([^}]*)\}/);

console.log("\n[BLANK.flights literal located]");
assert("BLANK.flights literal found in App.jsx", !!flightsMatch, "could not locate `flights: { ... }`");

const flightsBody = flightsMatch ? flightsMatch[1] : "";

// Pull individual field defaults out of the literal body.
function fieldDefault(body, key) {
  // key: "value"  OR  key: false  OR  key: ""
  const m = body.match(new RegExp(`${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|true|false|null)`));
  return m ? m[1] : undefined;
}

const homeAirport = fieldDefault(flightsBody, "homeAirport");

console.log("\n[homeAirport default = EWR]");
assert('homeAirport default is the string "EWR"', homeAirport === '"EWR"', `got: ${homeAirport}`);

// --- The default must be parseable by the real airport-code parser --------
// Mirror of extractAirportCode()'s regex in App.jsx (^[A-Za-z]{3}\b).
function extractAirportCode(value) {
  if (!value) return "";
  const m = String(value).trim().match(/^([A-Za-z]{3})\b/);
  return m ? m[1].toUpperCase() : "";
}
const EWR = homeAirport ? JSON.parse(homeAirport) : "";

console.log("\n[default is a usable / editable string]");
assert("default is a non-empty string", typeof EWR === "string" && EWR.length > 0, `typeof=${typeof EWR}`);
assert("default passes extractAirportCode → EWR", extractAirportCode(EWR) === "EWR", `got: ${extractAirportCode(EWR)}`);
assert("default is non-empty so validation gate (.trim()) passes", EWR.trim().length > 0);

// --- Scope guard: no other flight field default was changed ---------------
console.log("\n[scope guard — other flight defaults untouched]");
assert("airline default still empty string", fieldDefault(flightsBody, "airline") === '""', `got: ${fieldDefault(flightsBody, "airline")}`);
assert("cabin default still empty string", fieldDefault(flightsBody, "cabin") === '""', `got: ${fieldDefault(flightsBody, "cabin")}`);
assert("flex default still empty string", fieldDefault(flightsBody, "flex") === '""', `got: ${fieldDefault(flightsBody, "flex")}`);
assert("noFlight default still false", fieldDefault(flightsBody, "noFlight") === "false", `got: ${fieldDefault(flightsBody, "noFlight")}`);

// --- Output sections default shape ----------------------------------------
// The `outputs` useState initializer must default ONLY the day-by-day
// itinerary ON; every add-on section defaults OFF so the user opts in on the
// choices panel before building. The same literal also appears in the trip-open
// reset (setOut(i.outputs || { ... })); both must agree, so we assert on every
// matching literal in the source.
console.log("\n[outputs defaults — itinerary on, add-ons off]");

const OUTPUT_KEYS = ["itinerary","weather","navigation","logistics","tonight","menus","flags","planb","snobs","practical","badges","pronunciation"];

function outputDefault(body, key) {
  const m = body.match(new RegExp(`\\b${key}\\s*:\\s*(true|false)`));
  return m ? m[1] : undefined;
}

// Every outputs literal carries all 12 keys starting with `itinerary:`.
const outputLiterals = SRC.match(/\bitinerary:\s*true,\s*weather:\s*(?:true|false)[^}]*\bpronunciation:\s*(?:true|false)/g) || [];
assert("found outputs default literal(s) in App.jsx", outputLiterals.length >= 2, `found ${outputLiterals.length}`);

outputLiterals.forEach((body, idx) => {
  assert(`literal #${idx + 1}: itinerary defaults true`, outputDefault(body, "itinerary") === "true", `got: ${outputDefault(body, "itinerary")}`);
  for (const key of OUTPUT_KEYS.filter(k => k !== "itinerary")) {
    assert(`literal #${idx + 1}: ${key} defaults false`, outputDefault(body, key) === "false", `got: ${outputDefault(body, key)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
