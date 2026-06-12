// Unit tests for the bpName helper inside useViewport.js. Doesn't exercise
// the hook itself (that would need a React renderer in Node, which is more
// machinery than the value justifies right now). bpName is pure and is the
// only piece other components branch on.

import { bpName, BP } from "../src/useViewport.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n[A] Breakpoint constants are sane");
assert("mobile_max < tablet_max", BP.MOBILE_MAX < BP.TABLET_MAX);
assert("tablet_max < desktop_max", BP.TABLET_MAX < BP.DESKTOP_MAX);
assert("mobile_max = 639", BP.MOBILE_MAX === 639);
assert("tablet_max = 959", BP.TABLET_MAX === 959);
assert("desktop_max = 1279", BP.DESKTOP_MAX === 1279);

console.log("\n[B] bpName at each boundary");
// Mobile boundary
assert("320 (small phone) → mobile", bpName(320) === "mobile");
assert("390 (iPhone 14) → mobile", bpName(390) === "mobile");
assert("414 (iPhone 14 Plus) → mobile", bpName(414) === "mobile");
assert("639 (exact boundary) → mobile", bpName(639) === "mobile");

// Tablet boundary
assert("640 (first tablet pixel) → tablet", bpName(640) === "tablet");
assert("768 (iPad portrait) → tablet", bpName(768) === "tablet");
assert("959 (exact boundary) → tablet", bpName(959) === "tablet");

// Desktop boundary
assert("960 (first desktop pixel) → desktop", bpName(960) === "desktop");
assert("1024 (small laptop) → desktop", bpName(1024) === "desktop");
assert("1279 (exact boundary) → desktop", bpName(1279) === "desktop");

// Wide
assert("1280 (first wide pixel) → wide", bpName(1280) === "wide");
assert("1920 (FHD) → wide", bpName(1920) === "wide");
assert("2560 (QHD) → wide", bpName(2560) === "wide");

console.log("\n[C] Edge cases");
assert("0 → mobile", bpName(0) === "mobile");
assert("-1 → mobile (defensive)", bpName(-1) === "mobile");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
