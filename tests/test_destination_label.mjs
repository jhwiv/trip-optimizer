// Tests for the build-progress hero's destination label (2026-08-07
// regression). User report: "the hero only shows the first country
// destination... all I see is the word England" on a real London → Paris →
// Normandy → Porto build.
//
// Two independent paths to the same symptom:
// 1. functions/api/extract-trip.js's schema explicitly instructs the model
//    to put only the FIRST stop in basics.destination for a multi-city
//    narrative ("For multi-city trips, the first stop"). basicsDestinationLabel
//    (src/App.jsx) used to check basics.destination FIRST, so that single
//    leftover string always won even once basics.cities[] held every real
//    stop — fixed by adding basics.destinations[] to the extraction schema
//    (all stops, in order) and preferring a genuinely multi-city cities[]
//    (2+ named entries) over the single destination string.
// 2. The original 2026-08-04 fix (basicsDestinationLabel's very first
//    version) already handled the case where basics.destination is EMPTY
//    and cities[] is the only source of truth — that half still works and
//    is covered here too so a future edit can't silently regress it.
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
  const cityNames = Array.isArray(basics?.cities) ? basics.cities.map((c) => c?.name).filter(Boolean) : [];
  if (cityNames.length > 1) return cityNames.join(" → ");
  if (basics?.destination) return basics.destination;
  if (cityNames.length === 1) return cityNames[0];
  return "";
}

function basicsDestinationList(basics) {
  const cityNames = Array.isArray(basics?.cities) ? basics.cities.map((c) => c?.name).filter(Boolean) : [];
  if (cityNames.length > 1) return cityNames;
  if (basics?.destination) return [basics.destination];
  if (cityNames.length === 1) return cityNames;
  return [];
}

// Mirrors the extraction-merge logic in App.jsx's "Build from this" handler:
// when exBasics.destinations lists 2+ stops, populate cities[] with all of
// them; otherwise fall back to the pre-existing single-city behavior.
function mergeCitiesFromExtraction(prevCities, exBasics) {
  const exDestinations = Array.isArray(exBasics.destinations)
    ? exBasics.destinations.map((d) => (typeof d === "string" ? d.trim() : "")).filter(Boolean)
    : [];
  if (exDestinations.length > 1) {
    return exDestinations.map((name, i) => ({ name, nights: prevCities?.[i]?.nights || "", focus: prevCities?.[i]?.focus || "" }));
  }
  return (prevCities && prevCities.length)
    ? prevCities.map((c, i) => i === 0 ? { ...c, name: exBasics.destination || c.name } : c)
    : [{ name: exBasics.destination || "", nights: "", focus: "" }];
}

console.log("\nbasicsDestinationLabel — real bug: a populated single-stop destination string used to always beat a full multi-city cities[]\n");
{
  // The exact reported scenario: extraction set basics.destination to just
  // the first/primary stop ("England"), but cities[] (however it got
  // populated) holds the real 4-country sequence.
  const basics = {
    destination: "England",
    cities: [{ name: "London" }, { name: "Paris" }, { name: "Normandy" }, { name: "Porto" }],
  };
  assert('a populated multi-city cities[] wins over a single leftover destination string ("England")',
    basicsDestinationLabel(basics) === "London → Paris → Normandy → Porto",
    basicsDestinationLabel(basics));
}
{
  // Single-destination trip: destination string alone, no cities[] — must
  // still work exactly as before this fix.
  const basics = { destination: "Paris", cities: [] };
  assert("a single-destination trip with no cities[] still returns the destination string",
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
  // truth (structured multi-city form). Must still work.
  const basics = { destination: "", cities: [{ name: "Kyoto" }, { name: "Osaka" }, { name: "Tokyo" }] };
  assert("an empty destination with populated cities[] still joins all cities (original 2026-08-04 fix)",
    basicsDestinationLabel(basics) === "Kyoto → Osaka → Tokyo");
}
{
  assert("no destination, no cities → empty string, not a throw",
    basicsDestinationLabel({}) === "");
  assert("null basics → empty string, not a throw",
    basicsDestinationLabel(null) === "");
}

console.log("\nbasicsDestinationList — array form for the visually-engaging multi-stop hero render\n");
{
  const basics = { destination: "England", cities: [{ name: "London" }, { name: "Paris" }, { name: "Normandy" }, { name: "Porto" }] };
  const list = basicsDestinationList(basics);
  assert("returns all four stops as an array, not the single leftover destination",
    JSON.stringify(list) === JSON.stringify(["London", "Paris", "Normandy", "Porto"]), JSON.stringify(list));
}
{
  const list = basicsDestinationList({ destination: "Paris", cities: [] });
  assert("single-destination trip returns a one-item array", JSON.stringify(list) === JSON.stringify(["Paris"]));
}
{
  assert("no destination, no cities → empty array", JSON.stringify(basicsDestinationList({})) === "[]");
}

console.log("\nmergeCitiesFromExtraction — populating cities[] from a multi-stop narrative extraction\n");
{
  const exBasics = { destination: "London", destinations: ["London", "Paris", "Normandy", "Porto"] };
  const cities = mergeCitiesFromExtraction([], exBasics);
  assert("a 4-stop narrative populates all 4 cities, in order",
    cities.map(c => c.name).join(",") === "London,Paris,Normandy,Porto", JSON.stringify(cities));
}
{
  // Single-destination narrative: destinations[] absent or single-item —
  // must NOT create a padded/duplicated cities[] array.
  const exBasics = { destination: "Paris" };
  const cities = mergeCitiesFromExtraction([{ name: "", nights: "", focus: "" }], exBasics);
  assert("a single-destination narrative still produces exactly one city",
    cities.length === 1 && cities[0].name === "Paris", JSON.stringify(cities));
}
{
  // destinations[] with only one entry (model correctly declined to treat
  // a single-city trip as multi-city) must not be treated as multi-city.
  const exBasics = { destination: "Rome", destinations: ["Rome"] };
  const cities = mergeCitiesFromExtraction([], exBasics);
  assert("a one-item destinations[] array falls back to normal single-city behavior",
    cities.length === 1 && cities[0].name === "Rome", JSON.stringify(cities));
}
{
  // Existing per-city nights/focus the user already typed into the
  // multi-city form must survive a re-extraction that names the same stops.
  const prevCities = [{ name: "London", nights: "4", focus: "museums" }, { name: "Paris", nights: "3", focus: "" }];
  const exBasics = { destination: "London", destinations: ["London", "Paris", "Normandy"] };
  const cities = mergeCitiesFromExtraction(prevCities, exBasics);
  assert("previously-entered nights/focus for existing cities survive a re-extraction",
    cities[0].nights === "4" && cities[0].focus === "museums" && cities[1].nights === "3", JSON.stringify(cities));
  assert("a newly-added third city gets blank nights/focus for the user to fill in",
    cities[2].name === "Normandy" && cities[2].nights === "" && cities[2].focus === "", JSON.stringify(cities));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
