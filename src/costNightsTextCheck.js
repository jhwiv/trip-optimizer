// Cost-estimate breakdown text vs. real per-property night counts.
//
// A real reported build (2026-09-02, a Carvoeiro/Lagos/Algarve trip) shipped
// cost_estimate.breakdown[] with a category string that names specific
// hotels and a night count for each: "Lodging (9 paid nights: Cascade
// Wellness Resort 5n + Tivoli Carvoeiro 4n)". The stated total (9) happened
// to be right, but BOTH named splits were wrong — the real stay was 6 nights
// at Cascade and 3 at Tivoli. This is the same class of bug
// findBudgetTotalMismatches (budgetTotalsCheck.js) catches for the dollar
// totals, and the same class enforceMetaDateRange/reconcileMetaNights catch
// for the meta line and cities[] — a free-text summary silently disagreeing
// with a fact this app can compute from the real day-by-day sequence. This
// is the one surface those checks don't reach: PROSE inside breakdown[]
// .category is never parsed or reconciled anywhere else in this file's
// otherwise-established "meta / cities[] / cost_estimate" reconciliation
// trio (see legNights.js's own header comment).
//
// Deliberately conservative: only flags a mention when the named property
// can be confidently matched (substring, case-insensitive) against a real
// hotel name derived from the plan's own Hotel items — an unmatched name is
// left alone rather than guessed at, matching this file's dayContinuityCheck
// /driveTimeVerify siblings' own "don't flag what you can't confirm" rule.
//
// Pure: no network, no React, no module state.

import { deriveHotelNights } from "./legNights.js";

// Matches a short capitalized name phrase immediately followed by "Nn"
// (e.g. "Cascade Wellness Resort 5n", "Tivoli Carvoeiro 4n"). Deliberately
// narrow (1-6 words, each starting with a letter or digit) so it doesn't
// swallow an entire sentence when the pattern isn't actually present.
const NAME_NIGHTS_RE = /([A-Z][\w&'.-]*(?:\s+[A-Za-z0-9&'.-]+){0,5})\s+(\d+)\s*n\b/g;

export function findCostNightsTextMismatches(plan) {
  const breakdown = Array.isArray(plan?.cost_estimate?.breakdown) ? plan.cost_estimate.breakdown : [];
  if (breakdown.length === 0) return [];

  const hotelNights = deriveHotelNights(plan);
  if (!hotelNights) return [];

  const flags = [];
  for (const b of breakdown) {
    const category = typeof b?.category === "string" ? b.category : "";
    if (!category) continue;
    NAME_NIGHTS_RE.lastIndex = 0;
    let m;
    while ((m = NAME_NIGHTS_RE.exec(category))) {
      const mentionedName = m[1].trim();
      const mentionedNights = Number(m[2]);
      if (!Number.isFinite(mentionedNights)) continue;
      const mentionedKey = mentionedName.toLowerCase();
      // Substring match either direction — the breakdown often shortens a
      // full property name ("Tivoli Carvoeiro" for "Tivoli Carvoeiro
      // Algarve Resort"), mirroring dayContinuityCheck.js's resolveCity().
      let match = null;
      for (const [key, entry] of hotelNights) {
        if (key === mentionedKey || key.includes(mentionedKey) || mentionedKey.includes(key)) {
          match = entry;
          break;
        }
      }
      if (!match) continue;
      if (match.nights !== mentionedNights) {
        flags.push({
          code: "COST_ESTIMATE_NIGHTS_MISMATCH",
          severity: "warn",
          target: "cost_estimate",
          message: `Cost breakdown says "${mentionedName} ${mentionedNights}n", but the real day-by-day sequence shows ${match.nights} night${match.nights === 1 ? "" : "s"} at ${match.name}.`,
        });
      }
    }
  }
  return flags;
}
