// Booking-link plausibility (report bug 5, validator V5).
//
// The 2026-07-28 build shipped a "Book ↗" button pointing at
//   https://www.viator.com/tours/Lisbon/…/d538-123456LISBONWW2
// The host is real, the path shape is nearly right, and it 404s. The URL
// liveness probe (/api/verify-url) only swapped the on-screen href to a Google
// search — the plan object kept the fabricated link and the PDF printed it.
//
// Two defenses live here:
//
//   1. classifyBookingUrl / findImplausibleBookingUrls — zero-network, purely
//      structural. Operator deep links have machine-generated ID shapes; a
//      model inventing one gets the host and the prose right and the ID wrong.
//      Blocks export.
//   2. stripDeadBookingUrls — consumes the /api/verify-url verdict and removes
//      the dead link from the plan object, so the exporter can no longer print
//      what the screen already refuses to link to.
//
// Hosts we don't have a rule for classify as "unknown", never "implausible".
// A boutique operator's own booking page is the common case and we have no
// business guessing at its URL grammar.

const VIATOR_HOST = /(^|\.)viator\.com$/i;
const GYG_HOST = /(^|\.)getyourguide\.[a-z.]+$/i;
const TIQETS_HOST = /(^|\.)tiqets\.com$/i;
const OPENTABLE_HOST = /(^|\.)opentable\.[a-z.]+$/i;
const RESY_HOST = /(^|\.)resy\.com$/i;

// Viator product URLs end in /d<destinationId>-<productCode>, where the
// product code is digits with an optional P-suffix ("d538-25289P1").
//
// NOTE for maintainers: Viator also issues codes with trailing alphabetic
// tokens on some legacy products, which this rule reads as fabricated. That
// is deliberate — the fabricated link this validator exists to catch
// ("d538-123456LISBONWW2") is indistinguishable in shape from those. Because
// the flag blocks export, widen this pattern rather than loosening the whole
// check if a real link ever trips it.
const VIATOR_PRODUCT = /\/d\d+-\d+(?:P\d+)?(?:[/?#]|$)/i;

// GetYourGuide: /<city>-l<locationId>/<slug>-t<tourId>
const GYG_ID = /-[tl]\d+(?:[/?#]|$)/i;

// Tiqets: product pages carry a numeric product id, /…-p974116/ or /…/974116/
const TIQETS_ID = /(?:-p\d+|\/\d{4,})(?:[/?#]|$)/i;

// OpenTable: /r/<slug>, /restaurant/profile/<id>, or ?restref=<id>
const OPENTABLE_PATH = /\/(?:r|restaurant\/profile)\/[a-z0-9-]+/i;
const OPENTABLE_REF = /[?&]restref=\d+/i;

// Resy: /cities/<city>/<slug> (older links use /cities/<city>/venues/<slug>)
const RESY_PATH = /\/cities\/[a-z0-9-]+\/(?:venues\/)?[a-z0-9-]+/i;

// Classify a single booking URL without touching the network.
//
// Returns { status, host, reason? } where status is:
//   "ok"          — recognized operator, ID shape matches
//   "implausible" — recognized operator, ID shape does not match
//   "unknown"     — unparseable, non-http, or a host we have no rule for
export function classifyBookingUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    return { status: "unknown", host: "", reason: "No URL" };
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { status: "unknown", host: "", reason: "Not a parseable URL" };
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    return { status: "unknown", host: parsed.hostname, reason: "Not an http(s) URL" };
  }
  const host = parsed.hostname;
  const pathAndQuery = `${parsed.pathname}${parsed.search}`;

  const rule = [
    [VIATOR_HOST, VIATOR_PRODUCT, "Viator product links end in /d<destination>-<productCode>, e.g. /d538-25289P1"],
    [GYG_HOST, GYG_ID, "GetYourGuide links carry a -t<tourId> or -l<locationId> segment"],
    [TIQETS_HOST, TIQETS_ID, "Tiqets product links carry a numeric product id"],
    [RESY_HOST, RESY_PATH, "Resy links are /cities/<city>/<venue-slug>"],
  ].find(([hostRe]) => hostRe.test(host));

  if (rule) {
    const [, idRe, reason] = rule;
    return idRe.test(pathAndQuery) ? { status: "ok", host } : { status: "implausible", host, reason };
  }

  if (OPENTABLE_HOST.test(host)) {
    return OPENTABLE_PATH.test(pathAndQuery) || OPENTABLE_REF.test(pathAndQuery)
      ? { status: "ok", host }
      : { status: "implausible", host, reason: "OpenTable links are /r/<slug> or carry ?restref=<id>" };
  }

  return { status: "unknown", host };
}

// Every booking-ish URL in the plan, with enough context to write a flag and
// to strip the field again later. `path` names the property to delete.
function collectBookingUrls(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const out = [];
  const push = (url, dayIdx, itemIdx, target, holder, key) => {
    if (typeof url !== "string" || !url.trim()) return;
    out.push({ url: url.trim(), dayIdx, day: dayIdx + 1, itemIdx, target, holder, key });
  };
  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    items.forEach((item, itemIdx) => {
      const name = item?.restaurant?.name || item?.text || item?.location || `Day ${dayIdx + 1} item`;
      const rName = item?.restaurant?.name || name;
      const bName = item?.restaurant?.backup?.name || name;
      push(item?.contact?.booking_url, dayIdx, itemIdx, name, "contact", "booking_url");
      push(item?.flight?.booking_url, dayIdx, itemIdx, name, "flight", "booking_url");
      push(item?.restaurant?.contact?.booking_url, dayIdx, itemIdx, rName, "restaurant.contact", "booking_url");
      push(item?.restaurant?.reservation?.url, dayIdx, itemIdx, rName, "restaurant.reservation", "url");
      push(item?.restaurant?.backup?.contact?.booking_url, dayIdx, itemIdx, bName, "restaurant.backup.contact", "booking_url");
      push(item?.restaurant?.backup?.reservation?.url, dayIdx, itemIdx, bName, "restaurant.backup.reservation", "url");
    });
  });
  return out;
}

// Structural pass over the plan's booking links. Emits placesVerify-shaped
// flags at block severity: a fabricated deep link is worse than no link,
// because the "Book ↗" affordance tells the traveler the reservation is a
// click away.
export function findImplausibleBookingUrls(plan) {
  const out = [];
  for (const hit of collectBookingUrls(plan)) {
    const verdict = classifyBookingUrl(hit.url);
    if (verdict.status !== "implausible") continue;
    out.push({
      code: "BOOKING_URL_IMPLAUSIBLE",
      severity: "block",
      dayIdx: hit.dayIdx,
      itemIdx: hit.itemIdx,
      day: hit.day,
      target: hit.target,
      message: `${hit.target}: booking link ${hit.url} doesn't match ${verdict.host}'s URL format (${verdict.reason}). Likely fabricated — remove it or replace with a verified link.`,
    });
  }
  return out;
}

function withoutKey(obj, key) {
  if (!obj || typeof obj !== "object") return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}

// Apply the /api/verify-url liveness verdict to the plan object itself.
//
// `status` is the Map<url, "ok"|"dead"> produced by useURLVerification. Only
// definitive "dead" verdicts strip; unknown/pending/ok are left alone, same
// posture as the on-screen fallback.
//
// Returns { data, flags, removed }. `data` is the input untouched (same
// reference) when nothing was dead, so callers can keep their memo cheap.
export function stripDeadBookingUrls(plan, status) {
  if (!plan || !Array.isArray(plan.days) || !status || typeof status.get !== "function") {
    return { data: plan, flags: [], removed: [] };
  }
  const dead = collectBookingUrls(plan).filter((hit) => status.get(hit.url) === "dead");
  if (dead.length === 0) return { data: plan, flags: [], removed: [] };

  const isDead = (url) => typeof url === "string" && status.get(url.trim()) === "dead";

  const days = plan.days.map((day) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    let dayChanged = false;
    const nextItems = items.map((item) => {
      if (!item || typeof item !== "object") return item;
      let next = item;
      const set = (key, value) => { next = { ...next, [key]: value }; dayChanged = true; };

      if (isDead(item.contact?.booking_url)) set("contact", withoutKey(item.contact, "booking_url"));
      if (isDead(item.flight?.booking_url)) set("flight", withoutKey(item.flight, "booking_url"));

      const r = item.restaurant;
      if (r && typeof r === "object") {
        let nextR = r;
        if (isDead(r.contact?.booking_url)) nextR = { ...nextR, contact: withoutKey(r.contact, "booking_url") };
        if (isDead(r.reservation?.url)) nextR = { ...nextR, reservation: withoutKey(r.reservation, "url") };
        const b = r.backup;
        if (b && typeof b === "object") {
          let nextB = b;
          if (isDead(b.contact?.booking_url)) nextB = { ...nextB, contact: withoutKey(b.contact, "booking_url") };
          if (isDead(b.reservation?.url)) nextB = { ...nextB, reservation: withoutKey(b.reservation, "url") };
          if (nextB !== b) nextR = { ...nextR, backup: nextB };
        }
        if (nextR !== r) set("restaurant", nextR);
      }
      return next;
    });
    if (!dayChanged) return day;
    return { ...day, items: nextItems };
  });

  const flags = dead.map((hit) => ({
    code: "BOOKING_URL_DEAD",
    severity: "warn",
    dayIdx: hit.dayIdx,
    itemIdx: hit.itemIdx,
    day: hit.day,
    target: hit.target,
    message: `${hit.target}: booking link ${hit.url} did not respond. Removed from the itinerary; use the search fallback instead.`,
  }));

  return { data: { ...plan, days }, flags, removed: dead.map((h) => h.url) };
}
