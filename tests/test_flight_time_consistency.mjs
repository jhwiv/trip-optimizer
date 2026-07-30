// Tests for src/flightTimeConsistency.js (report bug 4, validator V4) and the
// propagation that makes it unnecessary.
//
// The 2026-07-28 build shipped Day 1 headed "9:30 AM · FLIGHT" above a row
// reading "UA934 EWR 8:20 AM → LHR 8:40 PM". The maintainer's convention is
// item.time == flight.depart_time, always — there is no "leave for the
// airport" meaning in the header.
//
// The real fix is withFlightMerge() propagating depart_time back to the parent
// item whenever the resolver writes it. This validator is the safety belt, so
// the interesting assertion is the last block: it must fire when propagation
// is skipped, and stay silent when propagation ran.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeClock, clocksAgree, findFlightTimeMismatches } from "../src/flightTimeConsistency.js";
import { withFlightMerge } from "../src/flightResolver.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== normalizeClock ===");
{
  assert("24h passes through", normalizeClock("08:45") === "08:45");
  assert("single-digit hour is padded", normalizeClock("8:45") === "08:45");
  assert("AM is parsed", normalizeClock("8:20 AM") === "08:20");
  assert("PM shifts by 12", normalizeClock("8:40 PM") === "20:40");
  assert("12 AM is midnight", normalizeClock("12:05 AM") === "00:05");
  assert("12 PM is noon", normalizeClock("12:05 PM") === "12:05");
  assert("lowercase meridiem works", normalizeClock("2:00 pm") === "14:00");
  assert("no space before meridiem works", normalizeClock("2:00pm") === "14:00");
  assert("ISO timestamps are accepted", normalizeClock("2026-10-01T08:45:00Z") === "08:45");
  assert("ISO with a space separator works", normalizeClock("2026-10-01 08:45") === "08:45");

  assert("null → null", normalizeClock(null) === null);
  assert("undefined → null", normalizeClock(undefined) === null);
  assert("empty string → null", normalizeClock("   ") === null);
  assert("prose → null", normalizeClock("mid-morning") === null);
  assert("hour out of range → null", normalizeClock("25:00") === null);
  assert("minute out of range → null", normalizeClock("10:75") === null);
  assert("trailing junk → null", normalizeClock("08:45 (local)") === null);
}

console.log("\n=== clocksAgree ===");
{
  assert("identical clocks agree", clocksAgree("08:20", "08:20"));
  assert("same instant in two formats agrees", clocksAgree("8:20 AM", "08:20"));
  assert("different clocks disagree", !clocksAgree("09:30", "08:20"));
  // Unparseable is not a contradiction — we only flag decidable conflicts.
  assert("unparseable left side is not a mismatch", clocksAgree("mid-morning", "08:20"));
  assert("unparseable right side is not a mismatch", clocksAgree("08:20", ""));
}

console.log("\n=== findFlightTimeMismatches ===");
{
  const plan = {
    days: [
      {
        day: 1,
        items: [
          {
            type: "Flight",
            time: "09:30",
            text: "Fly to London",
            flight: { carrier: "United", flight_number: "UA934", from_airport: "EWR", to_airport: "LHR", depart_time: "08:20", arrive_time: "20:40" },
          },
        ],
      },
    ],
  };
  const [hit, ...rest] = findFlightTimeMismatches(plan);
  assert("the mismatch is found", !!hit && rest.length === 0, JSON.stringify(findFlightTimeMismatches(plan)));
  assert("code is FLIGHT_TIME_MISMATCH", hit?.code === "FLIGHT_TIME_MISMATCH");
  assert("severity is block", hit?.severity === "block");
  assert("dayIdx is 0-based", hit?.dayIdx === 0);
  assert("day is 1-based and numeric — applyQualityLayer prefixes it with 'Day '",
    hit?.day === 1, JSON.stringify(hit?.day));
  assert("itemIdx points at the flight", hit?.itemIdx === 0);
  assert("target names the flight", hit?.target === "United UA934", hit?.target);
  assert("message quotes both clocks",
    /09:30/.test(hit?.message || "") && /08:20/.test(hit?.message || ""), hit?.message);

  const agreeing = structuredClone(plan);
  agreeing.days[0].time = undefined;
  agreeing.days[0].items[0].time = "08:20";
  assert("an agreeing pair is silent", findFlightTimeMismatches(agreeing).length === 0);

  const mixedFormat = structuredClone(plan);
  mixedFormat.days[0].items[0].time = "8:20 AM";
  assert("12h header vs 24h depart_time is not a mismatch",
    findFlightTimeMismatches(mixedFormat).length === 0, JSON.stringify(findFlightTimeMismatches(mixedFormat)));

  const noDepart = structuredClone(plan);
  delete noDepart.days[0].items[0].flight.depart_time;
  assert("a missing depart_time is skipped, not flagged",
    findFlightTimeMismatches(noDepart).length === 0);

  const notAFlight = structuredClone(plan);
  notAFlight.days[0].items[0].type = "Transport";
  assert("only Flight items are checked", findFlightTimeMismatches(notAFlight).length === 0);

  assert("the clean fixture is silent",
    findFlightTimeMismatches(fixture("plan_linear_clean.json")).length === 0);
  assert("null plan → []", findFlightTimeMismatches(null).length === 0);
  assert("days with null entries survive", findFlightTimeMismatches({ days: [null] }).length === 0);
}

console.log("\n=== the fix: withFlightMerge propagates, the validator stays quiet ===");
{
  const item = { type: "Flight", time: "09:30", text: "Fly to London", flight: { flight_number: "UA934" } };
  const merge = { depart_time: "08:20", arrive_time: "20:40", from_airport: "EWR", to_airport: "LHR" };

  const merged = withFlightMerge(item, merge);
  assert("header follows the resolved departure", merged.time === "08:20", merged.time);
  assert("the flight object is merged, not replaced", merged.flight.flight_number === "UA934");
  assert("the original item is not mutated", item.time === "09:30");
  assert("a propagated item produces no finding",
    findFlightTimeMismatches({ days: [{ items: [merged] }] }).length === 0);

  // Same merge with propagation disabled — this is what a regression looks
  // like, and the validator must catch it.
  const unpropagated = { ...item, flight: { ...item.flight, ...merge } };
  assert("skipping propagation trips the validator",
    findFlightTimeMismatches({ days: [{ items: [unpropagated] }] }).length === 1);

  const pmMerge = withFlightMerge(item, { depart_time: "2:00 PM" });
  assert("a 12h resolver time is normalized into the header", pmMerge.time === "14:00", pmMerge.time);

  const noTime = withFlightMerge(item, { arrive_time: "20:40" });
  assert("a merge without depart_time leaves the header alone", noTime.time === "09:30");
  const junkTime = withFlightMerge(item, { depart_time: "mid-morning" });
  assert("an unparseable departure never overwrites the header", junkTime.time === "09:30");
  assert("null item passes through", withFlightMerge(null, merge) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
