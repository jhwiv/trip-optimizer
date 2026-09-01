// Tests for src/overconfidentLanguageCheck.js — the ROUTESMITH ITINERARY-
// QUALITY UPGRADE spec's §15 example: don't publish "safe"/"confirmed"/
// "verified" language about a restaurant that's still verify_before_booking.

import { findOverconfidentLanguage } from "../src/overconfidentLanguageCheck.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function planWith(restaurantName, verifyStatus, sourceField, text) {
  return {
    days: [
      {
        items: [
          {
            type: "Dinner",
            restaurant: { name: restaurantName, verify_status: verifyStatus, cuisine: "French", why: "x" },
          },
        ],
      },
    ],
    [sourceField]: [text],
  };
}

console.log("\n=== findOverconfidentLanguage ===");
{
  assert("null plan is safe", findOverconfidentLanguage(null).length === 0);
  assert("no restaurants at all → no flags", findOverconfidentLanguage({ tonight: ["Everything is confirmed"] }).length === 0);
  assert("no tonight/flags entries → no flags",
    findOverconfidentLanguage({ days: [{ items: [{ type: "Dinner", restaurant: { name: "Le Squelette", verify_status: "verify_before_booking" } }] }] }).length === 0);

  const flagged = findOverconfidentLanguage(
    planWith("Le Squelette", "verify_before_booking", "tonight", "Le Squelette dinner is confirmed for tonight."),
  );
  assert("confidence word + unconfirmed restaurant name in tonight[] → OVERCONFIDENT_LANGUAGE warn",
    flagged.length === 1 && flagged[0].code === "OVERCONFIDENT_LANGUAGE" && flagged[0].severity === "warn");
  assert("target records the source field", flagged[0].target === "tonight");

  assert("same case in flags[] also fires",
    findOverconfidentLanguage(planWith("Le Squelette", "verify_before_booking", "flags", "Reservation at Le Squelette is verified."))
      .length === 1);

  assert("restaurant already confirmed_operating → no flag even with confidence word",
    findOverconfidentLanguage(planWith("Le Squelette", "confirmed_operating", "tonight", "Le Squelette dinner is confirmed for tonight.")).length === 0);

  assert("restaurant with no verify_status at all → no flag (nothing to contradict)",
    findOverconfidentLanguage(planWith("Le Squelette", undefined, "tonight", "Le Squelette dinner is confirmed for tonight.")).length === 0);

  assert("confidence word present but restaurant name NOT mentioned → no flag",
    findOverconfidentLanguage(planWith("Le Squelette", "verify_before_booking", "tonight", "Everything for tonight is confirmed.")).length === 0);

  assert("restaurant name present but no confidence word → no flag",
    findOverconfidentLanguage(planWith("Le Squelette", "verify_before_booking", "tonight", "Call ahead to book Le Squelette.")).length === 0);

  const backupCase = {
    days: [{
      items: [{
        type: "Dinner",
        restaurant: {
          name: "Main Spot", verify_status: "confirmed_operating",
          backup: { name: "Backup Bistro", verify_status: "verify_before_booking" },
        },
      }],
    }],
    flags: ["Backup Bistro is a safe fallback if Main Spot is full."],
  };
  assert("an unconfirmed BACKUP restaurant is also checked",
    findOverconfidentLanguage(backupCase).length === 1);

  const dedupeCase = planWith("Le Squelette", "verify_before_booking", "tonight", "Le Squelette dinner is confirmed and verified for tonight.");
  assert("a single entry with two confidence words still produces exactly one flag (no double-count)",
    findOverconfidentLanguage(dedupeCase).length === 1);

  assert("a very short restaurant name (below MIN_NAME_LEN) doesn't cause spurious wide substring matches",
    findOverconfidentLanguage(planWith("Ate", "verify_before_booking", "tonight", "Dinner reservations are all confirmed tonight.")).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
