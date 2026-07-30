/**
 * qa_continuity_gate.mjs — browser proof that the day-continuity gate fires.
 *
 * Unit tests show findContinuityIssues() returns block-severity flags. This
 * script shows the running app refusing to export the plan that shipped on
 * 2026-07-28 (London → Normandy → Amsterdam → Lisbon, repo @ e49a0dd), and
 * still exporting a structurally sound one. Per CLAUDE.md "VERIFICATION
 * DISCIPLINE", code compiling is not evidence — this is.
 *
 * Usage:
 *   npm run build
 *   npx vite preview --port 4176 --host 127.0.0.1 &
 *   node tests/qa_continuity_gate.mjs
 *
 * Screenshots land in scratchpad/.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SC = join(ROOT, 'scratchpad');
const APP = 'http://127.0.0.1:4176';
const MP = 4177;

mkdirSync(SC, { recursive: true });

const fixture = (n) => readFileSync(join(HERE, 'fixtures', n), 'utf8');
const COLLISION_PLAN = fixture('plan_day67_collision.json');
const CLEAN_PLAN = fixture('plan_linear_clean.json');

// The app rejects a plan whose day count disagrees with the extracted basics
// ("the plan was cut off before it finished"), so each scenario ships the
// extraction that matches its fixture.
const extractFor = (basics) => ({
  extracted: {
    basics: { startDate: '2026-10-01', travelers: 'A. Traveler', ...basics },
    flights: {}, hotel: {}, restaurants: [], activities: [], name_checks: [],
  },
});

const EXTRACT_COLLISION = extractFor({
  destination: 'London, Normandy, Amsterdam & Lisbon',
  nights: 10,
  cities: [
    { name: 'London', nights: 3 },
    { name: 'Bayeux', nights: 2 },
    { name: 'Amsterdam', nights: 3 },
    { name: 'Lisbon', nights: 2 },
  ],
});

const EXTRACT_CLEAN = extractFor({
  destination: 'Amsterdam & Bruges',
  nights: 7,
  cities: [
    { name: 'Amsterdam', nights: 4 },
    { name: 'Bruges', nights: 3 },
  ],
});

const FAKE_REVIEW = JSON.stringify({ findings: [], summary: 'No blocking findings.' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let _passed = 0, _total = 0;
const _failures = [];
function chk(name, pass, detail = '') {
  _total++;
  if (pass) { _passed++; console.log(`  ✅ ${name}`); }
  else { _failures.push({ name, detail }); console.error(`  ❌ ${name}${detail ? '  [' + detail + ']' : ''}`); }
}

// ─── Mock API ─────────────────────────────────────────────────────────────────

const mockState = { plan: COLLISION_PLAN, extract: EXTRACT_COLLISION, buildN: 0, wrapperDone: false };

// Trips over src/chunkPlan.js's SINGLE_CALL_TOKEN_BUDGET are built as one call
// per day-range plus a "wrapper" call for the non-day fields, then reassembled
// by stitchPlan. The 11-day collision plan crosses that threshold, so the mock
// has to answer the chunked protocol — returning the whole plan to every call
// makes stitchPlan drop meta and cities[] on the floor.
function buildPayloadFor(body) {
  const chunk = /CHUNK MODE — GENERATE ONLY Day (\d+)–Day (\d+)/.exec(body);
  if (chunk) {
    const plan = JSON.parse(mockState.plan);
    return JSON.stringify({ days: plan.days.slice(Number(chunk[1]) - 1, Number(chunk[2])) });
  }
  if (/WRAPPER MODE/.test(body)) {
    mockState.wrapperDone = true;
    const { days, ...wrapper } = JSON.parse(mockState.plan);
    void days;
    return JSON.stringify({ ...wrapper, days: [] });
  }
  // Single-call build (small trips) first, review afterwards.
  if (mockState.buildN === 1 && !mockState.wrapperDone) return mockState.plan;
  return FAKE_REVIEW;
}

const mock = createServer(async (req, res) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(200, h); res.end(); return; }
  let body = ''; req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));
  const p = new URL(req.url, 'http://x').pathname;

  if (p === '/api/extract-trip') { res.writeHead(200, h); res.end(JSON.stringify(mockState.extract)); return; }
  if (p === '/api/review-retrieve') { res.writeHead(200, h); res.end('{"snippets":[]}'); return; }

  if (p === '/api/build' && req.method === 'POST') {
    mockState.buildN++;
    const payload = buildPayloadFor(body);
    const half = Math.floor(payload.length / 2);
    const parts = [
      JSON.stringify({ type: 'job', jobId: `job-${mockState.buildN}` }) + '\n',
      JSON.stringify({ type: 'delta', text: payload.slice(0, half) }) + '\n',
      JSON.stringify({ type: 'delta', text: payload.slice(half) }) + '\n',
      JSON.stringify({ type: 'stop_reason', reason: 'end_turn' }) + '\n',
      JSON.stringify({ type: 'done', len: payload.length }) + '\n',
    ];
    res.writeHead(200, { ...h, 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
    for (const pt of parts) { await sleep(120); if (!res.destroyed) res.write(pt); }
    if (!res.destroyed) res.end();
    return;
  }

  // Every venue verifies clean, so anything the gate blocks is structural.
  if (p.includes('places-verify')) { res.writeHead(200, h); res.end('{"ok":true,"results":[]}'); return; }

  res.writeHead(200, h); res.end('{"ok":true}');
});

// ─── Page harness (mirrors tests/qa_beta.mjs) ─────────────────────────────────

async function makePage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  const pdfFail = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // The gate's throw is surfaced by the export handler's own console.error
    // before the on-screen banner self-clears; keep it out of the generic
    // console-error bucket so B5 still means "nothing unexpected happened".
    if (/PDF save failed/.test(t)) { pdfFail.push(t.slice(0, 300)); return; }
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

async function buildPlan(page, prompt) {
  await page.goto(`${APP}?direct=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.locator('textarea').first().fill(prompt);
  await page.locator('button').filter({ hasText: /plan my trip/i }).first().click();
  await page.waitForTimeout(2500);
  // Extraction can land on the Details sub-view; the Outputs sub-view (which
  // carries the build button) is one "Jump to select outputs" away.
  const jump = page.locator('button').filter({ hasText: /jump to select outputs/i }).first();
  if (await jump.isVisible({ timeout: 2000 }).catch(() => false)) {
    await jump.click();
    await page.waitForTimeout(1200);
  }
  await page.locator('button').filter({ hasText: /plan my trip/i }).last().click();
  return waitForText(page, 'day 1', 30000);
}

// The export handler clears its error banner 5s after the failure
// (src/App.jsx, the setTimeout in the PDF-save finally block), so the banner is
// polled from the moment of the click rather than read once at the end.
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
  // The banner self-clears 5s after the failure, so the screenshot has to be
  // taken here rather than at the end of the scenario.
  if (shotPath) await page.screenshot({ path: shotPath, fullPage: false });

  const download = await downloadP;
  return { found: true, dialogMsg, download, banner };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

await new Promise(r => mock.listen(MP, '127.0.0.1', r));
const browser = await chromium.launch();

console.log('\n── A: Day 6/7 collision plan is refused at export ──\n');
{
  mockState.plan = COLLISION_PLAN; mockState.extract = EXTRACT_COLLISION; mockState.buildN = 0; mockState.wrapperDone = false;
  const { page, pdfFail } = await makePage(browser);
  chk('A1 plan renders on Step 3', await buildPlan(page,
    '11 days from London through Normandy and Amsterdam to Lisbon starting October 1 2026'));
  await page.waitForTimeout(1200);

  // TripHero (which carries the "Trip route" city breakdown) is hidden while
  // the auto-review is still running.
  await waitForText(page, 'trip route', 30000);
  const bodyBefore = await page.locator('body').innerText().catch(() => '');
  await page.getByText(/^Trip route/).first().evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SC, 'continuity_gate_nights.png'), fullPage: false });
  console.log(`     screenshot → scratchpad/continuity_gate_nights.png`);
  const { found, dialogMsg, download, banner } = await clickExport(page, join(SC, 'continuity_gate_blocked.png'));
  chk('A2 PDF button present', found);
  chk('A3 export blocked — no PDF produced', download === null, download ? 'a PDF downloaded' : '');
  chk('A4 user sees an export error', Boolean(banner) || /could not save pdf|cannot export/i.test(dialogMsg),
    `banner=${banner} dialog=${dialogMsg}`);
  chk('A5 gate reports an itinerary-structure block',
    pdfFail.some(t => /itinerary structure/.test(t) && !/0 itinerary structure/.test(t)),
    pdfFail.join(' | ') || 'no "PDF save failed" console error');
  chk('A6 night counts corrected on screen (Amsterdam 3, not 4)',
    /amsterdam[\s\S]{0,80}?3 nights/i.test(bodyBefore),
    bodyBefore.match(/Amsterdam[\s\S]{0,60}nights/i)?.[0] || 'no match');

  console.log(`     screenshot → scratchpad/continuity_gate_blocked.png`);
  await page.context().close();
}

console.log('\n── B: structurally sound plan still exports ──\n');
{
  mockState.plan = CLEAN_PLAN; mockState.extract = EXTRACT_CLEAN; mockState.buildN = 0; mockState.wrapperDone = false;
  const { page, errs, pdfFail } = await makePage(browser);
  chk('B1 plan renders on Step 3', await buildPlan(page,
    '8 days in Amsterdam and Bruges starting October 1 2026'));
  await waitForText(page, 'trip route', 30000);
  await page.getByText(/^Trip route/).first().evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SC, 'continuity_gate_clean.png'), fullPage: false });
  const { found, dialogMsg, download, banner } = await clickExport(page);
  chk('B2 PDF button present', found);
  chk('B3 no export error shown', !banner && !/cannot export|could not save pdf/i.test(dialogMsg),
    `banner=${banner} dialog=${dialogMsg}`);
  chk('B4 PDF download initiated', download !== null);
  chk('B5 gate did not fire', pdfFail.length === 0, pdfFail.join(' | '));
  chk('B6 no console errors', errs.length === 0, errs.join(' | '));
  console.log(`     screenshot → scratchpad/continuity_gate_clean.png`);
  await page.context().close();
}

await browser.close();
mock.close();

console.log(`\n${_passed}/${_total} checks passed`);
for (const f of _failures) console.log(`  FAILED: ${f.name} ${f.detail}`);
process.exit(_failures.length ? 1 : 0);
