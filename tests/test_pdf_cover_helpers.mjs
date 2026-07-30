// Tests for the pure cover/room helpers in src/pdf/itineraryPdf.js:
//   • normalizeRoomType   — bug #5 (Hoxton room-category brand map)
//   • deriveLegNights      — bug #6 (real per-leg nights breakdown)
//   • rewriteMetaNights    — bug #6 (rewrite misleading "(6+1)" token)
//   • deriveTransportSummary — bug #7 (modes actually used; rental only if real)
//
// These are pure functions; jsPDF is dynamically imported only inside the
// builder, so importing the module here does not require a DOM.

import {
  normalizeRoomType,
  deriveLegNights,
  deriveCityNights,
  rewriteMetaNights,
  deriveTransportSummary,
  markdownToProse,
} from "../src/pdf/itineraryPdf.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== normalizeRoomType (#5) ===");
{
  const out = normalizeRoomType("The Hoxton, Amsterdam", "Roomy or Biggy room (canal view upgrade recommended)");
  assert('quotes "Roomy"', /"Roomy"/.test(out), out);
  assert('quotes "Biggy"', /"Biggy"/.test(out), out);
  assert('"room" → "room category"', /room category/.test(out), out);
  assert("parenthetical becomes (request canal view)", /\(request canal view\)/.test(out), out);
  assert("no leftover 'upgrade recommended'", !/upgrade recommended/.test(out), out);
}
assert("non-Hoxton hotel left untouched", normalizeRoomType("Marriott Downtown", "Roomy suite") === "Roomy suite");
assert("empty room type passed through", normalizeRoomType("The Hoxton", "") === "");
assert("case-insensitive brand match", /"Cosy"/.test(normalizeRoomType("the hoxton southwark", "Cosy room")));

console.log("=== deriveLegNights (#6) ===");
{
  // 8 days: Amsterdam x5 then Bruges x3, final day is departure.
  const days = [
    ...Array(5).fill({ city: "Amsterdam" }),
    ...Array(3).fill({ city: "Bruges" }),
  ];
  const legs = deriveLegNights({ days });
  assert("two legs derived", Array.isArray(legs) && legs.length === 2, JSON.stringify(legs));
  assert("Amsterdam 5 nights", legs?.[0]?.city === "Amsterdam" && legs[0].nights === 5);
  assert("Bruges 2 nights (last day is departure)", legs?.[1]?.city === "Bruges" && legs[1].nights === 2);
}
assert("single leg → null", deriveLegNights({ days: [{ city: "Amsterdam" }, { city: "Amsterdam" }] }) === null);
assert("missing city data → null", deriveLegNights({ days: [{ city: "Amsterdam" }, {}] }) === null);
assert("no days → null", deriveLegNights({}) === null);

console.log("=== deriveCityNights (RCA bug D2) ===");
{
  // A→B→A: Amsterdam 3 (start) + Bruges 3 + Amsterdam 1 (last day departs).
  // deriveLegNights → [Ams:3, Bruges:3, Ams:1]; per-city totals sum the two
  // Amsterdam legs to 4. This is the case the reference PDF got wrong
  // ("Amsterdam · 6n / Bruges · 1n" from the model instead of 4 / 3).
  const days = [
    ...Array(3).fill({ city: "Amsterdam" }),
    ...Array(3).fill({ city: "Bruges" }),
    ...Array(2).fill({ city: "Amsterdam" }),
  ];
  const totals = deriveCityNights({ days });
  assert("returns a Map", totals instanceof Map, String(totals));
  assert("Amsterdam sums both legs → 4n", totals?.get("amsterdam") === 4, JSON.stringify([...(totals || [])]));
  assert("Bruges → 3n", totals?.get("bruges") === 3, JSON.stringify([...(totals || [])]));
}
{
  // Simple two-leg trip, lookup is case-insensitive on the key.
  const days = [
    ...Array(5).fill({ city: "Amsterdam" }),
    ...Array(3).fill({ city: "Bruges" }),
  ];
  const totals = deriveCityNights({ days });
  assert("Amsterdam 5n", totals?.get("amsterdam") === 5);
  assert("Bruges 2n (last day departs)", totals?.get("bruges") === 2);
  assert("keys are lower-cased", totals?.get("Amsterdam") === undefined);
}
assert("single leg → null (undeivable, caller omits token)",
  deriveCityNights({ days: [{ city: "Amsterdam" }, { city: "Amsterdam" }] }) === null);
assert("missing city data → null", deriveCityNights({ days: [{ city: "Amsterdam" }, {}] }) === null);
assert("no days → null", deriveCityNights({}) === null);
assert("null data → null", deriveCityNights(null) === null);

console.log("=== rewriteMetaNights (#6) ===");
{
  const days = [
    ...Array(5).fill({ city: "Amsterdam" }),
    ...Array(3).fill({ city: "Bruges" }),
  ];
  const out = rewriteMetaNights("Jul 14–21 · 7 nights (6+1)", { days });
  assert("rewrites (6+1) → (5+2)", /7 nights \(5\+2\)/.test(out), out);
  assert("keeps the rest of the meta", /Jul 14–21/.test(out), out);
}
assert("no nights token → unchanged", rewriteMetaNights("Amsterdam & Bruges", { days: [{ city: "A" }, { city: "B" }, { city: "B" }] }) === "Amsterdam & Bruges");
assert("undeivable split → unchanged", rewriteMetaNights("7 nights (6+1)", {}) === "7 nights (6+1)");

console.log("=== deriveTransportSummary (#7) ===");
{
  // Trains + private car, no rental leg.
  const data = { days: [{ items: [
    { type: "Transport", text: "Train to Bruges (NS Intercity)" },
    { type: "Transport", text: "Private car transfer to hotel" },
  ] }] };
  const { modes, rentalUsed } = deriveTransportSummary(data);
  assert("rental not used", rentalUsed === false);
  assert("train detected", modes.includes("train"), JSON.stringify(modes));
  assert("private car detected", modes.includes("private car"), JSON.stringify(modes));
  assert("no rental-car mode", !modes.includes("rental car"), JSON.stringify(modes));
}
{
  const data = { days: [{ items: [
    { type: "Car", text: "Pick up rental car at Hertz" },
  ] }] };
  const { rentalUsed } = deriveTransportSummary(data);
  assert("rental leg → rentalUsed true", rentalUsed === true);
}
{
  // A restaurant named "The Tram Stop" must NOT register as transport.
  const data = { days: [{ items: [
    { type: "Dinner", text: "The Tram Stop Brasserie" },
  ] }] };
  const { modes } = deriveTransportSummary(data);
  assert("non-transport item ignored", modes.length === 0, JSON.stringify(modes));
}

console.log("=== markdownToProse (P1: guidelines are pasted markdown) ===");
assert("ATX header stripped, title kept", markdownToProse("## Day 1\nBayeux") === "Day 1\nBayeux");
assert("bold markers stripped", markdownToProse("**Nuremberg** next") === "Nuremberg next");
assert("italics stripped", markdownToProse("_quiet_ room") === "quiet room");
assert("link collapses to its label",
  markdownToProse("see [the museum](https://x.test)") === "see the museum");
assert("horizontal rule becomes a blank line",
  markdownToProse("one\n\n-----\n\ntwo") === "one\n\ntwo",
  JSON.stringify(markdownToProse("one\n\n-----\n\ntwo")));
assert("leading dashes become bullets", markdownToProse("- no red-eyes") === "• no red-eyes");
assert("runs of blank lines collapse to one",
  markdownToProse("a\n\n\n\nb") === "a\n\nb", JSON.stringify(markdownToProse("a\n\n\n\nb")));
assert("plain prose passes through untouched",
  markdownToProse("Two weeks in France.") === "Two weeks in France.");
assert("empty input → empty string", markdownToProse("") === "");
assert("null input → empty string", markdownToProse(null) === "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
