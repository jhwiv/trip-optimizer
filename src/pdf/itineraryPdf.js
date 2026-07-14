// =============================================================================
// itineraryPdf.js — Polished, printable, VECTOR itinerary PDF.
// -----------------------------------------------------------------------------
// Why this exists:
//   The legacy PDF was an html2canvas raster screenshot of the live UI — dark
//   mode bleed, narrow column, no hyperlinks, fuzzy text. This module ignores
//   the DOM entirely and lays out a sharp, hyperlinked, multi-page document
//   directly from the trip plan data using jsPDF text/line APIs.
//
// Public API:
//   buildItineraryPdf(data, inputs, { setStatus, buildId }) -> jsPDF instance
//
// The caller is responsible for saving with the desired filename.
//
// Layout:
//   • Cover page   — destination title, meta line, teal accent rule, "What you told us"
//                    summary (compact two-column key/value), generated date.
//   • Day pages    — one chunk per day (page-breaks naturally), headline +
//                    weather + chronological items table with type-specific
//                    detail blocks (flight, hotel, restaurant, activity).
//   • References   — logistics chips, weather window, pack list, plan B, flags,
//                    snobs, tonight.
//   • Footer       — page number + brand + build id on every page.
//
// Hyperlinks: phones (tel:), addresses (Google Maps search), and any website /
// booking_url / reservation.url are rendered as clickable teal underlined text
// via pdf.textWithLink().
// =============================================================================

import { groupItemsByCategory } from "../categoryGroups.js";
import { bucketProviders, PROVIDER_PDF_CAP } from "../localProviders.js";

// Stable key for looking up pre-fetched item photos by name + city.
// Must match the identical function in App.jsx that builds the photo map.
function makeItemPhotoKey(text, city) {
  return `${String(text || "").trim().toLowerCase().slice(0, 80)}|${String(city || "").trim().toLowerCase().slice(0, 30)}`;
}

export const COLOR = {
  ink: [17, 17, 17],          // body text
  inkSoft: [85, 85, 85],      // secondary
  inkFaint: [140, 140, 140],  // meta / footer
  accent: [49, 97, 105],      // teal accent — matches --color-accent-hover (#316169)
  rule: [220, 220, 220],      // dividers
  ruleSoft: [240, 240, 240],  // row separators
  warn: [180, 90, 40],        // ⚠︎ markers
  bgChip: [232, 244, 246],    // pale teal tint for chips
};

export const FONT = {
  sans: "helvetica",
  serif: "times",
};

// Page geometry — US Letter portrait. Tightened margins (15mm vs 18mm) to
// give content ~12% more usable area per page and reduce the airy feel users
// were complaining about. Still leaves a printable safe zone.
export const PAGE = {
  width: 215.9,   // mm (letter)
  height: 279.4,  // mm (letter)
  marginX: 15,
  marginTop: 14,
  marginBottom: 14,
};

// IMPORTANT: jsPDF's built-in fonts (Helvetica/Times) use WinAnsi encoding,
// which CANNOT render Unicode arrows, geometric shapes, or emoji. They print
// as garbled glyph IDs. Stick to ASCII (or Latin-1) for type icons. The
// aesthetic is built from typography (small caps + teal accents) instead of
// pictograms.

// Sanitize free text to glyphs that jsPDF's built-in WinAnsi fonts can render.
// Anything outside Latin-1 (smart arrows, geometric shapes, emoji, thin space,
// the ⚠︎ glyph used by tonight items) becomes garbage with the built-in fonts.
// Convert '08:30' / '8:30' / '20:15' (24h) to '8:30 AM' / '8:15 PM'.
// Pass through anything that doesn't look like an HH:MM clock string (e.g.
// already-formatted '8:00 AM', durations like '4h 35m', empty values).
// Mirrors the formatTime() helper in App.jsx so the PDF and the live UI
// always display times the same way.
export function to12h(t) {
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

// Decompose Latin diacritics to their base ASCII letter so destinations
// like Korčula, Hvar, Pelješac, Šibenik, Mladý, Bršadin render cleanly
// instead of as "Kor?ula" / "Pelje?ac". jsPDF's built-in Helvetica only
// supports WinAnsi/CP1252, which doesn't include the Central-European
// Latin Extended-A block (ČćŽšđ etc.) — so we fold them down to
// their ASCII equivalents BEFORE the catchall strip.
const DIACRITIC_FOLDS = {
  // Latin Extended-A / Latin Extended-B Croatian + general European set
  "\u0100": "A", "\u0101": "a", "\u0102": "A", "\u0103": "a", "\u0104": "A", "\u0105": "a",
  "\u0106": "C", "\u0107": "c", "\u0108": "C", "\u0109": "c", "\u010A": "C", "\u010B": "c", "\u010C": "C", "\u010D": "c",
  "\u010E": "D", "\u010F": "d", "\u0110": "D", "\u0111": "d",
  "\u0112": "E", "\u0113": "e", "\u0114": "E", "\u0115": "e", "\u0116": "E", "\u0117": "e", "\u0118": "E", "\u0119": "e", "\u011A": "E", "\u011B": "e",
  "\u011C": "G", "\u011D": "g", "\u011E": "G", "\u011F": "g", "\u0120": "G", "\u0121": "g", "\u0122": "G", "\u0123": "g",
  "\u0124": "H", "\u0125": "h", "\u0126": "H", "\u0127": "h",
  "\u0128": "I", "\u0129": "i", "\u012A": "I", "\u012B": "i", "\u012C": "I", "\u012D": "i", "\u012E": "I", "\u012F": "i", "\u0130": "I", "\u0131": "i",
  "\u0134": "J", "\u0135": "j",
  "\u0136": "K", "\u0137": "k",
  "\u0139": "L", "\u013A": "l", "\u013B": "L", "\u013C": "l", "\u013D": "L", "\u013E": "l", "\u013F": "L", "\u0140": "l", "\u0141": "L", "\u0142": "l",
  "\u0143": "N", "\u0144": "n", "\u0145": "N", "\u0146": "n", "\u0147": "N", "\u0148": "n",
  "\u014C": "O", "\u014D": "o", "\u014E": "O", "\u014F": "o", "\u0150": "O", "\u0151": "o",
  "\u0154": "R", "\u0155": "r", "\u0156": "R", "\u0157": "r", "\u0158": "R", "\u0159": "r",
  "\u015A": "S", "\u015B": "s", "\u015C": "S", "\u015D": "s", "\u015E": "S", "\u015F": "s", "\u0160": "S", "\u0161": "s",
  "\u0162": "T", "\u0163": "t", "\u0164": "T", "\u0165": "t", "\u0166": "T", "\u0167": "t",
  "\u0168": "U", "\u0169": "u", "\u016A": "U", "\u016B": "u", "\u016C": "U", "\u016D": "u", "\u016E": "U", "\u016F": "u", "\u0170": "U", "\u0171": "u", "\u0172": "U", "\u0173": "u",
  "\u0174": "W", "\u0175": "w",
  "\u0176": "Y", "\u0177": "y", "\u0178": "Y",
  "\u0179": "Z", "\u017A": "z", "\u017B": "Z", "\u017C": "z", "\u017D": "Z", "\u017E": "z",
  // Common ligatures
  "\u0152": "OE", "\u0153": "oe", "\u00C6": "AE", "\u00E6": "ae", "\u00DF": "ss",
};
const DIACRITIC_RE = new RegExp("[" + Object.keys(DIACRITIC_FOLDS).join("") + "]", "g");

function foldDiacritics(s) {
  // First try NFKD-decompose-and-strip-combining-marks (covers a much wider
  // set than the manual table). The table above handles the precomposed
  // characters that NFKD doesn't break apart (đ, ł, ø, etc.).
  let out = s;
  try { out = out.normalize("NFKD").replace(/[\u0300-\u036F]/g, ""); } catch { /* normalize unsupported */ }
  return out.replace(DIACRITIC_RE, (ch) => DIACRITIC_FOLDS[ch] || ch);
}

export function asciiSafe(s) {
  if (s == null) return "";
  let out = String(s)
    // Directional arrows -> ASCII tokens.
    .replace(/[\u2192\u279C\u27A1\u2794]/g, " -> ")
    .replace(/\u2190/g, " <- ")
    .replace(/\u2194/g, " <-> ")
    .replace(/\u21D2/g, " => ")
    // Warning / priority markers used by tonight[].
    .replace(/\u26A0\uFE0E?/g, "!")
    .replace(/[\u2705\u2713\u2714]/g, "*")
    // Decorative emoji the planner sometimes emits before titles
    // (star, sparkles, sun, wine, building, etc.). Strip silently — we
    // do NOT want a stray "?" appearing in front of restaurant names.
    .replace(/[\u2605\u2606\u2728\u2600-\u2604\u2607-\u2691\u26A0-\u27BF]/g, "")
    // Common pictographic emoji ranges in the SMP — strip silently.
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, "")
    // Whitespace cleanup.
    .replace(/[\u2009\u200A\u202F\u00A0]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // Smart quotes -> ASCII.
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2015/g, "--"); // horizontal bar

  // Fold Latin diacritics down to base ASCII so destinations like Korčula
  // / Šibenik / Pelješac render as Korcula / Sibenik / Peljesac instead of
  // Kor?ula / ?ibenik / Pelje?ac.
  out = foldDiacritics(out);

  return out
    // The remaining CP1252-mapped chars (en dash 0x2013, em dash 0x2014,
    // ellipsis 0x2026, bullet 0x2022) are passed through — jsPDF's default
    // Helvetica encoding maps them correctly through WinAnsi/CP1252 even
    // though their Unicode codepoints are > 0xFF. Leaving them keeps the
    // typography looking professional (real dashes, real ellipsis).
    // Collapse double spaces.
    .replace(/ {2,}/g, " ")
    // Strip anything OTHER than ASCII, Latin-1 Supplement, and the CP1252
    // "extras" (smart quotes, dashes, bullet, ellipsis, trademark, euro).
    // Silent strip (was "?") so leftover emoji don't pollute headlines like
    // "? Cocktails at Bar Mavar" / "? Sea Organ".
    // The \x00-\xFF range is the deliberate "keep Latin-1" allowlist; the
    // control bytes inside it are expected and harmless because the input
    // strings never contain literal NULs / DELs. Suppress the warning.
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\xFF\u2013\u2014\u2018-\u201D\u2022\u2026\u20AC\u2122]/g, "")
    // Trim leading whitespace left behind by stripped emoji.
    // (Do NOT strip bullet chars here — markdownToProse emits leading
    // "• " for list items and we want to preserve that.)
    .replace(/^\s+/, "")
    .replace(/\s{2,}/g, " ");
}

// Strip the markdown the planner pours into the Trip Guidelines narrative
// box (## headers, **bold**, [text](url), -----, leading dashes for bullets)
// down to clean prose with paragraph breaks. The PDF can't render the
// markup, so left as-is it looked like a wall of code on the cover.

// -----------------------------------------------------------------------------
// PdfCursor — a tiny stateful helper for layout. Tracks current Y, page count,
// and provides primitives the rest of the module uses without repeating boiler.
// -----------------------------------------------------------------------------
export function makeCursor(pdf) {
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

  // Linked text — teal + underline, registered as a clickable PDF annotation.
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

    setColor(COLOR.accent);
    setDraw(COLOR.accent);
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

  // Inline teal accent rule used under section headers.
  function accentRule(width = 36) {
    setDraw(COLOR.accent);
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

  // Bullet item: teal dot + wrapped text.
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
    setFill(COLOR.accent);
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
      setDraw(COLOR.accent);
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
export function mapsUrl(address) {
  if (!address) return null;
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(address);
}
export function telUrl(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  return "tel:" + cleaned;
}
function carrierBookUrl(carrier) {
  if (!carrier) return null;
  const c = String(carrier).toLowerCase();
  if (c.includes("united")) return "https://www.united.com";
  if (c.includes("american")) return "https://www.aa.com";
  if (c.includes("delta")) return "https://www.delta.com";
  if (c.includes("jetblue")) return "https://www.jetblue.com";
  if (c.includes("southwest")) return "https://www.southwest.com";
  if (c.includes("alaska")) return "https://www.alaskaair.com";
  if (c.includes("frontier")) return "https://www.flyfrontier.com";
  if (c.includes("spirit")) return "https://www.spirit.com";
  if (c.includes("lufthansa")) return "https://www.lufthansa.com";
  if (c.includes("swiss")) return "https://www.swiss.com";
  if (c.includes("air france")) return "https://www.airfrance.com";
  if (c.includes("klm")) return "https://www.klm.com";
  if (c.includes("british")) return "https://www.britishairways.com";
  if (c.includes("iberia")) return "https://www.iberia.com";
  if (c.includes("cathay")) return "https://www.cathaypacific.com";
  if (c.includes("ana") || c.includes("all nippon")) return "https://www.ana.co.jp/en/us/";
  if (c.includes("jal") || c.includes("japan airlines")) return "https://www.jal.com";
  return null;
}
export function safe(s) { return s == null ? "" : String(s); }
export function titleCase(s) {
  if (!s) return s;
  return String(s).replace(/\b\w/g, c => c.toUpperCase());
}

// Hotel-brand → proprietary room-category names. Several brands market their
// room tiers with invented proper nouns (Hoxton's Cosy/Snug/Roomy/Biggy) that
// read as lowercase adjectives unless we quote + capitalize them. Keyed by a
// lowercase brand token matched against the hotel name; extend with Marriott /
// Aman / etc. as needed — the renderer stays data-driven off this map.
export const BRAND_ROOM_CATEGORIES = {
  hoxton: ["Cosy", "Snug", "Roomy", "Biggy"],
};

function detectHotelBrand(name) {
  const n = String(name || "").toLowerCase();
  for (const brand of Object.keys(BRAND_ROOM_CATEGORIES)) {
    if (n.includes(brand)) return brand;
  }
  return null;
}

// Render a brand's room-category names as the proper nouns they are: quoted and
// capitalized, labeled as a "room category" rather than a plain adjective. When
// the hotel isn't a known brand the room string passes through untouched.
//   Hoxton: `Roomy or Biggy room (canal view upgrade recommended)`
//        →  `"Roomy" or "Biggy" room category (request canal view)`
export function normalizeRoomType(hotelName, roomType) {
  if (!roomType) return roomType;
  const brand = detectHotelBrand(hotelName);
  if (!brand) return roomType;
  let out = String(roomType);
  for (const cat of BRAND_ROOM_CATEGORIES[brand]) {
    // Quote + capitalize the category, skipping any that's already quoted.
    const re = new RegExp(`(?<!["'\\w])${cat}(?!["'\\w])`, "gi");
    out = out.replace(re, `"${cat}"`);
  }
  // These are named categories, not loose adjectives — make that explicit.
  out = out.replace(/\broom\b(?! category)/i, "room category");
  // Tighten a "canal view upgrade recommended" nudge into a cleaner request.
  out = out.replace(/\([^)]*canal view[^)]*\)/i, "(request canal view)");
  return out;
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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Derive a "September 2026" cover subtitle from the trip's start date + night
// count. Pure and timezone-safe: the ISO date is parsed in UTC so a Cloudflare
// Worker's UTC runtime can't shift the month across a boundary. Spans:
//   same month/year        → "September 2026"
//   cross-month, same year → "September – October 2026"
//   cross-year             → "December 2026 – January 2027"
// Returns null when startDate isn't a parseable YYYY-MM-DD, so the caller can
// omit the subtitle rather than print a fabricated date.
export function formatTripMonthYear(startDate, nights) {
  const m = safe(startDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const startY = Number(m[1]);
  const startMo = Number(m[2]) - 1;
  const startD = Number(m[3]);
  const n = Number.parseInt(nights, 10);
  const spanNights = Number.isFinite(n) && n > 0 ? n : 0;
  const start = new Date(Date.UTC(startY, startMo, startD));
  const end = new Date(Date.UTC(startY, startMo, startD + spanNights));
  const sM = start.getUTCMonth(), sY = start.getUTCFullYear();
  const eM = end.getUTCMonth(), eY = end.getUTCFullYear();
  if (sY === eY && sM === eM) return `${MONTH_NAMES[sM]} ${sY}`;
  if (sY === eY) return `${MONTH_NAMES[sM]} – ${MONTH_NAMES[eM]} ${sY}`;
  return `${MONTH_NAMES[sM]} ${sY} – ${MONTH_NAMES[eM]} ${eY}`;
}

// Human-friendly transport modes actually used in the trip, derived from the
// ground-transport steps in the day-by-day (NOT the user's stated preference).
// Returns { modes: [labels], rentalUsed: bool }. A rental-car brand is only
// worth surfacing when a rental leg genuinely appears in the plan.
const TRANSPORT_MODE_PATTERNS = [
  { label: "rental car", rental: true, re: /\b(rental|hertz|avis|europcar|sixt|enterprise|budget rent|car rental|rent(?:al)? car|pick ?up (?:the |your )?car)\b/i },
  { label: "train", re: /\b(train|rail|railway|\bNS\b|centraal|eurostar|intercity|thalys)\b/i },
  { label: "private car", re: /\b(private car|car service|chauffeur|private transfer|black car|sedan)\b/i },
  { label: "ferry", re: /\b(ferry|catamaran|boat transfer)\b/i },
  { label: "tram", re: /\btram\b/i },
  { label: "metro", re: /\b(metro|subway|underground)\b/i },
  { label: "taxi", re: /\b(taxi|uber|cab)\b/i },
];

export function deriveTransportSummary(data) {
  const days = Array.isArray(data?.days) ? data.days : [];
  const seen = [];
  let rentalUsed = false;
  for (const d of days) {
    const items = Array.isArray(d?.items) ? d.items : [];
    for (const it of items) {
      const type = safe(it?.type).toLowerCase();
      const isGround = /car|transport|train|transfer|ferry|tram|metro|taxi|drive|bus/.test(type);
      // Derive ONLY from genuine ground-transport steps (spec #7): keying off
      // the item TYPE keeps a restaurant called "The Tram Stop" or an activity
      // named "Train Museum" from registering as a mode of travel.
      if (!isGround) continue;
      const haystack = `${safe(it?.type)} ${safe(it?.text)} ${safe(it?.location)}`;
      for (const m of TRANSPORT_MODE_PATTERNS) {
        if (m.re.test(haystack)) {
          if (m.rental) rentalUsed = true;
          if (!seen.includes(m.label)) seen.push(m.label);
        }
      }
    }
  }
  return { modes: seen, rentalUsed };
}

// Cover "Transport" value. Only surfaces a rental-car brand when a rental leg
// actually appears in the day-by-day; otherwise it shows the modes the trip
// really uses (e.g. "Train + private car"), title-cased and joined with " + ".
// Falls back to the user-profile transport string only when nothing usable can
// be derived from the plan.
function transportSummaryLine(data, t = {}) {
  const { modes, rentalUsed } = deriveTransportSummary(data);
  const profile = [t.type, t.company].filter(Boolean).join(" · ");
  if (rentalUsed) return profile || "Rental car";
  if (modes.length) {
    return modes
      .filter(m => m !== "rental car")
      .map(m => m.charAt(0).toUpperCase() + m.slice(1))
      .join(" + ");
  }
  return profile || null;
}

// -----------------------------------------------------------------------------
// COVER PAGE
// -----------------------------------------------------------------------------
function renderCover(cur, data, inputs, opts = {}) {
  const { pdf } = cur;
  const { coverPhoto } = opts;
  // Title text. For a multi-city trip the destination field becomes a long
  // "A -> B -> C -> ..." chain which sets unevenly at 26pt and screams
  // "unformatted code". If we have a structured cities array, use the first
  // + last city to form an elegant "Venice to Split" title; the full route
  // appears immediately below in the meta / cities preview lines anyway.
  let dest = safe(data?.destination || (Array.isArray(data?.cities) && data.cities[0]?.name) || "Your trip");
  const cityList = Array.isArray(data?.cities) ? data.cities : [];
  if (cityList.length >= 2) {
    const first = safe(cityList[0]?.name);
    const last = safe(cityList[cityList.length - 1]?.name);
    if (first && last && first !== last) dest = `${first} to ${last}`;
  } else if (/\s->\s/.test(dest)) {
    // Fallback when only the legacy string is available: pick endpoints.
    const parts = dest.split(/\s->\s/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) dest = `${parts[0]} to ${parts[parts.length - 1]}`;
  }
  // Replace the meta line's misleading "(6+1)" nights grouping with the real
  // per-leg breakdown derived from the day-by-day (e.g. "7 nights (3+3+1)").
  const meta = rewriteMetaNights(safe(data?.meta || ""), data);

  // Cover photo hero — full-width image at the top of the cover page.
  // Renders only when a data URL was fetched by the caller; silently skipped
  // when the /api/destination-photo request failed or returned nothing.
  if (coverPhoto) {
    // 3:2 aspect ratio — standard landscape photo proportion.
    // Centered in the printable area so left/right margins are symmetric.
    const photoW = 130;
    const photoH = Math.round(photoW * (2 / 3)); // 87mm
    const photoX = (PAGE.width - photoW) / 2;
    try {
      const imgFormat = coverPhoto.match(/^data:image\/(\w+);/)?.[1]?.toUpperCase() ?? "JPEG";
      pdf.addImage(coverPhoto, imgFormat, photoX, cur.state.y, photoW, photoH, undefined, "FAST");
      cur.state.y += photoH + 5;
    } catch { /* addImage failure silently falls through to text-only cover */ }
  } else {
    // No photo: compact spacing — the title block provides enough breathing room.
    cur.space(3);
  }

  // Eyebrow
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(8.5);
  pdf.setCharSpace(1.2);
  cur.setColor(COLOR.accent);
  pdf.text("ITINERARY", PAGE.marginX, cur.state.y);
  pdf.setCharSpace(0);
  cur.space(3);

  // Title (serif italic for editorial feel)
  cur.text(dest, {
    font: FONT.serif,
    style: "italic",
    size: 26,
    color: COLOR.ink,
    leading: 1.05,
  });

  // Month + year subtitle — a quiet editorial date line tucked directly under
  // the title (part of the title block, above the accent rule and the detailed
  // meta line that follows). Derived purely from the trip's start date +
  // nights; omitted when the start date isn't parseable rather than guessed.
  const monthYear = formatTripMonthYear(inputs?.basics?.startDate, inputs?.basics?.nights);
  if (monthYear) {
    cur.space(1);
    cur.text(monthYear, { font: FONT.serif, style: "normal", size: 17, color: COLOR.inkSoft, leading: 1.1 });
  }

  cur.space(2);

  // Teal accent rule
  cur.accentRule(48);
  cur.space(2);

  // Meta line
  if (meta) {
    cur.text(meta, { font: FONT.sans, style: "normal", size: 11, color: COLOR.inkSoft, leading: 1.3 });
  }

  // Cities preview (multi-city) — one city per line so a long multi-leg route
  // reads as a clean list instead of a single run-on sentence.
  if (Array.isArray(data?.cities) && data.cities.length > 1) {
    cur.space(2);
    data.cities.forEach((c, i) => {
      const line = `${i + 1}. ${c.name}${c.nights ? ` · ${c.nights}n` : ""}${c.focus ? ` — ${c.focus}` : ""}`;
      cur.text(line, { font: FONT.sans, style: "italic", size: 10, color: COLOR.inkSoft, leading: 1.35 });
    });
  }

  cur.space(3);
  cur.rule({ color: COLOR.rule, space: 0.5 });

  // "What you told us" — compact input summary, omit empties.
  if (inputs) {
    cur.space(1);
    pdf.setFont(FONT.sans, "bold");
    pdf.setFontSize(9);
    pdf.setCharSpace(1.0);
    cur.setColor(COLOR.accent);
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
      ["Transport", transportSummaryLine(data, t)],
      ["Vehicle", t.vehicle],
      ["Cuisine focus", dn.cuisine],
      ["Dining budget", Array.isArray(dn.budget) ? dn.budget.join(", ") : dn.budget],
      // Counts only — the full lists used to dump 27 restaurant names and 28
      // activities onto the cover, eating half the page. The actual items
      // are already woven into the day-by-day plan that follows.
      ["Requested restaurants", Array.isArray(inputs.restaurants) && inputs.restaurants.length
        ? `${inputs.restaurants.length} requested — see day plan`
        : null],
      ["Requested activities", Array.isArray(inputs.activities) && inputs.activities.length
        ? `${inputs.activities.length} requested — see day plan`
        : null],
      ["Interest level", it.level],
    ].filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== "" && r[1] !== "—");

    rows.forEach(r => cur.kvRow(r[0], r[1]));

    // Trip Guidelines and Trip Narrative are NOT re-printed on the cover.
    // They're the user's raw input; the trip plan that follows already
    // reflects them. Re-printing them earlier added 4–6 pages of dense prose
    // that the user explicitly called out as too much.
  }

  // Generated stamp removed from the cover body. Now that day-by-day content
  // can flow onto the cover page (whitespace fix), a bottom-of-page stamp
  // risked overlapping with that content. The footer pass at the end of the
  // build writes a Generated stamp on page 1 instead (see renderFooters).
}

// -----------------------------------------------------------------------------
// INTRODUCTION PAGE
// -----------------------------------------------------------------------------
// Standing instruction (user-set 2026-06-08): every itinerary PDF includes a
// dedicated full Introduction page positioned after the cover and before the
// Day-by-Day section. The page is destination-name + year as heading (same
// style as day headers), then two flowing-prose paragraphs separated by a
// thin rule — Part 1 "Arc of the Journey" and Part 2 "What Makes This
// Itinerary Different". No headers between parts. No bullets. The page MUST
// NOT show the word "Introduction".
//
// The two prose strings live on data.introduction.{arc, differentiators} and
// are emitted by the planner model (see INTRODUCTION-PAGE rule in the system
// prompt). When the model returned no genuinely distinctive off-path
// elements it writes 'NONE_FLAGGED' in differentiators — we surface that as
// a small italic note instead of fabricating content.
// -----------------------------------------------------------------------------
function renderIntroduction(cur, data, _inputs) {
  const { pdf } = cur;
  const intro = data && data.introduction;
  if (!intro || (typeof intro.arc !== "string" && typeof intro.differentiators !== "string")) {
    return; // no introduction to render — silently skip
  }

  // Force a fresh page so the intro always gets its own.
  cur.newPage();

  // Section header: "The Trip" — a titled anchor for the guiding narrative that
  // sits between "What You Told Us" and "Day by Day". The narrative used to
  // float untitled. Same small-caps / tracked / teal treatment as the day
  // headers. Still NO word "Introduction".
  const headingText = "The Trip";

  cur.space(2);
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(10);
  pdf.setCharSpace(1.6);
  cur.setColor(COLOR.accent);
  const headingMaxW = PAGE.width - PAGE.marginX * 2;
  const headingLines = pdf.splitTextToSize(asciiSafe(headingText.toUpperCase()), headingMaxW);
  const headingLineH = (10 * 1.2) / 2.83465;
  headingLines.forEach((ln, i) => {
    pdf.text(ln, PAGE.marginX, cur.state.y + i * headingLineH);
  });
  cur.state.y += Math.max(0, headingLines.length - 1) * headingLineH;
  pdf.setCharSpace(0);
  cur.space(2);
  cur.accentRule(48);
  cur.space(5);

  // Body — navy text in serif, generous leading for an editorial read.
  // The two parts sit as one continuous narrative separated only by paragraph
  // spacing. The single teal accent bar lives under the "The Trip" header
  // above; a second rule between the paragraphs used to split the narrative
  // into two disconnected blurbs (fixed per report #4).
  const arcText = (intro.arc && typeof intro.arc === "string") ? intro.arc.trim() : "";
  const diffText = (intro.differentiators && typeof intro.differentiators === "string") ? intro.differentiators.trim() : "";

  if (arcText) {
    cur.text(arcText, {
      font: FONT.serif,
      style: "normal",
      size: 11.5,
      color: COLOR.ink,
      leading: 1.55,
    });
  }

  if (diffText && diffText !== "NONE_FLAGGED") {
    // The two paragraphs are one guiding narrative — a rule between them
    // visually split it into two disconnected blurbs. The single accent bar
    // now lives under the "The Trip" header (above); here we use plain
    // paragraph spacing so the narrative reads as one continuous piece.
    cur.space(4);
    cur.text(diffText, {
      font: FONT.serif,
      style: "normal",
      size: 11.5,
      color: COLOR.ink,
      leading: 1.55,
    });
  } else if (diffText === "NONE_FLAGGED") {
    // The model flagged that this itinerary has no genuinely distinctive
    // off-path elements. Surface that honestly rather than fabricate.
    cur.space(4);
    cur.text(
      "The planner flagged this itinerary as a strong but standard route — no off-the-beaten-path differentiators worth singling out. Consider asking the reviewer for unusual additions if you want more distinction.",
      { font: FONT.sans, style: "italic", size: 10, color: COLOR.inkSoft, leading: 1.4 },
    );
  }
}

// -----------------------------------------------------------------------------
// DAY PAGES
// -----------------------------------------------------------------------------
function renderDay(cur, day, index, opts = {}) {
  const { pdf } = cur;
  const { cityPhoto = null, itemPhotos = {}, destination = "" } = opts;
  const dayCity = (day.city || destination || "").toLowerCase();

  // Reserve room before starting a day. 55mm fits a day label + headline +
  // 1 item without orphaning. Previous 72mm left up to 71mm of blank space
  // at the bottom of pages before a day header.
  cur.ensureSpace(55);

  // City photo banner — full-width landscape image shown on the first day
  // of each new city (passed in via opts.cityPhoto). Provides visual
  // interest without requiring every day to have its own photo fetch.
  if (cityPhoto) {
    // 3:2 aspect ratio, centered — same proportions as the cover photo.
    const photoW = 130;
    const photoH = Math.round(photoW * (2 / 3)); // 87mm
    const photoX = (PAGE.width - photoW) / 2;
    try {
      const imgFmt = cityPhoto.match(/^data:image\/(\w+);/)?.[1]?.toUpperCase() ?? "JPEG";
      pdf.addImage(cityPhoto, imgFmt, photoX, cur.state.y, photoW, photoH, undefined, "FAST");
      cur.state.y += photoH + 4;
    } catch { /* silently skip — text-only fallback */ }
  }

  // Day label — bigger, more tracked, and with a generous teal accent rule
  // so the start of each day reads like a proper section, not another bullet.
  //
  // WRAP the label rather than drawing it on one fixed line. Long labels
  // like "DAY 7 · WED AUG 31 · DUBROVNIK -> KORCULA (CATAMARAN)" render
  // ~190mm wide at 10pt bold + 1.6mm letter-spacing, well past the page
  // edge. splitTextToSize handles the wrap; we draw each line at the
  // current y and advance manually.
  cur.space(1);
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(10);
  pdf.setCharSpace(1.6);
  cur.setColor(COLOR.accent);
  const labelText = (day.label || `DAY ${index + 1}`).toString();
  const labelMaxW = PAGE.width - PAGE.marginX * 2;
  const labelLines = pdf.splitTextToSize(asciiSafe(labelText.toUpperCase()), labelMaxW);
  const labelLineH = (10 * 1.2) / 2.83465; // pt -> mm, tight leading for caps
  labelLines.forEach((ln, i) => {
    pdf.text(ln, PAGE.marginX, cur.state.y + i * labelLineH);
  });
  cur.state.y += Math.max(0, labelLines.length - 1) * labelLineH;
  pdf.setCharSpace(0);
  cur.space(1.5);
  cur.accentRule(36);
  cur.space(2);

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
    cur.space(0.3);
    cur.text(metaBits.join("  ·  "), { font: FONT.sans, style: "italic", size: 10, color: COLOR.inkSoft });
  }
  cur.space(0.3);
  cur.rule({ color: COLOR.rule, space: 0.5 });
  cur.space(0.3);

  // Items
  const items = Array.isArray(day.items) ? day.items : [];
  // Sort chronologically by time string ("HH:MM")
  items.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));

  items.forEach((item, i) => renderItem(cur, item, i === items.length - 1, itemPhotos, dayCity));
}

function renderItem(cur, item, isLast, itemPhotos = {}, dayCity = "") {
  const { pdf } = cur;
  if (!item) return;

  // Always render times in 12h AM/PM (UI parity).
  const time = to12h(safe(item.time));
  const endTime = to12h(safe(item.end_time));
  const timeLabel = endTime ? `${time}–${endTime}` : time;
  const type = safe(item.type);

  // Time column width — measure the ACTUAL rendered label width and reserve
  // enough room for it plus a 2mm gutter before the title column.
  //
  // The previous fixed 32mm worked for most labels but real-world cases
  // overflowed:
  //   "10:00 AM–12:30 PM" ≈ 33.5mm → collided with "Catamaran ..."
  //   "10:45 AM–2:00 PM"  ≈ 32.2mm → collided with "Private transfer ..."
  //   "11:00 AM–12:15 PM" ≈ 33.0mm → collided with "Roxanich Winery ..."
  // (user-reported PDF screenshot 2026-06-08.)
  //
  // Measured width is bounded at 42mm so a freak label can't eat the whole
  // page; if a label is wider than that the bound clips it and the title
  // column still gets reasonable space.
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(10.5);
  const measuredTimeW = timeLabel ? pdf.getTextWidth(asciiSafe(timeLabel)) : 0;
  const timeColW = Math.min(42, Math.max(32, measuredTimeW + 3));
  const headX = PAGE.marginX + timeColW;
  const bodyMaxW = PAGE.width - PAGE.marginX - headX;

  // Reserve enough vertical space for the WHOLE item including its type-
  // specific block (flight / hotel / restaurant / contact). Previous 14mm
  // only fit the headline; the trailing Backup / Note / Hours lines then
  // got orphaned to the next page (user reported an orphan BACKUP line on
  // an otherwise-blank page 3). 32mm comfortably fits a headline + 4–6
  // detail lines and forces the entire item onto the same page when there
  // isn't room to fit it intact at the bottom of the current page.
  //
  // FLIGHT cards carry more rows than any other item (Flight / Cabin /
  // Aircraft / Verify / Note / Book ≈ 6 detail lines + headline), so 32mm
  // was too small — a departing flight card could split, or (as reported on
  // the Amsterdam→Bruges Day 8) get pushed whole onto the next page and
  // read as orphaned. Reserve ~66mm for flight items so the card stays
  // intact as a single block within its day. This is the jsPDF equivalent
  // of `page-break-inside: avoid` on the flight card.
  const itemReserve = item.flight ? 66 : 32;
  cur.ensureSpace(itemReserve);
  cur.space(0.4);
  const itemTop = cur.state.y;
  const itemTopPage = cur.state.page;

  // Time block (left column)
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(10.5);
  cur.setColor(COLOR.ink);
  pdf.text(asciiSafe(timeLabel || "—"), PAGE.marginX, cur.state.y + 3.8);
  if (type) {
    pdf.setFont(FONT.sans, "bold");
    pdf.setFontSize(7.5);
    pdf.setCharSpace(0.6);
    cur.setColor(COLOR.accent);
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

  // "Why" — soft serif italic for editorial reasoning. Capped to one sentence
  // (or ~140 chars) so a paragraph-length blurb can't bloat the item.
  if (item.why) {
    let whyText = safe(item.why).trim();
    // Take the first sentence; fall back to a 140-char hard cap.
    //
    // Skip common abbreviations whose period is NOT a sentence terminator.
    // The original regex /^[^.!?\n]{8,}[.!?]/ would clip
    //   "Stone-paved alleys climb steeply to St. Euphemia, ..."
    // at "St." — the user-reported PDF showed dozens of these mid-sentence
    // truncations (St./Mt./Ave./Mr./Mrs./Dr./Jr./Sr./Co./Inc.).
    // New approach: walk forward through candidate terminators and skip
    // any preceded by a known abbreviation. Falls back to whole text if no
    // genuine terminator is found inside the 140-char cap.
    const ABBREVS = /\b(?:St|Mt|Mr|Mrs|Ms|Dr|Jr|Sr|Co|Inc|Ltd|Ave|Blvd|Rd|Ft|No|vs|etc|e\.g|i\.e)$/i;
    const findEnd = (s) => {
      const re = /[.!?]/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        if (m.index < 8) continue; // need at least 8 chars before terminator
        const prefix = s.slice(0, m.index);
        if (ABBREVS.test(prefix)) continue; // abbreviation, not a sentence end
        return m.index + 1;
      }
      return -1;
    };
    const endIdx = findEnd(whyText);
    if (endIdx > 0 && endIdx <= 200) {
      whyText = whyText.slice(0, endIdx);
    }
    if (whyText.length > 140) whyText = whyText.slice(0, 137).replace(/\s+\S*$/, "") + "…";
    pdf.setFont(FONT.serif, "italic");
    pdf.setFontSize(10);
    cur.setColor(COLOR.inkSoft);
    const whyLines = cur.wrap(whyText, bodyMaxW);
    const lineHWhy = (10 * 1.35) / 2.83465;
    whyLines.forEach((ln, i) => {
      pdf.text(asciiSafe(ln), headX, cur.state.y + 3 + i * lineHWhy);
    });
    cur.state.y += whyLines.length * lineHWhy + 1;
  }

  // Type-specific extras — Hotel and Activity items get an inline photo banner
  // (body-column width, ~24mm tall) when a pre-fetched photo is available.
  if (item.flight) {
    renderFlightBlock(cur, item.flight, headX, bodyMaxW);
  } else if (item.hotel) {
    const hotelName = item.hotel?.name || item.text || "";
    const photoKey = makeItemPhotoKey(hotelName, dayCity);
    const photo = itemPhotos[photoKey];
    if (photo) embedItemPhoto(cur, photo, headX, bodyMaxW);
    renderHotelBlock(cur, item.hotel, headX, bodyMaxW);
    if (item.contact) renderContactBlock(cur, item.contact, headX, bodyMaxW);
  } else if (item.type === "Activity") {
    const photoKey = makeItemPhotoKey(item.text || "", dayCity);
    const photo = itemPhotos[photoKey];
    if (photo) embedItemPhoto(cur, photo, headX, bodyMaxW);
    if (item.restaurant) renderRestaurantBlock(cur, item.restaurant, headX, bodyMaxW);
    if (item.contact) renderContactBlock(cur, item.contact, headX, bodyMaxW);
  } else {
    if (item.restaurant) renderRestaurantBlock(cur, item.restaurant, headX, bodyMaxW);
    if (item.contact) renderContactBlock(cur, item.contact, headX, bodyMaxW);
  }

  // Bottom spacer + divider line between items
  cur.space(0.5);
  if (!isLast) {
    cur.setDraw(COLOR.ruleSoft);
    pdf.setLineWidth(0.1);
    pdf.line(headX, cur.state.y, PAGE.width - PAGE.marginX, cur.state.y);
    cur.space(0.5);
  } else {
    cur.space(0.5);
  }
  // Make sure item top reference exists (keeps the column visually aligned
  // even if the body is shorter than the time label). Only enforce this
  // when we're still on the page the item started on — otherwise we'd push
  // state.y past the bottom margin of the new page, leaving everything
  // after the item on a fresh page with the rest of the current page blank.
  // (That was the cause of the giant whitespace gap between Day 1 and Day 2.)
  if (cur.state.page === itemTopPage && cur.state.y < itemTop + 10) {
    cur.state.y = itemTop + 10;
  }
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
    cur.setColor(COLOR.accent);
    cur.setDraw(COLOR.accent);
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
  // Ident: a schedule-resolved number (e.g. "UA1792") already carries its own
  // carrier prefix and is self-labeled, so pairing it with fl.carrier would
  // double-prefix it ("United UA1792"). Mirror the on-screen title logic: show
  // the number alone when it's self-prefixed/auto-resolved; otherwise pair
  // carrier + number.
  const _fn = fl.flight_number ? String(fl.flight_number).trim() : "";
  const _selfPrefixed = fl._autoResolvedFlightNumber || /^[A-Z0-9]{2}\s?\d{1,4}$/.test(_fn);
  const ident = _fn
    ? (_selfPrefixed ? _fn : [fl.carrier, _fn].filter(Boolean).join(" "))
    : (fl.carrier || "");
  const headline = [
    ident,
    [fl.from_airport, to12h(fl.depart_time)].filter(Boolean).join(" "),
    "→",
    [fl.to_airport, to12h(fl.arrive_time)].filter(Boolean).join(" "),
    fl.duration ? `· ${fl.duration}` : "",
    fl.nonstop ? "· nonstop" : (fl.connection ? `· via ${fl.connection}` : ""),
  ].filter(s => s && s !== "→ ").join(" ").replace(/\s+/g, " ").trim();
  if (headline) renderDetailLine(cur, "Flight", headline, x, maxW);
  if (fl.cabin) renderDetailLine(cur, "Cabin", fl.cabin, x, maxW);
  if (fl.aircraft) renderDetailLine(cur, "Aircraft", fl.aircraft, x, maxW);
  // Honesty qualifier — emit for EVERY flight block (outbound AND return) so the
  // card reads consistently regardless of direction. A flight number is the
  // scheduled operating flight, not a guaranteed booking; user-supplied numbers
  // still warrant a confirm-at-booking nudge. Only skipped when there is no
  // number at all (nothing to verify).
  if (fl.flight_number) {
    renderDetailLine(cur, "Verify", "Flight number is the scheduled operating flight — confirm at booking.", x, maxW);
  }
  // #12 follow-up: when both /api/flights-search attempts (airline-filtered
  // + route-only retry) missed AND the model also omitted clock times, the
  // resolver flags the flight with _timesUnconfirmed so the PDF can render
  // an honest line in place of the blank we used to leave behind. See
  // docs/wiki/concepts/flight-resolver-gaps.md.
  if (fl._timesUnconfirmed && !(fl.depart_time && fl.arrive_time)) {
    renderDetailLine(cur, "Times", "Not yet confirmed — check with airline at booking.", x, maxW);
  }
  if (fl.confirmation_note) renderDetailLine(cur, "Note", fl.confirmation_note, x, maxW);
  const bookUrl = carrierBookUrl(fl.carrier);
  if (bookUrl) renderLinkLine(cur, "Book", bookUrl, bookUrl, x, maxW);
}

// Embed a photo data URL as a right-aligned 3:2 thumbnail in the body column.
// Used for Hotel and Activity items. Silently skipped on any addImage failure.
function embedItemPhoto(cur, photoDataUrl, x, maxW) {
  if (!photoDataUrl) return;
  const { pdf } = cur;
  // 3:2 ratio thumbnail — matches standard landscape photo proportions.
  // Right-aligned within the body column so it sits beside the item heading.
  const photoW = Math.min(72, maxW);
  const photoH = Math.round(photoW * (2 / 3)); // 48mm at 72mm wide
  const photoX = x + maxW - photoW;
  cur.ensureSpace(photoH + 3);
  cur.space(1.5);
  try {
    const fmt = photoDataUrl.match(/^data:image\/(\w+);/)?.[1]?.toUpperCase() ?? "JPEG";
    pdf.addImage(photoDataUrl, fmt, photoX, cur.state.y, photoW, photoH, undefined, "FAST");
    cur.state.y += photoH + 3;
  } catch { /* skip on failure — text-only fallback */ }
}

function renderHotelBlock(cur, h, x, maxW) {
  if (h.name) renderDetailLine(cur, "Hotel", h.name, x, maxW);
  if (h.website) renderLinkLine(cur, "Website", h.website, h.website, x, maxW);
  if (h.booking_url && h.booking_url !== h.website) renderLinkLine(cur, "Book", h.booking_url, h.booking_url, x, maxW);
  if (h.address) renderLinkLine(cur, "Address", h.address, mapsUrl(h.address), x, maxW);
  if (h.phone) renderLinkLine(cur, "Phone", h.phone, telUrl(h.phone), x, maxW);
  const ci = [h.check_in_time ? `In ${to12h(h.check_in_time)}` : "", h.check_out_time ? `Out ${to12h(h.check_out_time)}` : ""].filter(Boolean).join("  ·  ");
  if (ci) renderDetailLine(cur, "Times", ci, x, maxW);
  if (h.room_type) renderDetailLine(cur, "Room", normalizeRoomType(h.name, h.room_type), x, maxW);
  if (h.confirmation_note) renderDetailLine(cur, "Note", h.confirmation_note, x, maxW);
}

// Render a row of small pill-style reservation chips: pale-teal fill, teal
// underlined platform label, tappable hyperlink.
// feel inside a button-shaped container so the user can tap directly from the
// PDF to OpenTable / Resy / Tock / Yelp / tel:. Wraps to a second line if the
// row exceeds maxW. Each chip is { label, url }.
function renderReservationChips(cur, chips, x, maxW) {
  const { pdf } = cur;
  if (!chips || !chips.length) return;
  cur.ensureSpace(7);
  _drawDetailLabel(cur, "Reserve", x);

  const chipX0 = x + DETAIL_LABEL_W;
  const chipH = 5.2;   // mm — pill height
  const padX = 2.4;    // horizontal padding inside chip
  const gap = 2.2;     // gap between chips
  const radius = 1.6;
  const fontSize = 9.5;
  const lineH = chipH + 1.6;

  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(fontSize);

  // First pass: measure widths.
  const sized = chips.map((c) => {
    const safe = asciiSafe(String(c.label || ""));
    const tw = pdf.getTextWidth(safe);
    return { ...c, safe, w: tw + padX * 2 };
  });

  let curX = chipX0;
  let curY = cur.state.y + 1.0;
  const rowMaxX = x + maxW;

  sized.forEach((c) => {
    if (curX + c.w > rowMaxX && curX > chipX0) {
      curY += lineH;
      curX = chipX0;
    }
    // Pill background.
    cur.setFill(COLOR.bgChip);
    cur.setDraw(COLOR.accent);
    pdf.setLineWidth(0.2);
    pdf.roundedRect(curX, curY, c.w, chipH, radius, radius, "FD");
    // Teal underlined label as a tappable link.
    const textX = curX + padX;
    const baselineY = curY + chipH - 1.5;
    cur.setColor(COLOR.accent);
    if (c.url) {
      pdf.textWithLink(c.safe, textX, baselineY, { url: c.url });
      pdf.setLineWidth(0.15);
      pdf.line(textX, baselineY + 0.5, textX + pdf.getTextWidth(c.safe), baselineY + 0.5);
    } else {
      pdf.text(c.safe, textX, baselineY);
    }
    curX += c.w + gap;
  });

  cur.state.y = curY + lineH;
}

// Map reservation.platform → human chip label.
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

  // Walk-in: single static chip, no URL.
  if (platform === "walkin") {
    chips.push({ label: "Walk-in", url: null });
    return chips;
  }

  // Primary online booking chip (OpenTable / Resy / Tock / Yelp) when we have
  // a URL. Phone is intentionally suppressed when an online URL exists — best
  // UX is one primary action, not a cluttered row.
  if (res.url) {
    const label = RESV_PLATFORM_LABEL[platform] || "Reserve";
    chips.push({ label, url: res.url });
    return chips;
  }

  // No URL: fall back to a Call chip if we have a phone number.
  if (res.phone) {
    chips.push({ label: "Call", url: telUrl(res.phone) });
    return chips;
  }

  // Platform stated but neither URL nor phone — render a label-only chip so
  // the user still sees the booking platform.
  if (platform) {
    chips.push({ label: RESV_PLATFORM_LABEL[platform] || titleCase(platform), url: null });
  }
  return chips;
}

function renderRestaurantBlock(cur, r, x, maxW) {
  if (r.name) renderDetailLine(cur, "Restaurant", r.name, x, maxW);
  const cuisineBits = [r.cuisine, r.price_range, r.neighborhood].filter(Boolean).join("  ·  ");
  if (cuisineBits) renderDetailLine(cur, "Style", cuisineBits, x, maxW);
  const chips = buildReservationChips(r.reservation);
  if (chips.length) renderReservationChips(cur, chips, x, maxW);
  if (r.contact) renderContactBlock(cur, r.contact, x, maxW);
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
// BY CATEGORY — the same plan items as the day-by-day, regrouped into category
// buckets (flights / lodging / ground transport / activities / dining) via the
// shared groupItemsByCategory helper so this section and the on-screen "By
// category" tab can never drift. A tight, scannable back-of-book reference; it
// reuses the same detail-line / block renderers as the day pages and invents
// nothing — every value is carried through from the (already-verified) plan.
// -----------------------------------------------------------------------------

// Cap per category so a sprawling trip can't balloon this reference section.
// The uncapped day-by-day remains the authoritative full listing.
const CATEGORY_PDF_CAP = 40;

// "Day 2 · Fri Jun 5 · 9:00 AM" — day number + the day-label's weekday/date
// segment (when present) + the item's 12-hour start time.
function categoryEntryContext(entry) {
  const weekday = String(entry.dayLabel || "").split(" · ")[1] || "";
  return [`Day ${entry.dayIndex + 1}`, weekday, to12h(safe(entry.time))]
    .filter(Boolean).join("  ·  ");
}

function renderCategoryEntry(cur, entry, category, x, maxW) {
  const { pdf } = cur;
  // Keep the context line + a couple of detail rows together on one page.
  cur.ensureSpace(16);
  cur.space(1.2);

  // Context line — small teal uppercase tag (Day / weekday / time).
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(7.5);
  pdf.setCharSpace(0.5);
  cur.setColor(COLOR.accent);
  pdf.text(asciiSafe(categoryEntryContext(entry).toUpperCase()), x, cur.state.y + 3);
  pdf.setCharSpace(0);
  cur.state.y += 5;

  const item = entry.item || {};
  if (category === "flights" && item.flight) {
    renderFlightBlock(cur, item.flight, x, maxW);
  } else if (category === "lodging" && item.hotel) {
    renderHotelBlock(cur, item.hotel, x, maxW);
  } else if (category === "dining" && item.restaurant) {
    renderRestaurantBlock(cur, item.restaurant, x, maxW);
  } else if (category === "transport") {
    if (item.text) renderDetailLine(cur, "Detail", item.text, x, maxW);
    if (item.location) renderDetailLine(cur, "Where", item.location, x, maxW);
    if (item.duration) renderDetailLine(cur, "Duration", item.duration, x, maxW);
    if (item.contact) renderContactBlock(cur, item.contact, x, maxW);
  } else {
    // activities (and any other card-bearing item)
    if (item.text) renderDetailLine(cur, "Activity", item.text, x, maxW);
    if (item.why) renderDetailLine(cur, "Why", item.why, x, maxW);
    if (item.location && !item.contact?.address) renderDetailLine(cur, "Where", item.location, x, maxW);
    if (item.contact) renderContactBlock(cur, item.contact, x, maxW);
  }
}

function renderByCategory(cur, data) {
  const groups = groupItemsByCategory(data);
  if (!groups.length) return;

  // Always begin "By Category" on a fresh page. Flowing it onto the tail of
  // the last day-by-day page made the final day's departing FLIGHT card read
  // as orphaned above this heading (Amsterdam→Bruges Day 8 report): the flight
  // and the "By Category" title sat together with no day association. A hard
  // page break cleanly separates the chronological plan from this regrouped
  // reference.
  cur.newPage();
  cur.space(4);
  cur.text("By Category", { font: FONT.serif, style: "italic", size: 22, color: COLOR.ink });
  cur.space(2);
  cur.accentRule(48);

  const x = PAGE.marginX + 3;
  const maxW = PAGE.width - PAGE.marginX - x;
  for (const group of groups) {
    sectionHeader(cur, `${group.label} (${group.items.length})`);
    const shown = group.items.slice(0, CATEGORY_PDF_CAP);
    shown.forEach((entry) => renderCategoryEntry(cur, entry, group.category, x, maxW));
    if (group.items.length > shown.length) {
      cur.space(1);
      cur.text(`+ ${group.items.length - shown.length} more in the day-by-day`, {
        font: FONT.sans, style: "italic", size: 9, color: COLOR.inkFaint, x,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// LOCAL PROVIDERS — real, verified private drivers / guides / tours / wine
// tastings surfaced for the trip. Reads the SAME results the on-screen "Local
// providers" tab fetched (passed in via options.providers) and runs them
// through the SAME shared bucketProviders() helper, so the two views can't
// drift. Every provider already cleared the find / find-providers verification
// pipeline; this renderer invents nothing and carries the honest verify label
// through. Skipped entirely when no relevant category produced results.
// -----------------------------------------------------------------------------
function renderProviderEntry(cur, item, x, maxW) {
  const { pdf } = cur;
  cur.ensureSpace(16);
  cur.space(1.2);

  // Name + verify label on the context line (teal uppercase tag).
  const tag = item.verifyLabel === "verified" ? "VERIFIED" : "VERIFY BEFORE BOOKING";
  const ctx = [item.name, item.city, tag].filter(Boolean).join("  ·  ");
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(7.5);
  pdf.setCharSpace(0.5);
  cur.setColor(COLOR.accent);
  pdf.text(asciiSafe(ctx.toUpperCase()), x, cur.state.y + 3);
  pdf.setCharSpace(0);
  cur.state.y += 5;

  if (item.descriptor) renderDetailLine(cur, "About", item.descriptor, x, maxW);
  const url = item.url || item.verifyUrl;
  if (url) renderLinkLine(cur, item.url ? "Website" : "Listing", url, url, x, maxW);
}

function renderLocalProviders(cur, providers) {
  if (!providers || typeof providers !== "object") return;
  const relevantIds = Array.isArray(providers.relevantIds) ? providers.relevantIds : [];
  const byCategory = providers.byCategory && typeof providers.byCategory === "object" ? providers.byCategory : {};
  if (relevantIds.length === 0) return;

  const groups = bucketProviders(relevantIds, byCategory, { cap: PROVIDER_PDF_CAP })
    .filter((g) => g.items.length > 0);
  if (groups.length === 0) return;

  cur.ensureSpace(55);
  cur.space(4);
  cur.text("Local Providers", { font: FONT.serif, style: "italic", size: 22, color: COLOR.ink });
  cur.space(2);
  cur.accentRule(48);
  cur.space(1.5);
  cur.text(
    "Real local operators checked against Google Places. Anything we couldn't confirm is labeled verify before booking.",
    { font: FONT.sans, style: "italic", size: 9, color: COLOR.inkFaint },
  );

  const x = PAGE.marginX + 3;
  const maxW = PAGE.width - PAGE.marginX - x;
  for (const group of groups) {
    sectionHeader(cur, `${group.label} (${group.total})`);
    group.items.forEach((item) => renderProviderEntry(cur, item, x, maxW));
    if (group.total > group.items.length) {
      cur.space(1);
      cur.text(`+ ${group.total - group.items.length} more found`, {
        font: FONT.sans, style: "italic", size: 9, color: COLOR.inkFaint, x,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// REFERENCE SECTIONS — logistics, weather, pack, planb, flags, snobs, tonight.
// -----------------------------------------------------------------------------
function sectionHeader(cur, title) {
  const { pdf } = cur;
  cur.ensureSpace(16);
  cur.space(2.5);
  pdf.setFont(FONT.sans, "bold");
  pdf.setFontSize(8.5);
  pdf.setCharSpace(1.4);
  cur.setColor(COLOR.accent);
  pdf.text(asciiSafe(String(title).toUpperCase()), PAGE.marginX, cur.state.y);
  pdf.setCharSpace(0);
  cur.space(1);
  cur.accentRule(28);
  cur.space(1.5);
}

function renderReferences(cur, data) {
  // Cap each list so the reference section stays a tight back-of-book rather
  // than a sprawling extra 10 pages. The day plan is the primary deliverable;
  // reference is meant to be a quick scan.
  const take = (arr, n) => (Array.isArray(arr) ? arr.filter(Boolean).slice(0, n) : []);
  const ref = {
    logistics: take(data?.logistics, 12),
    weather: safe(data?.weather_window),
    pack: take(data?.pack, 10),
    flags: take(data?.flags, 6),
    planb: take(data?.planb, 5),
    snobs: take(data?.snobs, 5),
    tonight: take(data?.tonight, 6),
  };

  const hasAny = ref.logistics.length || ref.weather || ref.pack.length || ref.flags.length || ref.planb.length || ref.snobs.length || ref.tonight.length;
  if (!hasAny) return;

  // Start references — push to a new page only if very little space remains.
  cur.ensureSpace(55);
  cur.space(4);

  // Section title — "Trip Reference"
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
      // Strip leading priority sigils. Match either the bare ⚠ (warning
      // sign) OR the same glyph followed by the U+FE0E variation selector,
      // plus the other sigils. Previous version placed both code points
      // inside one […] class, which made the variation selector a
      // standalone class element — lint flagged it as misleading.
      const cleaned = raw.replace(/^(?:⚠︎|[·•⚠!])+\s*/u, "").trim();
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
    ref.flags.forEach(f => bulletWithLinks(cur, f));
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
      cur.setColor(COLOR.accent);
      pdf.text(`${i + 1}.`, PAGE.marginX, cur.state.y + lineH * 0.78);
      // Text
      pdf.setFont(FONT.sans, "normal");
      cur.setColor(COLOR.ink);
      lines.forEach((ln, j) => {
        pdf.text(asciiSafe(ln), PAGE.marginX + indent, cur.state.y + lineH * 0.78 + j * lineH);
      });
      cur.state.y += lines.length * lineH + 1.5;
      // Auto-link any URLs embedded in the plan B text
      const urlRe2 = /https?:\/\/[^\s)>,"]+/g;
      const seen2 = new Set();
      const lhLink = (9 * 1.25) / 2.83465;
      let m2;
      const pStr = String(p);
      while ((m2 = urlRe2.exec(pStr)) !== null) {
        const url = m2[0].replace(/[.,;:]+$/, "");
        if (seen2.has(url)) continue;
        seen2.add(url);
        cur.ensureSpace(lhLink + 0.5);
        pdf.setFont(FONT.sans, "normal");
        pdf.setFontSize(9);
        const display = asciiSafe(url.length > 60 ? url.slice(0, 57) + "..." : url);
        const baselineY = cur.state.y + lhLink * 0.78;
        cur.setColor(COLOR.accent);
        pdf.textWithLink(display, PAGE.marginX + indent + 2, baselineY, { url });
        pdf.setLineWidth(0.12);
        pdf.line(PAGE.marginX + indent + 2, baselineY + 0.5, PAGE.marginX + indent + 2 + pdf.getTextWidth(display), baselineY + 0.5);
        cur.state.y += lhLink;
      }
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

// Render a bullet that auto-detects https:// URLs and phone numbers in the text,
// appending each as a separate clickable teal link on the line below the bullet.
function bulletWithLinks(cur, label) {
  cur.bullet(label);
  const text = String(label);
  const urlRe = /https?:\/\/[^\s)>,"]+/g;
  const telRe = /(?<!\d)(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;
  const seen = new Set();
  const { pdf } = cur;
  const size = 8.5;
  const indent = 10;
  const lineH = (size * 1.25) / 2.83465;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    cur.ensureSpace(lineH + 0.5);
    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(size);
    const display = asciiSafe(url.length > 60 ? url.slice(0, 57) + "..." : url);
    const baselineY = cur.state.y + lineH * 0.78;
    cur.setColor(COLOR.accent);
    pdf.textWithLink(display, PAGE.marginX + indent, baselineY, { url });
    pdf.setLineWidth(0.12);
    pdf.line(PAGE.marginX + indent, baselineY + 0.5, PAGE.marginX + indent + pdf.getTextWidth(display), baselineY + 0.5);
    cur.state.y += lineH;
  }
  while ((m = telRe.exec(text)) !== null) {
    const raw = m[0];
    const url = telUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    cur.ensureSpace(lineH + 0.5);
    pdf.setFont(FONT.sans, "normal");
    pdf.setFontSize(size);
    const display = asciiSafe(raw.trim());
    const baselineY = cur.state.y + lineH * 0.78;
    cur.setColor(COLOR.accent);
    pdf.textWithLink(display, PAGE.marginX + indent, baselineY, { url });
    pdf.setLineWidth(0.12);
    pdf.line(PAGE.marginX + indent, baselineY + 0.5, PAGE.marginX + indent + pdf.getTextWidth(display), baselineY + 0.5);
    cur.state.y += lineH;
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
      ? `www.routesmith.ai${opts.buildId ? ` · ${opts.buildId}` : ""} · Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`
      : "www.routesmith.ai";
    pdf.text(asciiSafe(left), PAGE.marginX, footerY);

    // Suppress the X/Y page number on the introduction page per spec
    // ("no page number on this page"). The brand mark on the left stays so
    // the page still anchors visually to the rest of the document.
    if (opts.introPageIndex && i === opts.introPageIndex) continue;

    const right = `${i} / ${total}`;
    const rw = pdf.getTextWidth(right);
    pdf.text(right, PAGE.width - PAGE.marginX - rw, footerY);
  }
}

// -----------------------------------------------------------------------------
// PUBLIC ENTRYPOINT
// -----------------------------------------------------------------------------
export async function buildItineraryPdf(data, inputs, options = {}) {
  const { setStatus, buildId, providers, coverPhoto, itemPhotos = {} } = options;
  if (setStatus) setStatus("Loading PDF engine…");

  const jsPDFModule = await import("jspdf");
  const { jsPDF } = jsPDFModule;

  if (setStatus) setStatus("Composing pages…");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter", compress: true });

  // Document metadata
  try {
    pdf.setProperties({
      title: `${safe(data?.destination) || "Trip"} itinerary`,
      author: "RouteSmith",
      subject: safe(data?.meta) || "Travel itinerary",
      creator: "www.routesmith.ai",
    });
  } catch { /* setProperties not critical */ }

  const cur = makeCursor(pdf);

  // 1. Cover
  renderCover(cur, data, inputs, { buildId, coverPhoto });

  // 2. Introduction page — a dedicated full page after the cover and before
  // the Day-by-Day section. Skipped silently if data.introduction is missing
  // (older builds, partial recovery from truncated streams) so the PDF still
  // generates cleanly without it.
  const beforeIntroPage = cur.state.page;
  renderIntroduction(cur, data, inputs);
  // The intro page (if it rendered) is the page right after the cover.
  // Capture it so renderFooters can suppress the X/Y page number on it,
  // per the spec "no page number on this page".
  const introPageIndex = (cur.state.page > beforeIntroPage) ? cur.state.page : null;

  // 3. Days — flow onto the current page if there's room, otherwise let
  // ensureSpace push to a new page. Previously this hard-coded a newPage()
  // which left a huge blank gap at the bottom of the cover page whenever
  // "What you told us" was short. Reserving ~60mm forces a break only when
  // the day-by-day header + first day's worth of content genuinely won't
  // fit on what's left of the cover page.
  const days = Array.isArray(data?.days) ? data.days : [];
  const cityPhotos = options.cityPhotos || {};
  if (days.length > 0) {
    cur.space(4);
    cur.ensureSpace(50);
    cur.text("Day by Day", { font: FONT.serif, style: "italic", size: 22, color: COLOR.ink });
    cur.space(1.5);
    cur.accentRule(48);
    cur.space(2);
    let lastDayCity = null;
    days.forEach((d, i) => {
      const dayCity = (d.city || "").toLowerCase();
      const isNewCity = dayCity && dayCity !== lastDayCity;
      const cityPhoto = isNewCity ? (cityPhotos[dayCity] || null) : null;
      if (d.city) lastDayCity = dayCity;
      renderDay(cur, d, i, { cityPhoto, itemPhotos, destination: data.destination || "" });
    });
  }

  // 4. By category — same items as the day-by-day, regrouped (flights /
  // lodging / transport / activities / dining). Sits after the chronological
  // plan and before the trip reference back-matter.
  renderByCategory(cur, data);

  // 5. Local providers — verified private drivers / guides / tours / tastings
  // (only when the trip surfaced any). Reuses the on-screen tab's results.
  renderLocalProviders(cur, providers);

  // 6. References
  renderReferences(cur, data);

  // 7. Footers (after everything else so page count is final)
  renderFooters(pdf, { buildId, introPageIndex });

  return pdf;
}
