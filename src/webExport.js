// Generates a self-contained HTML web app from a RouteSmith trip plan.
//
// The output is:
//   • A beautiful single-page itinerary site (open in any browser immediately)
//   • A clean developer handoff — all trip data is embedded as JSON in a
//     <script type="application/json"> block at the bottom
//   • Zero external runtime dependencies (font + CSS are all inline or from
//     Google Fonts, which can be swapped out for a self-hosted copy)
//
// Inspired by the editorial style of zurich-weekend.com and
// maritimesgrandloop.com: serif headings, generous whitespace, clean
// day-by-day timeline, venue contact cards.

function esc(s) {
  if (!s && s !== 0) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Flight items' depart_time/arrive_time can already be 12-hour strings with
// an AM/PM suffix (e.g. "3:05 PM") rather than the 24-hour "HH:MM" that
// item.time always uses -- the two fields come from different sources
// (item.time is code-formatted; flight.depart_time/arrive_time can be
// resolver- or model-written in either shape). Naively re-deriving AM/PM
// from the leading hour, as this function used to, silently flips a real
// "3:05 PM" into "3:05 AM": the old regex only read the hour and minute,
// ignoring any AM/PM suffix already present, then recomputed ampm from
// `h >= 12` -- 3 is never >= 12, so the recomputed value was always AM
// regardless of what the input actually said. Real observed case
// (2026-08-09): a web export showed "Departs 3:05 PM" in the header (from
// item.time="15:05", genuinely 24-hour) but "Departs 3:05 AM . Arrives
// 5:30 AM" in the flight detail line just below it (from
// flight.depart_time="3:05 PM"/arrive_time="5:30 PM", already 12-hour).
function formatTime(t) {
  if (!t || typeof t !== "string") return "";
  const trimmed = t.trim();
  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampmMatch) {
    // eslint-disable-next-line no-irregular-whitespace -- U+202F narrow no-break space between minutes and AM/PM (typographic convention)
    return `${parseInt(ampmMatch[1], 10)}:${ampmMatch[2]} ${ampmMatch[3].toUpperCase()}`;
  }
  const m = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return esc(t);
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  // eslint-disable-next-line no-irregular-whitespace -- U+202F narrow no-break space between minutes and AM/PM (typographic convention)
  return `${h}:${min} ${ampm}`;
}

function slugify(s) {
  return (s || "trip").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const BADGE_COLOR = {
  Flight:    { bg: "#e5edf5", color: "#2f5d83" },
  Hotel:     { bg: "#e3eef0", color: "#316169" },
  Car:       { bg: "#e3ede6", color: "#446b54" },
  Dinner:    { bg: "#f0e3e9", color: "#8a4760" },
  Lunch:     { bg: "#f0e3e9", color: "#8a4760" },
  Breakfast: { bg: "#f0e3e9", color: "#8a4760" },
  Brunch:    { bg: "#f0e3e9", color: "#8a4760" },
  Dining:    { bg: "#f0e3e9", color: "#8a4760" },
  Activity:  { bg: "#ede8f1", color: "#6b4a7d" },
  Tonight:   { bg: "#f0e3e9", color: "#8a4760" },
  "Plan B":  { bg: "#e3eef0", color: "#316169" },
  Note:      { bg: "#e3eef0", color: "#316169" },
  Snob:      { bg: "#f0e3e9", color: "#8a4760" },
  Flag:      { bg: "#f3e0db", color: "#9b3a2e" },
};

function badgeHtml(type) {
  const c = BADGE_COLOR[type] || { bg: "#f2f0ea", color: "#5b6577" };
  return `<span class="badge" style="background:${c.bg};color:${c.color}">${esc(type)}</span>`;
}

// DAY_ITEM_SCHEMA (src/App.jsx) has no top-level name/address/phone/website/
// notes/description fields — this used to read all of them directly off
// `item` and always rendered blank for real plans (Hotel items partially
// survived only via the item.hotel?.* fallbacks already in place). The real
// data lives one level down, in a shape that depends on item.type:
//   Hotel                        → item.hotel.{name,address,phone,website,confirmation_note}
//   Breakfast/Brunch/Lunch/
//   Dinner/Dining                → item.restaurant.{name,why} + .contact.{address,phone,website}
//   Activity/Transport/Note      → item.text (the headline) + item.why + item.contact.{address,phone,website}
//   Flight                       → item.flight.{carrier,flight_number,confirmation_note} — see flightDetail below
function itemVenue(item) {
  const type = item.type || "Note";
  if (type === "Hotel" && item.hotel) {
    const h = item.hotel;
    return { name: h.name || "", address: h.address || "", phone: h.phone || "", website: h.website || "", notes: h.confirmation_note || "" };
  }
  if (/^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(type) && item.restaurant) {
    const r = item.restaurant;
    const c = (r.contact && typeof r.contact === "object") ? r.contact : {};
    return { name: r.name || "", address: c.address || "", phone: c.phone || r.reservation?.phone || "", website: c.website || "", notes: r.why || "" };
  }
  // Flight items get their own branch, checked BEFORE the generic item.text
  // fallback below. applyQualityLayer's carrier-correction (KNOWN_NONSTOPS,
  // src/App.jsx) rewrites item.flight.carrier/flight_number/confirmation_note
  // when the model's claimed carrier doesn't actually fly the route nonstop —
  // it never touches item.text, the model's own original prose. The generic
  // fallback below reads item.text FIRST, so the export always showed the
  // model's stale, uncorrected carrier claim ("LOT nonstop Newark → London
  // Heathrow") even when the "At a glance" summary table (which reads
  // flight.carrier directly, see overviewHtml below) correctly showed the
  // corrected one ("United or British Airways or Virgin Atlantic") — the
  // two disagreeing on the very same flight. Real observed case (2026-08-09).
  if (type === "Flight" && item.flight) {
    const fl = item.flight;
    const name = [fl.carrier, fl.flight_number].filter(Boolean).join(" ").trim() || item.text || "";
    return { name, address: "", phone: "", website: "", notes: fl.confirmation_note || item.why || "" };
  }
  const c = (item.contact && typeof item.contact === "object") ? item.contact : {};
  return {
    name: item.text || "",
    address: c.address || "",
    phone: c.phone || "",
    website: c.website || "",
    notes: item.why || "",
  };
}

function itemHtml(item) {
  const type = item.type || "Note";
  const time = formatTime(item.time);
  const { name, address, phone, website, notes } = itemVenue(item);
  const flightDetail = item.flight
    ? `${esc(item.flight.from_airport || "")}→${esc(item.flight.to_airport || "")}${item.flight.depart_time ? " · Departs " + formatTime(item.flight.depart_time) : ""}${item.flight.arrive_time ? " · Arrives " + formatTime(item.flight.arrive_time) : ""}`
    : "";

  return `
    <article class="item">
      <div class="item-meta">
        ${badgeHtml(type)}
        ${time ? `<span class="time">${esc(time)}</span>` : ""}
      </div>
      ${name ? `<h3 class="item-name">${esc(name)}</h3>` : ""}
      ${flightDetail ? `<p class="item-detail flight-detail">${flightDetail}</p>` : ""}
      ${address ? `<p class="item-detail"><svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5A4.5 4.5 0 0 1 12.5 6c0 3-4.5 8.5-4.5 8.5S3.5 9 3.5 6A4.5 4.5 0 0 1 8 1.5Z"/><circle cx="8" cy="6" r="1.5"/></svg>${esc(address)}</p>` : ""}
      ${phone ? `<p class="item-detail"><svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1.5h2l1 3-1.5 1a8 8 0 0 0 4 4l1-1.5 3 1v2c0 .8-.7 1.5-1.5 1.5C6.9 13 3 9.1 3 3c0-.8.7-1.5 1.5-1.5Z"/></svg><a href="tel:${esc(phone)}">${esc(phone)}</a></p>` : ""}
      ${website ? `<p class="item-detail"><svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C6 4 5 6 5 8s1 4 3 6.5M8 1.5C10 4 11 6 11 8s-1 4-3 6.5M1.5 8h13"/></svg><a href="${esc(website)}" target="_blank" rel="noopener">${esc(website.replace(/^https?:\/\//, ""))}</a></p>` : ""}
      ${notes ? `<p class="item-notes">${esc(notes)}</p>` : ""}
    </article>`;
}

// DAY_SCHEMA has no "date"/"title"/"theme" fields. The computed weekday
// stamp lives inside "label" ("Day N · Wed Aug 25 · Arrive Santa Fe" — see
// dateFacts.js) and the day's signature moment is "headline". This used to
// read day.date/day.title/day.theme, none of which exist, so the date badge
// and day subtitle were always blank for every real plan.
function dayDateStamp(day) {
  const label = typeof day?.label === "string" ? day.label : "";
  const parts = label.split("·").map(s => s.trim()).filter(Boolean);
  // parts[0] is "Day N" (redundant with the number this renderer already
  // shows); parts[1], when present, is the computed date stamp itself.
  return parts[1] || "";
}

function dayHtml(day, index) {
  const items = Array.isArray(day.items) ? day.items : [];
  const dateStamp = dayDateStamp(day);
  const title = day.headline || "";
  return `
  <section class="day-section" id="day-${index}" data-day="${index}" ${index > 0 ? 'hidden' : ''}>
    <div class="day-header">
      <span class="day-number">Day ${index + 1}</span>
      ${dateStamp ? `<span class="day-date">${esc(dateStamp)}</span>` : ""}
      ${title ? `<p class="day-title">${esc(title)}</p>` : ""}
    </div>
    <div class="items-list">
      ${items.map(itemHtml).join("")}
    </div>
  </section>`;
}

function overviewHtml(data) {
  const items = (data.days || []).flatMap(d => d.items || []);
  const flights = items.filter(it => it.type === "Flight" && it.flight);
  const outbound = flights[0]?.flight;
  const inbound = flights[flights.length - 1]?.flight;
  const hotelItem = items.find(it => it.type === "Hotel" && it.hotel)?.hotel;
  const mealCount = items.filter(it => /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(it.type || "")).length;
  const activityCount = items.filter(it => it.type === "Activity").length;

  const rows = [];
  if (outbound) rows.push(`<tr><th>Fly out</th><td>${esc(outbound.carrier)} ${esc(outbound.flight_number)} · ${esc(outbound.from_airport)}→${esc(outbound.to_airport)}${outbound.depart_time ? " · " + formatTime(outbound.depart_time) : ""}</td></tr>`);
  if (inbound && inbound !== outbound) rows.push(`<tr><th>Return</th><td>${esc(inbound.carrier)} ${esc(inbound.flight_number)} · ${esc(inbound.from_airport)}→${esc(inbound.to_airport)}${inbound.depart_time ? " · " + formatTime(inbound.depart_time) : ""}</td></tr>`);
  if (hotelItem) rows.push(`<tr><th>Stay</th><td>${esc(hotelItem.name)}</td></tr>`);
  if (mealCount > 0 || activityCount > 0) rows.push(`<tr><th>Plan</th><td>${mealCount} meals · ${activityCount} activities · ${(data.days || []).length} days</td></tr>`);

  if (!rows.length) return "";
  return `
  <section class="overview-section">
    <h2 class="section-heading">At a glance</h2>
    <table class="overview-table">${rows.join("")}</table>
    ${Array.isArray(data.logistics) && data.logistics.length > 0
      ? `<div class="logistics">${data.logistics.map(l => `<span class="tag">${esc(l)}</span>`).join("")}</div>`
      : ""}
  </section>`;
}

// data.introduction is an object — { arc, differentiators } — not a string
// (see IntroductionAutoGenerator in src/App.jsx and renderIntroduction in
// src/pdf/itineraryPdf.js, the PDF's equivalent section). esc(intro) on the
// object used to stringify to the literal text "[object Object]" instead of
// rendering blank like the other bugs in this file — arguably worse, since
// it's visibly broken rather than silently missing. differentiators can also
// be the literal sentinel "NONE_FLAGGED", meaning the model found no
// genuinely distinctive elements — mirror the PDF's honest fallback copy
// rather than either showing the sentinel or hiding the section.
function introHtml(data) {
  const intro = data.introduction;
  const arc = (intro && typeof intro.arc === "string") ? intro.arc.trim() : "";
  const diffRaw = (intro && typeof intro.differentiators === "string") ? intro.differentiators.trim() : "";
  if (!arc && !diffRaw) return "";
  const paragraph = (text) => `<p>${esc(text).replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
  const diffHtml = diffRaw === "NONE_FLAGGED"
    ? `<p class="intro-note">The planner flagged this itinerary as a strong but standard route — no off-the-beaten-path differentiators worth singling out.</p>`
    : diffRaw ? paragraph(diffRaw) : "";
  return `
  <section class="intro-section">
    <div class="intro-text">${arc ? paragraph(arc) : ""}${diffHtml}</div>
  </section>`;
}

function dayNavHtml(days) {
  if (!days || days.length === 0) return "";
  return `
  <nav class="day-nav" aria-label="Day navigation">
    ${days.map((d, i) => {
      const label = dayDateStamp(d);
      return `<button class="day-nav-btn${i === 0 ? " active" : ""}" data-target="${i}" aria-selected="${i === 0}">${esc(label || `Day ${i + 1}`)}</button>`;
    }).join("")}
  </nav>`;
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; scroll-behavior: smooth; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: #f8f7f3;
    color: #1c2840;
    line-height: 1.6;
    -webkit-text-size-adjust: 100%;
  }
  a { color: #3f7d86; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ---- Hero ---- */
  .hero {
    background: linear-gradient(170deg, #0b1826 0%, #0d2133 55%, #091b2a 100%);
    color: #fff;
    padding: 72px 24px 56px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .hero::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 110% 55% at 50% 108%, rgba(49,97,105,0.65) 0%, transparent 65%),
      radial-gradient(ellipse 70% 40% at 90% 0%, rgba(63,125,134,0.18) 0%, transparent 55%);
    pointer-events: none;
  }
  .hero-inner { position: relative; max-width: 640px; margin: 0 auto; }
  .hero .eyebrow {
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.55);
    margin-bottom: 16px;
    font-weight: 500;
  }
  .hero h1 {
    font-family: 'Cormorant Garamond', 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: clamp(36px, 8vw, 62px);
    font-weight: 400;
    font-style: italic;
    letter-spacing: -0.5px;
    line-height: 1.1;
    margin-bottom: 12px;
  }
  .hero .meta {
    font-size: 14px;
    color: rgba(255,255,255,0.65);
    letter-spacing: 0.04em;
  }
  .hero .byline {
    margin-top: 32px;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.3);
  }

  /* ---- Layout ---- */
  .container { max-width: 720px; margin: 0 auto; padding: 0 20px; }

  /* ---- Intro ---- */
  .intro-section {
    background: #fff;
    border-bottom: 1px solid #dcd8cf;
    padding: 36px 0;
  }
  .intro-text {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 18px;
    line-height: 1.75;
    color: #1c2840;
    max-width: 600px;
  }
  .intro-text p { margin-bottom: 1em; }
  .intro-note {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px;
    font-style: italic;
    color: #5b6577;
  }

  /* ---- Overview ---- */
  .overview-section { padding: 40px 0; border-bottom: 1px solid #dcd8cf; }
  .section-heading {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #3f7d86;
    font-weight: 600;
    margin-bottom: 20px;
  }
  .overview-table { width: 100%; border-collapse: collapse; }
  .overview-table th, .overview-table td {
    padding: 9px 0;
    font-size: 13px;
    border-bottom: 0.5px solid #e6e3da;
    vertical-align: top;
    text-align: left;
  }
  .overview-table th {
    width: 80px;
    color: #9aa1ad;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding-right: 16px;
  }
  .logistics { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 16px; }
  .tag {
    font-size: 11.5px;
    background: #fff;
    border: 0.5px solid #dcd8cf;
    border-radius: 4px;
    padding: 4px 10px;
    color: #5b6577;
  }

  /* ---- Day nav ---- */
  .day-nav {
    background: #fff;
    border-bottom: 1px solid #dcd8cf;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
    position: sticky;
    top: 0;
    z-index: 20;
    padding: 0 4px;
  }
  .day-nav::-webkit-scrollbar { display: none; }
  .day-nav-btn {
    flex: none;
    padding: 13px 16px;
    font-size: 11px;
    font-family: inherit;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #9aa1ad;
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
  }
  .day-nav-btn.active, .day-nav-btn:hover {
    color: #1c2840;
    border-bottom-color: #3f7d86;
  }

  /* ---- Day sections ---- */
  .day-section { padding: 40px 0; border-bottom: 1px solid #dcd8cf; }
  .day-header { margin-bottom: 28px; }
  .day-number {
    display: inline-block;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #3f7d86;
    margin-bottom: 4px;
  }
  .day-date {
    display: block;
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 26px;
    font-style: italic;
    font-weight: 400;
    color: #1c2840;
    line-height: 1.2;
  }
  .day-title {
    font-size: 13px;
    color: #5b6577;
    margin-top: 4px;
    font-style: italic;
    line-height: 1.4;
  }

  /* ---- Items ---- */
  .items-list { display: flex; flex-direction: column; gap: 20px; }
  .item {
    background: #fff;
    border: 0.5px solid #dcd8cf;
    border-radius: 6px;
    padding: 16px 18px;
  }
  .item-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .badge {
    display: inline-block;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 3px;
  }
  .time {
    font-size: 11.5px;
    color: #5b6577;
    font-variant-numeric: tabular-nums;
  }
  .item-name {
    font-size: 16px;
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-weight: 500;
    color: #1c2840;
    margin-bottom: 6px;
    line-height: 1.3;
  }
  .item-detail {
    font-size: 12.5px;
    color: #5b6577;
    margin-top: 5px;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    line-height: 1.5;
  }
  .flight-detail {
    font-size: 13px;
    color: #1c2840;
    font-variant-numeric: tabular-nums;
    margin-bottom: 2px;
  }
  .item-detail a { color: #3f7d86; }
  .item-detail a:hover { text-decoration: underline; }
  .item-notes {
    font-size: 12px;
    color: #9aa1ad;
    margin-top: 8px;
    line-height: 1.55;
    font-style: italic;
    border-top: 0.5px solid #e6e3da;
    padding-top: 8px;
  }
  .icon {
    width: 13px;
    height: 13px;
    flex: none;
    margin-top: 2px;
    color: #9aa1ad;
  }

  /* ---- Footer ---- */
  .footer {
    background: #1c2840;
    color: rgba(255,255,255,0.45);
    text-align: center;
    padding: 40px 24px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .footer a { color: rgba(255,255,255,0.45); }

  /* ---- Data block ---- */
  .dev-note {
    background: #f2f0ea;
    border-top: 2px solid #dcd8cf;
    padding: 32px 0;
    font-size: 12px;
    color: #5b6577;
  }
  .dev-note h2 {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #9aa1ad;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .dev-note p { line-height: 1.6; }

  @media (max-width: 480px) {
    .hero { padding: 56px 20px 40px; }
    .day-section, .overview-section, .intro-section { padding: 28px 0; }
    .item { padding: 14px 14px; }
    .item-name { font-size: 15px; }
  }
  @media print {
    .day-nav { display: none; }
    .day-section[hidden] { display: block !important; }
  }
`;

const NAV_SCRIPT = `
  (function() {
    var btns = document.querySelectorAll('.day-nav-btn');
    var sections = document.querySelectorAll('.day-section');
    function show(idx) {
      sections.forEach(function(s, i) {
        if (i === idx) { s.removeAttribute('hidden'); }
        else { s.setAttribute('hidden', ''); }
      });
      btns.forEach(function(b, i) {
        b.classList.toggle('active', i === idx);
        b.setAttribute('aria-selected', String(i === idx));
      });
    }
    btns.forEach(function(btn, i) {
      btn.addEventListener('click', function() { show(i); });
    });
  })();
`;

export function buildWebApp(data, inputs) {
  const destination = data.destination || "Your trip";
  const meta = data.meta || (inputs?.basics
    ? [inputs.basics.startDate, inputs.basics.endDate].filter(Boolean).join(" – ")
    : "");
  const days = Array.isArray(data.days) ? data.days : [];
  const title = `${destination}${meta ? " · " + meta : ""}`;
  const generatedOn = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const htmlParts = [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="UTF-8">`,
    `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
    `  <title>${esc(title)}</title>`,
    `  <meta name="description" content="Itinerary for ${esc(destination)}">`,
    `  <link rel="preconnect" href="https://fonts.googleapis.com">`,
    `  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500;1,600&display=swap" rel="stylesheet">`,
    `  <style>${CSS}</style>`,
    `</head>`,
    `<body>`,

    // Hero
    `<header class="hero">`,
    `  <div class="hero-inner">`,
    `    <p class="eyebrow">Itinerary</p>`,
    `    <h1>${esc(destination)}</h1>`,
    meta ? `    <p class="meta">${esc(meta)}</p>` : "",
    `    <p class="byline">Planned with RouteSmith</p>`,
    `  </div>`,
    `</header>`,

    // Introduction (if present)
    `<div class="container">`,
    introHtml(data),

    // Overview
    overviewHtml(data),
    `</div>`,

    // Day navigation
    days.length > 1 ? dayNavHtml(days) : "",

    // Day sections
    `<div class="container">`,
    ...days.map((d, i) => dayHtml(d, i)),

    // Developer note
    `<div class="dev-note">`,
    `  <h2>Developer handoff</h2>`,
    `  <p>All trip data is embedded below as structured JSON. Use it to build a custom web app, import into a CMS, or generate any other output format.</p>`,
    `</div>`,
    `</div>`,

    // Footer
    `<footer class="footer">`,
    `  <p>Generated ${esc(generatedOn)} &nbsp;·&nbsp; <a href="https://routesmith.app">RouteSmith</a></p>`,
    `</footer>`,

    // Embedded data for developer handoff. Passes the plan's real day/item
    // fields through mostly as-is (label/headline/text/restaurant/hotel/
    // flight/contact/why) rather than re-flattening into invented fields —
    // the previous version's date/title/name/address/phone/website/notes
    // keys don't exist on the actual plan shape (DAY_SCHEMA has label/
    // headline, DAY_ITEM_SCHEMA has text/restaurant/hotel/flight/contact/
    // why), so every one of them always serialized as null. Passing the
    // real structure through is both correct and more useful to a developer
    // than a lossy re-shape of a schema this file was never actually reading.
    `<script id="trip-data" type="application/json">`,
    JSON.stringify({
      destination: data.destination,
      meta: data.meta,
      cities: data.cities,
      introduction: data.introduction || null,
      days: days.map(d => ({
        label: d.label || null,
        city: d.city || null,
        headline: d.headline || null,
        weather: d.weather || null,
        items: (d.items || []).map(it => ({
          type: it.type,
          time: it.time || null,
          end_time: it.end_time || null,
          text: it.text || null,
          location: it.location || null,
          why: it.why || null,
          contact: it.contact || null,
          flight: it.flight || null,
          hotel: it.hotel || null,
          restaurant: it.restaurant || null,
        })),
      })),
      logistics: data.logistics || [],
      generatedOn,
    }, null, 2),
    `</script>`,

    // Minimal nav JS
    `<script>${NAV_SCRIPT}</script>`,
    `</body>`,
    `</html>`,
  ];

  return htmlParts.filter(Boolean).join("\n");
}

export function downloadWebApp(data, inputs) {
  const html = buildWebApp(data, inputs);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const dest = slugify(data.destination || "trip");
  const dateStr = (data.meta || "").match(/\d{4}/)?.[0] || "";
  a.href = url;
  a.download = `${dest}${dateStr ? "-" + dateStr : ""}-itinerary.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
