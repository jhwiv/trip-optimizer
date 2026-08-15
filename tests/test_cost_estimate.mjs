// Tests for src/costEstimate.js — trip-level cost estimate normalize/format.

import {
  normalizeCostEstimate,
  formatCostAmount,
  formatCostRange,
  formatBreakdownLine,
} from "../src/costEstimate.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("normalizeCostEstimate");
{
  const n = normalizeCostEstimate({ currency: "usd", low: 3200, high: 4800, breakdown: [
    { category: "Flights", low: 1200, high: 1600 },
    { category: "Lodging", low: 1400, high: 2000 },
  ], basis: "Based on the flights and hotel in this plan." });
  assert("uppercases currency", n.currency === "USD", n.currency);
  assert("keeps low/high", n.low === 3200 && n.high === 4800);
  assert("keeps breakdown", n.breakdown.length === 2);
  assert("keeps basis", n.basis.startsWith("Based on"));
}
{
  const n = normalizeCostEstimate({ low: 5000, high: 3000 });
  assert("swaps backwards low/high", n.low === 3000 && n.high === 5000, JSON.stringify(n));
}
{
  const n = normalizeCostEstimate({ low: 4000 });
  assert("missing high mirrors low", n.low === 4000 && n.high === 4000);
}
{
  const n = normalizeCostEstimate({ high: 4000 });
  assert("missing low mirrors high", n.low === 4000 && n.high === 4000);
}
{
  const n = normalizeCostEstimate({ currency: "USD" });
  assert("no usable low/high returns null", n === null, JSON.stringify(n));
}
{
  const n = normalizeCostEstimate(null);
  assert("null input returns null", n === null);
}
{
  const n = normalizeCostEstimate({ low: -500, high: "2000.6" });
  assert("negative clamped to 0, string coerced", n.low === 0 && n.high === 2001, JSON.stringify(n));
}
{
  const n = normalizeCostEstimate({
    low: 1000, high: 2000,
    breakdown: [
      { category: "", low: 100, high: 200 },
      { category: "Bad", low: "nope", high: "also nope" },
      { category: "Dining", low: 500, high: 900 },
      "not an object",
      null,
    ],
  });
  assert("drops malformed breakdown entries, keeps valid ones", n.breakdown.length === 1 && n.breakdown[0].category === "Dining", JSON.stringify(n.breakdown));
}
{
  const n = normalizeCostEstimate({ low: 100, high: 200, breakdown: [{ category: "X", low: 300, high: 100 }] });
  assert("swaps backwards breakdown low/high", n.breakdown[0].low === 100 && n.breakdown[0].high === 300, JSON.stringify(n.breakdown));
}

console.log("\nformatCostAmount");
assert("USD symbol + grouping", formatCostAmount(3200, "USD") === "$3,200", formatCostAmount(3200, "USD"));
assert("EUR symbol", formatCostAmount(1500, "EUR") === "€1,500", formatCostAmount(1500, "EUR"));
assert("unknown currency falls back to code prefix", formatCostAmount(100, "XYZ") === "XYZ 100", formatCostAmount(100, "XYZ"));
assert("defaults to USD when currency omitted", formatCostAmount(50, undefined) === "$50");
assert("rounds fractional amount", formatCostAmount(99.6, "USD") === "$100", formatCostAmount(99.6, "USD"));
assert("null amount returns empty string", formatCostAmount(null, "USD") === "");

console.log("\nformatCostRange");
assert("range with distinct low/high", formatCostRange({ currency: "USD", low: 3200, high: 4800 }) === "$3,200–$4,800", formatCostRange({ currency: "USD", low: 3200, high: 4800 }));
assert("single value when low === high", formatCostRange({ currency: "USD", low: 2000, high: 2000 }) === "$2,000", formatCostRange({ currency: "USD", low: 2000, high: 2000 }));
assert("null estimate returns empty string", formatCostRange(null) === "");
assert("missing low/high returns empty string", formatCostRange({ currency: "USD" }) === "");

console.log("\nformatBreakdownLine");
assert("range line", formatBreakdownLine({ category: "Flights", low: 1200, high: 1600 }, "USD") === "Flights: $1,200–$1,600", formatBreakdownLine({ category: "Flights", low: 1200, high: 1600 }, "USD"));
assert("single-value line", formatBreakdownLine({ category: "Visa fee", low: 160, high: 160 }, "USD") === "Visa fee: $160", formatBreakdownLine({ category: "Visa fee", low: 160, high: 160 }, "USD"));
assert("null item returns empty string", formatBreakdownLine(null, "USD") === "");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
