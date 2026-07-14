// Tests for the two validators added to applyQualityLayer in src/App.jsx
// (RCA bugs G and D1):
//
//   1. City normalization (Bug D1): rewrite model-authored days[i].city
//      to the canonical spelling from inputs.basics.cities, so downstream
//      deriveLegNights groups cities consistently instead of over-
//      fragmenting on decorated variants like "Amsterdam Centraal" or
//      "Amsterdam / Bruges" transit labels.
//
//   2. Day completeness (Bug G): flag any day whose items contain no
//      anchor experience (Activity / Dinner / Lunch / Breakfast / Brunch
//      / Dining / Flight) so the user sees when a day is thin.
//
// Because applyQualityLayer is a large closure inside App.jsx and can't
// be imported directly here (jsdom-free tests), we mirror the two
// validators' pure logic locally and test that. When applyQualityLayer's
// implementation changes shape, keep these mirrors in sync.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// -----------------------------------------------------------------------------
// City normalization mirror (src/App.jsx ~3292-3331)
// -----------------------------------------------------------------------------
function normalizeCities(days, inputs, input = null) {
  const fixes = [];
  const warnings = [];
  if (!Array.isArray(days)) return { days, fixes, warnings };
  // Merge canonical list from inputs.basics.cities (form) + input.cities
  // (plan-emitted). Falls back to inputs.basics.destination for single-city.
  const collected = [];
  if (Array.isArray(inputs?.basics?.cities)) {
    for (const c of inputs.basics.cities) {
      const n = typeof c?.name === "string" ? c.name.trim() : "";
      if (n) collected.push(n);
    }
  }
  if (Array.isArray(input?.cities)) {
    for (const c of input.cities) {
      const n = typeof c?.name === "string" ? c.name.trim() : "";
      if (n) collected.push(n);
    }
  }
  if (collected.length === 0) {
    const dest = typeof inputs?.basics?.destination === "string" ? inputs.basics.destination.trim() : "";
    if (dest) collected.push(dest);
  }
  const seenLower = new Set();
  const canonicalNames = [];
  for (const n of collected) {
    const key = n.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    canonicalNames.push(n);
  }
  if (canonicalNames.length === 0) return { days, fixes, warnings };
  const canonicalLower = canonicalNames.map(n => n.trim().toLowerCase());
  days.forEach((day, dayIdx) => {
    const raw = typeof day?.city === "string" ? day.city.trim() : "";
    if (!raw) return;
    const rawLower = raw.toLowerCase();
    let matchIdx = canonicalLower.indexOf(rawLower);
    if (matchIdx < 0) {
      const ordered = canonicalLower
        .map((n, i) => ({ n, i, len: n.length }))
        .sort((a, b) => b.len - a.len);
      for (const { n, i } of ordered) {
        if (rawLower.includes(n) || n.includes(rawLower)) { matchIdx = i; break; }
      }
    }
    if (matchIdx < 0) {
      warnings.push(`Day ${dayIdx + 1} city "${raw}" not in canonical list (${canonicalNames.join(", ")}) — leg nights may be wrong on the cover`);
      return;
    }
    const canonical = canonicalNames[matchIdx];
    if (raw !== canonical) {
      day.city = canonical;
      fixes.push(`Normalized Day ${dayIdx + 1} city "${raw}" → "${canonical}"`);
    }
  });
  return { days, fixes, warnings };
}

// -----------------------------------------------------------------------------
// Day-completeness mirror (src/App.jsx ~3344-3355)
// -----------------------------------------------------------------------------
function findThinDays(days) {
  const ANCHOR_TYPES = /^(Activity|Dinner|Lunch|Breakfast|Brunch|Dining|Flight)$/i;
  const thin = [];
  if (!Array.isArray(days)) return thin;
  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    const anchorCount = items.filter(it => ANCHOR_TYPES.test(String(it?.type || ""))).length;
    if (anchorCount === 0) thin.push(dayIdx);
  });
  return thin;
}

// -----------------------------------------------------------------------------
// City normalization tests
// -----------------------------------------------------------------------------
console.log("=== City normalization (RCA bug D1) ===");

// Real observed case: Amsterdam→Bruges regen produced "3+1+2+1" leg count
// because the model decorated some day.city values with transit labels.
// After normalization, all Amsterdam-adjacent labels should collapse to
// "Amsterdam" and all Bruges-adjacent labels to "Bruges".
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }, { name: "Bruges" }] } };
  const days = [
    { city: "Amsterdam" },
    { city: "Amsterdam" },
    { city: "Amsterdam" },
    { city: "Amsterdam / Bruges" },  // transit-day label
    { city: "Bruges" },
    { city: "Bruges" },
    { city: "Amsterdam" },
    { city: "Amsterdam" },
  ];
  const { fixes } = normalizeCities(days, inputs);
  assert("transit-day label 'Amsterdam / Bruges' normalized to 'Amsterdam' (first canonical hit)",
    days[3].city === "Amsterdam",
    days[3].city);
  assert("normalization emitted one fix",
    fixes.length === 1 && /Day 4/.test(fixes[0]),
    fixes.join("|"));
}

// Case-insensitive exact match should short-circuit and NOT emit a fix
// (no rewrite needed).
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }] } };
  const days = [{ city: "amsterdam" }, { city: "AMSTERDAM" }, { city: "Amsterdam" }];
  const { fixes } = normalizeCities(days, inputs);
  assert("lowercase 'amsterdam' → 'Amsterdam'", days[0].city === "Amsterdam");
  assert("uppercase 'AMSTERDAM' → 'Amsterdam'", days[1].city === "Amsterdam");
  assert("already-canonical stays untouched", days[2].city === "Amsterdam");
  assert("two fixes emitted (only the two rewrites)",
    fixes.length === 2, `fixes=${fixes.length}`);
}

// Decorated names: canonical contained in raw.
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }, { name: "Bruges" }] } };
  const days = [
    { city: "Amsterdam Centraal" },
    { city: "Amsterdam (AMS)" },
    { city: "Bruges, Belgium" },
  ];
  normalizeCities(days, inputs);
  assert("'Amsterdam Centraal' → 'Amsterdam'", days[0].city === "Amsterdam");
  assert("'Amsterdam (AMS)' → 'Amsterdam'", days[1].city === "Amsterdam");
  assert("'Bruges, Belgium' → 'Bruges'", days[2].city === "Bruges");
}

// Abbreviated names: raw contained in canonical.
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }] } };
  const days = [{ city: "Ams" }];
  normalizeCities(days, inputs);
  assert("'Ams' → 'Amsterdam' (raw contained in canonical)", days[0].city === "Amsterdam");
}

// Off-book cities: not rewritten, warning emitted.
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }, { name: "Bruges" }] } };
  const days = [{ city: "Rotterdam" }];
  const { fixes, warnings } = normalizeCities(days, inputs);
  assert("off-book 'Rotterdam' left untouched", days[0].city === "Rotterdam");
  assert("no fix emitted for off-book city", fixes.length === 0);
  assert("warning emitted naming the off-book value",
    warnings.length === 1 && warnings[0].includes("Rotterdam"),
    warnings.join("|"));
}

// Blank city: left blank, no fix, no warning (deriveLegNights handles blanks separately).
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }] } };
  const days = [{ city: "" }, { city: "   " }, { city: null }, { }];
  const { fixes, warnings } = normalizeCities(days, inputs);
  assert("blank city stays blank", days[0].city === "");
  assert("no fix for blanks", fixes.length === 0);
  assert("no warning for blanks", warnings.length === 0);
}

// Fall back to inputs.basics.destination when cities[] is empty.
{
  const inputs = { basics: { destination: "Amsterdam", cities: [] } };
  const days = [{ city: "amsterdam" }];
  normalizeCities(days, inputs);
  assert("falls back to inputs.basics.destination when cities empty",
    days[0].city === "Amsterdam");
}

// Length-sorted tie-break: longest canonical name wins when both match.
{
  const inputs = { basics: { cities: [{ name: "New" }, { name: "New York" }] } };
  const days = [{ city: "New York City" }];
  normalizeCities(days, inputs);
  assert("'New York City' → 'New York' (longer canonical beats shorter)",
    days[0].city === "New York",
    days[0].city);
}

// No canonical list at all: silent no-op.
{
  const inputs = { basics: {} };
  const days = [{ city: "Amsterdam" }];
  const { fixes, warnings } = normalizeCities(days, inputs);
  assert("no canonical list → no changes", days[0].city === "Amsterdam");
  assert("no canonical list → no fixes", fixes.length === 0);
  assert("no canonical list → no warnings", warnings.length === 0);
}

// Union of inputs.basics.cities + input.cities. Real observed case:
// user narrative extracted only 'Amsterdam' into basics.cities, but the
// LLM plan emitted { cities: [Amsterdam, Bruges] } at the plan level. The
// merged canonical list must include Bruges so 'Bruges, Belgium' normalizes.
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }] } };
  const input = { cities: [{ name: "Amsterdam" }, { name: "Bruges" }] };
  const days = [
    { city: "Amsterdam" },
    { city: "Amsterdam Centraal" },
    { city: "Bruges, Belgium" },
    { city: "Bruges" },
  ];
  const { fixes, warnings } = normalizeCities(days, inputs, input);
  assert("union: 'Amsterdam Centraal' normalizes via basics.cities",
    days[1].city === "Amsterdam", days[1].city);
  assert("union: 'Bruges, Belgium' normalizes via input.cities",
    days[2].city === "Bruges", days[2].city);
  assert("union: no off-book warnings emitted",
    warnings.length === 0, warnings.join("|"));
  assert("union: two fixes emitted", fixes.length === 2, `fixes=${fixes.length}`);
}

// Dedupe: 'Amsterdam' appears in both inputs.basics.cities AND input.cities.
// Only one canonical entry survives.
{
  const inputs = { basics: { cities: [{ name: "Amsterdam" }] } };
  const input = { cities: [{ name: "amsterdam" }, { name: "Bruges" }] };
  const days = [{ city: "AMSTERDAM" }];
  const { fixes } = normalizeCities(days, inputs, input);
  assert("dedupe: first spelling wins (basics.cities 'Amsterdam' beats input.cities 'amsterdam')",
    days[0].city === "Amsterdam", days[0].city);
  assert("dedupe: exactly one fix for 'AMSTERDAM' → 'Amsterdam'",
    fixes.length === 1, `fixes=${fixes.length}`);
}

// -----------------------------------------------------------------------------
// Day-completeness tests
// -----------------------------------------------------------------------------
console.log("=== Day completeness (RCA bug G) ===");

// Real observed case: Amsterdam→Bruges Day 6 had only two NOTE items.
{
  const days = [
    { items: [{ type: "Note", text: "Morning free" }, { type: "Note", text: "Afternoon free" }] },
  ];
  const thin = findThinDays(days);
  assert("day with only Notes → flagged thin",
    thin.length === 1 && thin[0] === 0,
    JSON.stringify(thin));
}

// Day with an Activity: NOT thin.
{
  const days = [
    { items: [{ type: "Activity", text: "Anne Frank House" }, { type: "Note", text: "..." }] },
  ];
  assert("day with Activity → not thin", findThinDays(days).length === 0);
}

// Day with a Dinner: NOT thin.
{
  const days = [{ items: [{ type: "Dinner" }, { type: "Note" }] }];
  assert("day with Dinner → not thin", findThinDays(days).length === 0);
}

// Day with a Flight: NOT thin (arrival/departure days).
{
  const days = [{ items: [{ type: "Flight" }, { type: "Transport" }, { type: "Hotel" }] }];
  assert("day with Flight → not thin", findThinDays(days).length === 0);
}

// Day with only Transport + Hotel: thin (plumbing, no experience).
{
  const days = [{ items: [{ type: "Transport" }, { type: "Hotel" }] }];
  assert("day with only Transport+Hotel → thin",
    findThinDays(days).length === 1);
}

// Case-insensitive matching on type.
{
  const days = [
    { items: [{ type: "activity" }] },
    { items: [{ type: "DINNER" }] },
    { items: [{ type: "Brunch" }] },
  ];
  assert("lowercase 'activity' counts as anchor", findThinDays(days).includes(0) === false);
  assert("uppercase 'DINNER' counts as anchor", findThinDays(days).includes(1) === false);
  assert("mixed-case 'Brunch' counts as anchor", findThinDays(days).includes(2) === false);
}

// Multiple days, mixed thinness.
{
  const days = [
    { items: [{ type: "Activity" }] },           // day 1: fine
    { items: [{ type: "Note" }] },                // day 2: thin
    { items: [{ type: "Dinner" }] },              // day 3: fine
    { items: [{ type: "Note" }, { type: "Transport" }] }, // day 4: thin
  ];
  const thin = findThinDays(days);
  assert("multi-day mixed detection",
    thin.length === 2 && thin[0] === 1 && thin[1] === 3,
    JSON.stringify(thin));
}

// Empty day / no items array.
{
  const days = [{ items: [] }, { }, { items: null }];
  const thin = findThinDays(days);
  assert("empty items array → thin", thin.includes(0));
  assert("missing items key → thin", thin.includes(1));
  assert("null items → thin", thin.includes(2));
}

// Not an array: silent no-op.
{
  assert("null days → empty result", findThinDays(null).length === 0);
  assert("undefined days → empty result", findThinDays(undefined).length === 0);
  assert("non-array days → empty result", findThinDays({ 0: { items: [] } }).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
