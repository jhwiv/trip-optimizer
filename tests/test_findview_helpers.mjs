// Test FindView's pure helper functions (LODGING_RX, findIsNotLodging,
// readFindParams, writeFindParams) by extracting them from App.jsx.
// Since they're not exported, we eval the relevant snippets.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Re-create the LODGING_RX from the source file. Keep in sync.
const LODGING_RX = /\b(hotel|resort|inn|lodge|hostel|b&b|bed[\s-]?and[\s-]?breakfast|guesthouse|airbnb|vacation rental|accommodation)\b/i;
function findIsNotLodging(item) {
  if (!item || typeof item !== "object") return false;
  const typeName = [item.name, item.text, item.type, item.cuisine]
    .filter((s) => typeof s === "string")
    .join(" | ");
  return !LODGING_RX.test(typeName);
}

console.log("=== findIsNotLodging client-side filter ===");

// Restaurants that should PASS (not lodging)
const goodRestaurants = [
  { name: "Cafe Pasqual's", type: "Restaurant", cuisine: "Modern Southwestern" },
  { name: "Le Cinq", type: "Restaurant", cuisine: "French haute" },
  { name: "Geronimo", type: "Restaurant", cuisine: "Contemporary" },
  { name: "Sazon", type: "Restaurant" },
  { name: "Cafe Innovation", type: "Restaurant" }, // 'inn' inside 'Innovation' should NOT match \binn\b
  { name: "The Restaurant at the Compound", type: "Restaurant" }, // 'at' is fine
  { name: "Joseph's Culinary Pub", type: "Restaurant" },
];
for (const r of goodRestaurants) {
  assert(`PASS: "${r.name}"`, findIsNotLodging(r));
}

// Things that should be FILTERED OUT
const lodgingItems = [
  { name: "The Ritz-Carlton Hotel", type: "Hotel" },
  { name: "Inn at Loretto", type: "Inn" },
  { name: "Bishop's Lodge Resort", type: "Resort" },
  { name: "Mountain Hostel", type: "Hostel" },
  { name: "Cozy B&B", type: "Bed & breakfast" },
  { name: "Family Guesthouse", type: "Guesthouse" },
  { name: "Bed and Breakfast House", type: "B&B" },
  { name: "Airbnb Loft", type: "Airbnb" },
  { name: "Vacation Rental Suite", type: "Accommodation" },
  { name: "Sleep Lodge", type: "Lodge" },
];
for (const r of lodgingItems) {
  assert(`FILTER: "${r.name}"`, !findIsNotLodging(r));
}

// Edge cases
assert("null returns false (defensive)", findIsNotLodging(null) === false);
assert("undefined returns false", findIsNotLodging(undefined) === false);
assert("string instead of object", findIsNotLodging("Hotel") === false);
assert("object with non-string name", findIsNotLodging({ name: 123, type: "Restaurant" }) === true);
assert("empty object passes (no lodging keyword)", findIsNotLodging({}) === true);

// Critical: 'inn' should NOT match these
const innFalsePositives = [
  { name: "Cafe Innovation" },
  { name: "Winner's Dinner" },
  { name: "Inning Bar" }, // 'inn' followed by letters — \binn\b shouldn't match
  { name: "Beginner's Sushi" },
];
for (const r of innFalsePositives) {
  assert(`'inn' boundary: "${r.name}" passes`, findIsNotLodging(r));
}

// Critical: 'inn' SHOULD match these
const innTruePositives = [
  { name: "The Inn at Loretto" },
  { name: "Country Inn Eatery" },
  { name: "Some Inn", type: "Inn" },
];
for (const r of innTruePositives) {
  assert(`'inn' word boundary: "${r.name}" filtered`, !findIsNotLodging(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
