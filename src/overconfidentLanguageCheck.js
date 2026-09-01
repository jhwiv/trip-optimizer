// "Confident language vs. unverified venue" check.
//
// ROUTESMITH ITINERARY-QUALITY UPGRADE spec, §15 "ADD MANDATORY
// CONTRADICTION QA" — its own literal example: "Do not publish reassuring
// language such as 'safe' / 'confirmed' / 'verified' when the underlying
// information does not support it... If something cannot be confirmed,
// label it VERIFY BEFORE BOOKING."
//
// Scoped narrowly and conservatively, matching this codebase's own repeated
// lesson (CLAUDE.md documents this failure shape at least five times for
// src/dayContinuityCheck.js alone) that a free-text heuristic broadened past
// its original fixture keeps finding new false positives. This only flags a
// tonight[]/flags[] entry that BOTH (a) contains one of the three confidence
// words, AND (b) names — by substring match — a restaurant whose
// verify_status is still "verify_before_booking": the one structured field
// the build prompt already requires on every restaurant (RESTAURANT_SCHEMA),
// so there is no free-text inference involved in deciding "unconfirmed."
// Restaurants only for this first pass: hotel/activity confirmation status
// isn't a single clean always-populated field the same way verify_status is.
//
// Pure: no network, no React, no module state.

const CONFIDENCE_WORD_RE = /\b(safe|confirmed|verified)\b/i;

// A name shorter than this is too generic to trust as a substring match
// (e.g. a one-word restaurant name that's also a common English word).
const MIN_NAME_LEN = 4;

function collectUnconfirmedRestaurantNames(plan) {
  const names = [];
  const days = Array.isArray(plan?.days) ? plan.days : [];
  days.forEach((day) => {
    (Array.isArray(day?.items) ? day.items : []).forEach((item) => {
      const r = item?.restaurant;
      if (!r) return;
      if (r.name && r.verify_status && r.verify_status !== "confirmed_operating") {
        names.push(r.name.trim().toLowerCase());
      }
      const b = r.backup;
      if (b?.name && b.verify_status && b.verify_status !== "confirmed_operating") {
        names.push(b.name.trim().toLowerCase());
      }
    });
  });
  // Dedupe.
  return [...new Set(names.filter((n) => n.length >= MIN_NAME_LEN))];
}

export function findOverconfidentLanguage(plan) {
  const unconfirmed = collectUnconfirmedRestaurantNames(plan);
  if (unconfirmed.length === 0) return [];

  const sources = [
    ...(Array.isArray(plan?.tonight) ? plan.tonight.map((t) => ["tonight", t]) : []),
    ...(Array.isArray(plan?.flags) ? plan.flags.map((t) => ["flags", t]) : []),
  ];

  const out = [];
  const seen = new Set();
  for (const [field, text] of sources) {
    if (typeof text !== "string" || !CONFIDENCE_WORD_RE.test(text)) continue;
    const lower = text.toLowerCase();
    const hit = unconfirmed.find((name) => lower.includes(name));
    if (!hit) continue;
    const key = `${field}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code: "OVERCONFIDENT_LANGUAGE",
      severity: "warn",
      target: field,
      message: `${field}[] says "${text.trim()}" but the referenced restaurant is not yet confirmed (verify_status: verify_before_booking) — use "VERIFY BEFORE BOOKING" language instead of "safe"/"confirmed"/"verified".`,
    });
  }
  return out;
}
