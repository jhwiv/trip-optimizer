// Tests for the ambiguous-city-name disambiguation instruction added to
// TRIP_PLAN_TOOL's schema (2026-09-02), the generation-time half of the
// KNOWN FAILURE MODE #24 fix. The deterministic backstop
// (stripLocationMismatchedProviders, src/localProviders.js — see
// tests/test_local_providers.mjs) already fully covers the reported Lagos,
// Nigeria / Lagos, Portugal mixup regardless of what the model writes; this
// closes the other half of the gap — a bare, internationally-ambiguous city
// name (no country/state) reaching plan.cities[].name / days[].city in the
// first place, which is what fed the wrong-country search downstream.
//
// TRIP_PLAN_TOOL and DAY_SCHEMA are const declarations inside src/App.jsx
// with no export — per this file's established convention for prompt/
// schema content that can't be imported directly, these are source-text
// assertions against the actual schema descriptions, not import-based
// tests. Model COMPLIANCE with this instruction is unverifiable in this
// sandbox (no live ANTHROPIC_API_KEY) — this only proves the instruction
// text reaches the schema, matching every other prompt-only fix in
// CLAUDE.md's KNOWN FAILURE MODE history.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== TRIP_PLAN_TOOL.cities[].name — disambiguation instruction ===");
{
  const citiesNameDesc = 'name: { type: "string", description: "City name as the user entered it';
  const idx = APP_SRC.indexOf(citiesNameDesc);
  assert("cities[].name field exists", idx !== -1);
  const field = APP_SRC.slice(idx, idx + 700);
  assert("instructs disambiguating a same-named-elsewhere city with country/state",
    /share.{0,20}name with a much more prominent/.test(field), field);
  assert("uses the real reported Lagos, Portugal vs. Nigeria example",
    field.includes("Lagos") && field.includes("Portugal") && field.includes("Nigeria"), field);
  assert("explains WHY — the name feeds a downstream search",
    field.includes("used downstream to search for real local businesses"), field);
  assert("explicit worked example of the correct format",
    field.includes("'Lagos, Portugal', not bare 'Lagos'"), field);
}

console.log("\n=== DAY_SCHEMA.city — disambiguation instruction ===");
{
  const dayCityDesc = 'city: { type: "string", description: "Which city this day belongs to';
  const idx = APP_SRC.indexOf(dayCityDesc);
  assert("days[].city field exists", idx !== -1);
  const field = APP_SRC.slice(idx, idx + 700);
  assert("instructs disambiguating a same-named-elsewhere city with country/state",
    /share.{0,20}with a much more prominent|shared with a much more prominent/.test(field), field);
  assert("uses the real reported Lagos, Portugal vs. Nigeria example",
    field.includes("Lagos") && field.includes("Portugal") && field.includes("Nigeria"), field);
  assert("existing transit-day 'From→To' instruction is untouched",
    field.includes("Transit days that span two cities use 'From→To' format"), field);
}

console.log("\n=== both fields name other real international name collisions, not just Lagos ===");
{
  // A worked example that ONLY ever mentions Lagos would risk being read as
  // "the Lagos case specifically" rather than a general rule — both fields
  // should list several other well-known collisions so the instruction
  // generalizes.
  const otherCities = ["Cambridge", "Valencia", "Birmingham", "Manchester", "Vienna"];
  for (const label of ["cities[].name", "days[].city"]) {
    const marker = label === "cities[].name"
      ? 'name: { type: "string", description: "City name as the user entered it'
      : 'city: { type: "string", description: "Which city this day belongs to';
    const idx = APP_SRC.indexOf(marker);
    const field = APP_SRC.slice(idx, idx + 700);
    const coverage = otherCities.filter((c) => field.includes(c));
    assert(`${label} names multiple other real collisions beyond Lagos (found ${coverage.length}/5)`,
      coverage.length >= 3, coverage.join(","));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
