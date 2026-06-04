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
    const blockH = Math.max(keyLines.length, valueLines.length) *
