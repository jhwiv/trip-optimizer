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
  deriveLegNightsByPosition,
  deriveHotelNights,
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

console.log("\n=== transit-day hotel reattribution (2026-08-07 regression) ===");
{
  // Real observed case: a 15-day London/Paris/Normandy/Porto build. Day 5 is
  // labeled "Portsmouth" (where the day's activities happen) but its hotel
  // check-in that evening is a Normandy property; Day 7 is labeled
  // "Normandy" but checks into a Paris hotel that evening. Reading days[].city
  // literally gave "3+3+2+6" (wrong on every count); the real breakdown,
  // confirmed against the hotel check-in/check-out dates, is
  // London 4 / Normandy 2+1 / Paris 3 / Porto 4 = 14.
  const hotel = (name) => ({ hotel: { name } });
  const trip = {
    days: [
      { day: 1, city: "London", items: [{ type: "Hotel", text: "Check in London Marriott", ...hotel("London Marriott") }] },
      { day: 2, city: "London", items: [{ type: "Activity", text: "Churchill War Rooms" }] },
      { day: 3, city: "London", items: [{ type: "Activity", text: "Imperial War Museum" }] },
      { day: 4, city: "London", items: [{ type: "Activity", text: "Bletchley Park day trip" }] },
      { day: 5, city: "Portsmouth", items: [
        { type: "Hotel", text: "Check out London Marriott", ...hotel("London Marriott") },
        { type: "Activity", text: "Portsmouth D-Day Museum" },
        { type: "Hotel", text: "Late check-in Villa Lara Hotel & Spa", ...hotel("Villa Lara Hotel & Spa") },
      ] },
      { day: 6, city: "Normandy", items: [{ type: "Activity", text: "Bayeux Tapestry Museum" }] },
      { day: 7, city: "Normandy", items: [
        { type: "Hotel", text: "Check out Villa Lara Hotel & Spa", ...hotel("Villa Lara Hotel & Spa") },
        { type: "Transport", text: "Drive Bayeux to Paris via A13" },
        { type: "Hotel", text: "Check in Paris Marriott Champs Elysees", ...hotel("Paris Marriott Champs Elysees") },
      ] },
      { day: 8, city: "Paris", items: [{ type: "Activity", text: "Paris WWII sites" }] },
      { day: 9, city: "Paris", items: [{ type: "Activity", text: "Paris recovery" }] },
      { day: 10, city: "Normandy", items: [
        { type: "Hotel", text: "Check out Paris Marriott Champs Elysees", ...hotel("Paris Marriott Champs Elysees") },
        { type: "Activity", text: "Normandy American Cemetery" },
        { type: "Hotel", text: "Check in Novotel Bayeux", ...hotel("Novotel Bayeux") },
      ] },
      { day: 11, city: "Porto, Portugal", items: [
        { type: "Hotel", text: "Check out Novotel Bayeux", ...hotel("Novotel Bayeux") },
        { type: "Flight", text: "Flight Paris CDG to Porto OPO" },
        { type: "Hotel", text: "Check in The Yeatman Hotel", ...hotel("The Yeatman Hotel") },
      ] },
      { day: 12, city: "Porto, Portugal", items: [{ type: "Activity", text: "Douro Valley Wine Day" }] },
      { day: 13, city: "Porto, Portugal", items: [{ type: "Activity", text: "Ribeira & Port Lodges" }] },
      { day: 14, city: "Porto, Portugal", items: [{ type: "Activity", text: "Livraria Lello" }] },
      { day: 15, city: "Porto, Portugal", items: [{ type: "Hotel", text: "Check out The Yeatman Hotel", ...hotel("The Yeatman Hotel") }] },
    ],
  };

  const legs = deriveLegNights(trip);
  assert("five legs (Normandy split into two runs)", legs.length === 5, JSON.stringify(legs));
  assert("breakdown is 4+2+3+1+4", legs.map(l => l.nights).join("+") === "4+2+3+1+4", JSON.stringify(legs));
  assert("Day 5's night is attributed to Normandy, not Portsmouth (the day.city label)",
    legs[1].city === "Normandy", JSON.stringify(legs));
  assert("Day 7's night is attributed to Paris, not Normandy (the day.city label)",
    legs[2].city === "Paris", JSON.stringify(legs));
  assert("nights sum to 14", legs.reduce((n, l) => n + l.nights, 0) === 14);

  const totals = deriveCityNights(trip);
  assert("London totals 4", totals.get("london") === 4, String(totals.get("london")));
  assert("Normandy totals 3 (2+1 across both legs)", totals.get("normandy") === 3, String(totals.get("normandy")));
  assert("Paris totals 3, not 2 (the day.city-only count)", totals.get("paris") === 3, String(totals.get("paris")));
  assert("Porto totals 4", totals.get("porto, portugal") === 4, String(totals.get("porto, portugal")));

  // Back-to-back single-night transit days (Day 10 -> Day 11, both
  // check-out-and-check-in-same-day) must NOT collapse into each other —
  // each has its own, different destination. This is the regression the
  // "only borrow when the NEXT day is settled" guard exists for: naively
  // borrowing forward through both handed Day 10's night to Porto,
  // silently deleting the one-night Normandy return entirely.
  const dayTenLeg = legs.find((l, i) => i === 3);
  assert("Day 10's one-night Normandy return survives as its own leg (not merged into Porto)",
    dayTenLeg && dayTenLeg.city === "Normandy" && dayTenLeg.nights === 1, JSON.stringify(legs));
}

console.log("\n=== rewriteMetaNights / stripMetaNightsBreakdown — bare 'a+b+c nights' format (2026-08-07 regression) ===");
{
  // Real observed meta shape: the breakdown appears as its own trailing
  // clause with no parentheses ("... · Relaxed pace · 3+3+2+6 nights"),
  // which the parenthetical-only regex never matched — the wrong model
  // breakdown shipped untouched even though deriveLegNights could derive
  // the correct one.
  const plan = {
    days: [
      { day: 1, city: "Rome" }, { day: 2, city: "Rome" }, { day: 3, city: "Rome" },
      { day: 4, city: "Florence" }, { day: 5, city: "Florence" },
    ],
  };
  const meta = "Mon–Fri · 4 nights · 2 adults · Relaxed pace · 5+1 nights";
  assert("bare breakdown is rewritten to the derived one",
    rewriteMetaNights(meta, plan) === "Mon–Fri · 4 nights · 2 adults · Relaxed pace · 3+1 nights",
    rewriteMetaNights(meta, plan));
  assert("parenthetical form still works unchanged (no regression)",
    rewriteMetaNights("4 nights (5+1)", plan) === "4 nights (3+1)", rewriteMetaNights("4 nights (5+1)", plan));

  const underivable = { days: [{ day: 1, city: "Rome" }, { day: 2, city: "" }] };
  assert("bare breakdown is stripped (not printed) when underivable",
    stripMetaNightsBreakdown("4 nights · 5+1 nights") === "4 nights",
    stripMetaNightsBreakdown("4 nights · 5+1 nights"));
  void underivable; // documents the underivable case rewriteMetaNights/reconcileMetaNights already cover elsewhere

  assert("parseMetaNightsBreakdown reads the bare format",
    JSON.stringify(parseMetaNightsBreakdown("4 nights · 5+1 nights")) === "[5,1]",
    JSON.stringify(parseMetaNightsBreakdown("4 nights · 5+1 nights")));
}

console.log("\n=== dayHasHotelEvent / dayContinuityCheck.js's hotelEvent — sibling consistency (2026-08-09 follow-up) ===");
{
  // A code-review pass on the dayContinuityCheck.js hotelEvent() fix (added
  // an "Overnight at..." reminder → not a check-in exemption) flagged that
  // this file's own dayHasHotelEvent(), documented as its mirror, was not
  // updated with the same exemption — risking the two "same input, same
  // classification" functions disagreeing on a genuine transit day whose
  // ONLY new-hotel signal is "Overnight at [Hotel]" (no separate "check in"
  // line). dayContinuityCheck.js's fix was instead scoped to "no check-out
  // recorded yet today" rather than a bare text match, so a real transit day
  // (which always has an earlier same-day check-out) still counts its
  // "Overnight at..." arrival as a check-in in BOTH files — this test proves
  // deriveLegNights still recognizes the transit day correctly post-fix,
  // i.e. the two files did not end up disagreeing on this real shape.
  // Day 2's own city label names the ORIGIN (the exact real-world pattern
  // this module's header comment documents) even though the night is spent
  // in Nuremberg — only correctly detecting Day 2 as a transit day (both a
  // check-out AND a check-in that day) makes deriveLegNights borrow Day 3's
  // settled label forward and attribute the night to Nuremberg instead of
  // Bayeux. If hotelEvent()/dayHasHotelEvent() disagreed on whether
  // "Overnight at Sheraton..." (no separate "check in" line) counts as a
  // check-in, this transit day would go undetected, Day 2 would stay grouped
  // under "Bayeux," and the final leg's night would round down to zero and
  // get filtered out entirely — collapsing 2 real legs into 1 and returning
  // null (deriveLegNights requires >= 2 legs).
  const transitDayOvernightOnly = {
    days: [
      { day: 1, city: "Bayeux", items: [
        { type: "Activity", text: "Bayeux Tapestry" },
      ] },
      { day: 2, city: "Bayeux", items: [
        { type: "Hotel", text: "Check out of Mercure Omaha Beach", hotel: { name: "Mercure Omaha Beach" } },
        { type: "Transport", text: "Drive Bayeux to Nuremberg — 7h" },
        { type: "Hotel", text: "Overnight at Sheraton Carlton Hotel Nuremberg", hotel: { name: "Sheraton Carlton Hotel Nuremberg" } },
      ] },
      { day: 3, city: "Nuremberg", items: [
        { type: "Activity", text: "Nuremberg Trials Memorial" },
      ] },
    ],
  };
  const legs = deriveLegNights(transitDayOvernightOnly);
  assert("Day 2 is correctly detected as a transit day and its night borrows forward to Nuremberg, not Bayeux",
    JSON.stringify(legs) === JSON.stringify([{ city: "Bayeux", nights: 1 }, { city: "Nuremberg", nights: 1 }]),
    JSON.stringify(legs));
}

console.log("\n=== resolvedDayCity via buildDayLegs (2026-09-02 regression: Carvoeiro/Lagos mislabeling) ===");
{
  // Real reported case: a 13-day, 3-leg Carvoeiro (friends) / Lagos (Cascade
  // Wellness Resort) / Carvoeiro (Tivoli) trip. days[].city mislabeled Day 4
  // (the transfer TO Lagos, where the traveller actually slept that night)
  // and Day 6 (a same-day round-trip drive back to Carvoeiro for a
  // paddleboard outing, returning to sleep in Lagos) both as "Carvoeiro" —
  // even though both days have unambiguous Transport text naming the real
  // city. The shipped meta line read "12 nights (4+1+1+3+3)"; the real split
  // is 3+6+3.
  const dayTrip = (n, city, extraItems = []) => ({
    day: n, city, items: [{ type: "Activity", text: "A real waypoint activity" }, ...extraItems],
  });
  const plan = {
    cities: [{ name: "Carvoeiro" }, { name: "Lagos" }, { name: "Carvoeiro" }],
    days: [
      dayTrip(1, "Carvoeiro"),
      dayTrip(2, "Carvoeiro"),
      dayTrip(3, "Carvoeiro"),
      // Day 4: mislabeled "Carvoeiro" in days[].city, but the Transport item
      // resolves cleanly to Lagos, and a Hotel check-in confirms it.
      {
        day: 4, city: "Carvoeiro",
        items: [
          { type: "Transport", text: "Drive Carvoeiro to Lagos — 30 min via N125" },
          { type: "Hotel", text: "Check in to Cascade Wellness Resort", hotel: { name: "Cascade Wellness Resort" } },
        ],
      },
      dayTrip(5, "Lagos"),
      // Day 6: mislabeled "Carvoeiro" in days[].city (matching the day's
      // OWN headline, "Return to Carvoeiro"), but it's a same-day round
      // trip — both drives resolve, so the traveller never actually leaves
      // Lagos as their base for the night.
      {
        day: 6, city: "Carvoeiro",
        items: [
          { type: "Transport", text: "Drive Lagos -> Carvoeiro · 30 min via N125" },
          { type: "Activity", text: "Paddleboard to Benagil Cave" },
          { type: "Transport", text: "Drive Carvoeiro -> Lagos · 30 min via N125 to return to resort" },
        ],
      },
      dayTrip(7, "Lagos"),
      dayTrip(8, "Lagos"),
      dayTrip(9, "Lagos"),
      // Day 10: correctly labeled "Carvoeiro" already (transfer to Tivoli).
      {
        day: 10, city: "Carvoeiro",
        items: [
          { type: "Transport", text: "Drive Lagos -> Carvoeiro · 30 min via N125" },
          { type: "Hotel", text: "Check in to Tivoli Carvoeiro Algarve Resort", hotel: { name: "Tivoli Carvoeiro Algarve Resort" } },
        ],
      },
      dayTrip(11, "Carvoeiro"),
      dayTrip(12, "Carvoeiro"),
      dayTrip(13, "Carvoeiro"), // departure day
    ],
  };
  const legs = deriveLegNights(plan);
  assert("three legs, not five — Day 4 and Day 6 no longer fracture the Lagos stay",
    legs && legs.length === 3, JSON.stringify(legs));
  assert("breakdown is 3+6+3, not the raw-label 4+1+1+3+3",
    legs && legs.map(l => l.nights).join("+") === "3+6+3", JSON.stringify(legs));
  assert("cities in visit order: Carvoeiro, Lagos, Carvoeiro",
    legs && legs.map(l => l.city).join(",") === "Carvoeiro,Lagos,Carvoeiro", JSON.stringify(legs));
  assert("nights sum to 12 (13 days − 1 departure day)",
    legs && legs.reduce((n, l) => n + l.nights, 0) === 12);

  const totals = deriveCityNights(plan);
  assert("Carvoeiro totals 6 (3 + 3 across both legs)", totals && totals.get("carvoeiro") === 6, String(totals?.get("carvoeiro")));
  assert("Lagos totals 6, not 8 (the raw-label count)", totals && totals.get("lagos") === 6, String(totals?.get("lagos")));

  assert("meta breakdown is corrected to 3+6+3",
    rewriteMetaNights("12 nights (4+1+1+3+3)", plan) === "12 nights (3+6+3)",
    rewriteMetaNights("12 nights (4+1+1+3+3)", plan));
}

console.log("\n=== deriveLegNightsByPosition — per-LEG counts for A→B→A trips (2026-09-02) ===");
{
  // Same fixture shape as the real reported build: Carvoeiro (3n) → Lagos
  // (6n) → Carvoeiro (3n). A per-city-aggregate lookup (the old bug) would
  // show 6n on BOTH Carvoeiro entries (3+3 combined); a per-leg positional
  // lookup must show each leg's own 3n.
  const plan = {
    days: [
      { day: 1, city: "Carvoeiro" }, { day: 2, city: "Carvoeiro" }, { day: 3, city: "Carvoeiro" },
      { day: 4, city: "Lagos" }, { day: 5, city: "Lagos" }, { day: 6, city: "Lagos" },
      { day: 7, city: "Lagos" }, { day: 8, city: "Lagos" }, { day: 9, city: "Lagos" },
      { day: 10, city: "Carvoeiro" }, { day: 11, city: "Carvoeiro" }, { day: 12, city: "Carvoeiro" }, { day: 13, city: "Carvoeiro" },
    ],
  };
  const names = ["Carvoeiro", "Lagos", "Carvoeiro"];
  const byPos = deriveLegNightsByPosition(plan, names);
  assert("three entries, one per leg", byPos.length === 3, JSON.stringify(byPos));
  assert("first Carvoeiro leg shows its OWN 3 nights, not the combined 6",
    byPos[0] === 3, JSON.stringify(byPos));
  assert("Lagos leg shows 6", byPos[1] === 6, JSON.stringify(byPos));
  assert("second Carvoeiro leg ALSO shows its own 3, not 6 — the two legs differ",
    byPos[2] === 3, JSON.stringify(byPos));

  assert("length mismatch (fewer names than derived legs) → all null, no guessing",
    JSON.stringify(deriveLegNightsByPosition(plan, ["Carvoeiro", "Lagos"])) === JSON.stringify([null, null]));
  assert("length mismatch (more names than derived legs) → all null",
    JSON.stringify(deriveLegNightsByPosition(plan, ["Carvoeiro", "Lagos", "Carvoeiro", "Extra"])) ===
    JSON.stringify([null, null, null, null]));

  assert("a mismatched single position is nulled individually, not the whole array",
    JSON.stringify(deriveLegNightsByPosition(plan, ["Carvoeiro", "Wrong Name Entirely", "Carvoeiro"])) ===
    JSON.stringify([3, null, 3]));

  assert("underivable plan (single leg) → all null", JSON.stringify(deriveLegNightsByPosition(planOf("Rome", "Rome"), ["Rome"])) === JSON.stringify([null]));
  assert("empty names → empty array", JSON.stringify(deriveLegNightsByPosition(plan, [])) === "[]");
  assert("null names → empty array", JSON.stringify(deriveLegNightsByPosition(plan, null)) === "[]");
}

console.log("\n=== deriveHotelNights — real per-property counts (2026-09-02) ===");
{
  // Same real-world shape: 3 nights staying with friends (no Hotel item at
  // all — unpaid, correctly excluded), 6 paid nights at Cascade Wellness
  // Resort, 3 paid nights at Tivoli Carvoeiro Algarve Resort.
  const act = (text) => ({ type: "Activity", text });
  const plan = {
    days: [
      { city: "Carvoeiro", items: [act("Arrive at friends' home")] },
      { city: "Carvoeiro", items: [act("Beach day")] },
      { city: "Carvoeiro", items: [act("Benagil speedboat")] },
      {
        city: "Lagos",
        items: [
          { type: "Transport", text: "Drive Carvoeiro to Lagos" },
          { type: "Hotel", text: "Check in to Cascade Wellness Resort", hotel: { name: "Cascade Wellness Resort" } },
        ],
      },
      { city: "Lagos", items: [act("Old town")] },
      { city: "Lagos", items: [act("Paddleboard day trip")] },
      { city: "Lagos", items: [act("Ponta da Piedade")] },
      { city: "Lagos", items: [act("Sagres")] },
      { city: "Lagos", items: [act("Spa morning")] },
      {
        city: "Carvoeiro",
        items: [
          { type: "Transport", text: "Drive Lagos to Carvoeiro" },
          { type: "Hotel", text: "Check in to Tivoli Carvoeiro Algarve Resort", hotel: { name: "Tivoli Carvoeiro Algarve Resort" } },
        ],
      },
      { city: "Carvoeiro", items: [act("Sagres & Cape St. Vincent")] },
      { city: "Carvoeiro", items: [act("Silves")] },
      { city: "Carvoeiro", items: [{ type: "Hotel", text: "Check out of Tivoli Carvoeiro Algarve Resort", hotel: { name: "Tivoli Carvoeiro Algarve Resort" } }] },
    ],
  };
  const hotelNights = deriveHotelNights(plan);
  assert("two properties tracked", hotelNights && hotelNights.size === 2, hotelNights && JSON.stringify([...hotelNights]));
  assert("Cascade Wellness Resort: 6 real paid nights",
    hotelNights?.get("cascade wellness resort")?.nights === 6, JSON.stringify(hotelNights?.get("cascade wellness resort")));
  assert("Tivoli Carvoeiro Algarve Resort: 3 real paid nights",
    hotelNights?.get("tivoli carvoeiro algarve resort")?.nights === 3, JSON.stringify(hotelNights?.get("tivoli carvoeiro algarve resort")));
  assert("staying-with-friends nights (no Hotel item) accrue to no property",
    [...hotelNights.values()].reduce((n, h) => n + h.nights, 0) === 9);

  assert("too few days → null", deriveHotelNights({ days: [{ city: "Rome" }] }) === null);
  assert("no plan → null", deriveHotelNights(null) === null);
  assert("no hotel ever checked in → null",
    deriveHotelNights({ days: [{ city: "Rome", items: [act("Walk")] }, { city: "Rome", items: [act("Walk")] }] }) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
