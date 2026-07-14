// Tests for src/arrivalOrderCheck.js — the arrival-day ordering validator
// (bug #3b). It must flag any day where a ground / check-in / activity step is
// scheduled before the flight lands that day + a minimum connection buffer,
// and must stay silent on physically-plausible plans.
//
// TZ forced to UTC so parseClockToMinutes' ISO handling is deterministic.
process.env.TZ = "UTC";

import {
  findArrivalOrderIssues,
  assertArrivalDayOrdering,
  cascadeArrivalDayTimes,
  DEFAULT_ARRIVAL_BUFFER_MIN,
} from "../src/arrivalOrderCheck.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// The reported contradiction, corrected to the real landing time: DL70 lands
// AMS 7:15 AM, but a "train" step is scheduled 6:00 AM — before the plane is
// on the ground. This is exactly what the validator must catch.
const badPlan = {
  days: [
    {
      date: "2026-07-14",
      city: "Amsterdam",
      items: [
        { type: "Flight", flight: { to_airport: "AMS", arrive_time: "7:15 AM" } },
        { type: "Transport", text: "Train to city centre", time: "6:00 AM" },
        { type: "Hotel", text: "The Hoxton check-in", time: "8:30 AM" },
      ],
    },
  ],
};

// Same landing, but every ground step is comfortably after landing + buffer.
const goodPlan = {
  days: [
    {
      date: "2026-07-14",
      city: "Amsterdam",
      items: [
        { type: "Flight", flight: { to_airport: "AMS", arrive_time: "7:15 AM" } },
        { type: "Transport", text: "Train to city centre", time: "9:00 AM" },
        { type: "Hotel", text: "The Hoxton check-in", time: "10:30 AM" },
      ],
    },
  ],
};

console.log("=== findArrivalOrderIssues ===");
{
  const issues = findArrivalOrderIssues(badPlan);
  assert("flags the pre-landing ground step", issues.length === 1, JSON.stringify(issues));
  assert("names the offending step", /Train to city centre/.test(issues[0]?.message || ""));
  assert("names the step time", issues[0]?.stepTime === "6:00 AM");
  assert("names the landing time", issues[0]?.landingTime === "7:15 AM");
  assert("reports the buffer used", issues[0]?.bufferMin === DEFAULT_ARRIVAL_BUFFER_MIN);
}

{
  const issues = findArrivalOrderIssues(goodPlan);
  assert("clean plan → no issues", issues.length === 0, JSON.stringify(issues));
}

// A step exactly at landing (0-min gap) is still a violation (needs >= buffer).
{
  const edge = {
    days: [{
      date: "2026-07-14", city: "Amsterdam",
      items: [
        { type: "Flight", flight: { arrive_time: "7:15 AM" } },
        { type: "Activity", text: "Museum", time: "7:15 AM" },
      ],
    }],
  };
  const issues = findArrivalOrderIssues(edge);
  assert("step at exactly landing time is flagged", issues.length === 1);
}

// A step at landing + buffer exactly is allowed.
{
  const edge = {
    days: [{
      date: "2026-07-14", city: "Amsterdam",
      items: [
        { type: "Flight", flight: { arrive_time: "7:15 AM" } },
        { type: "Activity", text: "Museum", time: "8:15 AM" }, // +60
      ],
    }],
  };
  assert("step at landing+buffer is allowed", findArrivalOrderIssues(edge).length === 0);
}

console.log("=== edge cases: no false positives ===");
assert("no days → []", findArrivalOrderIssues({}).length === 0);
assert("null → []", findArrivalOrderIssues(null).length === 0);
assert(
  "day with no flight arrival → skipped",
  findArrivalOrderIssues({ days: [{ items: [{ type: "Activity", time: "6:00 AM" }] }] }).length === 0,
);
assert(
  "flight without parseable arrive_time → skipped",
  findArrivalOrderIssues({ days: [{ items: [
    { type: "Flight", flight: { arrive_time: "" } },
    { type: "Activity", time: "6:00 AM" },
  ] }] }).length === 0,
);
assert(
  "ground item without a time → skipped (not flagged)",
  findArrivalOrderIssues({ days: [{ items: [
    { type: "Flight", flight: { arrive_time: "7:15 AM" } },
    { type: "Activity", text: "Free time" },
  ] }] }).length === 0,
);

console.log("=== custom buffer ===");
{
  // 90-min buffer: a 8:30 AM step after a 7:15 AM landing (75 min) now fails.
  const plan = {
    days: [{ items: [
      { type: "Flight", flight: { arrive_time: "7:15 AM" } },
      { type: "Transport", text: "Private car", time: "8:30 AM" },
    ] }],
  };
  assert("passes at 60-min buffer", findArrivalOrderIssues(plan, { bufferMin: 60 }).length === 0);
  assert("fails at 90-min buffer", findArrivalOrderIssues(plan, { bufferMin: 90 }).length === 1);
}

console.log("=== assertArrivalDayOrdering ===");
{
  let threw = false, err = null;
  try { assertArrivalDayOrdering(badPlan); } catch (e) { threw = true; err = e; }
  assert("throws on violation", threw);
  assert("error carries code ARRIVAL_ORDER", err?.code === "ARRIVAL_ORDER");
  assert("error carries issues array", Array.isArray(err?.issues) && err.issues.length === 1);
}
{
  let threw = false;
  try { assertArrivalDayOrdering(goodPlan); } catch { threw = true; }
  assert("does not throw on clean plan", !threw);
}

console.log("=== cascadeArrivalDayTimes ===");
{
  const fixed = cascadeArrivalDayTimes(badPlan);
  assert("cascade resolves the violation", findArrivalOrderIssues(fixed).length === 0);
  const train = fixed.days[0].items[1];
  assert("cascaded step pushed to landing+buffer (8:15 AM)", train.time === "8:15 AM", train.time);
  assert("cascaded step marked _timeCascaded", train._timeCascaded === true);
  assert("does not mutate the input plan", badPlan.days[0].items[1].time === "6:00 AM");
  // A step already after the threshold is left untouched.
  assert("later step untouched", fixed.days[0].items[2].time === "8:30 AM");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
