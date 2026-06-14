// Tests for the name-similarity guard in functions/api/places-verify.js
//
// Two layers:
//   1. Pure helpers: normalizeNameForCompare, diceCoefficient, isSimilarEnough.
//   2. Integration: verifyOneVenue with mocked fetch — when Places
//      returns a fuzzy non-match, the venue should resolve to
//      { found:false, error:'not-found', reason:'name-mismatch' } and
//      NEVER call Place Details (saves a billed API call).

import {
  normalizeNameForCompare,
  diceCoefficient,
  isSimilarEnough,
  verifyOneVenue,
} from "../functions/api/places-verify.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

// =========================================================
// normalizeNameForCompare
// =========================================================
console.log("\n[normalizeNameForCompare]");
assert("strips diacritics", normalizeNameForCompare("Café Sabarsky") === "sabarsky");
assert("drops 'the'", normalizeNameForCompare("The Waterhouse") === "waterhouse");
assert("drops 'restaurant'", normalizeNameForCompare("Waterhouse Restaurant") === "waterhouse");
assert("drops 'museum'", normalizeNameForCompare("Loretto Chapel Museum") === "loretto chapel");
assert("drops 'hotel'", normalizeNameForCompare("Aman Venice Hotel") === "aman venice");
assert("collapses punctuation", normalizeNameForCompare("Tune-Up Café!") === "tune up");
assert("collapses whitespace", normalizeNameForCompare("  Geronimo   ") === "geronimo");
assert("preserves alphanumeric", normalizeNameForCompare("Studio 54") === "studio 54");
assert("empty input → empty", normalizeNameForCompare("") === "");
assert("non-string → empty", normalizeNameForCompare(null) === "");
assert("all-stopword → empty", normalizeNameForCompare("The Restaurant") === "");

// =========================================================
// diceCoefficient
// =========================================================
console.log("\n[diceCoefficient]");
assert("identical → 1.0", diceCoefficient("geronimo", "geronimo") === 1.0);
assert("empty → 0", diceCoefficient("", "geronimo") === 0);
assert("zero overlap → 0", diceCoefficient("abc", "xyz") === 0);
assert("partial overlap > 0", diceCoefficient("waterhouse", "waterhous") > 0.8);
// Sanity: two completely different strings score very low.
{
  const score = diceCoefficient("roxanich", "tune up");
  assert("'roxanich' vs 'tune up' < 0.2", score < 0.2, `got ${score.toFixed(3)}`);
}

// =========================================================
// isSimilarEnough — the cases that matter
// =========================================================
console.log("\n[isSimilarEnough — PASS cases (real-world venue extensions)]");
assert("exact match", isSimilarEnough("Geronimo", "Geronimo"));
assert("Loretto Chapel → Loretto Chapel Museum", isSimilarEnough("Loretto Chapel", "Loretto Chapel Museum"));
assert("The Waterhouse → Waterhouse Restaurant", isSimilarEnough("The Waterhouse", "Waterhouse Restaurant"));
assert("Café Sabarsky → Cafe Sabarsky (accents)", isSimilarEnough("Café Sabarsky", "Cafe Sabarsky"));
assert("Aman Venice → Aman Venice Hotel", isSimilarEnough("Aman Venice", "Aman Venice Hotel"));
assert("Meow Wolf → Meow Wolf Santa Fe", isSimilarEnough("Meow Wolf", "Meow Wolf Santa Fe"));
assert("case-insensitive", isSimilarEnough("GERONIMO", "geronimo"));
assert("extra whitespace", isSimilarEnough("  Geronimo  ", "Geronimo"));
assert("apostrophe variation", isSimilarEnough("Joe's Diner", "Joes Diner"));

console.log("\n[isSimilarEnough — BLOCK cases (the failures we want to catch)]");
{
  const r = isSimilarEnough("Some Place That Does Not Exist 9z9z", "Tune-Up Café");
  assert("garbage query → real café BLOCKED", r === false);
}
{
  const r = isSimilarEnough("Roxanich", "Tune-Up Café");
  assert("invented name → unrelated café BLOCKED", r === false);
}
{
  const r = isSimilarEnough("Almayer", "Some Other Place");
  assert("Almayer-class hallucination BLOCKED", r === false);
}
{
  const r = isSimilarEnough("Restaurant Divino", "Restaurant Other Thing");
  assert("stoplist-only match BLOCKED ('Restaurant' is dropped, leaving nothing in common)", r === false);
}

console.log("\n[isSimilarEnough — edge cases]");
assert("empty query → false", !isSimilarEnough("", "Real Place"));
assert("empty resolved → false", !isSimilarEnough("Query", ""));
assert("both empty → false", !isSimilarEnough("", ""));
assert("null inputs → false", !isSimilarEnough(null, null));

// =========================================================
// Integration: verifyOneVenue with name-mismatch guard
// =========================================================
console.log("\n[verifyOneVenue — name-mismatch causes not-found, no Details call]");

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAILS_PREFIX = "https://places.googleapis.com/v1/places/";

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

{
  // Garbage query → Places returns Tune-Up Café (fuzzy match)
  let detailsCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === TEXT_SEARCH_URL) {
      return new Response(JSON.stringify({
        places: [{
          id: "id_tune_up",
          displayName: { text: "Tune-Up Café" },
          location: { latitude: 35.68, longitude: -105.96 },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(DETAILS_PREFIX)) {
      detailsCalled = true;
      return new Response(JSON.stringify({ id: "id_tune_up", displayName: { text: "Tune-Up Café" } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Unexpected: " + url);
  };

  const kv = makeKV();
  const result = await verifyOneVenue({
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    name: "Some Place That Does Not Exist 9z9z",
    city: "Santa Fe",
  });

  assert("found: false", result.found === false);
  assert("error: not-found", result.error === "not-found");
  assert("reason: name-mismatch", result.reason === "name-mismatch");
  assert("resolved_name surfaced", result.resolved_name === "Tune-Up Café");
  assert("Place Details NEVER called (cost saving)", detailsCalled === false);
  await new Promise((r) => setTimeout(r, 30));
  assert("name-mismatch IS cached (definitive answer)", kv._store.size === 1);

  globalThis.fetch = originalFetch;
}

{
  // Real venue → similar enough → proceed to Details
  let detailsCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === TEXT_SEARCH_URL) {
      return new Response(JSON.stringify({
        places: [{
          id: "id_loretto",
          displayName: { text: "Loretto Chapel Museum" },
          location: { latitude: 35.68, longitude: -105.93 },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(DETAILS_PREFIX)) {
      detailsCalled = true;
      return new Response(JSON.stringify({
        id: "id_loretto",
        displayName: { text: "Loretto Chapel Museum" },
        formattedAddress: "207 Old Santa Fe Trail",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Unexpected: " + url);
  };

  const result = await verifyOneVenue({
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    name: "Loretto Chapel",
    city: "Santa Fe",
  });

  assert("legit Places extension still works", result.found === true);
  assert("Place Details was called", detailsCalled === true);
  assert("address from Details surfaced", result.address === "207 Old Santa Fe Trail");

  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
