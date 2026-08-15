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

// --- hotel.brand / transport.company must NOT default to a real company ---
// Reported 2026-08-15 from a real generated itinerary: BLANK.hotel.brand
// defaulted to ["Marriott / Bonvoy"] and BLANK.transport.company to "Hertz"
// — real company names pre-filled as if the traveler had chosen them, unlike
// every other free-text/multi-select field in BLANK (which starts genuinely
// empty). A user who never touched these two fields got both silently
// injected into the build prompt as real preferences: a redundant Hertz
// rental with no use case in an itinerary built entirely around private
// transfers, and — worse — a fabricated "Bonvoy points" claim on a hotel
// (Nayara Gardens) with no Marriott affiliation at all.
console.log("\n[hotel.brand / transport.company default to genuinely empty]");
const hotelMatch = SRC.match(/\bhotel:\s*\{([^}]*)\}/);
assert("BLANK.hotel literal found in App.jsx", !!hotelMatch, "could not locate `hotel: { ... }`");
const hotelBody = hotelMatch ? hotelMatch[1] : "";
assert("hotel.brand defaults to an empty array, not a real brand", /\bbrand:\s*\[\]/.test(hotelBody), `got: ${hotelBody}`);
assert("hotel.tier default still empty string", fieldDefault(hotelBody, "tier") === '""', `got: ${fieldDefault(hotelBody, "tier")}`);
assert("hotel.mustHave default still empty string", fieldDefault(hotelBody, "mustHave") === '""', `got: ${fieldDefault(hotelBody, "mustHave")}`);

const transportMatch = SRC.match(/\btransport:\s*\{([^}]*)\}/);
assert("BLANK.transport literal found in App.jsx", !!transportMatch, "could not locate `transport: { ... }`");
const transportBody = transportMatch ? transportMatch[1] : "";
assert("transport.company defaults to an empty string, not a real company", fieldDefault(transportBody, "company") === '""', `got: ${fieldDefault(transportBody, "company")}`);
assert("transport.type default still empty array", /\btype:\s*\[\]/.test(transportBody), `got: ${transportBody}`);
assert("transport.vehicle default still empty string", fieldDefault(transportBody, "vehicle") === '""', `got: ${fieldDefault(transportBody, "vehicle")}`);

// --- The build prompt must warn against fabricating loyalty affiliation ---
// when a specifically-named must-have hotel doesn't match the stated brand
// preference — a defense-in-depth backstop for a traveler who genuinely
// picks a brand AND separately names a hotel outside it.
console.log("\n[build prompt guards against fabricated loyalty claims]");
assert("prompt warns against claiming loyalty-program participation for a mismatched must-have hotel",
  /do not claim, state, or imply that this specific hotel participates in, earns, or redeems points/i.test(SRC),
  "expected the hotel-brand mismatch guard sentence in buildUserPrompt");

// --- The build prompt must connect an unspecified cabin to budget tier ----
console.log("\n[build prompt connects unspecified cabin to budget tier]");
assert("prompt defaults toward Business for an unspecified cabin on a $$$$$ budget",
  /ultra high end.*default to Business class/i.test(SRC),
  "expected the $$$$$ -> Business cabin default sentence in buildUserPrompt");
assert("prompt leans toward Premium Economy/Business for an unspecified cabin on a $$$$ budget",
  /luxury.*lean toward Premium Economy or Business/i.test(SRC),
  "expected the $$$$ -> Premium Economy/Business cabin lean sentence in buildUserPrompt");

// --- Output sections default shape ----------------------------------------
// The default output selection must enable ONLY the day-by-day itinerary;
// every add-on section defaults OFF so the user opts in on the choices panel
// before building (PR #57 invariant). The default literal was centralized into
// src/outputsState.js (DEFAULT_OUTPUTS) so the session-restore path can reuse
// it and a remount no longer silently drops the user's picks — so we assert on
// that source of truth rather than the old inline App.jsx literals.
console.log("\n[outputs defaults — itinerary on, add-ons off]");

const OUTPUT_KEYS = ["itinerary","weather","cost","navigation","logistics","tonight","menus","flags","planb","snobs","practical","badges","pronunciation"];

function outputDefault(body, key) {
  const m = body.match(new RegExp(`\\b${key}\\s*:\\s*(true|false)`));
  return m ? m[1] : undefined;
}

const OUTPUTS_SRC = readFileSync(join(HERE, "..", "src", "outputsState.js"), "utf8");
// Isolate the DEFAULT_OUTPUTS object literal.
const defaultOutputsMatch = OUTPUTS_SRC.match(/DEFAULT_OUTPUTS\s*=\s*Object\.freeze\(\{([^}]*)\}/);
assert("DEFAULT_OUTPUTS literal found in outputsState.js", !!defaultOutputsMatch, "could not locate DEFAULT_OUTPUTS");
const defaultsBody = defaultOutputsMatch ? defaultOutputsMatch[1] : "";
assert("DEFAULT_OUTPUTS: itinerary defaults true", outputDefault(defaultsBody, "itinerary") === "true", `got: ${outputDefault(defaultsBody, "itinerary")}`);
// #4: preselect all sections EXCEPT the last two in display order
// (badges, pronunciation). Everything else defaults ON.
const DEFAULT_OFF = ["badges", "pronunciation"];
for (const key of OUTPUT_KEYS.filter(k => k !== "itinerary")) {
  const want = DEFAULT_OFF.includes(key) ? "false" : "true";
  assert(`DEFAULT_OUTPUTS: ${key} defaults ${want}`, outputDefault(defaultsBody, key) === want, `got: ${outputDefault(defaultsBody, key)}`);
}
// App.jsx must restore outputs from the recovered snapshot (not hardcode them)
// so a remount keeps the user's selection — guard against a regression back to
// an inline defaults literal at the useState initializer.
assert("App.jsx restores outputs via resolveOutputs(recovered…)", /useState\(\(\)\s*=>\s*resolveOutputs\(recovered/.test(SRC), "expected resolveOutputs(recovered?.inputs?.outputs) initializer");
assert("App.jsx persists outputs in the session snapshot", /inputs:\s*\{[^}]*\boutputs\b[^}]*\}/.test(SRC), "expected `outputs` inside the snapshot inputs object");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
