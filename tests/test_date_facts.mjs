// Tests for src/dateFacts.js — anchored against KNOWN dates so the
// weekday computation can never silently regress.
//
// Anchors:
//   Aug 25 2027 = Wednesday
//   Sep  5 2027 = Sunday
//   Jun  3 2027 = Thursday
//
// These are the exact dates that surfaced the original bug (model
// rendered Aug 25 2027 as Monday). If any of these change, this suite
// fails loud.

import {
  parseISODate,
  weekdayOf,
  addDays,
  shortStamp,
  buildDateTable,
} from "../src/dateFacts.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("\n[parseISODate]");
assert("good ISO date", JSON.stringify(parseISODate("2027-08-25")) === '{"y":2027,"m":8,"d":25}');
assert("ISO with time suffix accepted", parseISODate("2027-08-25T00:00:00Z")?.d === 25);
assert("bad string null", parseISODate("not a date") === null);
assert("non-string null", parseISODate(null) === null);
assert("month 13 rejected", parseISODate("2027-13-01") === null);
assert("day 0 rejected", parseISODate("2027-08-00") === null);

console.log("\n[weekdayOf — anchor dates from the spec]");
assert("Aug 25 2027 = Wednesday (spec anchor)", weekdayOf("2027-08-25") === "Wednesday");
assert("Sep 5 2027 = Sunday (spec anchor)", weekdayOf("2027-09-05") === "Sunday");
assert("Jun 3 2027 = Thursday", weekdayOf("2027-06-03") === "Thursday");
assert("Jan 1 2024 = Monday", weekdayOf("2024-01-01") === "Monday");
assert("short form", weekdayOf("2027-08-25", { short: true }) === "Wed");
assert("bad input → empty", weekdayOf("nope") === "");

console.log("\n[addDays]");
assert("addDays +1 within month", addDays("2027-08-25", 1) === "2027-08-26");
assert("addDays +7 spans week", addDays("2027-08-25", 7) === "2027-09-01");
assert("addDays across month boundary", addDays("2027-08-31", 1) === "2027-09-01");
assert("addDays across year boundary", addDays("2027-12-31", 1) === "2028-01-01");
assert("addDays 0 is identity", addDays("2027-08-25", 0) === "2027-08-25");
assert("addDays negative", addDays("2027-08-25", -1) === "2027-08-24");
assert("addDays bad input", addDays("nope", 5) === "");

console.log("\n[shortStamp]");
assert("Aug 25 2027 → 'Wed Aug 25'", shortStamp("2027-08-25") === "Wed Aug 25");
assert("Sep 5 2027 → 'Sun Sep 5'", shortStamp("2027-09-05") === "Sun Sep 5");
assert("Jan 1 2027 → 'Fri Jan 1'", shortStamp("2027-01-01") === "Fri Jan 1");

console.log("\n[buildDateTable]");
{
  const table = buildDateTable("2027-08-25", 4);
  const expected = [
    "COMPUTED DATE TABLE (use these verbatim — do not recompute, do not guess weekdays):",
    "Day 1 — Wed Aug 25, 2027",
    "Day 2 — Thu Aug 26, 2027",
    "Day 3 — Fri Aug 27, 2027",
    "Day 4 — Sat Aug 28, 2027",
  ].join("\n");
  assert("4-day table from Aug 25 2027", table === expected, table);
}
{
  const table = buildDateTable("2027-09-03", 4);
  // Day 3 must be Sunday Sep 5 (anchor)
  assert("table contains 'Sun Sep 5, 2027'", table.includes("Day 3 — Sun Sep 5, 2027"));
}
assert("bad start ISO → empty", buildDateTable("not-a-date", 5) === "");
assert("0 total days → empty", buildDateTable("2027-08-25", 0) === "");
assert("non-integer total days → empty", buildDateTable("2027-08-25", 3.5) === "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
