/**
 * qa_narrative_to_outputs.mjs — browser proof that narrative mode lands on the
 * Outputs pane and that the build is reachable from there.
 *
 * Regression guard for 25bd571 ("fix: land on ESSENTIALS after narrative"),
 * which flipped the defer-nav effect's `setOutputsStep(true)` to `false`. The
 * wizard carries two orthogonal state pieces — `step` (1/2/3) and `outputsStep`
 * — so step 2 has two sub-panes: the Details form and Outputs. Only Outputs
 * renders the build trigger, and `handleBuild` has exactly one call site. With
 * the flip in place the narrative user landed on Details and could not start a
 * build without finding "Jump to select outputs →" on their own.
 *
 * tests/test_build_flow.mjs section 7 pins the same invariant in source text.
 * Per CLAUDE.md "VERIFICATION DISCIPLINE" that is not evidence the running app
 * behaves; this script drives the real UI.
 *
 * Unlike qa_structural_gate.mjs this needs no stateful mock server — nothing
 * here inspects posted venues — so /api/* is fulfilled straight from the route
 * handler. The NDJSON shape for /api/build is the one CLAUDE.md documents.
 *
 * Usage:
 *   npm run build
 *   npx vite preview --port 4176 --host 127.0.0.1 &
 *   node tests/qa_narrative_to_outputs.mjs
 *
 * Screenshots land in scratchpad/.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SC = join(HERE, '..', 'scratchpad');
const APP = 'http://127.0.0.1:4176';

mkdirSync(SC, { recursive: true });

let _passed = 0, _total = 0;
const _failures = [];
function chk(name, pass, detail = '') {
  _total++;
  if (pass) { _passed++; console.log(`  ✅ ${name}`); }
  else { _failures.push({ name, detail }); console.error(`  ❌ ${name}${detail ? '  [' + detail + ']' : ''}`); }
}

const PLAN = {
  destination: 'Porto',
  meta: 'Two nights in Porto.',
  cities: [{ name: 'Porto', nights: 2 }],
  weather_window: 'Mild, 18–24°C.',
  pack: ['Layers'],
  planb: ['Serralves'],
  tonight: 'MUST: dinner at Antiqvvm.',
  days: [
    {
      label: 'Day 1', city: 'Porto', headline: 'Ribeira at golden hour', weather: 'Mild.',
      items: [
        { type: 'Hotel', time: '14:00', title: 'Check in', hotel: { name: 'Torel Avantgarde' } },
        { type: 'Dinner', time: '19:30', title: 'Dinner', restaurant: { name: 'Antiqvvm', backup: 'Cantinho do Avillez' } },
      ],
    },
    {
      label: 'Day 2', city: 'Porto', headline: 'Douro valley', weather: 'Sunny.',
      items: [
        { type: 'Activity', time: '11:00', text: 'Douro tasting', contact: {} },
        { type: 'Dinner', time: '20:00', title: 'Dinner', restaurant: { name: 'Cantina 32', backup: 'Flor dos Congregados' } },
      ],
    },
  ],
};

const ndjson = (text) => [
  JSON.stringify({ type: 'job', jobId: 'qa-narrative' }) + '\n',
  JSON.stringify({ type: 'delta', text }) + '\n',
  JSON.stringify({ type: 'stop_reason', reason: 'end_turn' }) + '\n',
  JSON.stringify({ type: 'done', len: text.length }) + '\n',
].join('');

// /api/build serves three callers, demultiplexed by the tool name in the POST
// body: submit_review is the post-build review, everything else is the build.
const buildCalls = [];

async function makePage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!/net::ERR_|favicon|404/.test(t)) errs.push(t.slice(0, 200));
  });
  page.on('dialog', d => d.accept());
  await page.route('**googleapis.com/**', r => r.abort());
  await page.route('**gstatic.com/**', r => r.abort());

  // Playwright matches the MOST RECENTLY registered route first, so the
  // catch-all goes down before the specific handlers that must beat it.
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/**', r => r.fulfill(json({
    ok: true, sources: [], snippets: [], results: [], suggestions: [], confirmations: [], text: '',
  })));
  await page.route('**/api/destination-photo**', r => r.fulfill(json({ url: '' })));
  await page.route('**/api/extract-trip', r => r.fulfill(json({
    extracted: { basics: { destination: 'Porto', nights: '2', month: 'September' }, restaurants: [] },
  })));
  await page.route('**/api/build', route => {
    const tools = (JSON.parse(route.request().postData() || '{}').tools || []).map(t => t?.name || '').join(',');
    const isReview = tools.includes('submit_review');
    if (!isReview) buildCalls.push(Date.now());
    const payload = isReview ? { verdict: 'B+', findings: [] } : PLAN;
    route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: ndjson(JSON.stringify(payload)) });
  });
  return { page, ctx, errs };
}

async function waitForText(page, text, ms = 20000) {
  try {
    await page.waitForFunction(t => document.body.innerText.toLowerCase().includes(t), text.toLowerCase(), { timeout: ms });
    return true;
  } catch { return false; }
}

const browser = await chromium.launch();
const { page, ctx, errs } = await makePage(browser);

console.log('\n── Step 1: narrative mode ──\n');
await page.goto(`${APP}?direct=1`, { waitUntil: 'domcontentloaded' });
const ta = page.locator('textarea').first();
// isVisible() is a point-in-time check and does not retry; waitFor does.
const taReady = await ta.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
chk('step 1 renders the narrative textarea', taReady);
await ta.fill('Two nights in Porto in September. Moderate budget, no Michelin.');
await page.locator('button').filter({ hasText: /plan my trip/i }).first().click();

console.log('\n── After "Plan my trip →": must be the OUTPUTS pane ──\n');
// Extraction is ~2s mocked; wait on the pane's own marker rather than a sleep.
const landed = await waitForText(page, 'output sections', 25000);
chk('lands on a pane showing "Output sections"', landed);
await page.screenshot({ path: join(SC, 'qa_narrative_outputs_pane.png'), fullPage: true });

const body = await page.locator('body').innerText();
chk('stepper reports step 2', /2\s*\/\s*3/.test(body), body.slice(0, 80));
chk('Outputs pane marker: "Output sections · N of 12 active"',
  /output sections\s*·\s*\d+ of 12 active/i.test(body));
chk('Outputs pane marker: "Expert review sources"',
  /expert review sources/i.test(body));
chk('Outputs pane marker: "← Back" to the Details form',
  await page.locator('button').filter({ hasText: /←\s*Back/ }).first().isVisible().catch(() => false));

// The Details form's CTA. Its presence would mean we are on the wrong pane —
// this is the exact symptom 25bd571 produced.
chk('"Jump to select outputs" is NOT present (that is the Details CTA)',
  await page.locator('button').filter({ hasText: /jump to select outputs/i }).count() === 0);

console.log('\n── The build trigger is reachable and fires ──\n');
const buildBtn = page.locator('button').filter({ hasText: /^plan my trip$/i }).first();
// With the 25bd571 regression this button does not exist at all — the whole
// point of the bug. Gate the click so the suite reports every failure instead
// of dying on a locator timeout.
const haveBuildBtn = await buildBtn.count() > 0;
chk('the build button is present on this pane', haveBuildBtn);
chk('the build button is enabled', haveBuildBtn && await buildBtn.isEnabled().catch(() => false));
chk('no build has been started yet', buildCalls.length === 0, `saw ${buildCalls.length}`);

if (haveBuildBtn) {
  await buildBtn.click();
  const rendered = await waitForText(page, 'day 1', 30000);
  chk('clicking it POSTs to /api/build', buildCalls.length === 1, `saw ${buildCalls.length}`);
  chk('the itinerary renders (DAY 1)', rendered);
  await page.waitForTimeout(2500);
  const finalBody = await page.locator('body').innerText();
  chk('itinerary shows the built plan', /antiqvvm/i.test(finalBody));
  await page.screenshot({ path: join(SC, 'qa_narrative_itinerary.png'), fullPage: false });
} else {
  chk('clicking it POSTs to /api/build', false, 'no build button to click');
  chk('the itinerary renders (DAY 1)', false, 'no build button to click');
  chk('itinerary shows the built plan', false, 'no build button to click');
}

chk('zero console errors', errs.length === 0, errs.join(' | ').slice(0, 300));

await ctx.close();
await browser.close();

if (_failures.length) {
  console.error('\nFailures:');
  for (const f of _failures) console.error(`  - ${f.name}${f.detail ? '  [' + f.detail + ']' : ''}`);
}
console.log(`\n${_passed}/${_total} checks passed`);
process.exit(_failures.length ? 1 : 0);
