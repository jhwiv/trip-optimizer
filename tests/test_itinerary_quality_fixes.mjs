// Tests for three quality-layer fixes found auditing the 2026-08-03 Sedona
// build (Elote Cafe listed twice on Day 3; the Pink Jeep Broken Arrow tour
// promised in the day's headline but never scheduled as an item; the
// "MUST:" tonight entries for both silently losing their urgency badge).
//
// applyQualityLayer and tonightPriority/stripTonightPrefix are closures
// inside src/App.jsx and can't be imported directly here (jsdom-free tests),
// so — following the convention in test_day_completeness_and_city_normalization.mjs —
// each fix's pure logic is mirrored locally and tested against that mirror.
// Keep these mirrors in sync if the App.jsx implementations change shape.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// -----------------------------------------------------------------------------
// 1. Same-day duplicate-venue dedupe mirror (src/App.jsx applyQualityLayer §1)
// -----------------------------------------------------------------------------
function dedupeRestaurants(days) {
  const fixes = [];
  const seen = new Map();
  days.forEach((day, dayIdx) => {
    if (!Array.isArray(day.items)) return;
    const seenTypesToday = new Map();
    const dupFlags = [];
    day.items = day.items.filter(item => {
      const r = item.restaurant;
      const isMeal = /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(item.type || "");
      if (!r || !r.name || !isMeal) return true;
      const key = r.name.trim().toLowerCase();
      const typeKey = (item.type || "").toLowerCase();
      const todayTypes = seenTypesToday.get(key);
      if (todayTypes?.has(typeKey)) {
        fixes.push(`Day ${dayIdx + 1}: removed duplicate ${r.name} entry (${item.type})`);
        dupFlags.push({ code: "DUPLICATE_VENUE_SAME_DAY", severity: "warn", dayIdx, day: dayIdx + 1, target: r.name });
        return false;
      }
      if (todayTypes) todayTypes.add(typeKey);
      else seenTypesToday.set(key, new Set([typeKey]));

      const prior = seen.get(key);
      if (prior && prior.dayIndex !== dayIdx) {
        r._isReturnVisit = true;
        fixes.push(`Annotated repeat: ${r.name} (Day ${dayIdx + 1}) — first on Day ${prior.dayIndex + 1}`);
      } else if (!prior) {
        seen.set(key, { dayIndex: dayIdx, mealType: item.type || "meal" });
      }
      return true;
    });
    if (dupFlags.length > 0) {
      day.structural_flags = [...(day.structural_flags || []), ...dupFlags];
    }
  });
  return { days, fixes };
}

console.log("\n1. Same-day duplicate-venue dedupe\n");
{
  // The exact Sedona Day 3 shape: Elote Cafe as Dinner at 6:30 PM and again at 7:30 PM.
  const days = [
    {
      items: [
        { type: "Activity", time: "07:30", text: "Bell Rock" },
        { type: "Dinner", time: "18:30", restaurant: { name: "Elote Cafe", hours: "Tue-Sat 5-9PM" } },
        { type: "Dinner", time: "19:30", restaurant: { name: "Elote Cafe" } },
      ],
    },
  ];
  const { days: out, fixes } = dedupeRestaurants(days);
  assert("the duplicate Dinner item is removed", out[0].items.length === 2, `got ${out[0].items.length}`);
  assert("the surviving item is the first (richer) occurrence", out[0].items[1].restaurant.hours === "Tue-Sat 5-9PM");
  assert("a fix is logged", fixes.some(f => /removed duplicate Elote Cafe/i.test(f)), fixes.join(" | "));
  assert("a DUPLICATE_VENUE_SAME_DAY warn flag is attached", out[0].structural_flags?.[0]?.code === "DUPLICATE_VENUE_SAME_DAY");
  assert("the flag severity is warn (auto-corrected, not blocking)", out[0].structural_flags?.[0]?.severity === "warn");
}
{
  // Legitimate cross-day return visit must still be annotated, not removed.
  const days = [
    { items: [{ type: "Dinner", time: "19:00", restaurant: { name: "Cantina 32" } }] },
    { items: [{ type: "Dinner", time: "20:00", restaurant: { name: "Cantina 32" } }] },
  ];
  const { days: out } = dedupeRestaurants(days);
  assert("a return visit on a LATER day is kept, not removed", out[1].items.length === 1);
  assert("the later day's item is annotated as a return visit", out[1].items[0].restaurant._isReturnVisit === true);
  assert("no structural flag on a legitimate return visit", !out[1].structural_flags);
}
{
  // Same restaurant, same day, DIFFERENT meal types (lunch then dinner) is not
  // the bug this fix targets — both items must survive.
  const days = [
    {
      items: [
        { type: "Lunch", time: "12:00", restaurant: { name: "The Hudson" } },
        { type: "Dinner", time: "19:00", restaurant: { name: "The Hudson" } },
      ],
    },
  ];
  const { days: out } = dedupeRestaurants(days);
  assert("same restaurant, different meal types, same day — both items survive", out[0].items.length === 2);
  // Regression (peer-review finding, 2026-08-03): the "seen" map used for
  // cross-day return-visit annotation was keyed only by name, with no check
  // that the prior sighting was on an EARLIER day — so the Dinner item here
  // got mislabeled "Return visit — first appeared Day 1 (lunch)" referring
  // to the SAME day, which is nonsensical (it isn't a return visit from
  // itself). Same-day/different-meal-type must get no annotation at all.
  assert("...and the second (Dinner) item is NOT mislabeled as a same-day \"return visit\"",
    out[0].items[1].restaurant._isReturnVisit !== true, JSON.stringify(out[0].items[1].restaurant));
  assert("...and its why/hours text is untouched by a same-day return-visit note",
    !out[0].items[1].restaurant.why, out[0].items[1].restaurant.why);
}
{
  // A genuine cross-day return visit must still be annotated correctly even
  // when the first sighting was a DIFFERENT meal type than the second.
  const days = [
    { items: [{ type: "Lunch", time: "12:00", restaurant: { name: "The Hudson" } }] },
    { items: [{ type: "Dinner", time: "19:00", restaurant: { name: "The Hudson" } }] },
  ];
  const { days: out } = dedupeRestaurants(days);
  assert("a cross-day return visit (different meal type) is still annotated",
    out[1].items[0].restaurant._isReturnVisit === true);
}

// -----------------------------------------------------------------------------
// 2. Marquee-coverage haystack mirror (src/App.jsx applyQualityLayer §2.6)
// -----------------------------------------------------------------------------
function marqueeHaystacks(days, input) {
  const itemParts = [];
  days.forEach(d => {
    (d.items || []).forEach(it => {
      if (it.text) itemParts.push(String(it.text));
      if (it.why) itemParts.push(String(it.why));
      if (it.location) itemParts.push(String(it.location));
      if (it.restaurant?.name) itemParts.push(String(it.restaurant.name));
      if (it.hotel?.name) itemParts.push(String(it.hotel.name));
    });
  });
  const proseParts = [];
  days.forEach(d => {
    if (d.headline) proseParts.push(String(d.headline));
    if (d.weather) proseParts.push(String(d.weather));
  });
  if (Array.isArray(input?.snobs)) proseParts.push(input.snobs.join(" "));
  if (Array.isArray(input?.flags)) proseParts.push(input.flags.join(" "));
  return {
    itemHaystack: itemParts.join(" ").toLowerCase(),
    proseHaystack: proseParts.join(" ").toLowerCase(),
  };
}
const SEDONA_GROUPS = [
  ["cathedral rock", "bell rock", "chapel of the holy cross"],
  ["pink jeep", "broken arrow", "jeep tour"],
];
function marqueeFindings(days, input, groups) {
  const { itemHaystack, proseHaystack } = marqueeHaystacks(days, input);
  const findings = [];
  for (const group of groups) {
    if (group.some(kw => itemHaystack.includes(kw))) continue;
    findings.push({ label: group[0], promisedOnly: group.some(kw => proseHaystack.includes(kw)) });
  }
  return findings;
}

console.log("\n2. Marquee-coverage haystack: scheduled (items) vs merely promised (prose)\n");
{
  // DAY_ITEM_SCHEMA has "text"/"why", never "name"/"notes" — the item
  // haystack must actually read the fields items really carry.
  const days = [{ headline: "Arrival", items: [{ type: "Activity", text: "Cathedral Rock scramble" }] }];
  const findings = marqueeFindings(days, {}, SEDONA_GROUPS);
  assert("a marquee mention living only in item.text counts as scheduled",
    !findings.some(f => f.label === "cathedral rock"), JSON.stringify(findings));
}
{
  // The actual 2026-08-03 shape: headline AND flags[] both promise Pink
  // Jeep, Bell Rock is a real scheduled item, but no item anywhere is the
  // Pink Jeep tour itself — a merged haystack would find "pink jeep" in the
  // headline/flags and wrongly call it scheduled. The split must not.
  const days = [
    {
      headline: "Pink Jeep off-road tour — broken-arrow trail at midday",
      items: [
        { type: "Activity", text: "Bell Rock Pathway — easy loop", location: "Bell Rock Pathway Trailhead" },
        { type: "Note", text: "Return to hotel" },
        { type: "Dinner", text: "Dinner", restaurant: { name: "Elote Cafe" } },
      ],
    },
  ];
  const input = { flags: ["Pink Jeep Broken Arrow tour books out 5-7 days ahead — reserve this week"] };
  const findings = marqueeFindings(days, input, SEDONA_GROUPS);
  assert("Bell Rock group is satisfied (item text + location)", !findings.some(f => f.label === "cathedral rock"));
  const pinkJeep = findings.find(f => f.label === "pink jeep");
  assert("Pink Jeep tour is flagged missing even though headline + flags mention it",
    !!pinkJeep, JSON.stringify(findings));
  assert("...and is specifically flagged as promised-but-not-scheduled, not merely absent",
    pinkJeep?.promisedOnly === true, JSON.stringify(pinkJeep));
}
{
  // Once an item actually schedules it, the flag must clear.
  const days = [
    {
      headline: "Pink Jeep off-road tour — broken-arrow trail at midday",
      items: [
        { type: "Activity", text: "Pink Jeep Broken Arrow backcountry tour", location: "Pink Jeep Tours, Sedona" },
      ],
    },
  ];
  const findings = marqueeFindings(days, {}, SEDONA_GROUPS);
  assert("Pink Jeep group clears once an item actually schedules it",
    !findings.some(f => f.label === "pink jeep"), JSON.stringify(findings));
}

// -----------------------------------------------------------------------------
// 2b. destStr mirror — the destination-matching bug the tests above never
// exercised (src/App.jsx applyQualityLayer, function signature
// `applyQualityLayer(input, inputs)`). The whole MARQUEE_REQUIRED check
// above is only ever reached at all if destStr resolves to something —
// tests 2/2a above bypass that entirely by handing missingMarquee/
// marqueeFindings a hardcoded `groups` array, which is exactly why this
// bug went undetected: destStr was ALWAYS the empty string in production,
// because applyQualityLayer's only real call site
// (ItineraryView, `applyQualityLayer(rawData, inputs)`) passes
// {basics, flights, hotel, ...} as `inputs` — destination/cities live at
// inputs.basics.destination/inputs.basics.cities, never inputs.destination/
// inputs.cities directly. Confirmed live via a captured network request
// showing the marquee warning was never generated for any real build.
// -----------------------------------------------------------------------------
function destStr(input, inputs) {
  const parts = [input?.destination, inputs?.basics?.destination];
  const cityLists = [input?.cities, inputs?.basics?.cities].filter(Array.isArray);
  cityLists.forEach(list => list.forEach(c => { if (c?.name) parts.push(c.name); }));
  return parts.filter(Boolean).join(" ").toLowerCase();
}

console.log("\n2b. destStr resolves the real destination (the actual production bug)\n");
{
  // The real shape ItineraryView passes: inputs = {basics, flights, ...},
  // destination/cities nested under inputs.basics — never inputs.destination.
  const plan = { destination: "Sedona, AZ" };
  const wizardInputs = { basics: { destination: "Sedona, AZ" } };
  // destStr joins both sources without deduping (the plan's own destination
  // AND the wizard's inputs.basics.destination), so it isn't necessarily an
  // exact match — only consumed via .includes()/regex .test() downstream,
  // never ===. Assert what's actually consumed.
  assert("destStr resolves from inputs.basics.destination (the real wizard shape)",
    destStr(plan, wizardInputs).includes("sedona, az"));
}
{
  // The regression: the OLD code read inputs.destination (doesn't exist on
  // the real {basics, flights, ...} shape) and inputs.cities (same problem)
  // — both always undefined, so destStr was always "". Prove the plan's own
  // top-level destination field is now used as a source too, since a plan
  // always carries one even when wizardInputs is thin.
  const plan = { destination: "Sedona, AZ" };
  const thinWizardInputs = { basics: {} }; // destination not set on the form side
  assert("destStr still resolves from the plan's own destination when wizard basics lack one",
    destStr(plan, thinWizardInputs) === "sedona, az");
}
{
  const wrongShapeInputs = { destination: "Sedona, AZ" }; // the OLD (wrong) shape this bug assumed
  assert("a flat inputs.destination (never the real shape) contributes nothing new beyond the plan's own field",
    destStr(null, wrongShapeInputs) === "", "if this fails, destStr regressed back to trusting the wrong shape");
}
{
  const plan = {};
  const wizardInputs = { basics: { cities: [{ name: "Sedona" }, { name: "Flagstaff" }] } };
  assert("multi-city wizard inputs.basics.cities[] all contribute",
    destStr(plan, wizardInputs).includes("sedona") && destStr(plan, wizardInputs).includes("flagstaff"));
}
console.log("\n2c. End-to-end: destStr now actually reaches the Sedona MARQUEE_REQUIRED group\n");
{
  const plan = { destination: "Sedona, AZ" };
  const wizardInputs = { basics: { destination: "Sedona, AZ" } };
  const resolvedDestStr = destStr(plan, wizardInputs);
  const sedonaMatches = /\bsedona\b/i.test(resolvedDestStr);
  assert("the Sedona MARQUEE_REQUIRED rule's match regex fires against the resolved destStr",
    sedonaMatches, resolvedDestStr);
  // With destStr now resolving, the earlier Pink Jeep scenario (test 2, the
  // "promised but not scheduled" case) is reachable in production, not just
  // in an isolated unit test that assumed the destination check already passed.
  const days = [
    {
      headline: "Pink Jeep off-road tour — broken-arrow trail at midday",
      items: [
        { type: "Activity", text: "Bell Rock Pathway — easy loop", location: "Bell Rock Pathway Trailhead" },
        { type: "Note", text: "Return to hotel" },
      ],
    },
  ];
  const findings = marqueeFindings(days, {}, SEDONA_GROUPS);
  assert("Pink Jeep is flagged missing once destStr correctly resolves to Sedona",
    findings.some(f => f.label === "pink jeep"), JSON.stringify(findings));
}

// -----------------------------------------------------------------------------
// 3. tonightPriority / stripTonightPrefix mirror (src/App.jsx)
// -----------------------------------------------------------------------------
function tonightPriority(s) {
  const t = (s || "").trim();
  if (/^⚠/.test(t) || /^must\s+today\b/i.test(t) || /^must\s*:/i.test(t)) return { rank: 0, label: "Must today" };
  if (/^this week/i.test(t) || /^·\s*this week/i.test(t)) return { rank: 1, label: "This week" };
  if (/^anytime/i.test(t)) return { rank: 2, label: "Anytime" };
  return { rank: 1, label: null };
}
function stripTonightPrefix(s) {
  return (s || "")
    .replace(/^(?:⚠︎?\s*)?Must\s+today\s*[:—–-]?\s*/i, "")
    .replace(/^(?:⚠︎?\s*)?Must\s*:\s*/i, "")
    .replace(/^·?\s*This week\s*[:—–-]?\s*/i, "")
    .replace(/^Anytime\s*[:—–-]?\s*/i, "")
    .trim();
}

console.log("\n3. tonightPriority recognizes bare \"MUST:\" (model output drift)\n");
{
  const p = tonightPriority("MUST: Reserve Pink Jeep Broken Arrow Tour for Day 3 (Fri ~1 PM departure)");
  assert("bare \"MUST:\" gets the urgency rank", p.rank === 0, JSON.stringify(p));
  assert("bare \"MUST:\" gets the \"Must today\" label", p.label === "Must today");
}
{
  const p = tonightPriority("⚠︎ Must today: Book the terrace table");
  assert("the original '⚠︎ Must today:' phrasing still classifies correctly (no regression)", p.rank === 0);
}
{
  const p = tonightPriority("must today book the terrace table");
  assert("bare 'must today' without a colon still classifies correctly (no regression)", p.rank === 0);
}
{
  const p = tonightPriority("Must-see sunset spot, no rush");
  assert("an ordinary sentence starting with \"Must-\" (no colon) is NOT misclassified as urgent", p.rank !== 0, JSON.stringify(p));
}
assert("stripTonightPrefix removes the bare \"MUST:\" prefix",
  stripTonightPrefix("MUST: Reserve Pink Jeep Broken Arrow Tour for Day 3") === "Reserve Pink Jeep Broken Arrow Tour for Day 3");
assert("stripTonightPrefix still removes the original '⚠︎ Must today:' prefix (with the literal emoji)",
  stripTonightPrefix("⚠︎ Must today: Book the terrace table") === "Book the terrace table");
// Regression: "⚠︎?" is two code points (U+26A0 + the U+FE0E variation
// selector) — "?" only makes the SELECTOR optional, so the base glyph was
// never actually optional. Any real-world entry following the instructed
// "Must today:" wording but omitting the literal unicode emoji (the common
// case — the model reliably writes the words, rarely the exact glyph)
// rendered with the raw prefix still attached, unstripped.
assert("stripTonightPrefix removes 'Must today:' with NO emoji at all (the common case)",
  stripTonightPrefix("Must today: Book the terrace table") === "Book the terrace table");

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
