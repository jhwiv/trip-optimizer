// Tests for src/hoursParser.js — every fixture string is from real
// Google Places (New) API responses captured 2026-06-14.

import {
  parseWindow,
  parseDaySpec,
  parseWeekdayLine,
  parseWeekdayDescriptions,
  isOpenAt,
  weekdayNameFromIndex,
} from "../src/hoursParser.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

// =========================================================
// parseWindow — observed shapes
// =========================================================
console.log("\n[parseWindow — observed live shapes]");
// "4:45 – 11:00 PM": start inherits PM from end. 16:45 to 23:00.
{
  const w = parseWindow("4:45 – 11:00 PM");
  assert("Geronimo '4:45 – 11:00 PM' start = 16:45", w?.start_min === 16 * 60 + 45);
  assert("Geronimo '4:45 – 11:00 PM' end = 23:00", w?.end_min === 23 * 60);
}
// "11:00 AM – 9:00 PM": full periods on both.
{
  const w = parseWindow("11:00 AM – 9:00 PM");
  assert("Tomasita '11:00 AM – 9:00 PM' start = 11:00", w?.start_min === 11 * 60);
  assert("Tomasita end = 21:00", w?.end_min === 21 * 60);
}
// "12:00 – 2:00 PM": PM inherited; 12:00 PM = 12:00 noon.
{
  const w = parseWindow("12:00 – 2:00 PM");
  assert("Compound lunch start 12:00 PM = 12:00 noon = 720", w?.start_min === 12 * 60);
  assert("Compound lunch end 14:00", w?.end_min === 14 * 60);
}
// "5:00 – 7:30 PM": PM inherited.
{
  const w = parseWindow("5:00 – 7:30 PM");
  assert("Compound dinner start 17:00", w?.start_min === 17 * 60);
  assert("Compound dinner end 19:30", w?.end_min === 19 * 60 + 30);
}
// "8:00 AM – 3:00 PM": explicit AM and PM.
{
  const w = parseWindow("8:00 AM – 3:00 PM");
  assert("Pasqual breakfast start 08:00", w?.start_min === 8 * 60);
  assert("Pasqual breakfast end 15:00", w?.end_min === 15 * 60);
}
// "9:00 AM – 5:00 PM": Loretto Chapel.
{
  const w = parseWindow("9:00 AM – 5:00 PM");
  assert("Loretto open 09:00", w?.start_min === 9 * 60);
  assert("Loretto close 17:00", w?.end_min === 17 * 60);
}

console.log("\n[parseWindow — malformed input]");
assert("empty string → null", parseWindow("") === null);
assert("missing end period → null", parseWindow("9:00 – 5:00") === null);
assert("garbage → null", parseWindow("not a window") === null);
assert("non-string → null", parseWindow(null) === null);
assert("only one side → null", parseWindow("5:00 PM") === null);

// =========================================================
// parseDaySpec — Closed, Open 24 hours, multi-window
// =========================================================
console.log("\n[parseDaySpec]");
{
  const d = parseDaySpec("Closed");
  assert("'Closed' → closed:true", d.closed === true);
}
{
  const d = parseDaySpec("closed"); // case variation
  assert("'closed' (lowercase) → closed:true", d.closed === true);
}
{
  const d = parseDaySpec("Open 24 hours");
  assert("'Open 24 hours' → open24:true", d.open24 === true);
}
{
  const d = parseDaySpec("4:45 – 11:00 PM");
  assert("single window length 1", d.windows?.length === 1);
}
{
  const d = parseDaySpec("12:00 – 2:00 PM, 5:00 – 7:30 PM");
  assert("split shift length 2", d.windows?.length === 2);
  assert("lunch first 720→840", d.windows[0].start_min === 720 && d.windows[0].end_min === 840);
  assert("dinner second 1020→1170", d.windows[1].start_min === 1020 && d.windows[1].end_min === 1170);
}
{
  const d = parseDaySpec("8:00 AM – 3:00 PM, 5:30 – 9:30 PM");
  assert("Pasqual breakfast→dinner length 2", d.windows?.length === 2);
}
{
  const d = parseDaySpec("12:00 – 1:00 PM, 5:00 – 11:00 PM");
  assert("EMP weekend split parses", d.windows?.length === 2);
}

console.log("\n[parseDaySpec — malformed]");
assert("garbage → error", parseDaySpec("nonsense").error);
assert("empty → error", parseDaySpec("").error);

// =========================================================
// parseWeekdayLine + parseWeekdayDescriptions
// =========================================================
console.log("\n[parseWeekdayLine]");
{
  const l = parseWeekdayLine("Monday: 4:45 – 11:00 PM");
  assert("weekday: Monday", l?.weekday === "Monday");
  assert("windows present", l?.windows?.length === 1);
}
{
  const l = parseWeekdayLine("Sunday: Closed");
  assert("Sunday closed", l?.weekday === "Sunday" && l?.closed === true);
}
assert("'Notaday: 9-5' → null", parseWeekdayLine("Notaday: 9:00 AM – 5:00 PM") === null);
assert("non-string → null", parseWeekdayLine(null) === null);

console.log("\n[parseWeekdayDescriptions — real Joseph Restaurant 2026-06-14]");
{
  const joseph = parseWeekdayDescriptions([
    "Monday: Closed",
    "Tuesday: Closed",
    "Wednesday: 5:00 – 9:00 PM",
    "Thursday: 5:00 – 9:00 PM",
    "Friday: 5:00 – 9:00 PM",
    "Saturday: 5:00 – 9:00 PM",
    "Sunday: 5:00 – 9:00 PM",
  ]);
  assert("7 days parsed", Object.keys(joseph).length === 7);
  assert("Monday closed", joseph.Monday.closed === true);
  assert("Wednesday open", joseph.Wednesday.windows?.length === 1);
}

console.log("\n[parseWeekdayDescriptions — real Compound 2026-06-14]");
{
  const compound = parseWeekdayDescriptions([
    "Monday: 12:00 – 2:00 PM, 5:00 – 7:30 PM",
    "Tuesday: 12:00 – 2:00 PM, 5:00 – 7:30 PM",
    "Wednesday: 12:00 – 2:00 PM, 5:00 – 7:30 PM",
    "Thursday: 12:00 – 2:00 PM, 5:00 – 7:30 PM",
    "Friday: 12:00 – 2:00 PM, 5:00 – 8:00 PM",
    "Saturday: 12:00 – 2:00 PM, 5:00 – 8:00 PM",
    "Sunday: Closed",
  ]);
  assert("Sunday closed", compound.Sunday.closed === true);
  assert("Friday dinner ends 20:00", compound.Friday.windows[1].end_min === 20 * 60);
  assert("Monday lunch starts noon", compound.Monday.windows[0].start_min === 12 * 60);
}

// =========================================================
// isOpenAt — the actual question that matters
// =========================================================
console.log("\n[isOpenAt — Joseph Restaurant (closed Mon/Tue)]");
{
  const joseph = parseWeekdayDescriptions([
    "Monday: Closed",
    "Tuesday: Closed",
    "Wednesday: 5:00 – 9:00 PM",
    "Thursday: 5:00 – 9:00 PM",
    "Friday: 5:00 – 9:00 PM",
    "Saturday: 5:00 – 9:00 PM",
    "Sunday: 5:00 – 9:00 PM",
  ]);
  assert("Mon 19:00 → closed_all_day", isOpenAt(joseph, "Monday", "19:00").status === "closed_all_day");
  assert("Tue 19:00 → closed_all_day", isOpenAt(joseph, "Tuesday", "19:00").status === "closed_all_day");
  assert("Wed 19:00 → open", isOpenAt(joseph, "Wednesday", "19:00").status === "open");
  assert("Wed 16:00 → outside_hours (before open)", isOpenAt(joseph, "Wednesday", "16:00").status === "outside_hours");
  assert("Wed 21:30 → outside_hours (after close)", isOpenAt(joseph, "Wednesday", "21:30").status === "outside_hours");
  assert("Wed 21:00 → outside_hours (at close)", isOpenAt(joseph, "Wednesday", "21:00").status === "outside_hours");
  assert("Wed 17:00 → open (at open)", isOpenAt(joseph, "Wednesday", "17:00").status === "open");
}

console.log("\n[isOpenAt — Compound (split lunch/dinner)]");
{
  const compound = parseWeekdayDescriptions([
    "Monday: 12:00 – 2:00 PM, 5:00 – 7:30 PM",
    "Friday: 12:00 – 2:00 PM, 5:00 – 8:00 PM",
    "Sunday: Closed",
  ]);
  assert("Mon 13:00 → open (in lunch)", isOpenAt(compound, "Monday", "13:00").status === "open");
  assert("Mon 14:30 → outside_hours (between lunch and dinner)", isOpenAt(compound, "Monday", "14:30").status === "outside_hours");
  assert("Mon 19:00 → open (in dinner)", isOpenAt(compound, "Monday", "19:00").status === "open");
  assert("Mon 19:30 → outside_hours (at close)", isOpenAt(compound, "Monday", "19:30").status === "outside_hours");
  assert("Fri 19:30 → open (Fri extended to 20:00)", isOpenAt(compound, "Friday", "19:30").status === "open");
  assert("Sun 19:00 → closed_all_day", isOpenAt(compound, "Sunday", "19:00").status === "closed_all_day");
}

console.log("\n[isOpenAt — Geronimo (open every day, evening)]");
{
  const g = parseWeekdayDescriptions([
    "Monday: 4:45 – 11:00 PM",
    "Tuesday: 4:45 – 11:00 PM",
    "Wednesday: 4:45 – 11:00 PM",
    "Thursday: 4:45 – 11:00 PM",
    "Friday: 4:45 – 11:00 PM",
    "Saturday: 4:45 – 11:00 PM",
    "Sunday: 4:45 – 11:00 PM",
  ]);
  assert("Mon 19:00 → open", isOpenAt(g, "Monday", "19:00").status === "open");
  assert("Mon 12:00 → outside_hours (lunch closed)", isOpenAt(g, "Monday", "12:00").status === "outside_hours");
  assert("Mon 16:30 → outside_hours (just before open)", isOpenAt(g, "Monday", "16:30").status === "outside_hours");
  assert("Mon 16:45 → open (at open minute)", isOpenAt(g, "Monday", "16:45").status === "open");
}

console.log("\n[isOpenAt — Open 24 hours]");
{
  const h = parseWeekdayDescriptions([
    "Monday: Open 24 hours",
    "Tuesday: Open 24 hours",
  ]);
  assert("Mon 03:00 → open24", isOpenAt(h, "Monday", "03:00").status === "open24");
  assert("Tue 14:00 → open24", isOpenAt(h, "Tuesday", "14:00").status === "open24");
}

console.log("\n[isOpenAt — midnight-crossing window (defensive)]");
{
  // Synthetic: "5:00 PM – 1:00 AM" → start_min 1020, end_min 60.
  // We treat the same-day side [start, 24:00) as open.
  const bar = {
    Friday: { weekday: "Friday", windows: [{ start_min: 17 * 60, end_min: 1 * 60 }] },
  };
  assert("Fri 23:00 → open (same-day late side)", isOpenAt(bar, "Friday", "23:00").status === "open");
  assert("Fri 12:00 → outside_hours (before open)", isOpenAt(bar, "Friday", "12:00").status === "outside_hours");
}

console.log("\n[isOpenAt — defensive cases]");
assert("missing weekday → unknown", isOpenAt({}, "Monday", "19:00").status === "unknown");
assert("null hours → unknown", isOpenAt(null, "Monday", "19:00").status === "unknown");
assert("bad time → unknown", isOpenAt({Monday:{weekday:"Monday",windows:[{start_min:0,end_min:60}]}}, "Monday", "garbage").status === "unknown");
{
  // No time supplied + day has windows: best we can do is "open".
  const r = isOpenAt({Monday:{weekday:"Monday",windows:[{start_min:0,end_min:60}]}}, "Monday", null);
  assert("no time, day has windows → open (best guess)", r.status === "open");
}

console.log("\n[weekdayNameFromIndex]");
assert("0 → Sunday", weekdayNameFromIndex(0) === "Sunday");
assert("3 → Wednesday", weekdayNameFromIndex(3) === "Wednesday");
assert("7 → null", weekdayNameFromIndex(7) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
