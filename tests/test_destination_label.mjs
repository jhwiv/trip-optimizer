// Tests for the build-progress hero's destination label (2026-08-07
// regression). User report: "the hero only shows the first country
// destination... all I see is the word England" on a real London → Paris →
// Normandy → Porto build.
//
// Two independent paths to the same display symptom:
// 1. functions/api/extract-trip.js's schema explicitly instructs the model
//    to put only the FIRST stop in basics.destination for a multi-city
//    narrative ("For multi-city trips, the first stop"). basicsDestinationLabel
//    (src/App.jsx) used to check basics.destination FIRST, so that single
//    leftover string always won — fixed by adding basics.destinations[] to
//    the extraction schema (all stops, in order) and a display-only
//    basics.multiStopHint field the label functions check first.
// 2. The original 2026-08-04 fix (basicsDestinationLabel's very first
//    version) already handled the case where basics.destination is EMPTY
//    and basics.cities[] (the structured multi-city form) is the only
//    source of truth — that half still works and is covered here too.
//
// SAME-DAY REGRESSION, also covered here: the first version of fix #1 wrote
// the extracted stops straight into basics.cities[] (with blank per-city
// nights, since extraction has no way to know the split). basics.cities[] is
// the ONLY field isMultiCity (cities.length > 1) and handleBuild's night-
// count math read — with cities.length > 1, handleBuild sums cities[].nights
// instead of using basics.nights, and an all-blank sum is 0, so a real
// 14-night trip's nightsNum collapsed to 1. The model, still driven by the
// full narrative (unaffected — it's the real source of truth for /api/build),
// wrote toward the actual 14-night trip while budgeted for a 1-night one,
// truncating almost immediately: "No day-by-day plan returned... Got keys:
// destination, meta, cities" (cut off before any days content — exactly the
// build failure this reproduces below). Fix: the multi-stop hint now lives
// in a separate basics.multiStopHint field that NOTHING outside the display
// path reads, so it structurally cannot affect isMultiCity or night math —
// basics.cities[] is only ever populated by the user typing into the
// structured multi-city form, exactly as it worked before 2026-08-07.
//
// basicsDestinationLabel/basicsDestinationList are closures inside
// src/App.jsx and can't be imported directly here (jsdom-free tests) — the
// established convention (see tests/test_itinerary_quality_fixes.mjs,
// tests/test_review_quality_escalation.mjs) is to mirror the pure logic
// locally and test against that mirror. Keep this mirror in sync if the
// App.jsx implementation's shape changes.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function basicsDestinationLabel(basics) {
  const hint = Array.isArray(basics?.multiStopHint) ? basics.multiStopHint.filter(Boolean) : [];
  if (hint.length > 1) return hint.join(" → ");
  const cityNames = Array.isArray(basics?.cities) ? basics.cities.map((c) => c?.name).filter(Boolean) : [];
  if (cityNames.length > 1) return cityNames.join(" → ");
  if (basics?.destination) return basics.destination;
  if (cityNames.length === 1) return cityNames[0];
  return "";
}

function basicsDestinationList(basics) {
  const hint = Array.isArray(basics?.multiStopHint) ? basics.multiStopHint.filter(Boolean) : [];
  if (hint.length > 1) return hint;
  const cityNames = Array.isArray(basics?.cities) ? basics.cities.map((c) => c?.name).filter(Boolean) : [];
  if (cityNames.length > 1) return cityNames;
  if (basics?.destination) return [basics.destination];
  if (cityNames.length === 1) return cityNames;
  return [];
}

// Mirrors the CURRENT (post-regression-fix) extraction-merge logic in
// App.jsx's "Build from this" handler: basics.cities[] is populated ONLY
// the way it always was (mirror destination into cities[0].name, never add
// rows); the multi-stop list goes into the separate, display-only
// multiStopHint field instead.
function mergeBasicsFromExtraction(prevCities, exBasics) {
  const exDestinations = Array.isArray(exBasics.destinations)
    ? exBasics.destinations.map((d) => (typeof d === "string" ? d.trim() : "")).filter(Boolean)
    : [];
  const cities = (prevCities && prevCities.length)
    ? prevCities.map((c, i) => i === 0 ? { ...c, name: exBasics.destination || c.name } : c)
    : [{ name: exBasics.destination || "", nights: "", focus: "" }];
  return { cities, multiStopHint: exDestinations.length > 1 ? exDestinations : undefined };
}

// Mirrors handleBuild's night-count math (src/App.jsx ~line 14090-14092,
// 16020-16024): isMultiCity and the token-budget nightsNum are driven
// SOLELY by basics.cities[] — this is the exact mechanism the regression
// broke, so it's asserted directly here, not just the display output.
function computeNightsNum(basics) {
  const cities = (basics.cities && basics.cities.length > 0) ? basics.cities : [{ name: basics.destination || "", nights: basics.nights || "", focus: "" }];
  const isMultiCity = cities.length > 1;
  const totalNightsBuild = isMultiCity
    ? cities.reduce((sum, c) => sum + (parseInt(c?.nights, 10) || 0), 0)
    : (parseInt(basics.nights || "3", 10) || 3);
  return { isMultiCity, nightsNum: Math.max(1, totalNightsBuild) };
}

console.log("\nbasicsDestinationLabel — multiStopHint takes precedence for display\n");
{
  // The exact reported scenario: extraction set basics.destination to just
  // the first/primary stop ("England"), and the display-only hint carries
  // the real 4-country sequence. basics.cities is left untouched (single
  // entry, as it always was for a narrative-only build).
  const basics = {
    destination: "England",
    cities: [{ name: "England", nights: "", focus: "" }],
    multiStopHint: ["London", "Paris", "Normandy", "Porto"],
  };
  assert('multiStopHint wins over a single leftover destination string ("England")',
    basicsDestinationLabel(basics) === "London → Paris → Normandy → Porto",
    basicsDestinationLabel(basics));
}
{
  // Single-destination trip: destination string alone, no hint, no
  // multi-city cities[] — must still work exactly as before this fix.
  const basics = { destination: "Paris", cities: [] };
  assert("a single-destination trip with no cities[]/hint still returns the destination string",
    basicsDestinationLabel(basics) === "Paris");
}
{
  // Single-destination trip where cities[] mirrors it 1:1 (the common
  // case) — same string either way, no behavior change.
  const basics = { destination: "Paris", cities: [{ name: "Paris" }] };
  assert("a single-city cities[] matching destination still returns just that name",
    basicsDestinationLabel(basics) === "Paris");
}
{
  // 2026-08-04 original fix: destination EMPTY, cities[] the only source of
  // truth (structured multi-city form, real per-city nights typed by the
  // user). Must still work — this is the ONLY path cities[] gets multiple
  // entries through.
  const basics = { destination: "", cities: [{ name: "Kyoto", nights: "3" }, { name: "Osaka", nights: "2" }, { name: "Tokyo", nights: "4" }] };
  assert("an empty destination with populated cities[] still joins all cities (original 2026-08-04 fix)",
    basicsDestinationLabel(basics) === "Kyoto → Osaka → Tokyo");
}
{
  assert("no destination, no cities, no hint → empty string, not a throw",
    basicsDestinationLabel({}) === "");
  assert("null basics → empty string, not a throw",
    basicsDestinationLabel(null) === "");
}
{
  // A one-item hint must not be treated as multi-stop.
  const basics = { destination: "Paris", cities: [{ name: "Paris" }], multiStopHint: ["Paris"] };
  assert("a one-item multiStopHint falls back to normal single-destination display",
    basicsDestinationLabel(basics) === "Paris");
}

console.log("\nbasicsDestinationList — array form for the visually-engaging multi-stop hero render\n");
{
  const basics = { destination: "England", cities: [{ name: "England" }], multiStopHint: ["London", "Paris", "Normandy", "Porto"] };
  const list = basicsDestinationList(basics);
  assert("returns all four stops as an array, not the single leftover destination",
    JSON.stringify(list) === JSON.stringify(["London", "Paris", "Normandy", "Porto"]), JSON.stringify(list));
}
{
  const list = basicsDestinationList({ destination: "Paris", cities: [] });
  assert("single-destination trip returns a one-item array", JSON.stringify(list) === JSON.stringify(["Paris"]));
}
{
  assert("no destination, no cities, no hint → empty array", JSON.stringify(basicsDestinationList({})) === "[]");
}

console.log("\nmergeBasicsFromExtraction — the multi-stop hint is display-only and never touches cities[]\n");
{
  const exBasics = { destination: "London", destinations: ["London", "Paris", "Normandy", "Porto"] };
  const { cities, multiStopHint } = mergeBasicsFromExtraction([], exBasics);
  assert("cities[] stays a single entry even for a 4-stop narrative",
    cities.length === 1 && cities[0].name === "London", JSON.stringify(cities));
  assert("multiStopHint carries all 4 stops instead",
    JSON.stringify(multiStopHint) === JSON.stringify(["London", "Paris", "Normandy", "Porto"]));
}
{
  // Single-destination narrative: destinations[] absent or single-item —
  // no hint at all, cities[] unaffected.
  const exBasics = { destination: "Paris" };
  const { cities, multiStopHint } = mergeBasicsFromExtraction([{ name: "", nights: "", focus: "" }], exBasics);
  assert("a single-destination narrative still produces exactly one city",
    cities.length === 1 && cities[0].name === "Paris", JSON.stringify(cities));
  assert("no multiStopHint for a single-destination narrative", multiStopHint === undefined);
}
{
  const exBasics = { destination: "Rome", destinations: ["Rome"] };
  const { cities, multiStopHint } = mergeBasicsFromExtraction([], exBasics);
  assert("a one-item destinations[] array does not produce a hint",
    multiStopHint === undefined && cities.length === 1 && cities[0].name === "Rome", JSON.stringify({ cities, multiStopHint }));
}
{
  // Previously-entered per-city nights (from the structured form) must
  // survive a re-extraction untouched — cities[] is never overwritten by
  // the hint logic at all beyond the existing city[0] name mirror.
  const prevCities = [{ name: "London", nights: "4", focus: "museums" }, { name: "Paris", nights: "3", focus: "" }];
  const exBasics = { destination: "London", destinations: ["London", "Paris", "Normandy"] };
  const { cities } = mergeBasicsFromExtraction(prevCities, exBasics);
  assert("previously-entered multi-city nights/focus are completely untouched by a re-extraction",
    cities.length === 2 && cities[0].nights === "4" && cities[0].focus === "museums" && cities[1].nights === "3",
    JSON.stringify(cities));
}

console.log("\ncomputeNightsNum — the actual regression: cities[] must never silently zero out the build's night budget\n");
{
  // The exact reproduced failure: narrative extraction detects 3 stops,
  // multiStopHint carries them, cities[] is untouched (single entry,
  // basics.nights = "14" as the user actually specified). Before the fix,
  // cities[] would have gained 3 blank-nights rows here and collapsed
  // nightsNum to 1 — asserted explicitly so this can never silently
  // regress again.
  const basics = { destination: "England", nights: "14", cities: [{ name: "England", nights: "", focus: "" }], multiStopHint: ["England", "France", "Portugal"] };
  const { isMultiCity, nightsNum } = computeNightsNum(basics);
  assert("isMultiCity stays false for a narrative-only multi-stop trip (cities[] has one entry)",
    isMultiCity === false);
  assert("nightsNum reads the real 14 from basics.nights, not a collapsed 1",
    nightsNum === 14, `got ${nightsNum}`);
}
{
  // Negative control: the ORIGINAL (buggy) shape — cities[] WITH multiple
  // blank-nights rows — really does collapse nightsNum to 1. This isn't
  // asserting desired behavior; it's documenting exactly why multiStopHint
  // had to be kept out of cities[] in the first place.
  const buggyBasics = { destination: "England", nights: "14", cities: [{ name: "England", nights: "" }, { name: "France", nights: "" }, { name: "Portugal", nights: "" }] };
  const { isMultiCity, nightsNum } = computeNightsNum(buggyBasics);
  assert("(documents the bug) blank-nights multi-city rows flip isMultiCity true", isMultiCity === true);
  assert("(documents the bug) and collapse nightsNum to 1, not 14", nightsNum === 1, `got ${nightsNum}`);
}
{
  // The legitimate multi-city path (structured form, real per-city nights)
  // must still sum correctly — this is the ORIGINAL working behavior and
  // must not be broken by the fix.
  const basics = { cities: [{ name: "London", nights: "4" }, { name: "Paris", nights: "3" }, { name: "Porto", nights: "4" }] };
  const { isMultiCity, nightsNum } = computeNightsNum(basics);
  assert("a real structured-form multi-city trip is still isMultiCity", isMultiCity === true);
  assert("and still sums real per-city nights correctly (4+3+4=11)", nightsNum === 11, `got ${nightsNum}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
