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
export function deriveLegNights(data) {
  const days = Array.isArray(data?.days) ? data.days : [];
  if (days.length < 2) return null;
  // A "transit" day both checks out of one hotel and into a new one. Real
  // observed case (2026-08-07, a London/Paris/Normandy/Porto build):
  // day.city often names the ORIGIN city (where the day's activities
  // start), even though the night itself is spent at the new hotel in the
  // DESTINATION — a day labeled "Normandy" that checks out of a Normandy
  // hotel and into a Paris one that same evening attributed the night to
  // Normandy instead of Paris, throwing off both legs.
  const isTransitDay = days.map((d) => dayHasHotelEvent(d, "out") && dayHasHotelEvent(d, "in"));
  const runs = [];
  for (let i = 0; i < days.length; i++) {
    let city = safe(days[i]?.city).trim();
    if (!city) return null; // incomplete city data — don't guess
    // Borrow the NEXT day's city label — but ONLY when that next day is
    // itself settled (not ALSO a transit day). Back-to-back single-night
    // transit days (e.g. a one-night return to Normandy immediately
    // followed by flying onward to Porto) each have their OWN, DIFFERENT
    // destination; blindly borrowing forward through both would collapse
    // them into whichever city the chain eventually settles in, silently
    // deleting the one-night stay in between. A transit day immediately
    // followed by another transit day is left on its own (usually already
    // reliable) label rather than guessed at.
    if (isTransitDay[i] && i + 1 < days.length && !isTransitDay[i + 1]) {
      const nextCity = safe(days[i + 1]?.city).trim();
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
