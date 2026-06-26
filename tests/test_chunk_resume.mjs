// Tests for the chunked-build RESUME decision logic in src/chunkPlan.js.
// classifyChunkResume decides, per persisted chunk job, whether to recover
// it from KV, re-attach to a running job, or re-run it. Repo convention:
// custom assert, prints "N passed, M failed", exits non-zero on failure.

import { classifyChunkResume, stitchPlan } from "../src/chunkPlan.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  \u2713", name); }
  else { failed++; console.log("  \u2717", name, detail || ""); }
}

console.log("\n[1] classifyChunkResume — recover a finished chunk");
{
  assert("status done -> recover", classifyChunkResume({ status: "done", delta: "{}" }) === "recover");
}

console.log("\n[2] classifyChunkResume — re-attach to a running chunk");
{
  assert("status running -> reattach", classifyChunkResume({ status: "running" }) === "reattach");
}

console.log("\n[3] classifyChunkResume — re-run missing / expired / errored / absent");
{
  assert("null -> rerun", classifyChunkResume(null) === "rerun");
  assert("undefined -> rerun", classifyChunkResume(undefined) === "rerun");
  assert("notFound -> rerun", classifyChunkResume({ notFound: true }) === "rerun");
  assert("status error -> rerun", classifyChunkResume({ status: "error", error: "boom" }) === "rerun");
  assert("unexpected status -> rerun", classifyChunkResume({ status: "weird" }) === "rerun");
  assert("non-object -> rerun", classifyChunkResume("nope") === "rerun");
}

console.log("\n[4] stitcher still refuses a partial set (wait-for-full-set guard)");
{
  // Resume must NOT stitch until every chunk has a plan. stitchPlan enforces
  // this by throwing when the assembled day count != expectedDays.
  let threw = false;
  try {
    stitchPlan({
      dayChunks: [{ days: [{ label: "Day 1" }, { label: "Day 2" }] }], // only 2 of 5
      wrapper: {},
      expectedDays: 5,
    });
  } catch (e) {
    threw = /assembled 2 days but expected 5/.test(String(e.message));
  }
  assert("partial set rejected", threw);

  // Full set stitches cleanly.
  const { plan } = stitchPlan({
    dayChunks: [
      { days: [{ label: "Day 1" }, { label: "Day 2" }, { label: "Day 3" }] },
      { days: [{ label: "Day 4" }, { label: "Day 5" }] },
    ],
    wrapper: { destination: "Test" },
    expectedDays: 5,
  });
  assert("full set stitches to 5 days", plan.days.length === 5);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
