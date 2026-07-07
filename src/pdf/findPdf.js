// =============================================================================
// findPdf.js — Printable, hyperlinked PDF export for /find (local-info-only)
// results. Sibling to itineraryPdf.js; reuses its jsPDF layout primitives
// (cursor, color/font tokens, URL builders) so both PDFs share one visual
// language, but lays out the flatter restaurant/activity list shape instead
// of the full itinerary's days/flights/hotels.
// -----------------------------------------------------------------------------
// Why this exists: the /find page (quick restaurant + activity lookup for a
// location, no hotels/flights/days) had zero export option — results were
// view-only in the browser. Users wanted a PDF with LIVE hyperlinks for
// websites, reservations, and phone numbers, matching what the full
// itinerary PDF already does.
//
// Public API:
//   buildFindPdf(payload, options) -> jsPDF instance
//     payload: { location, category, guidelines, restaurants, activities,
//                localExpert: { restaurants, activities } | null, note }
//     options: { setStatus, buildId }
//
// The caller is responsible for saving with the desired filename.
//
// Layout:
//   • Header    — "Find" wordmark line, location + category + guidelines,
//                 generated date.
//   • Restaurants — one block per venue: name, cuisine/price/neighborhood,
//                   reservation chip (clickable), contact block (phone/
//                   website/booking/address — all clickable), why-visit note.
//   • Activities  — one block per activity: title, type, why-visit note,
//                   contact block when present.
//   • Locally sourced — same two sections again, appended below, only when
//                        the "Ask the locals" pass returned results.
//   • Footer    — page number + brand on every page (mirrors itineraryPdf).
//
// Hyperlinks: phones (tel:), addresses (Google Maps search), and any
// website / booking_url / reservation.url are rendered as clickable teal
// underlined text via the shared `link()` cursor primitive — identical
// mechanism to the full itinerary PDF.
// =============================================================================

import {
  COLOR,
  FONT,
  PAGE,
  makeCursor,
  mapsUrl,
  telUrl,
  safe,
  titleCase,
} from "./itineraryPdf.js";

const RESV_PLATFORM_LABEL = {
  opentable: "OpenTable",
  resy: "Resy",
  tock: "Tock",
  yelp: "Yelp",
  phone: "Call",
  walkin: "Walk-in",
};

function buildReservationChips(res) {
  const chips = [];
  if (!res) return chips;
  const platform = (res.platform || "").toLowerCase();

  if (platform === "walkin") {
    chips.push({ label: "Walk-in", url: null });
    return chips;
  }
  if (res.url) {
    chips.push({ label: RESV_PLATFORM_LABEL[platform] || "Reserve", url: res.url });
    return chips;
  }
  if (res.phone) {
    chips.push({ label: "Call", url: telUrl(res.phone) });
    return chips;
  }
  if (platform) {
    chips.push({ label: RESV_PLATFORM_LABEL[platform] || titleCase(platform), url: null });
  }
  return chips;
}

function renderDetailLine(cur, label, value, x, maxW) {
  if (!value) return;
  cur.text([`${label.toUpperCase()}`], { x, maxWidth: maxW, size: 7.5, style: "bold", color: COLOR.inkFaint, space: 1.2 });
  cur.text(String(value), { x, maxWidth: maxW, size: 9.5, color: COLOR.ink, space: 0.3 });
}

function renderLinkLine(cur, label, value, url, x, maxW) {
  if (!value) return;
  if (!url) return renderDetailLine(cur, label, value, x, maxW);
  cur.text([`${label.toUpperCase()}`], { x, maxWidth: maxW, size: 7.5, style: "bold", color: COLOR.inkFaint, space: 1.2 });
  cur.link(String(value), url, { x, maxWidth: maxW, size: 9.5, space: 0.3 });
}

function renderReservationChips(cur, chips, x, maxW) {
  if (!chips || chips.length === 0) return;
  cur.text(["RESERVATION"], { x, maxWidth: maxW, size: 7.5, style: "bold", color: COLOR.inkFaint, space: 1.2 });
  for (const c of chips) {
    if (c.url) cur.link(c.label, c.url, { x, maxWidth: maxW, size: 9.5, space: 0.3 });
    else cur.text(c.label, { x, maxWidth: maxW, size: 9.5, color: COLOR.ink, space: 0.3 });
  }
}

function renderContactBlock(cur, c, x, maxW) {
  if (!c) return;
  if (c.phone) renderLinkLine(cur, "Phone", c.phone, telUrl(c.phone), x, maxW);
  if (c.website) renderLinkLine(cur, "Website", c.website, c.website, x, maxW);
  if (c.booking_url && c.booking_url !== c.website) renderLinkLine(cur, "Book", c.booking_url, c.booking_url, x, maxW);
  if (c.address) renderLinkLine(cur, "Address", c.address, mapsUrl(c.address), x, maxW);
  if (c.hours_verified && Array.isArray(c.hours_verified) && c.hours_verified.length) {
    renderDetailLine(cur, "Hours", c.hours_verified.join("; "), x, maxW);
  } else if (c.hours) {
    renderDetailLine(cur, "Hours", c.hours, x, maxW);
  }
}

function sectionHeader(cur, title, count) {
  cur.space(3);
  cur.ensureSpace(14);
  cur.text(`${title}${typeof count === "number" ? ` (${count})` : ""}`, {
    font: FONT.serif, style: "italic", size: 16, color: COLOR.ink, space: 1,
  });
  cur.accentRule(40);
  cur.space(2);
}

function renderCardDivider(cur) {
  cur.rule({ space: 2.5, color: COLOR.ruleSoft });
}

function renderRestaurantEntry(cur, r) {
  const x = PAGE.marginX;
  const maxW = PAGE.width - PAGE.marginX * 2;
  cur.ensureSpace(18);
  cur.text(safe(r.name) || "Restaurant", { x, maxWidth: maxW, font: FONT.sans, style: "bold", size: 12, color: COLOR.ink, space: 1 });

  const bits = [r.type, r.cuisine, r.price_range, r.neighborhood].filter(Boolean).join("  ·  ");
  if (bits) cur.text(bits, { x, maxWidth: maxW, size: 9, color: COLOR.inkSoft, space: 0.5 });

  if (r.why) cur.text(safe(r.why), { x, maxWidth: maxW, size: 9.5, color: COLOR.inkSoft, space: 1.2, leading: 1.35 });

  const chips = buildReservationChips(r.reservation);
  if (chips.length) renderReservationChips(cur, chips, x, maxW);
  if (r.contact) renderContactBlock(cur, r.contact, x, maxW);

  if (r.verify_status === "verify_before_booking") {
    cur.text("Verify before booking — confirm this listing is current.", { x, maxWidth: maxW, size: 8.5, style: "italic", color: COLOR.warn, space: 1.5 });
  }

  renderCardDivider(cur);
}

function renderActivityEntry(cur, a) {
  const x = PAGE.marginX;
  const maxW = PAGE.width - PAGE.marginX * 2;
  cur.ensureSpace(16);

  const dashIdx = (a.text || "").indexOf(" — ");
  const title = dashIdx > 0 ? a.text.slice(0, dashIdx) : (a.text || "Activity");
  const desc = dashIdx > 0 ? a.text.slice(dashIdx + 3) : "";

  cur.text(title, { x, maxWidth: maxW, font: FONT.sans, style: "bold", size: 12, color: COLOR.ink, space: 1 });
  if (a.type) cur.text(a.type, { x, maxWidth: maxW, size: 9, color: COLOR.inkSoft, space: 0.5 });
  if (desc) cur.text(desc, { x, maxWidth: maxW, size: 9.5, color: COLOR.inkSoft, space: 1, leading: 1.35 });
  if (a.why) cur.text(safe(a.why), { x, maxWidth: maxW, size: 9.5, color: COLOR.inkSoft, space: 1, leading: 1.35 });

  if (a.contact) renderContactBlock(cur, a.contact, x, maxW);

  if (a.verify_status === "verify_before_booking") {
    cur.text("Verify before visiting — confirm this listing is current.", { x, maxWidth: maxW, size: 8.5, style: "italic", color: COLOR.warn, space: 1.5 });
  }

  renderCardDivider(cur);
}

function renderHeader(cur, payload, buildId) {
  cur.text("Find — RouteSmith", { font: FONT.sans, style: "bold", size: 10, color: COLOR.accent, space: 0 });
  cur.space(1);
  cur.text(safe(payload.location) || "Search results", { font: FONT.serif, style: "italic", size: 24, color: COLOR.ink, space: 1 });
  cur.accentRule(48);
  cur.space(2);

  const categoryLabel = payload.category === "restaurants"
    ? "Restaurants only"
    : payload.category === "activities"
    ? "Activities only"
    : "Restaurants & activities";
  cur.text(categoryLabel, { size: 9.5, color: COLOR.inkSoft, space: 0.5 });

  if (payload.guidelines) {
    cur.text(`"${payload.guidelines}"`, { size: 9, style: "italic", color: COLOR.inkFaint, space: 1, leading: 1.35 });
  }
  if (payload.note) {
    cur.text(safe(payload.note), { size: 9, style: "italic", color: COLOR.inkFaint, space: 1.5, leading: 1.35 });
  }

  const generated = `Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}${buildId ? ` · ${buildId}` : ""}`;
  cur.text(generated, { size: 7.5, color: COLOR.inkFaint, space: 2 });
  cur.rule({ space: 2, color: COLOR.rule });
}

function renderFooters(pdf) {
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(COLOR.inkFaint[0], COLOR.inkFaint[1], COLOR.inkFaint[2]);
    pdf.setDrawColor(COLOR.ruleSoft[0], COLOR.ruleSoft[1], COLOR.ruleSoft[2]);
    pdf.setLineWidth(0.15);
    const footerY = PAGE.height - PAGE.marginBottom + 6;
    pdf.line(PAGE.marginX, footerY - 4, PAGE.width - PAGE.marginX, footerY - 4);
    pdf.text("www.routesmith.ai", PAGE.marginX, footerY);
    const right = `${i} / ${total}`;
    const rw = pdf.getTextWidth(right);
    pdf.text(right, PAGE.width - PAGE.marginX - rw, footerY);
  }
}

// -----------------------------------------------------------------------------
// PUBLIC ENTRYPOINT
// -----------------------------------------------------------------------------
export async function buildFindPdf(payload, options = {}) {
  // `compress` defaults to true (production) but can be disabled by callers
  // (e.g. tests) that need to inspect the raw, uncompressed text streams.
  // Compression never affects layout or which hyperlinks get embedded.
  const { setStatus, buildId, compress = true } = options;
  if (setStatus) setStatus("Loading PDF engine…");

  const jsPDFModule = await import("jspdf");
  const { jsPDF } = jsPDFModule;

  if (setStatus) setStatus("Composing pages…");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter", compress });

  try {
    pdf.setProperties({
      title: `${safe(payload?.location) || "Find"} — restaurants & activities`,
      author: "RouteSmith",
      subject: "Local restaurants and activities",
      creator: "www.routesmith.ai",
    });
  } catch { /* setProperties not critical */ }

  const cur = makeCursor(pdf);

  renderHeader(cur, payload, buildId);

  const restaurants = Array.isArray(payload.restaurants) ? payload.restaurants : [];
  const activities = Array.isArray(payload.activities) ? payload.activities : [];

  if (restaurants.length > 0) {
    sectionHeader(cur, "Restaurants", restaurants.length);
    restaurants.forEach((r) => renderRestaurantEntry(cur, r));
  }
  if (activities.length > 0) {
    sectionHeader(cur, "Activities", activities.length);
    activities.forEach((a) => renderActivityEntry(cur, a));
  }

  const leRestaurants = Array.isArray(payload?.localExpert?.restaurants) ? payload.localExpert.restaurants : [];
  const leActivities = Array.isArray(payload?.localExpert?.activities) ? payload.localExpert.activities : [];
  if (leRestaurants.length > 0 || leActivities.length > 0) {
    cur.space(4);
    cur.ensureSpace(16);
    cur.text("Locally Sourced", { font: FONT.serif, style: "italic", size: 18, color: COLOR.accent, space: 1 });
    cur.text("Pulled from regional press, local forums, and area guides.", { size: 8.5, style: "italic", color: COLOR.inkFaint, space: 1 });
    cur.accentRule(48);
    if (leRestaurants.length > 0) {
      sectionHeader(cur, "Restaurants", leRestaurants.length);
      leRestaurants.forEach((r) => renderRestaurantEntry(cur, r));
    }
    if (leActivities.length > 0) {
      sectionHeader(cur, "Activities", leActivities.length);
      leActivities.forEach((a) => renderActivityEntry(cur, a));
    }
  }

  renderFooters(pdf);

  return pdf;
}
