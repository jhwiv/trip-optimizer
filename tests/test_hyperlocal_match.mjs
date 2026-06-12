// Unit tests for matchHyperlocalRegion() — the destination-matching helper
// that decides which hyperlocal source set (if any) to auto-add to the
// Pro Review picker. The function lives inside src/App.jsx (not exported);
// same regex-extract pattern as the other helper tests.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf-8");

// Pull both the HYPERLOCAL_REGIONS table and matchHyperlocalRegion into
// scope by evaling the regex-matched code block. The block starts at
// `const HYPERLOCAL_REGIONS = [` and ends at the closing `}` of
// matchHyperlocalRegion. Anchor at the function's closing brace which
// appears on its own line: `\n}` after `return null;`.
const m = src.match(/const HYPERLOCAL_REGIONS = \[[\s\S]*?function matchHyperlocalRegion\(destination\) \{[\s\S]*?return null;\n\}/);
if (!m) throw new Error("HYPERLOCAL_REGIONS / matchHyperlocalRegion block not found in src/App.jsx");
// eslint-disable-next-line no-eval
eval(`${m[0]}; globalThis.matchHyperlocalRegion = matchHyperlocalRegion; globalThis.HYPERLOCAL_REGIONS = HYPERLOCAL_REGIONS;`);

const { matchHyperlocalRegion, HYPERLOCAL_REGIONS } = globalThis;

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n[A] Lake George positive matches");
{
  assert("'Lake George' bare", matchHyperlocalRegion("Lake George")?.key === "lake_george");
  assert("'Lake George, NY'", matchHyperlocalRegion("Lake George, NY")?.key === "lake_george");
  assert("'lake george' lowercased", matchHyperlocalRegion("lake george")?.key === "lake_george");
  assert("'Bolton Landing'", matchHyperlocalRegion("Bolton Landing")?.key === "lake_george");
  assert("'Bolton Landing, NY'", matchHyperlocalRegion("Bolton Landing, NY")?.key === "lake_george");
  assert("'Bolton, NY' shorthand", matchHyperlocalRegion("Bolton, NY")?.key === "lake_george");
  assert("multi-city string containing Lake George",
    matchHyperlocalRegion("Saratoga Springs Lake George Adirondacks")?.key === "lake_george");
}

console.log("\n[B] Lake George NEGATIVE matches — wrong-state disambiguation");
{
  // Lake George, Michigan is a real (small) lake; should NOT match.
  assert("'Lake George, MI' rejected", matchHyperlocalRegion("Lake George, MI") === null);
  assert("'Lake George Michigan' rejected", matchHyperlocalRegion("Lake George Michigan") === null);
  assert("'Lake George, FL' rejected", matchHyperlocalRegion("Lake George, FL") === null);
  assert("'Lake George, MN' rejected", matchHyperlocalRegion("Lake George, MN") === null);
  // But NY context overrides another state hint (rare edge: address-style strings)
  assert("'Lake George, NY (driving from MI)' still NY",
    matchHyperlocalRegion("Lake George, NY (driving from MI)")?.key === "lake_george");
}

console.log("\n[C] Unrelated destinations don't match");
{
  assert("'Paris' → null", matchHyperlocalRegion("Paris") === null);
  assert("'Aspen, CO' → null", matchHyperlocalRegion("Aspen, CO") === null);
  assert("'Saratoga Springs, NY' → null (no Lake George/Bolton)", matchHyperlocalRegion("Saratoga Springs, NY") === null);
  assert("empty string → null", matchHyperlocalRegion("") === null);
  assert("null → null (defensive)", matchHyperlocalRegion(null) === null);
  assert("undefined → null (defensive)", matchHyperlocalRegion(undefined) === null);
}

console.log("\n[D] Shape of the returned region");
{
  const r = matchHyperlocalRegion("Lake George, NY");
  assert("has key", r?.key === "lake_george");
  assert("has label", typeof r?.label === "string" && r.label.length > 0);
  assert("has sourceIds array", Array.isArray(r?.sourceIds) && r.sourceIds.length === 6);
  assert("sourceIds match server SOURCE_CONFIG keys",
    r?.sourceIds.includes("poststar") &&
    r?.sourceIds.includes("lgexaminer") &&
    r?.sourceIds.includes("adklife") &&
    r?.sourceIds.includes("adkreddit") &&
    r?.sourceIds.includes("visitlg") &&
    r?.sourceIds.includes("lgmirror"));
}

console.log("\n[E] Table integrity");
{
  assert("HYPERLOCAL_REGIONS is an array", Array.isArray(HYPERLOCAL_REGIONS));
  assert("at least one region defined", HYPERLOCAL_REGIONS.length >= 1);
  for (const r of HYPERLOCAL_REGIONS) {
    assert(`region ${r.key} has match()`, typeof r.match === "function");
    assert(`region ${r.key} has sourceIds`, Array.isArray(r.sourceIds) && r.sourceIds.length > 0);
    assert(`region ${r.key} label set`, typeof r.label === "string" && r.label.length > 0);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
