// Runs every test file in this directory in sequence and reports the totals.
//
// The individual test files were written as plain scripts that print
// 'N passed, M failed' on the last line and exit with code 1 on any
// failure. This runner spawns each one as a child process, captures the
// final summary line, and exits non-zero if any suite failed.
//
// Why not `node --test`? The existing suites pre-date node:test and use
// a simple custom assert helper. Rewriting them all into node:test format
// would be a separate, larger PR; this runner gets us into CI today
// without touching test internals.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(HERE)
  .filter((f) => f.startsWith("test_") && f.endsWith(".mjs"))
  .sort();

if (files.length === 0) {
  console.error("No test files found in tests/.");
  process.exit(1);
}

let totalPassed = 0;
let totalFailed = 0;
let anyFailed = false;
const failedSuites = [];

console.log(`Running ${files.length} test suite${files.length === 1 ? "" : "s"}\n`);

for (const file of files) {
  const start = Date.now();
  const res = spawnSync(process.execPath, [join(HERE, file)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Date.now() - start;
  const out = (res.stdout || "") + (res.stderr || "");
  // Last non-empty line should be "N passed, M failed".
  const lastLine = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  const m = lastLine.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  if (m) {
    const passed = parseInt(m[1], 10);
    const failed = parseInt(m[2], 10);
    totalPassed += passed;
    totalFailed += failed;
    const mark = failed === 0 && res.status === 0 ? "✓" : "✗";
    console.log(`  ${mark} ${file}  (${passed} passed${failed ? `, ${failed} failed` : ""}, ${ms}ms)`);
    if (failed > 0 || res.status !== 0) {
      anyFailed = true;
      failedSuites.push(file);
      // Print failed assertions for debugging
      const failedAssertions = out.split(/\r?\n/).filter((l) => /^\s*✗/.test(l));
      for (const a of failedAssertions) console.log(`      ${a.trim()}`);
    }
  } else {
    // No summary line — treat as catastrophic failure of that suite
    anyFailed = true;
    failedSuites.push(file);
    console.log(`  ✗ ${file}  (no summary line; exit ${res.status})`);
    if (out) {
      const lines = out.trim().split(/\r?\n/).slice(-8);
      for (const l of lines) console.log(`      ${l}`);
    }
  }
}

console.log(
  `\n${totalPassed} passed, ${totalFailed} failed across ${files.length} suite${files.length === 1 ? "" : "s"}`,
);
if (anyFailed) {
  console.log(`Failed suites: ${failedSuites.join(", ")}`);
}
process.exit(anyFailed ? 1 : 0);
