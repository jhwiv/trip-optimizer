// Tests for quality-layer fixes found auditing two reported Sedona builds
// (2026-08-03): Elote Cafe listed twice on Day 3; the Pink Jeep Broken
// Arrow tour promised in the day's headline but never scheduled as an
// item; the "MUST:" tonight entries for both silently losing their
// urgency badge; a later build repeating "Sunset at Airport Mesa overlook"
// as two identical Activity items; that same build's Day 1 missing a
// dinner entirely; and a stray "Mariposa" restaurant reference in
// Tonight/Flags that never appears anywhere in the actual itinerary.
//
// applyQualityLayer and tonightPriority/stripTonightPrefix are closures
// inside src/App.jsx and can't be imported directly here (jsdom-free tests),
// so — following the convention in test_day_completeness_and_city_normalization.mjs —
// each fix's pure logic is mirrored locally and tested against that mirror.
// Keep these mirrors in sync if the App.jsx implementations change shape.

import { activityName } from "../src/placesVerify.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// -----------------------------------------------------------------------------
// 1. Same-day duplicate-venue dedupe mirror (src/App.jsx applyQualityLayer §1)
//    Covers BOTH restaurants and activities — a generation duplication bug
//    confirmed systemic across both venue kinds (Elote Cafe as two Dinners;
//    "Sunset at Airport Mesa overlook" as two identical 5:30 PM Activities).
// -----------------------------------------------------------------------------
function dedupeVenues(days) {
  const fixes = [];
  const seen = new Map(); // `${kind}|${name}` → { dayIndex, subType }
  days.forEach((day, dayIdx) => {
    if (!Array.isArray(day.items)) return;
    const seenTodayByKey = new Map();
    const dupFlags = [];
    day.items = day.items.filter(item => {
      const type = item.type || "";
      const isMeal = /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(type);
      let kind, name, subType;
      if (isMeal && item.restaurant?.name) {
        kind = "restaurant";
        name = item.restaurant.name;
        subType = type.toLowerCase();
      } else if (type === "Activity") {
        const cleanName = activityName(item.text);
        if (!cleanName) return true;
        kind = "activity";
        name = cleanName;
        subType = item.time || "unspecified";
      } else {
        return true;
      }
      const dedupeKey = `${kind}|${name.trim().toLowerCase()}`;
      const todaySubTypes = seenTodayByKey.get(dedupeKey);
      if (todaySubTypes?.has(subType)) {
        fixes.push(`Day ${dayIdx + 1}: removed duplicate ${name} entry (${type})`);
        dupFlags.push({ code: "DUPLICATE_VENUE_SAME_DAY", severity: "warn", dayIdx, day: dayIdx + 1, target: name });
        return false;
      }
      if (todaySubTypes) todaySubTypes.add(subType);
      else seenTodayByKey.set(dedupeKey, new Set([subType]));

      const prior = seen.get(dedupeKey);
      if (prior && prior.dayIndex !== dayIdx) {
        const target = kind === "restaurant" ? item.restaurant : item;
        target._isReturnVisit = true;
        fixes.push(`Annotated repeat: ${name} (Day ${dayIdx + 1}) — first on Day ${prior.dayIndex + 1}`);
      } else if (!prior) {
        seen.set(dedupeKey, { dayIndex: dayIdx, subType });
      }
      return true;
    });
    if (dupFlags.length > 0) {
      day.structural_flags = [...(day.structural_flags || []), ...dupFlags];
    }
  });
  return { days, fixes };
}

console.log("\n1. Same-day duplicate-venue dedupe — restaurants\n");
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
  const { days: out, fixes } = dedupeVenues(days);
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
  const { days: out } = dedupeVenues(days);
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
  const { days: out } = dedupeVenues(days);
  assert("same restaurant, different meal types, same day — both items survive", out[0].items.length === 2);
  // Regression (peer-review finding, 2026-08-03): the "seen" map used for
  // cross-day return-visit annotation was keyed only by name, with no check
  // that the prior sighting was on an EARLIER day — so the Dinner item here
  // got mislabeled "Return visit — first appeared Day 1 (lunch)" referring
  // to the SAME day, which is nonsensical (it isn't a return visit from
  // itself). Same-day/different-meal-type must get no annotation at all.
  assert("...and the second (Dinner) item is NOT mislabeled as a same-day \"return visit\"",
    out[0].items[1].restaurant._isReturnVisit !== true, JSON.stringify(out[0].items[1].restaurant));
}
{
  // A genuine cross-day return visit must still be annotated correctly even
  // when the first sighting was a DIFFERENT meal type than the second.
  const days = [
    { items: [{ type: "Lunch", time: "12:00", restaurant: { name: "The Hudson" } }] },
    { items: [{ type: "Dinner", time: "19:00", restaurant: { name: "The Hudson" } }] },
  ];
  const { days: out } = dedupeVenues(days);
  assert("a cross-day return visit (different meal type) is still annotated",
    out[1].items[0].restaurant._isReturnVisit === true);
}

console.log("\n1b. Same-day duplicate-venue dedupe — activities (the Airport Mesa gap)\n");
{
  // The exact reported shape: "Sunset at Airport Mesa overlook" scheduled
  // twice back-to-back, both at 5:30 PM on Day 1, near-identical text.
  const days = [
    {
      items: [
        { type: "Hotel", time: "13:30", text: "Check in" },
        { type: "Activity", time: "17:30", text: "Sunset at Airport Mesa overlook — Sedona's 360° signature view", why: "The single best payoff-to-effort panorama in town." },
        { type: "Activity", time: "17:30", text: "Sunset at Airport Mesa overlook — Sedona's 360° signature view", why: "The single best payoff-to-effort panorama in town." },
      ],
    },
  ];
  const { days: out, fixes } = dedupeVenues(days);
  assert("the duplicate Activity item is removed", out[0].items.length === 2, `got ${out[0].items.length}`);
  assert("a fix is logged naming the activity", fixes.some(f => /removed duplicate Sunset at Airport Mesa/i.test(f)), fixes.join(" | "));
  assert("a DUPLICATE_VENUE_SAME_DAY flag is attached", out[0].structural_flags?.[0]?.code === "DUPLICATE_VENUE_SAME_DAY");
}
{
  // Same activity, same day, DIFFERENT times (sunrise then sunset at the
  // same overlook) is a legitimate itinerary choice, not the bug — both
  // items must survive, mirroring how a restaurant can appear at lunch AND
  // dinner on the same day.
  const days = [
    {
      items: [
        { type: "Activity", time: "06:30", text: "Airport Mesa overlook — sunrise" },
        { type: "Activity", time: "17:30", text: "Airport Mesa overlook — sunset" },
      ],
    },
  ];
  const { days: out } = dedupeVenues(days);
  assert("same activity venue, different times, same day — both items survive", out[0].items.length === 2);
}
{
  // A genuine cross-day return visit to the same activity venue must be
  // annotated (via item.why, since Activities have no nested object), not removed.
  const days = [
    { items: [{ type: "Activity", time: "17:30", text: "Airport Mesa overlook — sunset" }] },
    { items: [{ type: "Activity", time: "06:30", text: "Airport Mesa overlook — sunrise" }] },
  ];
  const { days: out } = dedupeVenues(days);
  assert("a return visit to the same activity venue on a LATER day is kept, not removed", out[1].items.length === 1);
  assert("the later day's item is annotated as a return visit via item.why", out[1].items[0]._isReturnVisit === true);
}
{
  // An Activity with no text (or no dash-extractable name) must not be
  // force-deduped against anything — conservative default.
  const days = [
    { items: [{ type: "Activity", time: "10:00", text: "" }, { type: "Activity", time: "11:00", text: "" }] },
  ];
  const { days: out } = dedupeVenues(days);
  assert("Activities with empty text are left alone, not treated as duplicates of each other", out[0].items.length === 2);
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
// 2d. buildCityHaystack / verifyCityHint mirror (src/App.jsx applyQualityLayer
// §2.4 closure gate + §2.5 Maps-URL backfill) — the identical input/inputs
// mixup as destStr above, found 2026-08-04 auditing for exactly this bug
// class after fixing it once already. buildCityHaystack(inputs) was called
// with the wizard's plural form state (no top-level destination/cities —
// those live at inputs.basics.*), so it always returned "" and the
// `if (Array.isArray(days) && cityHaystack)` guard around the ENTIRE closure
// gate ("the actual fix for the Husk Greenville incident" — stripping
// restaurants on the CLOSED_RESTAURANTS denylist) was always false. Same
// mixup, same silent-disable pattern, different feature.
// -----------------------------------------------------------------------------
function buildCityHaystack(input, inputs) {
  const parts = [];
  if (input?.destination) parts.push(String(input.destination));
  if (inputs?.basics?.destination) parts.push(String(inputs.basics.destination));
  const cityLists = [input?.cities, inputs?.basics?.cities].filter(Array.isArray);
  cityLists.forEach(list => list.forEach(c => { if (c?.name) parts.push(String(c.name)); }));
  return parts.join(" ").toLowerCase();
}

console.log("\n2d. buildCityHaystack resolves the real destination (closure gate no longer silently disabled)\n");
{
  const plan = { destination: "Greenville, SC" };
  const wizardInputs = { basics: { destination: "Greenville, SC" } };
  assert("buildCityHaystack resolves from the real wizard shape (inputs.basics.destination)",
    buildCityHaystack(plan, wizardInputs).includes("greenville, sc"));
}
{
  // Regression: the OLD code read inputs.destination/inputs.cities directly
  // (never exist on the real {basics, flights, ...} shape) — always "".
  // Prove the plan's own destination alone is enough even with thin wizard inputs.
  const plan = { destination: "Greenville, SC" };
  const thinWizardInputs = { basics: {} };
  assert("buildCityHaystack still resolves from the plan's own destination when wizard basics lack one",
    buildCityHaystack(plan, thinWizardInputs) === "greenville, sc");
}
{
  const wrongShapeInputs = { destination: "Greenville, SC" }; // the OLD (wrong) shape this bug assumed
  assert("a flat inputs.destination (never the real shape) contributes nothing new beyond the plan's own field",
    buildCityHaystack(null, wrongShapeInputs) === "",
    "if this fails, buildCityHaystack regressed back to trusting the wrong shape");
}
{
  // End-to-end: the closure gate's own guard (`if (cityHaystack)`) must now
  // actually be reachable with the real call-site shape, not just in a unit
  // test that hands the check a hardcoded non-empty haystack.
  const plan = { destination: "Greenville, SC" };
  const wizardInputs = { basics: { destination: "Greenville, SC" } };
  const cityHaystack = buildCityHaystack(plan, wizardInputs);
  assert("the closure-gate guard `if (cityHaystack)` is truthy with the real production call shape",
    !!cityHaystack, JSON.stringify(cityHaystack));
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

// -----------------------------------------------------------------------------
// 4. Missing-dinner check mirror (src/App.jsx applyQualityLayer, day-
// completeness section). Real observed case: a 2026-08-03 Sedona build's
// Day 1 ended its sunset activity at 7 PM and the day just stopped there —
// no dinner anywhere that evening, while every other day of the trip had
// one. Dinner (unlike Breakfast/Lunch) has no opt-in/opt-out mechanism —
// see src/mealPolicy.js — so it's expected every day except the last.
// -----------------------------------------------------------------------------
function findMissingDinnerDays(days) {
  const DINNER_TYPES = /^(Dinner|Dining)$/i;
  const warnings = [];
  days.forEach((day, dayIdx) => {
    if (dayIdx === days.length - 1) return;
    const items = Array.isArray(day?.items) ? day.items : [];
    const hasDinner = items.some(it => DINNER_TYPES.test(String(it?.type || "")));
    if (!hasDinner) warnings.push(`Day ${dayIdx + 1} has no dinner scheduled — every other day normally has one; confirm this is intentional`);
  });
  return warnings;
}

console.log("\n4. Missing-dinner check\n");
{
  // The exact reported shape: Day 1 has a hotel check-in and a sunset
  // activity, but no dinner; Days 2-3 both have one; Day 4 is the last day
  // (departure) and is exempt.
  const days = [
    { items: [{ type: "Hotel", time: "13:30" }, { type: "Activity", time: "17:30", text: "Sunset" }] },
    { items: [{ type: "Dinner", time: "19:00", restaurant: { name: "Mariposa" } }] },
    { items: [{ type: "Dinner", time: "19:00", restaurant: { name: "Reds Restaurant" } }] },
    { items: [{ type: "Flight", time: "15:30" }] },
  ];
  const warnings = findMissingDinnerDays(days);
  assert("Day 1 (missing dinner) is flagged", warnings.some(w => /^Day 1 has no dinner/.test(w)), JSON.stringify(warnings));
  assert("Day 2 (has dinner) is NOT flagged", !warnings.some(w => /^Day 2/.test(w)));
  assert("Day 3 (has dinner) is NOT flagged", !warnings.some(w => /^Day 3/.test(w)));
  assert("Day 4, the LAST day (departure, no dinner), is exempt — not flagged",
    !warnings.some(w => /^Day 4/.test(w)));
  assert("exactly one warning total", warnings.length === 1, JSON.stringify(warnings));
}
{
  const days = [{ items: [{ type: "Dinner", time: "19:00", restaurant: { name: "X" } }] }];
  assert("a single-day trip (the only day is also the last day) is exempt", findMissingDinnerDays(days).length === 0);
}
{
  assert("an empty days array produces no warnings", findMissingDinnerDays([]).length === 0);
}

// -----------------------------------------------------------------------------
// 5. Stray booking-reference check mirror (src/App.jsx applyQualityLayer
// §2.7). Real observed case: a 2026-08-03 Sedona build's Trip Reference
// said "This week: Book remaining restaurants — Mariposa (Day 1), Reds
// (Day 3) — all on OpenTable or via phone" — but "Mariposa" never appears
// as a restaurant anywhere in days[] (a leftover cross-draft reference;
// Reds does appear, as "Reds Restaurant", a superstring match).
// -----------------------------------------------------------------------------
function findStrayBookingReferences(days, input) {
  const allRestaurantNames = [];
  days.forEach(d => (d.items || []).forEach(it => {
    if (it?.restaurant?.name) allRestaurantNames.push(it.restaurant.name.trim().toLowerCase());
    if (it?.restaurant?.backup?.name) allRestaurantNames.push(it.restaurant.backup.name.trim().toLowerCase());
  }));
  const NAME_WORD = "(?:&|[A-Za-z0-9][A-Za-z0-9&’'.-]*)";
  const NAME_PATTERN = `[A-Z][A-Za-z0-9&’'.-]*(?:\\s+${NAME_WORD}){0,4}`;
  const forDayRe = new RegExp(`\\b(?:Book|Reserve)\\s+(${NAME_PATTERN})\\s+for\\s+Day\\s*\\d+`, "gi");
  const parenDayRe = new RegExp(`(${NAME_PATTERN})\\s*\\(Day\\s*\\d+\\)`, "g");
  const seenReminders = new Set();
  const warnings = [];
  const reminderSources = [
    ...(Array.isArray(input.tonight) ? input.tonight : []),
    ...(Array.isArray(input.flags) ? input.flags : []),
  ];
  reminderSources.forEach(text => {
    if (typeof text !== "string" || !/\b(book|reserve)\b/i.test(text)) return;
    const names = [];
    let m;
    forDayRe.lastIndex = 0;
    while ((m = forDayRe.exec(text))) names.push(m[1].trim());
    parenDayRe.lastIndex = 0;
    while ((m = parenDayRe.exec(text))) names.push(m[1].trim());
    names.forEach(name => {
      const key = name.toLowerCase();
      if (seenReminders.has(key)) return;
      seenReminders.add(key);
      const found = allRestaurantNames.some(rn => rn.includes(key) || key.includes(rn));
      if (!found) warnings.push(`"${name}" is named in Tonight/Flags as a restaurant to book, but no restaurant by that name appears anywhere in the itinerary — confirm this booking was actually scheduled.`);
    });
  });
  return warnings;
}

console.log("\n5. Stray booking-reference check\n");
{
  const days = [
    { items: [{ type: "Note" }] },
    { items: [{ type: "Dinner", restaurant: { name: "Reds Restaurant" } }] },
  ];
  const input = { tonight: ["This week: Book remaining restaurants — Mariposa (Day 1), Reds (Day 3) — all on OpenTable or via phone"] };
  const warnings = findStrayBookingReferences(days, input);
  assert("Mariposa (never scheduled anywhere) is flagged as a stray reference",
    warnings.some(w => /"Mariposa"/.test(w)), JSON.stringify(warnings));
  assert("Reds (matches \"Reds Restaurant\" by substring) is NOT flagged",
    !warnings.some(w => /"Reds"/.test(w)), JSON.stringify(warnings));
}
{
  // "Book X for Day N" citation shape (draft 1's format, distinct from the
  // "X (Day N)" list shape above).
  const days = [{ items: [{ type: "Dinner", restaurant: { name: "Dahl & Di Luca" } }] }];
  const input = { tonight: ["MUST: Book Dahl & Di Luca for Day 2 (Thu dinner) — call ahead, no online reservations"] };
  const warnings = findStrayBookingReferences(days, input);
  assert("a scheduled restaurant cited via the \"Book X for Day N\" shape is NOT flagged",
    warnings.length === 0, JSON.stringify(warnings));
}
{
  // No "book"/"reserve" verb at all — must not fire on an unrelated "(Day N)"
  // mention (e.g. a pacing note), which is not a booking reminder.
  const days = [{ items: [] }];
  const input = { flags: ["Cathedral Rock parking fills by 8 AM (Day 2) — arrive early"] };
  assert("a non-booking '(Day N)' mention does not fire at all", findStrayBookingReferences(days, input).length === 0);
}
{
  assert("no tonight/flags at all produces no warnings", findStrayBookingReferences([{ items: [] }], {}).length === 0);
}
{
  // Regression: found live, not in the original unit test — the real model
  // output uses an em-dash for this kind of list separator ("— Mariposa
  // (Day 1)"), which the original character class correctly excluded. A
  // plain hyphen (" - Mariposa (Day 1)") IS in that class, though, so a
  // bare "-" got swallowed into the name capture as if it were part of it
  // ("Book remaining restaurants - Mariposa" instead of "Mariposa"),
  // silently breaking the whole check for this phrasing. NAME_WORD now
  // excludes a bare hyphen as its own "word" while still allowing hyphens
  // attached within a real word and a bare "&" for compound names.
  const days = [
    { items: [{ type: "Note" }] },
    { items: [{ type: "Dinner", restaurant: { name: "Reds Restaurant" } }] },
  ];
  const input = { tonight: ["This week: Book remaining restaurants - Mariposa (Day 1), Reds (Day 3) - all on OpenTable or via phone"] };
  const warnings = findStrayBookingReferences(days, input);
  assert("a plain-hyphen list separator still extracts just \"Mariposa\", not \"Book remaining restaurants - Mariposa\"",
    warnings.some(w => /^"Mariposa" is named/.test(w)), JSON.stringify(warnings));
  assert("Reds is still correctly NOT flagged with the plain-hyphen phrasing",
    !warnings.some(w => /"Reds"/.test(w)), JSON.stringify(warnings));
}

// -----------------------------------------------------------------------------
// KNOWN_NONSTOPS carrier-correction — flight_number clearing (2026-08-07
// regression, src/App.jsx applyQualityLayer §2c). Mirrors the minimal shape
// of that step: given a route in KNOWN_NONSTOPS and a carrier that doesn't
// fly it nonstop, rewrite the carrier AND clear any carrier-specific flight
// number the model wrote for the old (wrong) carrier. Real observed case:
// "LO 15" (a LOT flight number) survived the earlier universal strip
// untouched (it had passed that step's own, unrelated verification), then
// this step correctly rewrote the carrier to United/BA/Virgin Atlantic (LOT
// doesn't fly EWR-LHR nonstop) but left "LO 15" attached — a LOT-numbered
// flight labeled "Book directly with United."
// -----------------------------------------------------------------------------
const KNOWN_NONSTOPS_MIRROR = {
  "EWR-LHR": ["United", "British Airways", "Virgin Atlantic"],
};
function routeKeyMirror(a, b) {
  if (!a || !b) return null;
  const x = String(a).toUpperCase().trim();
  const y = String(b).toUpperCase().trim();
  if (x === y) return null;
  return [x, y].sort().join("-");
}
function carrierMatchesKnownMirror(carrier, knownList) {
  if (!carrier || !Array.isArray(knownList)) return false;
  const c = carrier.toLowerCase();
  return knownList.some(k => c.includes(k.toLowerCase()) || k.toLowerCase().includes(c));
}
function correctKnownNonstopCarrier(f) {
  if (f.nonstop === false) return f;
  const key = routeKeyMirror(f.from_airport, f.to_airport);
  const known = key && KNOWN_NONSTOPS_MIRROR[key];
  if (!known || carrierMatchesKnownMirror(f.carrier, known)) return f;
  const allCorrect = known.slice(0, 3);
  f._originalCarrier = f.carrier;
  f.carrier = allCorrect.length > 1 ? allCorrect.join(" or ") : allCorrect[0];
  f._carrierOverride = true;
  if (f.flight_number) {
    f._originalFlightNumber = f.flight_number;
    f.flight_number = null;
  }
  delete f._scheduleVerified;
  f._flightUnverified = true;
  return f;
}
{
  const flight = {
    from_airport: "EWR", to_airport: "LHR", nonstop: true,
    carrier: "LOT", flight_number: "LO 15", _scheduleVerified: true,
  };
  const corrected = correctKnownNonstopCarrier(flight);
  assert("carrier is rewritten to the known nonstop operators",
    corrected.carrier === "United or British Airways or Virgin Atlantic", corrected.carrier);
  assert("the LOT-specific flight number is cleared, not left attached to the new carrier",
    corrected.flight_number === null, String(corrected.flight_number));
  assert("the original flight number is preserved for audit",
    corrected._originalFlightNumber === "LO 15", String(corrected._originalFlightNumber));
  assert("_scheduleVerified is removed — the old number's verification no longer applies",
    corrected._scheduleVerified === undefined);
  assert("_flightUnverified is set so downstream UI doesn't present a verified-looking number",
    corrected._flightUnverified === true);
}
{
  // A carrier that DOES fly the route nonstop must be left completely alone,
  // flight number included — this step only touches genuine mismatches.
  const flight = {
    from_airport: "EWR", to_airport: "LHR", nonstop: true,
    carrier: "United", flight_number: "UA 12", _scheduleVerified: true,
  };
  const result = correctKnownNonstopCarrier(flight);
  assert("a correct carrier is not rewritten", result.carrier === "United");
  assert("a correct carrier's flight number is untouched", result.flight_number === "UA 12");
  assert("a correct carrier's _scheduleVerified is untouched", result._scheduleVerified === true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
