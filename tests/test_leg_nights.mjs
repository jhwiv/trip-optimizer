// Tests for src/legNights.js — code-derived night counts.
//
// These helpers previously lived in src/pdf/itineraryPdf.js, so only the
// printed PDF showed honest numbers while the plan object, the meta header and
// the on-screen city breakdown kept the model's arithmetic. The 2026-07-28
// London → Normandy → Amsterdam → Lisbon build shipped "2+3+2+3 nights" over a
// 3-2-3-2 day sequence because of that split.
//
// tests/test_pdf_cover_helpers.mjs covers the same three functions through the
// PDF module's re-export; this file covers them at their new home plus the
// reconcile / strip / parse helpers the quality layer uses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  deriveLegNights,
  deriveCityNights,
  rewriteMetaNights,
  stripMetaNightsBreakdown,
  reconcileMetaNights,
  parseMetaNightsBreakdown,
} from "../src/legNights.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const planOf = (...cities) => ({ days: cities.map((city, i) => ({ day: i + 1, city })) });

console.log("=== deriveLegNights — linear trip ===");
{
  // 11 days: London ×3, Bayeux ×2, Amsterdam ×3, Lisbon ×3. The last day is a
  // departure, so the final leg loses a night: 3+2+3+2 = 10 nights.
  const legs = deriveLegNights(fixture("plan_day67_collision.json"));
  assert("four legs", legs.length === 4, JSON.stringify(legs));
  assert("breakdown is 3+2+3+2",
    legs.map(l => l.nights).join("+") === "3+2+3+2", JSON.stringify(legs));
  assert("cities in visit order",
    legs.map(l => l.city).join(",") === "London,Bayeux,Amsterdam,Lisbon");
  assert("nights sum to days − 1", legs.reduce((n, l) => n + l.nights, 0) === 10);
}

console.log("\n=== deriveLegNights — A→B→A ===");
{
  const legs = deriveLegNights(planOf("Amsterdam", "Amsterdam", "Bruges", "Bruges", "Amsterdam", "Amsterdam"));
  assert("return leg is kept as its own run", legs.length === 3, JSON.stringify(legs));
  assert("breakdown is 2+2+1", legs.map(l => l.nights).join("+") === "2+2+1", JSON.stringify(legs));
  assert("Amsterdam appears twice", legs.filter(l => l.city === "Amsterdam").length === 2);
}

console.log("\n=== deriveLegNights — returns null rather than guessing ===");
{
  assert("blank city anywhere → null", deriveLegNights(planOf("Rome", "", "Rome")) === null);
  assert("whitespace-only city → null", deriveLegNights(planOf("Rome", "   ", "Rome")) === null);
  assert("single leg → null", deriveLegNights(planOf("Rome", "Rome", "Rome")) === null);
  assert("single day → null", deriveLegNights(planOf("Rome")) === null);
  assert("no days → null", deriveLegNights({}) === null);
  assert("null plan → null", deriveLegNights(null) === null);
}

console.log("\n=== deriveCityNights ===");
{
  const totals = deriveCityNights(fixture("plan_day67_collision.json"));
  assert("Amsterdam totals 3", totals.get("amsterdam") === 3, String(totals.get("amsterdam")));
  assert("Lisbon totals 2", totals.get("lisbon") === 2, String(totals.get("lisbon")));
  assert("keys are lower-cased", totals.has("london") && !totals.has("London"));

  // A→B→A: the two Amsterdam legs are summed into one city total.
  const round = deriveCityNights(planOf("Amsterdam", "Amsterdam", "Bruges", "Bruges", "Amsterdam", "Amsterdam"));
  assert("repeat legs are summed", round.get("amsterdam") === 3, String(round.get("amsterdam")));
  assert("Bruges unaffected", round.get("bruges") === 2);

  assert("underivable → null", deriveCityNights(planOf("Rome", "", "Rome")) === null);
}

console.log("\n=== rewriteMetaNights ===");
{
  const plan = fixture("plan_day67_collision.json");
  assert("model breakdown replaced with the derived one",
    rewriteMetaNights("11 days · 10 nights (2+3+2+3)", plan) === "11 days · 10 nights (3+2+3+2)",
    rewriteMetaNights("11 days · 10 nights (2+3+2+3)", plan));
  assert("a wrong total is corrected too",
    rewriteMetaNights("11 days · 9 nights (2+3+2+2)", plan) === "11 days · 10 nights (3+2+3+2)",
    rewriteMetaNights("11 days · 9 nights (2+3+2+2)", plan));
  assert("meta with no nights parenthetical is untouched",
    rewriteMetaNights("Thu–Sun · autumn", plan) === "Thu–Sun · autumn");
  assert("underivable plan leaves meta alone",
    rewriteMetaNights("6 days · 5 nights (2+3)", planOf("Rome", "", "Rome")) === "6 days · 5 nights (2+3)");
  assert("empty meta stays empty", rewriteMetaNights("", plan) === "");
  assert("null meta → empty string", rewriteMetaNights(null, plan) === "");
}

console.log("\n=== stripMetaNightsBreakdown ===");
{
  assert("parenthetical dropped, total kept",
    stripMetaNightsBreakdown("11 days · 10 nights (2+3+2+3)") === "11 days · 10 nights",
    stripMetaNightsBreakdown("11 days · 10 nights (2+3+2+3)"));
  assert("singular 'night' handled",
    stripMetaNightsBreakdown("2 days · 1 night (1)") === "2 days · 1 nights",
    stripMetaNightsBreakdown("2 days · 1 night (1)"));
  assert("no parenthetical → unchanged",
    stripMetaNightsBreakdown("11 days · 10 nights") === "11 days · 10 nights");
  assert("empty stays empty", stripMetaNightsBreakdown("") === "");
}

console.log("\n=== reconcileMetaNights ===");
{
  const plan = fixture("plan_day67_collision.json");
  const fixed = reconcileMetaNights(plan.meta, plan);
  assert("derivable plan → rewritten", fixed.meta === "11 days · 10 nights (3+2+3+2)", fixed.meta);
  assert("changed flag set", fixed.changed === true);
  assert("derived legs returned", Array.isArray(fixed.derived) && fixed.derived.length === 4);

  // CLAUDE.md: sums are computed in code. When the day sequence can't confirm a
  // split, strip the model's rather than printing it as fact.
  const blank = planOf("Rome", "", "Rome");
  const stripped = reconcileMetaNights("3 days · 2 nights (1+1)", blank);
  assert("underivable plan → breakdown stripped, not model-printed",
    stripped.meta === "3 days · 2 nights", stripped.meta);
  assert("strip counts as a change", stripped.changed === true);
  assert("no derived legs when underivable", stripped.derived === null);

  const clean = fixture("plan_linear_clean.json");
  const noop = reconcileMetaNights(clean.meta, clean);
  assert("an already-correct meta is left alone", noop.meta === clean.meta, noop.meta);
  assert("no change reported", noop.changed === false);
}

console.log("\n=== parseMetaNightsBreakdown ===");
{
  assert("parses the model's breakdown",
    JSON.stringify(parseMetaNightsBreakdown("11 days · 10 nights (2+3+2+3)")) === "[2,3,2,3]");
  assert("tolerates spacing",
    JSON.stringify(parseMetaNightsBreakdown("10 nights ( 2 + 3 )")) === "[2,3]",
    JSON.stringify(parseMetaNightsBreakdown("10 nights ( 2 + 3 )")));
  assert("no parenthetical → null", parseMetaNightsBreakdown("11 days · 10 nights") === null);
  assert("non-numeric parenthetical → null", parseMetaNightsBreakdown("10 nights (mixed)") === null);
  assert("empty meta → null", parseMetaNightsBreakdown("") === null);
}

console.log("\n=== fragmented Day 6/7 sequence does not throw ===");
{
  // The failing plan's Day 6 and Day 7 are both "Amsterdam" with contradictory
  // content. deriveLegNights only reads days[].city, so it collapses them into
  // one run and returns a usable breakdown rather than crashing.
  let threw = null;
  try { deriveLegNights(fixture("plan_day67_collision.json")); }
  catch (e) { threw = e; }
  assert("no throw on the fragmented plan", threw === null, String(threw));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
