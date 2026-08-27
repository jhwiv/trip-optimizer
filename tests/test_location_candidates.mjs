// Tests for locationCandidates() in functions/api/find.js — the widening
// ladder that turns a freeform typed location into ordered candidate queries.
//
// The reported bug: "Chatham cape cod mass" resolved to nothing, so every
// per-venue Places lookup used that string as the city term and came back
// NOT_FOUND. The ladder has to reach "Chatham, MA" and "cape cod MA" while
// leaving already-well-formed input like "Santa Fe, NM" untouched at the head
// of the list.

import { locationCandidates } from "../functions/api/find.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail === undefined ? "" : detail); }
}

console.log("test_location_candidates.mjs");

// ---- The reported failing query ----
{
  const c = locationCandidates("Chatham cape cod mass");
  assert("raw string is tried first", c[0] === "Chatham cape cod mass", JSON.stringify(c));
  assert(
    "reaches 'Chatham, MA' (leading token + state hint)",
    c.includes("Chatham, MA"),
    JSON.stringify(c),
  );
  assert(
    "reaches 'cape cod MA' (tail read as a region)",
    c.includes("cape cod MA"),
    JSON.stringify(c),
  );
  assert(
    "normalizes the colloquial state token in place",
    c.includes("Chatham cape cod MA"),
    JSON.stringify(c),
  );
  assert("includes the bare locality", c.includes("Chatham"), JSON.stringify(c));
  assert("capped at 5 candidates", c.length <= 5, c.length);
}

// ---- Well-formed input must not be mangled ----
{
  const c = locationCandidates("Santa Fe, NM");
  assert("'Santa Fe, NM' is tried verbatim first", c[0] === "Santa Fe, NM", JSON.stringify(c));
  assert("'Santa Fe, NM' candidates capped at 5", c.length <= 5, c.length);
}
{
  const c = locationCandidates("Chatham, MA");
  assert("'Chatham, MA' tried verbatim first", c[0] === "Chatham, MA", JSON.stringify(c));
  assert(
    "already-correct USPS code recognized as a state token",
    c.includes("Chatham MA"),
    JSON.stringify(c),
  );
}

// ---- A leading token that is itself a state abbreviation ----
// "la jolla ca" must not become "la, CA" — the locality would be the state.
{
  const c = locationCandidates("la jolla ca");
  assert("'la jolla ca' tried verbatim first", c[0] === "la jolla ca", JSON.stringify(c));
  assert("does not produce 'la, CA'", !c.includes("la, CA"), JSON.stringify(c));
}

// ---- Region-only query (symptom #2) ----
{
  const c = locationCandidates("cape cod");
  assert("'cape cod' tried verbatim first", c[0] === "cape cod", JSON.stringify(c));
  assert("no empty-string candidates", c.every((x) => x.length > 0), JSON.stringify(c));
}

// ---- A bare state name must not yield an empty candidate ----
{
  const c = locationCandidates("massachusetts");
  assert("bare state name yields only itself", c.length === 1 && c[0] === "massachusetts", JSON.stringify(c));
}

// ---- Whitespace / empty handling ----
{
  assert("empty string → []", locationCandidates("").length === 0);
  assert("whitespace only → []", locationCandidates("   ").length === 0);
  assert("null → []", locationCandidates(null).length === 0);
  assert("undefined → []", locationCandidates(undefined).length === 0);
}
{
  const c = locationCandidates("  Chatham   cape cod   mass  ");
  assert("runs of whitespace collapsed", c[0] === "Chatham cape cod mass", JSON.stringify(c));
}

// ---- Candidates are unique ----
{
  const c = locationCandidates("Chatham cape cod mass");
  assert("no duplicate candidates", new Set(c).size === c.length, JSON.stringify(c));
}

// ---- Every candidate is capped for any input ----
{
  const inputs = [
    "a b c d mass", "one two three four five six", "Bolton Landing NY",
    "Lake George new york", "Portland ME", "Brooklyn New York",
  ];
  const allCapped = inputs.every((i) => locationCandidates(i).length <= 5);
  assert("every sample input stays within the 5-candidate cap", allCapped);
  const allNonEmpty = inputs.every((i) => locationCandidates(i).every((c) => c.length > 0));
  assert("no sample input produces an empty candidate", allNonEmpty);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
