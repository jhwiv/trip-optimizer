// audit-contrast.js
//
// WHAT THIS PROTECTS AGAINST
// A palette reskin (the upcoming Barrier Island Digital alignment, or any
// future tweak to the design tokens in index.html) can silently push a
// text/surface color pair below the WCAG 2.1 AA contrast minimum of 4.5:1
// for normal text. Low contrast is an accessibility regression that is hard
// to eyeball and easy to ship.
//
// WHY IT EXISTS
// This script parses the actual --color-* custom properties out of
// index.html's <style> block (the single source of truth for the palette)
// and recomputes the real WCAG contrast ratio for every text-on-surface pair
// the product actually renders. It fails CI if any pair regresses below AA,
// so the reskin cannot quietly degrade legibility. Pairs already failing on
// master are listed in scripts/contrast-known-issues.json and WARN instead of
// fail, so this gate can be adopted before those preexisting issues are fixed
// by the reskin PR (which removes them from that file as it goes).
//
// No external dependencies: pure Node, regex parsing, vanilla math.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const indexHtmlPath = join(repoRoot, 'index.html');
const knownIssuesPath = join(__dirname, 'contrast-known-issues.json');

const AA_NORMAL = 4.5;

// Text/surface pairs the product actually renders. Extend as usage grows.
const PAIRS = [
  ['--color-text-primary', '--color-background-primary'],
  ['--color-text-primary', '--color-background-secondary'],
  ['--color-text-secondary', '--color-background-primary'],
  ['--color-text-secondary', '--color-background-secondary'],
  ['--color-text-tertiary', '--color-background-primary'],
  ['--color-text-danger', '--color-background-primary'],
  ['--color-text-danger', '--color-background-secondary'],
];

function parseTokens(css) {
  // Match the :root block, then pull every --color-*: <hex>; declaration.
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  const scope = rootMatch ? rootMatch[1] : css;
  const tokens = {};
  const re = /(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s*;/gi;
  let m;
  while ((m = re.exec(scope)) !== null) {
    tokens[m[1]] = m[2];
  }
  return tokens;
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  const int = parseInt(h, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

// sRGB relative luminance per WCAG 2.1.
function relativeLuminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hexToRgb(hex1));
  const l2 = relativeLuminance(hexToRgb(hex2));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function loadKnownIssues() {
  try {
    const raw = readFileSync(knownIssuesPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Accept either { pairs: [[text, bg], ...] } or a bare array of pairs.
    const list = Array.isArray(parsed) ? parsed : parsed.pairs || [];
    return new Set(list.map(([t, b]) => `${t}__${b}`));
  } catch {
    return new Set();
  }
}

function main() {
  const css = readFileSync(indexHtmlPath, 'utf8');
  const tokens = parseTokens(css);
  const known = loadKnownIssues();

  const rows = [];
  let hardFailures = 0;
  let warnings = 0;
  const missing = [];

  for (const [textVar, bgVar] of PAIRS) {
    const textHex = tokens[textVar];
    const bgHex = tokens[bgVar];
    if (!textHex || !bgHex) {
      missing.push(`${textVar} on ${bgVar} (token not found: ` +
        `${!textHex ? textVar : bgVar})`);
      continue;
    }
    const ratio = contrastRatio(textHex, bgHex);
    const pass = ratio >= AA_NORMAL;
    const isKnown = known.has(`${textVar}__${bgVar}`);
    let status;
    if (pass) {
      status = 'PASS';
    } else if (isKnown) {
      status = 'WARN (known)';
      warnings++;
    } else {
      status = 'FAIL';
      hardFailures++;
    }
    rows.push({ textVar, bgVar, textHex, bgHex, ratio, status });
  }

  // Render table.
  const col = (s, w) => String(s).padEnd(w);
  const wText = Math.max(...rows.map((r) => r.textVar.length), 10) + 2;
  const wBg = Math.max(...rows.map((r) => r.bgVar.length), 10) + 2;
  console.log('WCAG 2.1 AA contrast audit (normal text minimum 4.5:1)');
  console.log('');
  console.log(
    col('text token', wText) +
    col('on surface', wBg) +
    col('text', 9) +
    col('surface', 9) +
    col('ratio', 9) +
    'status'
  );
  console.log('-'.repeat(wText + wBg + 9 + 9 + 9 + 12));
  for (const r of rows) {
    console.log(
      col(r.textVar, wText) +
      col(r.bgVar, wBg) +
      col(r.textHex, 9) +
      col(r.bgHex, 9) +
      col(`${r.ratio.toFixed(2)}:1`, 9) +
      r.status
    );
  }
  console.log('');

  if (missing.length) {
    console.error('ERROR: required tokens missing from index.html :root block:');
    for (const m of missing) console.error('  - ' + m);
    process.exit(1);
  }

  if (warnings) {
    console.log(`${warnings} pair(s) below AA but listed in ` +
      'contrast-known-issues.json (WARN, not failing).');
  }

  if (hardFailures) {
    console.error(`FAILED: ${hardFailures} text/surface pair(s) below ` +
      `${AA_NORMAL}:1 and not in contrast-known-issues.json.`);
    process.exit(1);
  }

  console.log('All audited pairs meet WCAG AA (or are known/warned). OK.');
}

main();
