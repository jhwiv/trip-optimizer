// Tests for src/referenceSheet.js — the ROUTESMITH ITINERARY-QUALITY
// UPGRADE spec's §13 "phone-ready reference sheet."

import { buildReferenceSheet } from "../src/referenceSheet.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("\n=== buildReferenceSheet ===");
{
  assert("null plan is safe", buildReferenceSheet(null).length === 0);
  assert("no days → empty", buildReferenceSheet({}).length === 0);

  const plan = {
    days: [
      {
        items: [
          { type: "Hotel", hotel: { name: "The Yeatman", phone: "+351 22 040 1400", address: "Rua do Choupelo, Porto", website: "https://theyeatman.com" } },
          { type: "Transport", text: "Private driver airport → The Yeatman", contact: { phone: "+351 91 000 0000", address: "" } },
          { type: "Dinner", restaurant: { name: "Cantina 32", reservation: { platform: "opentable" }, contact: { phone: "+351 22 001", address: "Rua Actor João Guedes 32" } } },
          { type: "Dinner", restaurant: { name: "Casual spot", reservation: { platform: "walkin" }, contact: { phone: "+351 22 999" } } },
          { type: "Activity", text: "Douro Valley wine tasting", why: "x" },
        ],
      },
      {
        items: [
          // Same hotel, checkout day — should dedupe, not double-list.
          { type: "Hotel", hotel: { name: "The Yeatman", phone: "+351 22 040 1400" } },
          { type: "Transport", text: "Airport shuttle" }, // no contact — excluded
        ],
      },
    ],
  };

  const sheet = buildReferenceSheet(plan);
  const kinds = sheet.map((e) => e.kind);
  const names = sheet.map((e) => e.name);

  assert("hotel included", names.includes("The Yeatman"));
  assert("hotel appears exactly once despite check-in AND check-out days", names.filter((n) => n === "The Yeatman").length === 1);
  assert("transport with real contact info is included", sheet.some((e) => e.kind === "Transport" && e.name.includes("Private driver")));
  assert("transport with no contact info is excluded", !sheet.some((e) => e.name === "Airport shuttle"));
  assert("a restaurant with a REAL reservation is included", names.includes("Cantina 32"));
  assert("a walk-in-only restaurant is excluded (not clutter)", !names.includes("Casual spot"));
  assert("an ordinary Activity item is never included (no structural signal for 'private guide')", !names.includes("Douro Valley wine tasting"));
  assert("exactly 3 curated entries total (1 hotel, 1 transport, 1 restaurant)", sheet.length === 3);
  assert("kinds are as expected", kinds.includes("Hotel") && kinds.includes("Transport") && kinds.includes("Restaurant"));

  const hotelEntry = sheet.find((e) => e.kind === "Hotel");
  assert("hotel entry carries phone/address/website through untouched", hotelEntry.phone === "+351 22 040 1400" && hotelEntry.website === "https://theyeatman.com");

  const restEntry = sheet.find((e) => e.kind === "Restaurant");
  assert("restaurant entry falls back to contact.phone when reservation.phone is absent", restEntry.phone === "+351 22 001");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
