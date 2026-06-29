// audit-hex-leaks.js
//
// WHAT THIS PROTECTS AGAINST
// src/App.jsx should drive color from the CSS custom-property tokens defined
// in index.html, not from inline hex literals. Every raw #rrggbb baked into
// the component is a spot the upcoming Barrier Island Digital palette reskin
// can miss, leaving stale colors that drift away from the design system.
//
// WHY IT EXISTS
// This is a ratchet, not a ban. It counts the hex literals currently in
// App.jsx (excluding known false positives — example flight numbers and
// confirmation codes that happen to look like hex) and fails CI if the count
// climbs above a committed baseline. New leaks are blocked; the reskin can
// LOWER the baseline as it migrates literals to tokens. The baseline lives in
// scripts/hex-leak-baseline.json.
//
// No external dependencies: pure Node, regex parsing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const targetPath = join(repoRoot, 'src', 'App.jsx');
const baselinePath = join(__dirname, 'hex-leak-baseline.json');

const HEX_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const CONTEXT_WINDOW = 200; // chars on each side of a match to inspect
// Substrings that mark a match as a non-color false positive (flight numbers,
// confirmation codes in user-facing copy). Case-insensitive.
const FALSE_POSITIVE_MARKERS = ['flight ', 'flt ', 'conf #', 'confirmation #'];

function countLeaks(source) {
  const lower = source.toLowerCase();
  let total = 0;
  let excluded = 0;
  let m;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(source)) !== null) {
    total++;
    const start = Math.max(0, m.index - CONTEXT_WINDOW);
    const end = Math.min(source.length, m.index + m[0].length + CONTEXT_WINDOW);
    const ctx = lower.slice(start, end);
    if (FALSE_POSITIVE_MARKERS.some((marker) => ctx.includes(marker))) {
      excluded++;
    }
  }
  return { total, excluded, leaks: total - excluded };
}

function main() {
  const source = readFileSync(targetPath, 'utf8');
  const { total, excluded, leaks } = countLeaks(source);

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).maxHexLiterals;
  } catch {
    console.error(`ERROR: could not read baseline from ${baselinePath}`);
    process.exit(1);
  }

  const diff = leaks - baseline;
  const sign = diff > 0 ? '+' : '';
  console.log('Hex-literal leak audit for src/App.jsx');
  console.log('');
  console.log(`  raw hex matches:       ${total}`);
  console.log(`  excluded (false pos.): ${excluded}`);
  console.log(`  counted leaks:         ${leaks}`);
  console.log(`  baseline ceiling:      ${baseline}`);
  console.log(`  diff vs baseline:      ${sign}${diff}`);
  console.log('');

  if (leaks > baseline) {
    console.error(`FAILED: ${leaks} hex literals exceeds baseline of ` +
      `${baseline}. New color literals were introduced — use the ` +
      `--color-* tokens from index.html instead, or update the baseline ` +
      `only if the increase is justified.`);
    process.exit(1);
  }

  if (leaks < baseline) {
    console.log(`OK: ${leaks} <= ${baseline}. Below baseline — consider ` +
      `lowering scripts/hex-leak-baseline.json to ratchet down.`);
  } else {
    console.log(`OK: ${leaks} <= ${baseline}.`);
  }
}

main();
