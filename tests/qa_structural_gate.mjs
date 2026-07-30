/**
 * qa_structural_gate.mjs — browser proof for the four remaining validators.
 *
 * Companion to qa_continuity_gate.mjs (which covers PR #145's continuity and
 * night-count work). Unit tests show the pure functions return the right flags;
 * per CLAUDE.md "VERIFICATION DISCIPLINE" that is not evidence the running app
 * refuses the export. This script drives the real UI:
 *
 *   C  flight header time ≠ flight.depart_time   → export BLOCKED
 *   D  fabricated Viator product code             → export BLOCKED
 *   E  reserved dinner on the venue's closed day  → export BLOCKED
 *   F  unconfirmable regional flight              → export ALLOWED, card warns
 *
 * Usage:
 *   npm run build
 *   npx vite preview --port 4176 --host 127.0.0.1 &
 *   node tests/qa_structural_gate.mjs
 *
 * Screenshots land in scratchpad/.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SC = join(ROOT, 'scratchpad');
const APP = 'http://127.0.0.1:4176';
const MP = 4178;

mkdirSync(SC, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let _passed = 0, _total = 0;
const _failures = [];
function chk(name, pass, detail = '') {
  _total++;
  if (pass) { _passed++; console.log(`  ✅ ${name}`); }
  else { _failures.push({ name, detail }); console.error(`  ❌ ${name}${detail ? '  [' + detail + ']' : ''}`); }
}

// ─── The base plan ────────────────────────────────────────────────────────────
//
// Four days, Bayeux → Amsterdam, structurally sound: every city change is
// carried by a flight, the hotel is checked out of before the next check-in,
// and the derived nights (2+1) match meta and cities[]. Each scenario mutates
// exactly one thing, so anything the gate reports is that scenario's defect.
//
// 2026-10-05 is a Monday — Day 1 is the closure day scenario E needs.
const basePlan = () => ({
  destination: 'Bayeux & Amsterdam',
  startDate: '2026-10-05',
  meta: '4 days · 3 nights (2+1)',
  cities: [{ name: 'Bayeux', nights: 2 }, { name: 'Amsterdam', nights: 1 }],
  days: [
    {
      day: 1, label: 'Mon Oct 5, 2026', date: '2026-10-05', city: 'Bayeux',
      items: [
        { time: '4:00 PM', type: 'Hotel', text: 'Check in at Villa Lara Hotel', hotel: { name: 'Villa Lara Hotel' } },
        { time: '7:30 PM', type: 'Dinner', text: 'Dinner at La Rapiere', restaurant: { name: 'La Rapiere' } },
      ],
    },
    {
      day: 2, label: 'Tue Oct 6, 2026', date: '2026-10-06', city: 'Bayeux',
      items: [
        { time: '10:00 AM', type: 'Activity', name: 'Bayeux Tapestry Museum', text: 'Bayeux Tapestry Museum' },
        { time: '7:30 PM', type: 'Dinner', text: 'Dinner at Le Pommier', restaurant: { name: 'Le Pommier' } },
      ],
    },
    {
      day: 3, label: 'Wed Oct 7, 2026', date: '2026-10-07', city: 'Amsterdam',
      items: [
        { time: '7:00 AM', type: 'Hotel', text: 'Check out of Villa Lara Hotel', hotel: { name: 'Villa Lara Hotel' } },
        {
          time: '8:20 AM', type: 'Flight', text: 'Fly Caen (CFR) → Amsterdam (AMS)',
          flight: {
            carrier: 'Air France', flight_number: 'AF7652',
            from_airport: 'CFR', to_airport: 'AMS',
            depart_time: '8:20 AM', arrive_time: '10:05 AM',
          },
        },
        { time: '2:00 PM', type: 'Hotel', text: 'Check in at The Hoxton, Amsterdam', hotel: { name: 'The Hoxton, Amsterdam' } },
      ],
    },
    {
      day: 4, label: 'Thu Oct 8, 2026', date: '2026-10-08', city: 'Amsterdam',
      items: [
        { time: '10:00 AM', type: 'Activity', name: 'Rijksmuseum', text: 'Rijksmuseum' },
        { time: '6:00 PM', type: 'Hotel', text: 'Check out of The Hoxton, Amsterdam', hotel: { name: 'The Hoxton, Amsterdam' } },
      ],
    },
  ],
});

const EXTRACT = {
  extracted: {
    basics: {
      destination: 'Bayeux & Amsterdam',
      startDate: '2026-10-05',
      travelers: 'A. Traveler',
      nights: 3,
      cities: [{ name: 'Bayeux', nights: 2 }, { name: 'Amsterdam', nights: 1 }],
    },
    flights: {}, hotel: {}, restaurants: [], activities: [], name_checks: [],
  },
};

const FABRICATED_VIATOR = 'https://www.viator.com/tours/Lisbon/Lisbon-WWII-History-Tour/d538-123456LISBONWW2';

const CLOSED_MONDAYS = [
  'Monday: Closed',
  'Tuesday: 12:00 – 2:00 PM, 7:00 – 9:30 PM',
  'Wednesday: 12:00 – 2:00 PM, 7:00 – 9:30 PM',
  'Thursday: 12:00 – 2:00 PM, 7:00 – 9:30 PM',
  'Friday: 12:00 – 2:00 PM, 7:00 – 9:30 PM',
  'Saturday: 12:00 – 2:00 PM, 7:00 – 9:30 PM',
  'Sunday: 12:00 – 2:00 PM',
];

const FAKE_REVIEW = JSON.stringify({ findings: [], summary: 'No blocking findings.' });

// ─── Mock API ─────────────────────────────────────────────────────────────────

const mockState = {
  plan: JSON.stringify(basePlan()),
  buildN: 0,
  verifications: [],   // /api/places-verify-batch
  flights: null,       // /api/flights-search — null means "never asked"
};

const mock = createServer(async (req, res) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(200, h); res.end(); return; }
  let body = ''; req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));
  const p = new URL(req.url, 'http://x').pathname;

  if (p === '/api/extract-trip') { res.writeHead(200, h); res.end(JSON.stringify(EXTRACT)); return; }
  if (p === '/api/review-retrieve') { res.writeHead(200, h); res.end('{"snippets":[]}'); return; }

  if (p === '/api/build' && req.method === 'POST') {
    mockState.buildN++;
    // Four days stays under chunkPlan's single-call budget, so build #1 is the
    // plan and everything after it is the auto-review.
    const payload = mockState.buildN === 1 ? mockState.plan : FAKE_REVIEW;
    const half = Math.floor(payload.length / 2);
    const parts = [
      JSON.stringify({ type: 'job', jobId: `job-${mockState.buildN}` }) + '\n',
      JSON.stringify({ type: 'delta', text: payload.slice(0, half) }) + '\n',
      JSON.stringify({ type: 'delta', text: payload.slice(half) }) + '\n',
      JSON.stringify({ type: 'stop_reason', reason: 'end_turn' }) + '\n',
      JSON.stringify({ type: 'done', len: payload.length }) + '\n',
    ];
    res.writeHead(200, { ...h, 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
    for (const pt of parts) { await sleep(100); if (!res.destroyed) res.write(pt); }
    if (!res.destroyed) res.end();
    return;
  }

  if (p === '/api/places-verify-batch') {
    res.writeHead(200, h); res.end(JSON.stringify({ ok: true, verifications: mockState.verifications })); return;
  }
  if (p.includes('places-verify')) { res.writeHead(200, h); res.end('{"ok":true,"results":[]}'); return; }

  // Empty flights[] with ok:true is the "route has no scheduled service"
  // verdict — what a fabricated CFR→AMS route actually looks like.
  if (p === '/api/flights-search') {
    res.writeHead(200, h);
    res.end(JSON.stringify(mockState.flights ?? { ok: false }));
    return;
  }

  // No verdicts: the liveness pass stays "unknown", which is the state the
  // structural URL check has to work in — it must catch a fabricated link
  // with no network evidence at all.
  if (p === '/api/verify-url') { res.writeHead(200, h); res.end('{"results":[]}'); return; }

  res.writeHead(200, h); res.end('{"ok":true}');
});

// ─── Page harness (mirrors qa_continuity_gate.mjs) ────────────────────────────

async function makePage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  const pdfFail = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/PDF save failed/.test(t)) { pdfFail.push(t.slice(0, 500)); return; }
    if (!/net::ERR_|favicon|404/.test(t)) errs.push(t.slice(0, 200));
  });
  await page.route('**googleapis.com/**', r => r.abort());
  await page.route('**gstatic.com/**', r => r.abort());
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    try {
      const resp = await fetch(`http://127.0.0.1:${MP}${u.pathname}${u.search}`, {
        method: route.request().method(),
        headers: { 'Content-Type': 'application/json' },
        body: route.request().method() !== 'GET' ? route.request().postData() : undefined,
      });
      await route.fulfill({
        status: resp.status,
        contentType: resp.headers.get('content-type') || 'application/json',
        body: await resp.text(),
      });
    } catch { await route.fulfill({ status: 500, body: '{}' }); }
  });
  return { page, ctx, errs, pdfFail };
}

async function waitForText(page, text, ms = 20000) {
  try {
    await page.waitForFunction(t => document.body.innerText.toLowerCase().includes(t), text.toLowerCase(), { timeout: ms });
    return true;
  } catch { return false; }
}

async function buildPlan(page) {
  await page.goto(`${APP}?direct=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.locator('textarea').first().fill('4 days in Bayeux and Amsterdam starting October 5 2026');
  await page.locator('button').filter({ hasText: /plan my trip/i }).first().click();
  await page.waitForTimeout(2500);
  const jump = page.locator('button').filter({ hasText: /jump to select outputs/i }).first();
  if (await jump.isVisible({ timeout: 2000 }).catch(() => false)) {
    await jump.click();
    await page.waitForTimeout(1200);
  }
  await page.locator('button').filter({ hasText: /plan my trip/i }).last().click();
  return waitForText(page, 'day 1', 30000);
}

async function clickExport(page, shotPath) {
  let dialogMsg = '';
  page.on('dialog', async d => { dialogMsg = d.message(); await d.accept(); });
  const btn = page.locator('button').filter({ hasText: /save as pdf|export.*pdf/i }).first();
  if (!(await btn.isVisible({ timeout: 5000 }).catch(() => false))) {
    return { found: false, dialogMsg, download: null, banner: '' };
  }
  const downloadP = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await btn.scrollIntoViewIfNeeded();
  await btn.click();

  let banner = '';
  for (let i = 0; i < 30; i++) {
    const txt = await page.locator('body').innerText().catch(() => '');
    const m = txt.match(/Could not save PDF[^\n]*/i);
    if (m) { banner = m[0]; break; }
    await sleep(100);
  }
  // The banner self-clears 5s after the failure, so shoot it here.
  if (shotPath) await page.screenshot({ path: shotPath, fullPage: false });
  const download = await downloadP;
  return { found: true, dialogMsg, download, banner };
}

// Run one scenario end-to-end. `mutate` receives the base plan object.
async function scenario(browser, { plan: mutate, verifications = [], flights = null }) {
  const p = basePlan();
  mutate(p);
  mockState.plan = JSON.stringify(p);
  mockState.buildN = 0;
  mockState.verifications = verifications;
  mockState.flights = flights;
  const ctx = await makePage(browser);
  const rendered = await buildPlan(ctx.page);
  // The venue-verify and flight-resolve passes are fire-and-forget; give them
  // a beat to land before the gate is exercised.
  await waitForText(ctx.page, 'trip route', 30000);
  await ctx.page.waitForTimeout(2500);
  return { ...ctx, rendered };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

await new Promise(r => mock.listen(MP, '127.0.0.1', r));
const browser = await chromium.launch();

console.log('\n── C: flight header time disagrees with depart_time ──\n');
{
  // _userSuppliedFlightNumber + both times is the one path flightNeedsResolve
  // skips, so nothing propagates depart_time back into the header. That is the
  // shape a real regression takes now that withFlightMerge self-heals the rest.
  const { page, pdfFail, rendered } = await scenario(browser, {
    plan: (p) => {
      const it = p.days[2].items[1];
      it.time = '9:30 AM';
      it.flight._userSuppliedFlightNumber = true;
    },
  });
  chk('C1 plan renders on Step 3', rendered);
  const { found, dialogMsg, download, banner } = await clickExport(page, join(SC, 'structural_gate_flight_time.png'));
  chk('C2 PDF button present', found);
  chk('C3 export blocked — no PDF produced', download === null, download ? 'a PDF downloaded' : '');
  chk('C4 user sees an export error', Boolean(banner) || /could not save pdf|cannot export/i.test(dialogMsg),
    `banner=${banner} dialog=${dialogMsg}`);
  chk('C5 gate names FLIGHT_TIME_MISMATCH',
    pdfFail.some(t => /FLIGHT_TIME_MISMATCH/.test(t)), pdfFail.join(' | ') || 'no "PDF save failed" console error');
  chk('C6 the block is counted as itinerary structure',
    pdfFail.some(t => /itinerary structure/.test(t) && !/0 itinerary structure/.test(t)), pdfFail.join(' | '));
  console.log('     screenshot → scratchpad/structural_gate_flight_time.png');
  await page.context().close();
}

console.log('\n── D: fabricated Viator product code ──\n');
{
  const { page, pdfFail, rendered } = await scenario(browser, {
    plan: (p) => { p.days[1].items[0].contact = { booking_url: FABRICATED_VIATOR }; },
  });
  chk('D1 plan renders on Step 3', rendered);
  const { found, download, banner, dialogMsg } = await clickExport(page, join(SC, 'structural_gate_booking_url.png'));
  chk('D2 PDF button present', found);
  chk('D3 export blocked — no PDF produced', download === null, download ? 'a PDF downloaded' : '');
  chk('D4 user sees an export error', Boolean(banner) || /could not save pdf|cannot export/i.test(dialogMsg),
    `banner=${banner} dialog=${dialogMsg}`);
  chk('D5 gate names BOOKING_URL_IMPLAUSIBLE',
    pdfFail.some(t => /BOOKING_URL_IMPLAUSIBLE/.test(t)), pdfFail.join(' | ') || 'no "PDF save failed" console error');
  console.log('     screenshot → scratchpad/structural_gate_booking_url.png');
  await page.context().close();
}

console.log('\n── E: reserved dinner on the restaurant\'s closed day ──\n');
{
  const { page, pdfFail, rendered } = await scenario(browser, {
    plan: (p) => {
      p.days[0].items[1].contact = { reserve: 'https://www.opentable.com/r/la-rapiere-bayeux' };
    },
    verifications: [{
      name: 'La Rapiere', kind: 'restaurant', found: true,
      business_status: 'OPERATIONAL', hours: CLOSED_MONDAYS, flags: [],
    }],
  });
  chk('E1 plan renders on Step 3', rendered);
  // CLOSED_ON_THIS_DAY is not a drop flag — unlike CLOSED_PERMANENTLY the venue
  // stays in the plan and the gate refuses the export instead. Verified here so
  // a future change can't quietly turn a closure into a silent deletion.
  chk('E2 the venue is flagged, not dropped', await waitForText(page, 'la rapiere', 8000));

  // The closure must be visible on the card, not just in the export gate. The
  // model's own _weekdayMismatch chip is amber; this one is Places-sourced and
  // block-severity, so it renders red and supersedes the model's.
  const chip = page.locator('[data-closure-chip="block"]').first();
  const chipVisible = await chip.isVisible({ timeout: 5000 }).catch(() => false);
  chk('E2a a block-severity closure chip is on the card before Export', chipVisible);
  const chipText = chipVisible ? await chip.innerText().catch(() => '') : '';
  chk('E2b the chip names the closed weekday', /closed\s+mon/i.test(chipText), chipText || '(no chip)');
  const chipTitle = chipVisible ? await chip.getAttribute('title').catch(() => '') : '';
  chk('E2c the tooltip attributes the closure to Places', /google places/i.test(chipTitle || ''), chipTitle || '(no title)');
  chk('E2d the model chip is suppressed — exactly one closure chip',
    await page.locator('[data-closure-chip]').count() === 1);
  if (chipVisible) {
    await chip.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: join(SC, 'closure_chip_block.png'), fullPage: false });
    console.log('     screenshot → scratchpad/closure_chip_block.png');
  }
  const { found, download, banner, dialogMsg } = await clickExport(page, join(SC, 'structural_gate_closed_anchor.png'));
  chk('E3 PDF button present', found);
  chk('E4 export blocked — no PDF produced', download === null, download ? 'a PDF downloaded' : '');
  chk('E5 user sees an export error', Boolean(banner) || /could not save pdf|cannot export/i.test(dialogMsg),
    `banner=${banner} dialog=${dialogMsg}`);
  chk('E6 gate names CLOSED_ON_THIS_DAY at venue scope',
    pdfFail.some(t => /CLOSED_ON_THIS_DAY/.test(t) && /La Rapiere/.test(t)), pdfFail.join(' | '));
  chk('E7 it is counted as a venue-verification block, not a structural one',
    pdfFail.some(t => /[1-9]\d* venue verification/.test(t)), pdfFail.join(' | '));
  console.log('     screenshot → scratchpad/structural_gate_closed_anchor.png');
  await page.context().close();
}

console.log('\n── F: unconfirmable regional flight warns but still exports ──\n');
{
  // Same AF7652 CFR→AMS the 2026-07-28 build shipped. The schedule API knows
  // the route does not exist; the plan is still the traveller's best option,
  // so it must export — with the route marked unverified rather than printed
  // as if a schedule had confirmed it.
  const { page, errs, pdfFail, rendered } = await scenario(browser, {
    plan: () => {},
    flights: { ok: true, flights: [] },
  });
  chk('F1 plan renders on Step 3', rendered);

  const dayTab = page.locator('button').filter({ hasText: /^Day 3$/i }).first();
  if (await dayTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await dayTab.click();
    await page.waitForTimeout(800);
  }
  const body = await page.locator('body').innerText().catch(() => '');
  chk('F2 the card warns the route is unconfirmed',
    /route\/times not confirmed/i.test(body), body.match(/.{0,60}not confirmed.{0,60}/i)?.[0] || 'no warning text');
  chk('F3 the warning tells the traveller what to do',
    /verify with the airline/i.test(body));
  await page.screenshot({ path: join(SC, 'structural_gate_flight_unverified.png'), fullPage: false });

  const { found, download, banner, dialogMsg } = await clickExport(page);
  chk('F4 PDF button present', found);
  chk('F5 no export error shown', !banner && !/cannot export|could not save pdf/i.test(dialogMsg),
    `banner=${banner} dialog=${dialogMsg}`);
  chk('F6 PDF download initiated — a warn never blocks', download !== null);
  chk('F7 gate did not fire', pdfFail.length === 0, pdfFail.join(' | '));
  chk('F8 no console errors', errs.length === 0, errs.join(' | '));
  console.log('     screenshot → scratchpad/structural_gate_flight_unverified.png');
  await page.context().close();
}

await browser.close();
mock.close();

console.log(`\n${_passed}/${_total} checks passed`);
for (const f of _failures) console.log(`  FAILED: ${f.name} ${f.detail}`);
process.exit(_failures.length ? 1 : 0);
