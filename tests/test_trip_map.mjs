// Tests for src/tripMap.js — deriving the ordered city list plotted on the
// PDF's "Trip Map" page (functions/api/trip-map.js is the server-side
// geocode+render half; this file only covers the pure client-side derivation).

import { deriveTripMapCities } from "../src/tripMap.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("\n=== deriveTripMapCities — days[].city as the primary source ===");
{
  const plan = {
    destination: "Should not be used",
    days: [
      { city: "London, England" },
      { city: "London, England" },
      { city: "London, England" },
      { city: "London, England → Normandy, France" },
      { city: "Normandy, France" },
      { city: "Normandy, France" },
      { city: "Porto, Portugal" },
    ],
  };
  const cities = deriveTripMapCities(plan);
  assert("keys off days[].city, not destination",
    cities[0] === "London, England");
  assert("consecutive repeats within a city's stay are collapsed",
    cities.filter((c) => c === "London, England").length === 1);
  assert("an arrow-joined transit day splits into both real endpoints",
    cities.includes("London, England") && cities.includes("Normandy, France"));
  assert("full expected sequence, in visiting order, no consecutive dupes",
    JSON.stringify(cities) === JSON.stringify([
      "London, England", "Normandy, France", "Porto, Portugal",
    ]),
    JSON.stringify(cities));
}

console.log("\n=== deriveTripMapCities — arrow variants ===");
{
  for (const arrow of ["→", "->", "—>", "–>"]) {
    const plan = { days: [{ city: "A" }, { city: `A ${arrow} B` }, { city: "B" }] };
    const cities = deriveTripMapCities(plan);
    assert(`arrow variant "${arrow}" splits correctly`,
      JSON.stringify(cities) === JSON.stringify(["A", "B"]), JSON.stringify(cities));
  }
}

console.log("\n=== deriveTripMapCities — destination fallback when no day.city data ===");
{
  assert("multi-city destination string is arrow-split, not geocoded as one blob",
    JSON.stringify(deriveTripMapCities({ destination: "Santa Fe → Taos → Albuquerque", days: [] })) ===
    JSON.stringify(["Santa Fe", "Taos", "Albuquerque"]));
  assert("single-city destination falls back to a one-element array",
    JSON.stringify(deriveTripMapCities({ destination: "Sedona, AZ", days: [] })) ===
    JSON.stringify(["Sedona, AZ"]));
  assert("days present but every day.city is blank still falls back to destination",
    JSON.stringify(deriveTripMapCities({ destination: "Sedona, AZ", days: [{ city: "" }, { city: null }] })) ===
    JSON.stringify(["Sedona, AZ"]));
}

console.log("\n=== deriveTripMapCities — empty / malformed input is safe ===");
{
  assert("no destination, no days → empty array", deriveTripMapCities({}).length === 0);
  assert("null plan → empty array", deriveTripMapCities(null).length === 0);
  assert("undefined plan → empty array", deriveTripMapCities(undefined).length === 0);
  assert("days not an array → falls back to destination",
    JSON.stringify(deriveTripMapCities({ destination: "Rome", days: "nope" })) === JSON.stringify(["Rome"]));
  assert("non-string day.city entries are skipped, not thrown on",
    JSON.stringify(deriveTripMapCities({ destination: "Rome", days: [{ city: 42 }, { city: {} }] })) === JSON.stringify(["Rome"]));
  assert("whitespace-only destination with no days → empty array",
    deriveTripMapCities({ destination: "   ", days: [] }).length === 0);
}

console.log("\n=== deriveTripMapCities — non-consecutive repeats are NOT collapsed ===");
{
  // A traveler returning to an earlier city later in the trip is a real,
  // legitimate route (e.g. a day trip back to base) — only *consecutive*
  // repeats (the same city's own multi-night stay) get deduped.
  const plan = { days: [{ city: "Paris" }, { city: "Lyon" }, { city: "Paris" }] };
  assert("Paris appears twice — once per real visit, not deduped globally",
    JSON.stringify(deriveTripMapCities(plan)) === JSON.stringify(["Paris", "Lyon", "Paris"]));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
