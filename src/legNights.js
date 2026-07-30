// Code-derived night counts.
//
// These helpers used to live inside src/pdf/itineraryPdf.js, which meant the
// only surface that showed honest night math was the printed PDF: the plan
// object, the on-screen city breakdown, and the meta line all kept whatever the
// model wrote. The 2026-07-28 London→Normandy→Amsterdam→Lisbon plan shipped a
// "2+3+2+3 nights" header over a 3-2-3-2 day sequence because of exactly that
// split. They live here now so applyQualityLayer can overwrite the model's
// counts everywhere, and the PDF re-exports them for its own call sites.
//
// Pure: no network, no React, no module state.

const safe = (s) => (s == null ? "" : String(s));

// Derive the real per-leg night breakdown from the day-by-day city sequence.
// The meta string's "(6+1)" grouping is model-emitted and often misleading for
// A→B→A trips (the return leg vanishes). Walking days[].city gives the true
// contiguous stays. Returns an ordered [{ city, nights }] or null when there
// aren't at least two legs with nights to describe.
//
// Nights per leg = number of days in the contiguous city run, minus one for the
// trip's final day (a departure day carries no overnight). This makes the parts
// sum to (totalDays - 1) = total nights.
export function deriveLegNights(data) {
  const days = Array.isArray(data?.days) ? data.days : [];
  if (days.length < 2) return null;
  const runs = [];
  for (let i = 0; i < days.length; i++) {
    const city = safe(days[i]?.city).trim();
    if (!city) return null; // incomplete city data — don't guess
    const prev = runs[runs.length - 1];
    if (prev && prev.city.toLowerCase() === city.toLowerCase()) prev.dayCount += 1;
    else runs.push({ city, dayCount: 1 });
  }
  // Final day is departure — drop one night from the last leg.
  runs[runs.length - 1].dayCount -= 1;
  const legs = runs.map(r => ({ city: r.city, nights: r.dayCount })).filter(l => l.nights > 0);
  return legs.length >= 2 ? legs : null;
}

// Total code-derived nights per city, keyed by lower-cased city name, summed
// across every contiguous leg (so a city visited twice — e.g. Amsterdam at the
// start and end of an A→B→A trip — reports its combined night count). Returns
// null when the split can't be derived, so callers omit the token rather than
// fall back to the model's unverified count (CLAUDE.md: sums computed in code).
export function deriveCityNights(data) {
  const legs = deriveLegNights(data);
  if (!legs) return null;
  const totals = new Map();
  for (const leg of legs) {
    const key = safe(leg.city).trim().toLowerCase();
    if (!key) continue;
    totals.set(key, (totals.get(key) || 0) + leg.nights);
  }
  return totals.size ? totals : null;
}

// Rewrite the misleading "N nights (a+b)" token in the meta line with the real
// leg breakdown, e.g. "7 nights (3+3+1)". Leaves meta untouched when the split
// can't be derived (single leg, missing city data) or meta carries no nights
// parenthetical to replace.
export function rewriteMetaNights(meta, data) {
  const s = safe(meta);
  if (!s) return s;
  const legs = deriveLegNights(data);
  if (!legs) return s;
  const total = legs.reduce((n, l) => n + l.nights, 0);
  const notation = legs.map(l => l.nights).join("+");
  return s.replace(/\b(\d+)\s*nights?\s*\([^)]*\)/i, `${total} nights (${notation})`);
}

const META_NIGHTS_RE = /\b(\d+)\s*nights?\s*\(([^)]*)\)/i;

// Drop the "(a+b+c)" breakdown from a meta line, keeping the total: "11 days ·
// 10 nights (2+3+2+3)" → "11 days · 10 nights". Used when deriveLegNights can't
// verify the split — an unverified breakdown is stripped, not printed
// (docs/wiki/concepts/verification-workflow.md:54).
export function stripMetaNightsBreakdown(meta) {
  const s = safe(meta);
  if (!s) return s;
  return s.replace(META_NIGHTS_RE, (_m, total) => `${total} nights`);
}

// Reconcile a meta line against the day-by-day sequence: rewrite the
// parenthetical when the split is derivable, strip it when it isn't. Returns
// { meta, derived, changed } so callers can log a fix only on a real edit.
export function reconcileMetaNights(meta, data) {
  const before = safe(meta);
  const legs = deriveLegNights(data);
  const after = legs ? rewriteMetaNights(before, data) : stripMetaNightsBreakdown(before);
  return { meta: after, derived: legs, changed: after !== before };
}

// The model's own breakdown, parsed out of the meta line, for comparing against
// the derived one. Returns an array of integers, or null when meta has no
// parenthetical (or it isn't a "+"-joined number list).
export function parseMetaNightsBreakdown(meta) {
  const m = META_NIGHTS_RE.exec(safe(meta));
  if (!m) return null;
  const parts = m[2].split("+").map((p) => Number(p.trim()));
  return parts.length && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}
