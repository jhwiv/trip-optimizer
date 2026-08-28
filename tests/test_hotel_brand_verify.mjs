// Tests for src/hotelBrandVerify.js — the independent hotel brand-claim
// check added 2026-08-28 to close the gap applyQualityLayer's §2e
// loyalty-fabrication check documents as its own known ceiling: a DIRECT
// single-chain claim on an independently-named hotel (no second chain
// named), which §2e's cross-chain-only logic cannot evaluate.
//
// Pure logic only — no network. functions/api/tripadvisor-verify.js's live
// Tripadvisor calls are not (and cannot be, in this sandbox — egress to
// every Tripadvisor host is blocked) exercised here.

import { collectHotelBrandClaims, applyHotelBrandFlags } from "../src/hotelBrandVerify.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("\n=== collectHotelBrandClaims ===");
{
  // Real observed shape (2026-08-15, KNOWN FAILURE MODE #20 / KNOWN
  // FAILURE MODE #9): a single, direct chain claim on an independently
  // -named hotel — exactly the case §2e cannot catch on its own.
  const plan = {
    days: [
      { city: "Bayeux", items: [
        { type: "Hotel", text: "Check in — Villa Lara", hotel: { name: "Villa Lara", confirmation_note: "Marriott Tribute Portfolio member — Bonvoy points post after checkout." } },
      ] },
      { city: "Bayeux", items: [
        // Cross-chain claim — §2e's job, must NOT be collected here.
        { type: "Hotel", text: "Check in — Novotel Bayeux", hotel: { name: "Novotel Bayeux", confirmation_note: "Marriott Bonvoy affiliate via Accor partnership (ALL - Accor Live Limitless reciprocal program)." } },
      ] },
      { city: "Lisbon", items: [
        // No chain mentioned at all — nothing to check.
        { type: "Hotel", text: "Check in — Hotel do Chiado", hotel: { name: "Hotel do Chiado" } },
      ] },
      { city: "Lisbon", items: [
        // A real, plausibly-true single-chain claim — still collected;
        // it's the SERVER's job (comparing against Tripadvisor) to decide
        // true vs false, not the collector's.
        { type: "Hotel", text: "Check in — Lisbon Marriott Hotel", hotel: { name: "Lisbon Marriott Hotel", confirmation_note: "Marriott Bonvoy elite benefits apply." } },
      ] },
    ],
  };
  const claims = collectHotelBrandClaims(plan, (day) => day?.city || "");
  assert("exactly 2 single-chain claims collected (Villa Lara, Lisbon Marriott)", claims.length === 2, JSON.stringify(claims));
  assert("Villa Lara claim collected with chainKey marriott",
    claims.some(c => c.hotelName === "Villa Lara" && c.chainKey === "marriott"));
  assert("Lisbon Marriott Hotel claim collected with chainKey marriott",
    claims.some(c => c.hotelName === "Lisbon Marriott Hotel" && c.chainKey === "marriott"));
  assert("the cross-chain Novotel Bayeux claim is NOT collected (that's §2e's job)",
    !claims.some(c => c.hotelName === "Novotel Bayeux"));
  assert("the hotel with no chain mentioned is NOT collected",
    !claims.some(c => c.hotelName === "Hotel do Chiado"));
  assert("city hint applied", claims.find(c => c.hotelName === "Villa Lara")?.city === "Bayeux");
  assert("chainLabel is human-readable", claims.find(c => c.hotelName === "Villa Lara")?.chainLabel === "Marriott");

  assert("a non-Hotel item is ignored", collectHotelBrandClaims({ days: [{ items: [{ type: "Activity", text: "Marriott-adjacent tour" }] }] }).length === 0);
  assert("a Hotel item with no hotel.name is ignored",
    collectHotelBrandClaims({ days: [{ items: [{ type: "Hotel", text: "Marriott somewhere", hotel: {} }] }] }).length === 0);
  assert("null plan is safe", collectHotelBrandClaims(null).length === 0);
  assert("no days is safe", collectHotelBrandClaims({}).length === 0);
}

console.log("\n=== applyHotelBrandFlags ===");
{
  const plan = {
    days: [
      { items: [
        { type: "Hotel", text: "Check in — Villa Lara", hotel: { name: "Villa Lara" }, flags: ["pre-existing flag"] },
      ] },
      { items: [
        { type: "Hotel", text: "Check in — Lisbon Marriott Hotel", hotel: { name: "Lisbon Marriott Hotel" } },
      ] },
      { items: [
        { type: "Hotel", text: "Check in — Some Other Hotel", hotel: { name: "Some Other Hotel" } },
      ] },
    ],
  };
  const claims = collectHotelBrandClaims({
    days: [
      { items: [{ type: "Hotel", text: "x", hotel: { name: "Villa Lara", confirmation_note: "Marriott Tribute Portfolio" } }] },
      { items: [{ type: "Hotel", text: "x", hotel: { name: "Lisbon Marriott Hotel", confirmation_note: "Marriott Bonvoy elite" } }] },
      { items: [{ type: "Hotel", text: "x", hotel: { name: "Some Other Hotel", confirmation_note: "Hilton Honors points" } }] },
    ],
  });

  // Real Tripadvisor-shaped verdicts (from the live MCP check this
  // session): Villa Lara's real listing has zero Marriott language —
  // unconfirmed. Lisbon Marriott Hotel's real listing IS Marriott —
  // confirmed, no flag. Third hotel: server never resolved it confidently
  // (matched:false) — fail safe, no flag either way.
  const results = new Map([
    ["0:0", { matched: true, resolvedName: "Villa Lara Hotel", description: "Sophisticated lodging with cathedral views, plus a lounge/bar & an exercise room." }],
    ["1:0", { matched: true, resolvedName: "Lisbon Marriott Hotel", description: "Part of the Marriott Bonvoy family, offering elite benefits." }],
    ["2:0", { matched: false, reason: "low-confidence" }],
  ]);

  const { data, flags } = applyHotelBrandFlags(plan, claims, results);
  assert("only the unconfirmed claim (Villa Lara) is flagged", flags.length === 1, JSON.stringify(flags));
  assert("flag targets Villa Lara", flags[0]?.target === "Villa Lara");
  assert("flag code is HOTEL_BRAND_UNCONFIRMED", flags[0]?.code === "HOTEL_BRAND_UNCONFIRMED");
  assert("severity is warn, never block", flags[0]?.severity === "warn");
  assert("message names the claimed chain and hedges rather than asserting fabrication",
    /Marriott/.test(flags[0]?.message) && /verify directly/i.test(flags[0]?.message), flags[0]?.message);
  assert("the flagged item's pre-existing flags array is preserved and extended",
    data.days[0].items[0].flags.includes("pre-existing flag") && data.days[0].items[0].flags.length === 2);
  assert("the confirmed Marriott hotel gains no flag",
    !data.days[1].items[0].flags?.length);
  assert("the low-confidence hotel gains no flag (fail safe)",
    !data.days[2].items[0].flags?.length);

  const noResults = applyHotelBrandFlags(plan, claims, new Map());
  assert("no verdicts at all → no flags, same plan reference (fail safe)",
    noResults.flags.length === 0 && noResults.data === plan);

  const errorResults = new Map([
    ["0:0", { error: "no-key" }],
    ["1:0", { matched: false }],
    ["2:0", { error: "network" }],
  ]);
  const errored = applyHotelBrandFlags(plan, claims, errorResults);
  assert("errors and unmatched results never produce a flag", errored.flags.length === 0);

  assert("null plan is safe", applyHotelBrandFlags(null, [], new Map()).flags.length === 0);
  assert("empty claims is safe", applyHotelBrandFlags(plan, [], new Map()).flags.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
