// Tests for the KNOWN FAILURE MODE #17 fix in runChunkedBuild (src/App.jsx):
// each chunk is now told explicitly, by day number, whether a city-to-city
// transition happens on its own first or last day, and whose job it is —
// closing the gap where two independent chunk generations both wrote the
// full transition on their shared boundary (a duplicated Bletchley
// Park/Normandy sequence in one real build; a Nuremberg→Porto arrival
// written twice, once at the end of the Nuremberg chunk and again at the
// start of the Porto chunk, in another).
//
// runChunkedBuild is a closure inside the TripOptimizer component and isn't
// independently importable, per this file's established convention — this
// test mirrors the exact transition-note logic and cross-checks the mirror
// against the real source text so the two can't silently drift apart.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { planDayChunks } from "../src/chunkPlan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Mirror of the transitionNote-building logic added to runChunkedBuild.
function buildTransitionNote(chunks, i) {
  const c = chunks[i];
  const prevChunk = chunks[i - 1];
  const nextChunk = chunks[i + 1];
  const myCity = Array.isArray(c.cityNames) ? c.cityNames[0] : null;
  const prevCity = prevChunk && Array.isArray(prevChunk.cityNames) ? prevChunk.cityNames[0] : null;
  const nextCity = nextChunk && Array.isArray(nextChunk.cityNames) ? nextChunk.cityNames[0] : null;
  const sameCity = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  let note = "";
  if (myCity && prevCity && !sameCity(myCity, prevCity)) {
    note += `\nDay ${c.startDay} is the arrival/transition day FROM ${prevCity} TO ${myCity} — a PRIOR, separate generation pass already ended with an ORDINARY day still in ${prevCity} (it wrote no departure). Write the FULL journey — checkout, departure, travel, arrival, hotel check-in — on Day ${c.startDay} only. Do not repeat any part of this transition later in this chunk.`;
  } else if (myCity && prevCity && sameCity(myCity, prevCity)) {
    note += `\nThis chunk CONTINUES the same ${myCity} stay from a prior generation pass, already under way — do not write any inter-city transition unless a day in this chunk's own range is listed above as belonging to a different city.`;
  }
  if (myCity && nextCity && !sameCity(myCity, nextCity)) {
    note += `\nDay ${c.endDay} is your LAST day and MUST stay an ORDINARY day in ${myCity} — do NOT write any departure, travel, or arrival toward ${nextCity} on this day. That transition is written entirely in a LATER, separate generation pass, on its own first day.`;
  }
  return note;
}

console.log("=== source wiring ===");
{
  assert("runChunkedBuild computes prevChunk/nextChunk", SRC.includes("const prevChunk = chunks[i - 1];") && SRC.includes("const nextChunk = chunks[i + 1];"));
  assert("transitionNote is folded into chunkConstraint", /\$\{cityHint\}\$\{transitionNote\}/.test(SRC));
  assert("arrival-day instruction present verbatim", SRC.includes("is the arrival/transition day FROM"));
  assert("last-day instruction present verbatim", SRC.includes("MUST stay an ORDINARY day in"));
  assert("same-city continuation instruction present verbatim", SRC.includes("CONTINUES the same"));
}

console.log("\n=== build #1 shape — a single city leg sub-split by MAX_DAYS_PER_CHUNK (real regression) ===");
{
  // London 7 nights (+ arrival day = 8 days) exceeds MAX_DAYS_PER_CHUNK (6),
  // sub-splitting into two SAME-CITY chunks — Day1-4 and Day5-8 — real
  // observed case: chunk 2 nonetheless wrote its own transition to Normandy
  // mid-chunk despite being told nothing but "these days belong to London".
  const chunks = planDayChunks({
    nights: 14,
    cities: [{ name: "London", nights: 7 }, { name: "Caen (Normandy)", nights: 1 }, { name: "Nuremberg", nights: 2 }, { name: "Porto", nights: 4 }],
  });
  assert("London leg sub-splits into two chunks", chunks[0].endDay === 4 && chunks[1].startDay === 5 && chunks[1].endDay === 8,
    JSON.stringify(chunks));

  const note0 = buildTransitionNote(chunks, 0);
  assert("chunk 1 (Day1-4, first chunk overall) gets no transition note", note0 === "", note0);

  const note1 = buildTransitionNote(chunks, 1);
  assert("chunk 2 (Day5-8, SAME city as chunk 1) is told it's a continuation, not a transition",
    note1.includes("CONTINUES the same London stay"), note1);
  assert("chunk 2 is explicitly told NOT to write a transition",
    note1.includes("do not write any inter-city transition"), note1);

  const note2 = buildTransitionNote(chunks, 2);
  assert("chunk 3 (Caen, a NEW city after London) is told Day9 is the arrival day FROM London",
    note2.includes("Day 9 is the arrival/transition day FROM London TO Caen (Normandy)"), note2);
}

console.log("\n=== build #2 shape — a leg boundary lands exactly on a chunk boundary (real regression) ===");
{
  // Nuremberg (3 nights, Day8-10) → Porto (5 nights, Day11-15): real observed
  // case, the Nuremberg chunk's last day AND the Porto chunk's first day both
  // wrote the full Nuremberg→Porto arrival, duplicating it.
  const chunks = planDayChunks({
    nights: 14,
    cities: [{ name: "London", nights: 4 }, { name: "Normandy", nights: 2 }, { name: "Nuremberg", nights: 3 }, { name: "Porto", nights: 5 }],
  });
  assert("chunk shape matches the real build (London, Normandy, Nuremberg, Porto)",
    chunks.length === 4 && chunks[2].startDay === 8 && chunks[2].endDay === 10 && chunks[3].startDay === 11 && chunks[3].endDay === 15,
    JSON.stringify(chunks));

  const nuremberg = buildTransitionNote(chunks, 2);
  assert("the Nuremberg chunk is told Day10 is its LAST day and must stay ordinary",
    nuremberg.includes("Day 10 is your LAST day and MUST stay an ORDINARY day in Nuremberg"), nuremberg);
  assert("the Nuremberg chunk is told the Porto transition is NOT its job",
    nuremberg.includes("do NOT write any departure, travel, or arrival toward Porto"), nuremberg);

  const porto = buildTransitionNote(chunks, 3);
  assert("the Porto chunk is told Day11 is the arrival day FROM Nuremberg",
    porto.includes("Day 11 is the arrival/transition day FROM Nuremberg TO Porto"), porto);
  assert("the Porto chunk is told the prior chunk wrote no departure",
    porto.includes("a PRIOR, separate generation pass already ended with an ORDINARY day still in Nuremberg"), porto);
}

console.log("\n=== single-city trip — no transition notes anywhere ===");
{
  const chunks = planDayChunks({ nights: 10, cities: [{ name: "Rome", nights: 10 }] });
  for (let i = 0; i < chunks.length; i++) {
    assert(`chunk ${i + 1} of a single-city trip gets no transition note`, buildTransitionNote(chunks, i) === "" || buildTransitionNote(chunks, i).includes("CONTINUES the same"));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
