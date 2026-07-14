// Tests for the follow-up cover helpers in src/pdf/itineraryPdf.js:
//   • formatTripMonthYear   — cover month/year subtitle (single-month,
//                             cross-month, cross-year, unparseable)
//   • buildLegacyRequestText — legacy backfill for the "Your Request" block
//                             (field-skipping, empties, nothing-to-say)
//
// Pure functions; jsPDF is only imported inside the builder, so importing the
// module here needs no DOM.
//
// TZ forced to a non-UTC zone so a month/year formatter that leaked the runtime
// timezone (instead of parsing the ISO date in UTC) would produce a wrong
// answer here rather than passing by CI-happens-to-be-UTC luck.
process.env.TZ = "America/Chicago";

import { formatTripMonthYear, buildLegacyRequestText, endSentence } from "../src/pdf/itineraryPdf.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== formatTripMonthYear (Change 1) ===");
assert("single month → 'September 2026'",
  formatTripMonthYear("2026-09-03", 7) === "September 2026",
  formatTripMonthYear("2026-09-03", 7));
assert("nights 0 stays single month",
  formatTripMonthYear("2026-09-03", 0) === "September 2026",
  formatTripMonthYear("2026-09-03", 0));
assert("last day still in month → single month",
  formatTripMonthYear("2026-09-01", 29) === "September 2026",
  formatTripMonthYear("2026-09-01", 29));
assert("cross-month same year → 'September – October 2026'",
  formatTripMonthYear("2026-09-28", 7) === "September – October 2026",
  formatTripMonthYear("2026-09-28", 7));
assert("cross-year → 'December 2026 – January 2027'",
  formatTripMonthYear("2026-12-28", 7) === "December 2026 – January 2027",
  formatTripMonthYear("2026-12-28", 7));
assert("nights as string coerces",
  formatTripMonthYear("2026-09-28", "7") === "September – October 2026",
  formatTripMonthYear("2026-09-28", "7"));
assert("timezone-safe: 2026-09-30 +0 nights stays September (not October via runtime tz)",
  formatTripMonthYear("2026-09-30", 0) === "September 2026",
  formatTripMonthYear("2026-09-30", 0));
assert("datetime ISO tolerated (leading date matched)",
  formatTripMonthYear("2026-09-03T00:00:00Z", 1) === "September 2026",
  formatTripMonthYear("2026-09-03T00:00:00Z", 1));
assert("unparseable date → null", formatTripMonthYear("Sept 3", 7) === null);
assert("empty date → null", formatTripMonthYear("", 7) === null);
assert("null date → null", formatTripMonthYear(null, 7) === null);
assert("missing nights treated as 0",
  formatTripMonthYear("2026-09-03") === "September 2026",
  String(formatTripMonthYear("2026-09-03")));

console.log("=== endSentence (RCA bug E) ===");
assert("appends '.' when unterminated", endSentence("Include Bruges Belgium") === "Include Bruges Belgium.");
assert("does NOT double a trailing period", endSentence("Include Bruges Belgium.") === "Include Bruges Belgium.");
assert("leaves a trailing '?' alone", endSentence("Any rooftop bars?") === "Any rooftop bars?");
assert("leaves a trailing '!' alone", endSentence("No red-eyes please!") === "No red-eyes please!");
assert("leaves an ASCII ellipsis alone (no 4th dot)", endSentence("and so on...") === "and so on...");
assert("leaves a unicode ellipsis alone", endSentence("and so on…") === "and so on…");
assert("trims trailing whitespace before appending", endSentence("canal view  ") === "canal view.");
assert("period followed by whitespace is treated as terminated", endSentence("Done.  ") === "Done.");
assert("empty string passes through", endSentence("") === "");
assert("whitespace-only passes through as empty", endSentence("   ") === "");
assert("null passes through as empty", endSentence(null) === "");

console.log("=== buildLegacyRequestText (Change 3) ===");
{
  // RCA bug E regression: a mustHave note that already ends in a period must
  // not render "..Belgium.." in the "Your Request" block.
  const out = buildLegacyRequestText({
    basics: { destination: "Amsterdam" },
    hotel: { mustHave: "Include Bruges Belgium." },
  });
  assert("no double period after pre-punctuated note",
    out.includes("Notes: Include Bruges Belgium.") && !out.includes("Belgium.."), out);
}
{
  // A question-mark note keeps its '?' rather than being forced to a period.
  const out = buildLegacyRequestText({ basics: {}, hotel: { mustHave: "Any tips?" } });
  assert("note keeps trailing '?'", out.includes("Notes: Any tips?") && !out.includes("tips?."), out);
}
{
  const out = buildLegacyRequestText({
    basics: { nights: 7, style: "relaxed", destination: "Amsterdam", startDate: "2026-09-03", travelers: "2 adults", pace: "easy", budget: "mid" },
    hotel: { tier: "4-star", brand: "Hoxton", mustHave: "canal view" },
  });
  assert("full lead sentence",
    out.startsWith("Plan a 7-night relaxed trip to Amsterdam starting 2026-09-03 for 2 adults."), out);
  assert("pace clause", /Pace: easy\./.test(out), out);
  assert("budget clause", /Budget: mid\./.test(out), out);
  assert("hotel clause combines tier + brand", /Hotel: 4-star Hoxton\./.test(out), out);
  assert("notes clause", /Notes: canal view\./.test(out), out);
}
{
  // Missing fields drop out cleanly — no dangling labels, no "for .".
  const out = buildLegacyRequestText({
    basics: { destination: "Bruges", nights: 3 },
    hotel: {},
  });
  assert("skips absent style/dates/travelers",
    out === "Plan a 3-night trip to Bruges.", out);
  assert("no empty Pace/Budget/Hotel/Notes", !/Pace:|Budget:|Hotel:|Notes:/.test(out), out);
  assert("no dangling 'for '", !/ for \./.test(out), out);
}
{
  // Only a hotel note — still produces a valid sentence (parts.length > 1).
  const out = buildLegacyRequestText({ basics: {}, hotel: { mustHave: "quiet room" } });
  assert("lead + notes only", out === "Plan a trip. Notes: quiet room.", out);
}
assert("nothing meaningful → empty string",
  buildLegacyRequestText({ basics: {}, hotel: {} }) === "");
assert("no inputs → empty string", buildLegacyRequestText() === "");
assert("whitespace-only fields skipped",
  buildLegacyRequestText({ basics: { destination: "   ", nights: "  " }, hotel: {} }) === "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
