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
// 2026-09-02 update: deriveLegNights used to group days purely by the RAW
// days[].city string, which this file's own header already warned is
// unreliable (see the transit-day comment on isTransitDay below) — and a
// real Carvoeiro/Lagos/Algarve build proved the warning wasn't fully heeded.
// Day 4 (the transfer TO Lagos, checking into Cascade Wellness Resort that
// night) had days[].city still labeled "Carvoeiro" — the ORIGIN, not where
// the traveller actually slept — and Day 6 (a same-day round-trip drive back
// to Carvoeiro for a paddleboard outing, returning to sleep in Lagos that
// night) was ALSO labeled "Carvoeiro", even though nothing about that day was
// a real base change. Both days had unambiguous, resolvable Transport text
// ("Drive Carvoeiro to Lagos", "Drive Lagos -> Carvoeiro ... Drive Carvoeiro
// -> Lagos") — dayContinuityCheck.js's buildDayLegs() already resolves this
// correctly for its OWN purposes (a day-trip return is recognized and never
// recorded as a real transition), it just was never reused here. The result:
// meta showed "12 nights (4+1+1+3+3)" — a nonsensical 5-segment split for a
// 3-city trip — instead of the real 3+6+3. deriveLegNights now prefers each
// day's buildDayLegs-resolved ending city (derived from real transitions,
// day-trip-return-aware) over the raw label, falling back to the raw label
// only when no transition resolved that day (the ordinary case, and the only
// case the pre-2026-09-02 hotel-checkin/checkout forward-borrow heuristic
// below still needs to cover).
//
// Pure: no network, no React, no module state.

import { buildDayLegs } from "./dayContinuityCheck.js";

const safe = (s) => (s == null ? "" : String(s));

const CHECKOUT_RE = /check[\s-]?out|depart(?:ure)? from (?:the )?hotel/i;
const CHECKIN_RE = /check[\s-]?in|arrive at (?:the )?hotel/i;

// Mirrors dayContinuityCheck.js's hotelEvent(): a bare Hotel item with
// neither phrase defaults to check-in (the model's default shape when it
// omits explicit "check in" wording but still attaches a hotel object).
function dayHasHotelEvent(day, kind) {
  const items = Array.isArray(day?.items) ? day.items : [];
  return items.some((item) => {
    if (!item || typeof item !== "object") return false;
    if (!/^Hotel$/i.test(String(item.type || ""))) return false;
    const text = `${item.text || ""} ${item?.hotel?.name || ""}`;
    if (CHECKOUT_RE.test(text)) return kind === "out";
    if (CHECKIN_RE.test(text) || item?.hotel) return kind === "in";
    return false;
  });
}

// Derive the real per-leg night breakdown from the day-by-day city sequence.
// The meta string's "(6+1)" grouping is model-emitted and often misleading for
// A→B→A trips (the return leg vanishes). Walking days[].city gives the true
// contiguous stays. Returns an ordered [{ city, nights }] or null when there
// aren't at least two legs with nights to describe.
//
// Nights per leg = number of days in the contiguous city run, minus one for the
// trip's final day (a departure day carries no overnight). This makes the parts
// sum to (totalDays - 1) = total nights.
// The city the traveller actually ended day `leg` in, per
// dayContinuityCheck.js's real transition resolution (day-trip-returns and
// same-city local errands already excluded) — the day's own last resolved
// transition, or the raw label when nothing resolved that day.
function resolvedDayCity(leg) {
  const transitions = Array.isArray(leg?.transitions) ? leg.transitions : [];
  const last = transitions[transitions.length - 1];
  const resolved = last && typeof last.to === "string" ? last.to.trim() : "";
  return resolved || safe(leg?.city).trim();
}

export function deriveLegNights(data) {
  const days = Array.isArray(data?.days) ? data.days : [];
  if (days.length < 2) return null;
  const dayLegs = buildDayLegs(data);
  // A "transit" day both checks out of one hotel and into a new one. Real
  // observed case (2026-08-07, a London/Paris/Normandy/Porto build):
  // day.city often names the ORIGIN city (where the day's activities
  // start), even though the night itself is spent at the new hotel in the
  // DESTINATION — a day labeled "Normandy" that checks out of a Normandy
  // hotel and into a Paris one that same evening attributed the night to
  // Normandy instead of Paris, throwing off both legs. This forward-borrow
  // is now a FALLBACK only: resolvedDayCity() (above) already resolves the
  // ordinary case correctly from the day's own Transport/Flight text, so
  // this only still matters when that text didn't resolve to a canonical
  // city at all (the case this heuristic was originally written for).
  const isTransitDay = days.map((d) => dayHasHotelEvent(d, "out") && dayHasHotelEvent(d, "in"));
  const runs = [];
  for (let i = 0; i < days.length; i++) {
    let city = resolvedDayCity(dayLegs[i]);
    if (!city) return null; // incomplete city data — don't guess
    const hadResolvedTransition = (dayLegs[i]?.transitions?.length || 0) > 0;
    // Borrow the NEXT day's city label — but ONLY when (a) this day's own
    // text didn't already resolve a real transition, and (b) that next day
    // is itself settled (not ALSO a transit day). Back-to-back single-night
    // transit days (e.g. a one-night return to Normandy immediately
    // followed by flying onward to Porto) each have their OWN, DIFFERENT
    // destination; blindly borrowing forward through both would collapse
    // them into whichever city the chain eventually settles in, silently
    // deleting the one-night stay in between. A transit day immediately
    // followed by another transit day is left on its own (usually already
    // reliable) label rather than guessed at.
    if (!hadResolvedTransition && isTransitDay[i] && i + 1 < days.length && !isTransitDay[i + 1]) {
      const nextCity = resolvedDayCity(dayLegs[i + 1]) || safe(days[i + 1]?.city).trim();
      if (nextCity) city = nextCity;
    }
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

// Per-LEG night counts, positionally paired against a caller-supplied
// ordered list of city names (e.g. plan.cities[].name or
// inputs.basics.cities[].name) — for renderers that show one line PER LEG,
// not one line per unique city.
//
// 2026-09-02: a real Carvoeiro/Lagos/Carvoeiro (Algarve) build shipped a
// cover-page "cities preview" reading "1. Carvoeiro · 8n ... 3. Carvoeiro ·
// 8n" — the SAME inflated number on BOTH Carvoeiro legs, instead of each
// leg's own 3 nights. Root cause: the renderer looked up each leg's count in
// deriveCityNights()'s map, which is deliberately keyed by NAME and SUMS
// every leg sharing that name (correct for "how many nights total in
// Carvoeiro across the whole trip", the wrong shape for "how many nights on
// THIS leg") — so a city visited twice always shows its combined total on
// every occurrence. This derives the real per-leg breakdown instead and
// pairs it positionally with `names`, which is safe specifically because
// both `names` and deriveLegNights()'s legs are documented/derived to be in
// travel order.
//
// Returns an array the same length as `names`; each entry is that leg's
// derived night count, or null when it can't be trusted — either the two
// lists don't have the same length (a length mismatch means position i in
// one list isn't reliably the same leg as position i in the other, so every
// entry is left null rather than guessed), or that specific position's name
// doesn't loosely match the derived leg's city (substring match either
// direction, mirroring dayContinuityCheck.js's own resolveCity()) — a single
// mismatched position is nulled individually rather than voiding the whole
// array, since the rest may still be trustworthy.
export function deriveLegNightsByPosition(data, names) {
  const list = Array.isArray(names) ? names : [];
  if (list.length === 0) return [];
  const legs = deriveLegNights(data);
  if (!legs || legs.length !== list.length) return list.map(() => null);
  return list.map((name, i) => {
    const a = safe(name).trim().toLowerCase();
    const b = safe(legs[i]?.city).trim().toLowerCase();
    if (!a || !b) return null;
    if (a !== b && !a.includes(b) && !b.includes(a)) return null;
    return legs[i].nights;
  });
}

// Real per-HOTEL night counts, keyed by lower-cased hotel name — a
// city-level total (deriveCityNights) is the wrong ground truth for a
// breakdown that names specific PROPERTIES, e.g. a real reported build's
// cost_estimate.breakdown wrote "Lodging (9 paid nights: Cascade Wellness
// Resort 5n + Tivoli Carvoeiro 4n)" — real per-property nights were 6 and 3.
// Two paid hotels in the SAME city (or a "staying with friends" segment with
// no paid lodging at all, as in that build) can't be told apart by city name
// alone.
//
// Walks the day sequence left to right tracking which hotel currently
// "owns" the traveller's night, using the same per-day hotelIn/hotelOut
// events buildDayLegs() already resolves (so a same-night "Overnight at..."
// reminder, a mid-stay day with no hotel item at all, and a same-day
// checkout+checkin transit day are all handled identically to the rest of
// this file's night math). A day with no Hotel item of any kind (e.g.
// staying with friends, camping) simply doesn't accrue a night to any named
// property — that's the correct, honest shape, not a bug to work around.
//
// Returns a Map of { name, nights } keyed by lower-cased hotel name, or null
// when there's nothing to report (fewer than 2 days, or no hotel ever
// checked in).
export function deriveHotelNights(data) {
  const dayLegs = buildDayLegs(data);
  if (dayLegs.length < 2) return null;
  let currentHotel = null;
  const totals = new Map();
  dayLegs.forEach((leg, i) => {
    if (leg.hotelIn?.name) currentHotel = safe(leg.hotelIn.name).trim();
    const isLastDay = i === dayLegs.length - 1;
    if (!isLastDay && currentHotel) {
      const key = currentHotel.toLowerCase();
      const prev = totals.get(key) || { name: currentHotel, nights: 0 };
      prev.nights += 1;
      totals.set(key, prev);
    }
    // Checked out with no same-day check-in elsewhere — no hotel currently
    // owns the traveller's night (until/unless a later check-in resumes it).
    if (leg.hotelOut?.name && !leg.hotelIn?.name) currentHotel = null;
  });
  return totals.size ? totals : null;
}

// Two formats have been observed for the model's night breakdown in the meta
// line:
//   - parenthetical, attached to the total: "10 nights (2+3+2+3)"
//   - bare, as its own trailing clause: "... · Relaxed pace · 3+3+2+6 nights"
// (real example, 2026-08-07: "Sat Oct 10–Sat Oct 24, 2026 · 14 nights · ...
// · Relaxed pace · 3+3+2+6 nights" — the existing parenthetical-only regex
// found nothing to replace in that shape, so a wrong breakdown shipped
// untouched even though deriveLegNights could derive the correct one.)
const META_NIGHTS_PAREN_RE = /\b(\d+)\s*nights?\s*\(([^)]*)\)/i;
const META_NIGHTS_BARE_RE = /\b(\d+(?:\s*\+\s*\d+)+)\s*nights?\b/i;

// Rewrite the misleading night breakdown in the meta line with the real leg
// breakdown, e.g. "7 nights (3+3+1)" or "3+3+1 nights", matching whichever
// format was already present. Leaves meta untouched when the split can't be
// derived (single leg, missing city data) or meta carries no breakdown to
// replace in either format.
export function rewriteMetaNights(meta, data) {
  const s = safe(meta);
  if (!s) return s;
  const legs = deriveLegNights(data);
  if (!legs) return s;
  const total = legs.reduce((n, l) => n + l.nights, 0);
  const notation = legs.map(l => l.nights).join("+");
  if (META_NIGHTS_PAREN_RE.test(s)) {
    return s.replace(META_NIGHTS_PAREN_RE, `${total} nights (${notation})`);
  }
  if (META_NIGHTS_BARE_RE.test(s)) {
    return s.replace(META_NIGHTS_BARE_RE, `${notation} nights`);
  }
  return s;
}

// Drop an unverifiable breakdown from a meta line. Parenthetical form keeps
// the total: "11 days · 10 nights (2+3+2+3)" → "11 days · 10 nights". Bare
// form has no total of its own to fall back to (the real total already
// appears earlier in the string as a separate "N nights" token), so the
// whole clause — plus its leading separator, if any — is dropped instead:
// "... · Relaxed pace · 3+3+2+6 nights" → "... · Relaxed pace". Used when
// deriveLegNights can't verify the split — an unverified breakdown is
// stripped, not printed (docs/wiki/concepts/verification-workflow.md:54).
export function stripMetaNightsBreakdown(meta) {
  const s = safe(meta);
  if (!s) return s;
  if (META_NIGHTS_PAREN_RE.test(s)) {
    return s.replace(META_NIGHTS_PAREN_RE, (_m, total) => `${total} nights`);
  }
  if (META_NIGHTS_BARE_RE.test(s)) {
    return s
      .replace(new RegExp(`\\s*[·•\\-–—]\\s*${META_NIGHTS_BARE_RE.source}`, "i"), "")
      .replace(META_NIGHTS_BARE_RE, "")
      .trim();
  }
  return s;
}

// Reconcile a meta line against the day-by-day sequence: rewrite the
// breakdown when the split is derivable, strip it when it isn't. Returns
// { meta, derived, changed } so callers can log a fix only on a real edit.
export function reconcileMetaNights(meta, data) {
  const before = safe(meta);
  const legs = deriveLegNights(data);
  const after = legs ? rewriteMetaNights(before, data) : stripMetaNightsBreakdown(before);
  return { meta: after, derived: legs, changed: after !== before };
}

// The model's own breakdown, parsed out of the meta line, for comparing
// against the derived one. Checks both the parenthetical and bare formats
// (see above). Returns an array of integers, or null when meta has neither
// (or the match isn't a "+"-joined number list).
export function parseMetaNightsBreakdown(meta) {
  const s = safe(meta);
  const parenMatch = META_NIGHTS_PAREN_RE.exec(s);
  const raw = parenMatch ? parenMatch[2] : META_NIGHTS_BARE_RE.exec(s)?.[1];
  if (!raw) return null;
  const parts = raw.split("+").map((p) => Number(p.trim()));
  return parts.length && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}
