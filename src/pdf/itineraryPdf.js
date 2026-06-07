// =============================================================================
// itineraryPdf.js — Polished, printable, VECTOR itinerary PDF.
// -----------------------------------------------------------------------------
// Why this exists:
//   The legacy PDF was an html2canvas raster screenshot of the live UI — dark
//   mode bleed, gold-on-dark, narrow column, no hyperlinks, fuzzy text. This
//   module ignores the DOM entirely and lays out a sharp, hyperlinked, multi-
//   page document directly from the trip plan data using jsPDF text/line APIs.
//
// Public API:
//   buildItineraryPdf(data, inputs, { setStatus, buildId }) -> jsPDF instance
//
// The caller is responsible for saving with the desired filename.
//
// Layout:
//   • Cover page   — destination title, meta line, gold rule, "What you told us"
//                    summary (compact two-column key/value), generated date.
//   • Day pages    — one chunk per day (page-breaks naturally), headline +
//                    weather + chronological items table with type-specific
//                    detail blocks (flight, hotel, restaurant, activity).
//   • References   — logistics chips, weather window, pack list, plan B, flags,
//                    snobs, tonight.
//   • Footer       — page number + brand + build id on every page.
//
// Hyperlinks: phones (tel:), addresses (Google Maps search), and any website /
// booking_url / reservation.url are rendered as clickable gold underlined text
// via pdf.textWithLink().
// =============================================================================

const COLOR = {
  ink: [17, 17, 17],          // body text
  inkSoft: [85, 85, 85],      // secondary
  inkFaint: [140, 140, 140],  // meta / footer
  gold: [201, 169, 97],       // #C9A961 brand accent
  rule: [220, 220, 220],      // dividers
  ruleSoft: [240, 240, 240],  // row separators
  warn: [180, 90, 40],        // ⚠︎ markers
  bgChip: [248, 244, 232],    // pale gold tint for chips
};

const FONT = {
  sans: "helvetica",
  serif: "times",
};

// Page geometry — US Letter portrait. Tightened margins (15mm vs 18mm) to
// give content ~12% more usable area per page and reduce the airy feel users
// were complaining about. Still leaves a printable safe zone.
const PAGE = {
  width: 215.9,   // mm (letter)
  height: 279.4,  // mm (letter)
  marginX: 15,
  marginTop: 14,
  marginBottom: 14,
};

// IMPORTANT: jsPDF's built-in fonts (Helvetica/Times) use WinAnsi encoding,
// which CANNOT render Unicode arrows, geometric shapes, or emoji. They print
// as garbled glyph IDs. Stick to ASCII for type icons. The aesthetic is built
// from typography (small caps + gold accents) instead of pictograms.
const TYPE_LABEL_PREFIX = {
  Flight: "—",
  Hotel: "—",
  Activity: "—",
  Breakfast: "—",
  Brunch: "—",
  Lunch: "—",
  Dinner: "—",
  Transport: "—",
  Note: "—",
};

// Sanitize free text to glyphs that jsPDF's built-in WinAnsi fonts can render.
// Anything outside Latin-1 (smart arrows, geometric shapes, emoji, thin space,
// the ⚠︎ glyph used by tonight items) becomes garbage with the built-in fonts.
// Convert '08:30' / '8:30' / '20:15' (24h) to '8:30 AM' / '8:15 PM'.
// Pass through anything that doesn't look like an HH:MM clock string (e.g.
// already-formatted '8:00 AM', durations like '4h 35m', empty values).
// Mirrors the formatTime() helper in App.jsx so the PDF and the live UI
// always display times the same way.
function to12h(t) {
  if (!t || typeof t !== "string") return t || "";
  const s = t.trim();
  if (/[AaPp][Mm]\b/.test(s)) return s; // already 12h
  const m = s.match(/^(\d{1,2}):(\d{2})(?!\d)/);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  if (isNaN(h) || h > 23) return s;
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  // Preserve any trailing characters after the HH:MM (e.g. "+1" for next-day).
  const tail = s.slice(m[0].length);
  return `${h12}:${mm} ${ampm}${tail}`;
}

function asciiSafe(s) {
  if (s == null) return "";
  return String(s)
    // Directional arrows -> ASCII tokens.
    .replace(/[\u2192\u279C\u27A1\u2794]/g, " -> ")
    .replace(/\u2190/g, " <- ")
    .replace(/\u2194/g, " <-> ")
    .replace(/\u21D2/g, " => ")
    // Warning / priority markers used by tonight[].
    .replace(/\u26A0\uFE0E?/g, "!")
    .replace(/[\u2705\u2713\u2714]/g, "*")
    .replace(/\u2728/g, "*")
    // Whitespace cleanup.
    .replace(/[\u2009\u200A\u202F\u00A0]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // Smart quotes -> ASCII.
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2015/g, "--") // horizontal bar
    // The remaining CP1252-mapped chars (en dash 0x2013, em dash 0x2014,
    // ellipsis 0x2026, bullet 0x2022) are passed through — jsPDF's default
    // Helvetica encoding maps them correctly through WinAnsi/CP1252 even
    // though their Unicode codepoints are > 0xFF. Leaving them keeps the
    // typography looking professional (real dashes, real ellipsis).
    // Collapse double spaces.
    .replace(/ {2,}/g, " ")
    // Strip anything OTHER than ASCII, Latin-1 Supplement, and the CP1252
    // "extras" (smart quotes, dashes, bullet, ellipsis, trademark, euro).
    // This prevents emoji / box-drawing / geometric glyphs from rendering
    // as garbled internal glyph IDs.
    .replace(/[^\x00-\xFF\u2013\u2014\u2018-\u201D\u2022\u2026\u20AC\u2122]/g, "?");
}

// -----------------------------------------------------------------------------
// PdfCursor — a tiny stateful helper for layout. Tracks current Y, page count,
// and provides primitives the rest of the module uses without repeating boiler.
// -----------------------------------------------------------------------------
function makeCursor(pdf) {
  const state = {
    y: PAGE.marginTop,
    page: 1,
    pageContentMaxY: PAGE.height - PAGE.marginBottom,
  };

  function setColor(rgb) {
    pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
  }
  function setDraw(rgb) {
    pdf.setDrawColor(rgb[0], rgb[1], rgb[2]);
  }
  function setFill(rgb) {
    pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
  }

  function ensureSpace(needed) {
    if (state.y + needed > state.pageContentMaxY) {
      pdf.addPage();
      state.page += 1;
      state.y = PAGE.marginTop;
      return true;
    }
    return false;
  }

  // Wrap text to fit a given width at the current font size, return lines.
  function wrap(text, maxWidth) {
    if (text == null) return [];
    const s = asciiSafe(text).replace(/\s+/g, " ").trim();
    if (!s) return [];
    return pdf.splitTextToSize(s, maxWidth);
  }

  // Draw plain text; advances state.y by lineHeight * lines.length.
  function text(str, opts = {}) {
    const {
      x = PAGE.marginX,
      maxWidth = PAGE.width - PAGE.marginX * 2,
      font = FONT.sans,
      style = "normal",
      size = 10,
      color = COLOR.ink,
      leading = 1.25,
      space = 0,        // extra mm before this block
      align = "left",
    } = opts;
    if (!str) return;
    pdf.setFont(font, style);
    pdf.setFontSize(size);
    setColor(color);

    const lines = Array.isArray(str) ? str : wrap(str, maxWidth);
    if (lines.length === 0) return;

    const lineH = (size * leading) / 2.83465; // pt -> mm
    ensureSpace(lines.length * lineH + space);
    state.y += space;

    for (const line of lines) {
      let drawX = x;
      if (align === "right") {
        drawX = x + maxWidth - pdf.getTextWidth(line);
      } else if (align === "center") {
        drawX = x + (maxWidth - pdf.getTextWidth(line)) / 2;
      }
      pdf.text(line, drawX, state.y + lineH * 0.78);
      state.y += lineH;
    }
    pdf.setCharSpace(0); // never leak
  }

  // Linked text — gold + underline, registered as a clickable PDF annotation.
  function link(label, url, opts = {}) {
    if (!label || !url) return;
    const {
      x = PAGE.marginX,
      maxWidth = PAGE.width - PAGE.marginX * 2,
      size = 10,
      font = FONT.sans,
      style = "normal",
      leading = 1.25,
      space = 0,
    } = opts;
    pdf.setFont(font, style);
    pdf.setFontSize(size);

    const lines = wrap(label, maxWidth);
    if (lines.length === 0) return;

    const lineH = (size * leading) / 2.83465;
    ensureSpace(lines.length * lineH + space);
    state.y += space;

    setColor(COLOR.gold);
    setDraw(COLOR.gold);
    pdf.setCharSpace(0);
    for (const line of lines) {
      const w = pdf.getTextWidth(line);
      const baselineY = state.y + lineH * 0.78;
      pdf.textWithLink(line, x, baselineY, { url });
      // Underline
      pdf.setLineWidth(0.15);
      pdf.line(x, baselineY + 0.6, x + w, baselineY + 0.6);
      state.y += lineH;
    }
  }

  function rule(opts = {}) {
    const {
      x1 = PAGE.marginX,
      x2 = PAGE.width - PAGE.marginX,
      color = COLOR.rule,
      weight = 0.2,
      space = 2,
    } = opts;
    ensureSpace(space + 1);
    state.y += space;
    setDraw(color);
    pdf.setLineWidth(weight);
    pdf.line(x1, state.y, x2, state.y);
    state.y += space;
  }

  // Inline gold accent rule used under section headers.
  function accentRule(width = 36) {
    setDraw(COLOR.gold);
    pdf.setLineWidth(0.6);
    pdf.line(PAGE.marginX, state.y, PAGE.marginX + width, state.y);
    state.y += 2;
  }

  function space(mm) { state.y += mm; }

  function newPage() {
    pdf.addPage();
    state.page += 1;
    state.y = PAGE.marginTop;
  }

  // Two-column key/value row. Used by the cover-page input summary.
  function kvRow(key, value, opts = {}) {
    const {
      keyWidth = 42,
      gap = 6, // hard minimum gutter so long labels don't kiss the value
      size = 8.5,
      rowGap = 0.6,
    } = opts;
    const valueWidth = (PAGE.width - PAGE.marginX * 2) - keyWidth - gap;

    pdf.setFont(FONT.sans, "bold");
    pdf.setFontSize(size - 1);
    setColor(COLOR.inkFaint);
    const keyLines = wrap(String(key).toUpperCase(), keyWidth);

    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(size);
    setColor(COLOR.ink);
    const valueLines = wrap(String(value), valueWidth);

    const lineH = (size * 1.3) / 2.83465;
    const blockH = Math.max(keyLines.length, valueLines.length) * lineH + rowGap;
    ensureSpace(blockH + 1);

    // KEY (small caps look — uppercase + tracked)
    pdf.setFont(FONT.sans, "bold");
    pdf.setFontSize(size - 1.5);
    pdf.setCharSpace(0.3);
    setColor(COLOR.inkFaint);
    keyLines.forEach((ln, i) => {
      pdf.text(asciiSafe(ln), PAGE.marginX, state.y + lineH * 0.78 + i * lineH);
    });
    pdf.setCharSpace(0);

    // VALUE
    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(size);
    setColor(COLOR.ink);
    valueLines.forEach((ln, i) => {
      pdf.text(asciiSafe(ln), PAGE.marginX + keyWidth + gap, state.y + lineH * 0.78 + i * lineH);
    });

    state.y += blockH;
    // Thin row separator
    setDraw(COLOR.ruleSoft);
    pdf.setLineWidth(0.1);
    pdf.line(PAGE.marginX, state.y, PAGE.width - PAGE.marginX, state.y);
    state.y += rowGap;
  }

  // Bullet item: gold dot + wrapped text.
  function bullet(label, opts = {}) {
    const {
      size = 10,
      indent = 6,
      space: pre = 0,
    } = opts;
    if (!label) return;
    const valueWidth = (PAGE.width - PAGE.marginX * 2) - indent;
    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(size);
    const lines = wrap(String(label), valueWidth);
    if (lines.length === 0) return;
    const lineH = (size * 1.3) / 2.83465;
    ensureSpace(lines.length * lineH + pre);
    state.y += pre;

    // Bullet dot
    setFill(COLOR.gold);
    pdf.circle(PAGE.marginX + 1.2, state.y + lineH * 0.5, 0.7, "F");

    setColor(COLOR.ink);
    lines.forEach((ln, i) => {
      pdf.text(asciiSafe(ln), PAGE.marginX + indent, state.y + lineH * 0.78 + i * lineH);
    });
    state.y += lines.length * lineH;
  }

  // Chip (rounded rect with text) — used for logistics. Lays out flowing.
  function chips(items, opts = {}) {
    const { size = 9, padX = 3, padY = 1.6, gap = 3, lineGap = 2.5 } = opts;
    if (!items || items.length === 0) return;
    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(size);
    const lineH = (size * 1.25) / 2.83465 + padY * 2;
    let x = PAGE.marginX;
    const xMax = PAGE.width - PAGE.marginX;
    ensureSpace(lineH);
    items.forEach(it => {
      const label = asciiSafe(it);
      const w = pdf.getTextWidth(label) + padX * 2;
      if (x + w > xMax) {
        state.y += lineH + lineGap;
        ensureSpace(lineH);
        x = PAGE.marginX;
      }
      setFill(COLOR.bgChip);
      setDraw(COLOR.gold);
      pdf.setLineWidth(0.2);
      pdf.roundedRect(x, state.y, w, lineH - 0.5, 1.2, 1.2, "FD");
      setColor(COLOR.ink);
      pdf.text(label, x + padX, state.y + lineH * 0.62);
      x += w + gap;
    });
    state.y += lineH + 1;
  }

  return {
    pdf,
    state,
    text,
    link,
    rule,
    accentRule,
    space,
    newPage,
    kvRow,
    bullet,
    chips,
    ensureSpace,
    wrap,
    setColor,
    setDraw,
    setFill,
  };
}

// -----------------------------------------------------------------------------
// Helpers — URL builders, label formatters, safe getters.
// -----------------------------------------------------------------------------
function mapsUrl(address) {
  if (!address) return null;
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(address);
}
function telUrl(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  return "tel:" + cleaned;
}
function safe(s) { return s == null ? "" : String(s); }
function titleCase(s) {
  if (!s) return s;
  return String(s).replace(/\b\w/g, c => c.toUpperCase());
}

// -----------------------------------------------------------------------------
// COVER PAGE
// -----------------------------------------------------------------------------
function renderCover(cur, data, inputs, _opts) {
  const { pdf } = cur;
  const dest = safe(data?.destination || (Array.isArray(data?.cities) && data.cities[0]?.name) || "Your trip");
  const meta = safe(data?.meta || "");

  // Compact top — tightened from 14mm to 8mm so the cover packs more onto
  // page 1 (user feedback: too much white space).
  cur.space(8);

  // Eyebrow
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(8.5);
  pdf.setCharSpace(1.2);
  cur.setColor(COLOR.gold);
  pdf.text("ITINERARY", PAGE.marginX, cur.state.y);
  pdf.setCharSpace(0);
  cur.space(5);

  // Title (serif italic for editorial feel)
  cur.text(dest, {
    font: FONT.serif,
    style: "italic",
    size: 26,
    color: COLOR.ink,
    leading: 1.05,
  });
  cur.space(2);

  // Gold accent rule
  cur.accentRule(48);
  cur.space(2);

  // Meta line
  if (meta) {
    cur.text(meta, { font: FONT.sans, style: "normal", size: 11, color: COLOR.inkSoft, leading: 1.3 });
  }

  // Cities preview (multi-city)
  if (Array.isArray(data?.cities) && data.cities.length > 1) {
    cur.space(2);
    const cityLine = data.cities.map((c, i) => `${i + 1}. ${c.name}${c.nights ? ` · ${c.nights}n` : ""}${c.focus ? ` — ${c.focus}` : ""}`).join("    ");
    cur.text(cityLine, { font: FONT.sans, style: "italic", size: 10, color: COLOR.inkSoft });
  }

  cur.space(3);
  cur.rule({ color: COLOR.rule, space: 0.5 });

  // "What you told us" — compact input summary, omit empties.
  if (inputs) {
    cur.space(1);
    pdf.setFont(FONT.sans, "bold");
    pdf.setFontSize(9);
    pdf.setCharSpace(1.0);
    cur.setColor(COLOR.gold);
    pdf.text("WHAT YOU TOLD US", PAGE.marginX, cur.state.y);
    pdf.setCharSpace(0);
    cur.space(4);

    const b = inputs.basics || {};
    const f = inputs.flights || {};
    const h = inputs.hotel || {};
    const t = inputs.transport || {};
    const dn = inputs.dining || {};
    const it = inputs.interests || {};

    const citiesLine = Array.isArray(b.cities) && b.cities.length > 1
      ? b.cities.map((c, i) => `${i + 1}) ${c.name} — ${c.nights}n${c.focus ? ` (${c.focus})` : ""}`).join("  ")
      : null;

    const rows = [
      ["Destination", b.destination],
      citiesLine ? ["Route", citiesLine] : null,
      ["Base area", b.baseArea],
      ["Start date", b.startDate],
      ["Nights", b.nights],
      ["Travelers", b.travelers],
      ["Style", b.style],
      ["Pace", b.pace],
      ["Budget", b.budget],
      ["Home airport", f.homeAirport],
      ["Airline", f.airline],
      ["Cabin", f.cabin],
      ["Hotel brand", h.brand],
      ["Hotel tier", h.tier],
      ["Hotel must-have", h.mustHave],
      ["Transport", [t.type, t.company].filter(Boolean).join(" · ")],
      ["Vehicle", t.vehicle],
      ["Cuisine focus", dn.cuisine],
      ["Dining budget", Array.isArray(dn.budget) ? dn.budget.join(", ") : dn.budget],
      ["Requested restaurants", Array.isArray(inputs.restaurants) ? inputs.restaurants.join(", ") : null],
      ["Requested activities", Array.isArray(inputs.activities) ? inputs.activities.join(", ") : null],
      ["Interest level", it.level],
      ["Interest detail", it.text],
      ["Trip guidelines", inputs.guidelines],
      ["Trip narrative", inputs.narrative],
    ].filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== "" && r[1] !== "—");

    rows.forEach(r => cur.kvRow(r[0], r[1]));
  }

  // Generated stamp removed from the cover body. Now that day-by-day content
  // can flow onto the cover page (whitespace fix), a bottom-of-page stamp
  // risked overlapping with that content. The footer pass at the end of the
  // build writes a Generated stamp on page 1 instead (see renderFooters).
}

// -----------------------------------------------------------------------------
// DAY PAGES
// -----------------------------------------------------------------------------
function renderDay(cur, day, index) {
  const { pdf } = cur;

  cur.ensureSpace(32); // need real room before starting a day

  // Day label
  cur.space(1);
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(8.5);
  pdf.setCharSpace(1.2);
  cur.setColor(COLOR.gold);
  const labelText = (day.label || `DAY ${index + 1}`).toString();
  pdf.text(asciiSafe(labelText.toUpperCase()), PAGE.marginX, cur.state.y);
  pdf.setCharSpace(0);
  cur.space(3.5);

  // Headline (editorial serif italic)
  if (day.headline) {
    cur.text(day.headline, {
      font: FONT.serif,
      style: "italic",
      size: 16,
      color: COLOR.ink,
      leading: 1.1,
    });
  }

  // Weather + pace
  const metaBits = [];
  if (day.weather) metaBits.push(day.weather);
  if (day.pace_note) metaBits.push(day.pace_note);
  if (day.city && !labelText.toLowerCase().includes(String(day.city).toLowerCase())) metaBits.push(day.city);
  if (metaBits.length) {
    cur.space(0.5);
    cur.text(metaBits.join("  ·  "), { font: FONT.sans, style: "italic", size: 10, color: COLOR.inkSoft });
  }
  cur.space(0.5);
  cur.rule({ color: COLOR.rule, space: 0.8 });
  cur.space(0.5);

  // Items
  const items = Array.isArray(day.items) ? day.items : [];
  // Sort chronologically by time string ("HH:MM")
  items.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));

  items.forEach((item, i) => renderItem(cur, item, i === items.length - 1));
}

function renderItem(cur, item, isLast) {
  const { pdf } = cur;
  if (!item) return;

  // Always render times in 12h AM/PM (UI parity).
  const time = to12h(safe(item.time));
  const endTime = to12h(safe(item.end_time));
  const timeLabel = endTime ? `${time}–${endTime}` : time;
  const type = safe(item.type);

  // Time column width. Must fit the widest time label at 10.5pt bold sans.
  // Real-world worst cases include "12:30 PM–2:00 PM" and "4:00 PM–5:30 PM"
  // — both around 30mm at this font/size. 24mm overflowed and the time text
  // crashed into the item title ("4:00 PM–5:30 PStroll"). 32mm gives the
  // longest realistic time range a 2mm buffer before the title column.
  const timeColW = 32;
  const headX = PAGE.marginX + timeColW;
  const bodyMaxW = PAGE.width - PAGE.marginX - headX;

  // Reserve enough vertical space for the WHOLE item including its type-
  // specific block (flight / hotel / restaurant / contact). Previous 14mm
  // only fit the headline; the trailing Backup / Note / Hours lines then
  // got orphaned to the next page (user reported an orphan BACKUP line on
  // an otherwise-blank page 3). 32mm comfortably fits a headline + 4–6
  // detail lines and forces the entire item onto the same page when there
  // isn't room to fit it intact at the bottom of the current page.
  cur.ensureSpace(32);
  cur.space(0.4);
  const itemTop = cur.state.y;

  // Time block (left column)
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(10.5);
  cur.setColor(COLOR.ink);
  pdf.text(asciiSafe(timeLabel || "—"), PAGE.marginX, cur.state.y + 3.8);
  if (type) {
    pdf.setFont(FONT.sans, "bold");
    pdf.setFontSize(7.5);
    pdf.setCharSpace(0.6);
    cur.setColor(COLOR.gold);
    pdf.text(asciiSafe(type.toUpperCase()), PAGE.marginX, cur.state.y + 8.5);
    pdf.setCharSpace(0);
  }

  // Body — type-specific
  const startY = cur.state.y;
  // Headline text
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(11);
  cur.setColor(COLOR.ink);
  const headlineLines = cur.wrap(safe(item.text), bodyMaxW);
  const lineHHead = (11 * 1.3) / 2.83465;
  headlineLines.forEach((ln, i) => {
    pdf.text(asciiSafe(ln), headX, startY + 3.5 + i * lineHHead);
  });
  cur.state.y = startY + Math.max(9, headlineLines.length * lineHHead + 2);

  // Optional secondary line — duration / location
  const secBits = [];
  if (item.duration) secBits.push(item.duration);
  if (item.location && !headlineLines.join(" ").toLowerCase().includes(String(item.location).toLowerCase())) {
    secBits.push(item.location);
  }
  if (secBits.length) {
    pdf.setFont(FONT.sans, "italic");
    pdf.setFontSize(9.5);
    cur.setColor(COLOR.inkSoft);
    const secLines = cur.wrap(secBits.join("  ·  "), bodyMaxW);
    const lineHSec = (9.5 * 1.3) / 2.83465;
    secLines.forEach((ln, i) => {
      pdf.text(asciiSafe(ln), headX, cur.state.y + 3 + i * lineHSec);
    });
    cur.state.y += secLines.length * lineHSec + 1;
  }

  // "Why" — soft serif italic for editorial reasoning
  if (item.why) {
    pdf.setFont(FONT.serif, "italic");
    pdf.setFontSize(10);
    cur.setColor(COLOR.inkSoft);
    const whyLines = cur.wrap(safe(item.why), bodyMaxW);
    const lineHWhy = (10 * 1.35) / 2.83465;
    whyLines.forEach((ln, i) => {
      pdf.text(asciiSafe(ln), headX, cur.state.y + 3 + i * lineHWhy);
    });
    cur.state.y += whyLines.length * lineHWhy + 1;
  }

  // Type-specific extras
  if (item.flight) renderFlightBlock(cur, item.flight, headX, bodyMaxW);
  if (item.hotel) renderHotelBlock(cur, item.hotel, headX, bodyMaxW);
  if (item.restaurant) renderRestaurantBlock(cur, item.restaurant, headX, bodyMaxW);
  if (item.contact) renderContactBlock(cur, item.contact, headX, bodyMaxW);

  // Bottom spacer + divider line between items
  cur.space(0.8);
  if (!isLast) {
    cur.setDraw(COLOR.ruleSoft);
    pdf.setLineWidth(0.1);
    pdf.line(headX, cur.state.y, PAGE.width - PAGE.marginX, cur.state.y);
    cur.space(0.8);
  } else {
    cur.space(0.8);
  }
  // Make sure item top reference exists (keeps the column visually aligned even if body shorter than label).
  if (cur.state.y < itemTop + 10) cur.state.y = itemTop + 10;
}

// Fixed label column for detail rows — ensures consistent value start X
// regardless of label length, so we never get "REQUESTED RESTAURANTSGeronimo".
// Labels that overflow the column get a soft right-side truncation.
const DETAIL_LABEL_W = 23; // mm — wide enough for "RESTAURANT"

function _drawDetailLabel(cur, label, x) {
  const { pdf } = cur;
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(7.5);
  pdf.setCharSpace(0.4);
  cur.setColor(COLOR.inkFaint);
  let labelStr = asciiSafe(String(label).toUpperCase());
  // Truncate to fit DETAIL_LABEL_W minus the gap.
  const maxLabelW = DETAIL_LABEL_W - 2.5;
  while (labelStr.length > 1 && pdf.getTextWidth(labelStr) > maxLabelW) {
    labelStr = labelStr.slice(0, -1);
  }
  pdf.text(labelStr, x, cur.state.y + 3.2);
  pdf.setCharSpace(0);
}

// Render a labeled key/value line within an item body block.
function renderDetailLine(cur, label, value, x, maxW) {
  const { pdf } = cur;
  if (!value) return;
  cur.ensureSpace(5);
  _drawDetailLabel(cur, label, x);

  pdf.setFont(FONT.sans, "normal");
  pdf.setFontSize(10);
  cur.setColor(COLOR.ink);
  const valueX = x + DETAIL_LABEL_W;
  const lines = cur.wrap(String(value), maxW - DETAIL_LABEL_W);
  const lineH = (10 * 1.3) / 2.83465;
  lines.forEach((ln, i) => {
    pdf.text(asciiSafe(ln), valueX, cur.state.y + 3.2 + i * lineH);
  });
  cur.state.y += Math.max(5, lines.length * lineH + 0.5);
}

// Render a labeled linked value (phone / website / address).
function renderLinkLine(cur, label, value, url, x, maxW) {
  const { pdf } = cur;
  if (!value) return;
  cur.ensureSpace(5);
  _drawDetailLabel(cur, label, x);

  pdf.setFont(FONT.sans, "normal");
  pdf.setFontSize(10);
  const valueX = x + DETAIL_LABEL_W;
  const lines = cur.wrap(String(value), maxW - DETAIL_LABEL_W);
  const lineH = (10 * 1.3) / 2.83465;
  if (url) {
    cur.setColor(COLOR.gold);
    cur.setDraw(COLOR.gold);
    pdf.setLineWidth(0.15);
    lines.forEach((ln, i) => {
      const baselineY = cur.state.y + 3.2 + i * lineH;
      const safeLn = asciiSafe(ln);
      pdf.textWithLink(safeLn, valueX, baselineY, { url });
      const w = pdf.getTextWidth(safeLn);
      pdf.line(valueX, baselineY + 0.6, valueX + w, baselineY + 0.6);
    });
  } else {
    cur.setColor(COLOR.ink);
    lines.forEach((ln, i) => {
      pdf.text(asciiSafe(ln), valueX, cur.state.y + 3.2 + i * lineH);
    });
  }
  cur.state.y += Math.max(5, lines.length * lineH + 0.5);
}

function renderFlightBlock(cur, fl, x, maxW) {
  // Single combined headline line: "United UA 1234 · EWR 8:45 AM → ABQ 11:20 AM · 4h 35m"
  const headline = [
    [fl.carrier, fl.flight_number].filter(Boolean).join(" "),
    [fl.from_airport, to12h(fl.depart_time)].filter(Boolean).join(" "),
    "→",
    [fl.to_airport, to12h(fl.arrive_time)].filter(Boolean).join(" "),
    fl.duration ? `· ${fl.duration}` : "",
    fl.nonstop ? "· nonstop" : (fl.connection ? `· via ${fl.connection}` : ""),
  ].filter(s => s && s !== "→ ").join(" ").replace(/\s+/g, " ").trim();
  if (headline) renderDetailLine(cur, "Flight", headline, x, maxW);
  if (fl.cabin) renderDetailLine(cur, "Cabin", fl.cabin, x, maxW);
  if (fl.aircraft) renderDetailLine(cur, "Aircraft", fl.aircraft, x, maxW);
  if (fl.confirmation_note) renderDetailLine(cur, "Note", fl.confirmation_note, x, maxW);
}

function renderHotelBlock(cur, h, x, maxW) {
  if (h.name) renderDetailLine(cur, "Hotel", h.name, x, maxW);
  if (h.address) renderLinkLine(cur, "Address", h.address, mapsUrl(h.address), x, maxW);
  if (h.phone) renderLinkLine(cur, "Phone", h.phone, telUrl(h.phone), x, maxW);
  const ci = [h.check_in_time ? `In ${to12h(h.check_in_time)}` : "", h.check_out_time ? `Out ${to12h(h.check_out_time)}` : ""].filter(Boolean).join("  ·  ");
  if (ci) renderDetailLine(cur, "Times", ci, x, maxW);
  if (h.room_type) renderDetailLine(cur, "Room", h.room_type, x, maxW);
  if (h.confirmation_note) renderDetailLine(cur, "Note", h.confirmation_note, x, maxW);
}

function renderRestaurantBlock(cur, r, x, maxW) {
  if (r.name) renderDetailLine(cur, "Restaurant", r.name, x, maxW);
  const cuisineBits = [r.cuisine, r.price_range, r.neighborhood].filter(Boolean).join("  ·  ");
  if (cuisineBits) renderDetailLine(cur, "Style", cuisineBits, x, maxW);
  const res = r.reservation || {};
  if (res.platform || res.url || res.phone) {
    const platLabel = res.platform ? titleCase(res.platform) : "Reserve";
    if (res.url) {
      renderLinkLine(cur, "Reserve", `${platLabel} — ${res.url}`, res.url, x, maxW);
    } else if (res.phone) {
      renderLinkLine(cur, "Reserve", `${platLabel} — ${res.phone}`, telUrl(res.phone), x, maxW);
    } else {
      renderDetailLine(cur, "Reserve", platLabel, x, maxW);
    }
  }
  if (r.closure_note) renderDetailLine(cur, "Closures", r.closure_note, x, maxW);
  if (r.backup && r.backup.name) {
    renderDetailLine(cur, "Backup", `${r.backup.name}${r.backup.cuisine ? ` · ${r.backup.cuisine}` : ""}`, x, maxW);
  }
}

function renderContactBlock(cur, c, x, maxW) {
  if (c.phone) renderLinkLine(cur, "Phone", c.phone, telUrl(c.phone), x, maxW);
  if (c.website) renderLinkLine(cur, "Website", c.website, c.website, x, maxW);
  if (c.booking_url && c.booking_url !== c.website) renderLinkLine(cur, "Book", c.booking_url, c.booking_url, x, maxW);
  if (c.address) renderLinkLine(cur, "Address", c.address, mapsUrl(c.address), x, maxW);
  if (c.hours) renderDetailLine(cur, "Hours", c.hours, x, maxW);
  if (c.price) renderDetailLine(cur, "Price", c.price, x, maxW);
  if (c.booking_note) renderDetailLine(cur, "Note", c.booking_note, x, maxW);
}

// -----------------------------------------------------------------------------
// REFERENCE SECTIONS — logistics, weather, pack, planb, flags, snobs, tonight.
// -----------------------------------------------------------------------------
function sectionHeader(cur, title) {
  const { pdf } = cur;
  cur.ensureSpace(18);
  cur.space(3.5);
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(8.5);
  pdf.setCharSpace(1.4);
  cur.setColor(COLOR.gold);
  pdf.text(asciiSafe(String(title).toUpperCase()), PAGE.marginX, cur.state.y);
  pdf.setCharSpace(0);
  cur.space(1);
  cur.accentRule(28);
  cur.space(1.5);
}

function renderReferences(cur, data) {
  const ref = {
    logistics: Array.isArray(data?.logistics) ? data.logistics.filter(Boolean) : [],
    weather: safe(data?.weather_window),
    pack: Array.isArray(data?.pack) ? data.pack.filter(Boolean) : [],
    flags: Array.isArray(data?.flags) ? data.flags.filter(Boolean) : [],
    planb: Array.isArray(data?.planb) ? data.planb.filter(Boolean) : [],
    snobs: Array.isArray(data?.snobs) ? data.snobs.filter(Boolean) : [],
    tonight: Array.isArray(data?.tonight) ? data.tonight.filter(Boolean) : [],
  };

  const hasAny = ref.logistics.length || ref.weather || ref.pack.length || ref.flags.length || ref.planb.length || ref.snobs.length || ref.tonight.length;
  if (!hasAny) return;

  // Always start references on a fresh page so they read like a back-of-book reference.
  cur.newPage();

  // Section title — "Trip Reference"
  cur.space(2);
  cur.text("Trip Reference", { font: FONT.serif, style: "italic", size: 22, color: COLOR.ink });
  cur.space(2);
  cur.accentRule(48);

  if (ref.tonight.length) {
    sectionHeader(cur, "Tonight");
    // Sort by priority prefix: must-do / urgent first, then this-week, then anytime.
    const sorted = [...ref.tonight].sort((a, b) => prioRank(a) - prioRank(b));
    sorted.forEach(t => {
      const raw = String(t);
      const isUrgent = /^[⚠!]/u.test(raw) || /must/i.test(raw.slice(0, 12));
      const cleaned = raw.replace(/^[·•⚠︎!]+\s*/u, "").trim();
      // Render with explicit prefix tag so the priority survives ASCII coercion.
      const prefix = isUrgent ? "MUST: " : (/^anytime/i.test(cleaned) ? "" : "");
      cur.bullet((prefix + cleaned).replace(/^MUST: must today:?\s*/i, "MUST: "), { size: 10.5 });
    });
  }

  if (ref.logistics.length) {
    sectionHeader(cur, "Logistics");
    cur.chips(ref.logistics);
  }

  if (ref.weather) {
    sectionHeader(cur, "Weather window");
    cur.text(ref.weather, { size: 10.5, color: COLOR.ink, leading: 1.4 });
  }

  if (ref.pack.length) {
    sectionHeader(cur, "Pack");
    ref.pack.forEach(p => cur.bullet(p));
  }

  if (ref.flags.length) {
    sectionHeader(cur, "Flags");
    ref.flags.forEach(f => cur.bullet(f));
  }

  if (ref.planb.length) {
    sectionHeader(cur, "Plan B");
    ref.planb.forEach((p, i) => {
      const { pdf } = cur;
      const indent = 8;
      const maxW = PAGE.width - PAGE.marginX * 2 - indent;
      pdf.setFont(FONT.sans, "normal");
      pdf.setFontSize(10);
      const lines = cur.wrap(String(p), maxW);
      const lineH = (10 * 1.35) / 2.83465;
      cur.ensureSpace(lines.length * lineH + 2);
      // Number
      pdf.setFont(FONT.sans, "bold");
      pdf.setFontSize(10);
      cur.setColor(COLOR.gold);
      pdf.text(`${i + 1}.`, PAGE.marginX, cur.state.y + lineH * 0.78);
      // Text
      pdf.setFont(FONT.sans, "normal");
      cur.setColor(COLOR.ink);
      lines.forEach((ln, j) => {
        pdf.text(asciiSafe(ln), PAGE.marginX + indent, cur.state.y + lineH * 0.78 + j * lineH);
      });
      cur.state.y += lines.length * lineH + 1.5;
    });
  }

  if (ref.snobs.length) {
    sectionHeader(cur, "Insider notes");
    ref.snobs.forEach(s => {
      cur.text(`“${String(s).replace(/^["“”]+|["“”]+$/g, "")}”`, {
        font: FONT.serif, style: "italic", size: 10.5, color: COLOR.inkSoft, leading: 1.4, space: 1,
      });
    });
  }
}

function prioRank(t) {
  const s = String(t || "");
  if (/^[⚠]/u.test(s)) return 0;
  if (/^Anytime/i.test(s)) return 2;
  return 1;
}

// -----------------------------------------------------------------------------
// FOOTER — drawn LAST, after all content, so we know total page count.
// -----------------------------------------------------------------------------
function renderFooters(pdf, opts) {
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(COLOR.inkFaint[0], COLOR.inkFaint[1], COLOR.inkFaint[2]);
    // Hairline divider above footer
    pdf.setDrawColor(COLOR.ruleSoft[0], COLOR.ruleSoft[1], COLOR.ruleSoft[2]);
    pdf.setLineWidth(0.15);
    const footerY = PAGE.height - PAGE.marginBottom + 6;
    pdf.line(PAGE.marginX, footerY - 4, PAGE.width - PAGE.marginX, footerY - 4);

    // Page 1 carries the Generated stamp; subsequent pages carry the brand
    // mark. Both fit on a single footer line so we never overlap content.
    const left = i === 1
      ? `Trip Optimizer${opts.buildId ? ` · ${opts.buildId}` : ""} · Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
      : `Trip Optimizer${opts.buildId ? ` · ${opts.buildId}` : ""}`;
    pdf.text(asciiSafe(left), PAGE.marginX, footerY);

    const right = `${i} / ${total}`;
    const rw = pdf.getTextWidth(right);
    pdf.text(right, PAGE.width - PAGE.marginX - rw, footerY);
  }
}

// -----------------------------------------------------------------------------
// PUBLIC ENTRYPOINT
// -----------------------------------------------------------------------------
export async function buildItineraryPdf(data, inputs, options = {}) {
  const { setStatus, buildId } = options;
  if (setStatus) setStatus("Loading PDF engine…");

  const jsPDFModule = await import("jspdf");
  const { jsPDF } = jsPDFModule;

  if (setStatus) setStatus("Composing pages…");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter", compress: true });

  // Document metadata
  try {
    pdf.setProperties({
      title: `${safe(data?.destination) || "Trip"} itinerary`,
      author: "Trip Optimizer",
      subject: safe(data?.meta) || "Travel itinerary",
      creator: "Trip Optimizer",
    });
  } catch (_) { /* setProperties not critical */ }

  const cur = makeCursor(pdf);

  // 1. Cover
  renderCover(cur, data, inputs, { buildId });

  // 2. Days — flow onto the current page if there's room, otherwise let
  // ensureSpace push to a new page. Previously this hard-coded a newPage()
  // which left a huge blank gap at the bottom of the cover page whenever
  // "What you told us" was short. Reserving ~60mm forces a break only when
  // the day-by-day header + first day's worth of content genuinely won't
  // fit on what's left of the cover page.
  const days = Array.isArray(data?.days) ? data.days : [];
  if (days.length > 0) {
    cur.space(8);
    cur.ensureSpace(60);
    cur.text("Day by Day", { font: FONT.serif, style: "italic", size: 22, color: COLOR.ink });
    cur.space(2);
    cur.accentRule(48);
    cur.space(4);
    days.forEach((d, i) => renderDay(cur, d, i));
  }

  // 3. References
  renderReferences(cur, data);

  // 4. Footers (after everything else so page count is final)
  renderFooters(pdf, { buildId });

  return pdf;
}
