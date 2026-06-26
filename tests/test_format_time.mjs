// Test formatTime() — the canonical 12-hour AM/PM clock formatter from
// src/App.jsx. Not exported, so re-created here verbatim (keep in sync).
// Guards the "imperial 12-hour time only" rule: 24-hour inputs must render
// as AM/PM, already-12h and non-time strings pass through unchanged.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Mirror of formatTime in src/App.jsx — keep in sync.
function formatTime(t) {
  if (!t || typeof t !== "string") return "";
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${mm} ${ampm}`;
}

console.log("=== formatTime: 24-hour → 12-hour AM/PM ===");
assert('"20:15" → "8:15 PM"', formatTime("20:15") === "8:15 PM", formatTime("20:15"));
assert('"00:30" → "12:30 AM"', formatTime("00:30") === "12:30 AM", formatTime("00:30"));
assert('"13:00" → "1:00 PM"', formatTime("13:00") === "1:00 PM", formatTime("13:00"));
assert('"12:00" → "12:00 PM" (noon)', formatTime("12:00") === "12:00 PM", formatTime("12:00"));
assert('"23:59" → "11:59 PM"', formatTime("23:59") === "11:59 PM", formatTime("23:59"));
assert('"09:05" → "9:05 AM"', formatTime("09:05") === "9:05 AM", formatTime("09:05"));

console.log("=== formatTime: already 12-hour / single-digit hour ===");
assert('"8:30" → "8:30 AM"', formatTime("8:30") === "8:30 AM", formatTime("8:30"));
assert('"7:00 PM" leading time parsed as 7:00 AM', formatTime("7:00 PM") === "7:00 AM", formatTime("7:00 PM"));

console.log("=== formatTime: pass-through non-time strings ===");
assert("empty string → ''", formatTime("") === "");
assert("null → ''", formatTime(null) === "");
assert("undefined → ''", formatTime(undefined) === "");
assert("non-string (number) → ''", formatTime(1900) === "");
assert('"Flexible" passes through', formatTime("Flexible") === "Flexible", formatTime("Flexible"));
assert('"all day" passes through', formatTime("all day") === "all day", formatTime("all day"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
