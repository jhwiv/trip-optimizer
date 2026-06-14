// Tests for src/pacingCheck.js -- pure logic, no fetch.

import {
  collectPacingPairs,
  applyPacingFlags,
  _internals,
} from "../src/pacingCheck.js";

const { pickMode, parseTimeMin, inferDurationMin, itemCoords } = _internals;

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

// =========================================================
// Internal helpers
// =========================================================
console.log("\n[parseTimeMin]");
assert("19:00 -> 1140", parseTimeMin("19:00") === 19 * 60);
assert("08:30 -> 510", parseTimeMin("08:30") === 510);
assert("9:00 -> 540 (no leading zero)", parseTimeMin("9:00") === 540);
assert("garbage -> null", parseTimeMin("nope") === null);
assert("25:00 -> null", parseTimeMin("25:00") === null);
assert("non-string -> null", parseTimeMin(null) === null);

console.log("\n[inferDurationMin]");
assert("explicit duration_minutes wins", inferDurationMin({ duration_minutes: 75, type: "Activity" }) === 75);
assert("derive from start+end", inferDurationMin({ time: "14:00", end_time: "15:30", type: "Activity" }) === 90);
assert("Activity default 60", inferDurationMin({ type: "Activity", time: "14:00" }) === 60);
assert("Dinner default 120", inferDurationMin({ type: "Dinner" }) === 120);
assert("unknown type -> null", inferDurationMin({ type: "Mystery" }) === null);
assert("zero duration_minutes falls back", inferDurationMin({ duration_minutes: 0, type: "Dinner" }) === 120);

console.log("\n[pickMode]");
assert("same Venice -> WALK", pickMode("Venice", "Venice") === "WALK");
assert("same dubrovnik (lowercase) -> WALK", pickMode("dubrovnik", "Dubrovnik") === "WALK");
assert("Manhattan == Manhattan -> WALK", pickMode("Manhattan", "Manhattan") === "WALK");
assert("same unknown city -> DRIVE", pickMode("Smalltown", "Smalltown") === "DRIVE");
assert("different cities -> DRIVE", pickMode("Rovinj", "Split") === "DRIVE");

console.log("\n[itemCoords]");
assert("activity coords", JSON.stringify(itemCoords({ lat: 1, lng: 2 })) === '{"lat":1,"lng":2}');
assert("restaurant nested", JSON.stringify(itemCoords({ restaurant: { lat: 3, lng: 4 } })) === '{"lat":3,"lng":4}');
assert("missing -> null", itemCoords({ type: "Activity" }) === null);
assert("partial -> null", itemCoords({ lat: 1 }) === null);

// =========================================================
// collectPacingPairs
// =========================================================
console.log("\n[collectPacingPairs -- empty plan]");
assert("null plan -> []", collectPacingPairs(null).length === 0);
assert("no days -> []", collectPacingPairs({}).length === 0);
assert("empty days -> []", collectPacingPairs({ days: [] }).length === 0);

console.log("\n[collectPacingPairs -- skip types]");
{
  const plan = {
    days: [{
      city: "Dubrovnik",
      items: [
        { type: "Flight", time: "08:00", lat: 0, lng: 0 },
        { type: "Hotel", time: "09:00", lat: 0, lng: 0 },
        { type: "Activity", name: "A", time: "10:00", lat: 42.65, lng: 18.09 },
        { type: "Activity", name: "B", time: "11:30", lat: 42.65, lng: 18.10 },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  assert("1 pair built", pairs.length === 1);
  assert("from A to B", pairs[0].fromName === "A" && pairs[0].toName === "B");
  assert("WALK in dubrovnik", pairs[0].travelMode === "WALK");
}

console.log("\n[collectPacingPairs -- same venue is skipped]");
{
  const plan = {
    days: [{
      city: "Rovinj",
      items: [
        { type: "Activity", name: "X", time: "10:00", lat: 45.0811, lng: 13.6386, place_id: "p1" },
        { type: "Activity", name: "Y", time: "11:00", lat: 45.0811, lng: 13.6386, place_id: "p1" },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  assert("same place_id skipped", pairs.length === 0);
}

console.log("\n[collectPacingPairs -- Dinner with nested restaurant coords]");
{
  const plan = {
    days: [{
      city: "Hvar",
      items: [
        { type: "Activity", name: "Fortica", time: "17:30", lat: 43.17, lng: 16.44 },
        { type: "Dinner", time: "21:00", restaurant: { name: "Gariful", lat: 43.17, lng: 16.45 } },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  assert("1 pair from Activity to Dinner", pairs.length === 1);
  assert("toName from restaurant", pairs[0].toName === "Gariful");
  assert("destLng from nested coords", pairs[0].destLng === 16.45);
}

console.log("\n[collectPacingPairs -- multiple adjacencies]");
{
  // 3 activities -> 2 adjacencies
  const plan = {
    days: [{
      city: "Split",
      items: [
        { type: "Activity", name: "A", time: "09:00", lat: 43.51, lng: 16.43 },
        { type: "Activity", name: "B", time: "11:00", lat: 43.52, lng: 16.44 },
        { type: "Activity", name: "C", time: "14:00", lat: 43.51, lng: 16.42 },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  assert("2 pairs", pairs.length === 2);
  assert("first A->B", pairs[0].fromName === "A" && pairs[0].toName === "B");
  assert("second B->C", pairs[1].fromName === "B" && pairs[1].toName === "C");
}

// =========================================================
// applyPacingFlags
// =========================================================
console.log("\n[applyPacingFlags -- ample buffer, no flags]");
{
  const plan = {
    days: [{
      items: [
        { type: "Activity", name: "A", time: "10:00", lat: 42.65, lng: 18.09 },
        { type: "Activity", name: "B", time: "14:00", lat: 42.65, lng: 18.10 },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  // Mock route: 5 min travel, 4-hour gap, plenty of slack
  const routes = [{ id: pairs[0].id, found: true, duration_seconds: 300, distance_meters: 800 }];
  const next = applyPacingFlags(plan, pairs, routes);
  assert("no flags attached", !next.days[0].items[0].flags && !next.days[0].items[1].flags);
}

console.log("\n[applyPacingFlags -- impossible -> block]");
{
  // Florence-Siena: A ends at 13:30 (Activity 1h, started 12:30),
  // B starts 13:45. Drive ~75 km = ~60 min. 15-min gap, 60 min travel
  // -> impossible.
  const plan = {
    days: [{
      city: "Florence",
      items: [
        { type: "Activity", name: "Uffizi", time: "12:30", duration_minutes: 60, lat: 43.768, lng: 11.255 },
        { type: "Lunch", time: "13:45", restaurant: { name: "Trattoria Toscana", lat: 43.318, lng: 11.331 } },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  const routes = [{ id: pairs[0].id, found: true, duration_seconds: 60 * 60, distance_meters: 75000 }];
  const next = applyPacingFlags(plan, pairs, routes);
  const aFlags = next.days[0].items[0].flags || [];
  const bFlags = next.days[0].items[1].flags || [];
  assert("Activity got PACING_IMPOSSIBLE", aFlags.some(f => f.code === "PACING_IMPOSSIBLE"));
  assert("Lunch got PACING_IMPOSSIBLE", bFlags.some(f => f.code === "PACING_IMPOSSIBLE"));
  assert("severity block", aFlags.find(f => f.code === "PACING_IMPOSSIBLE")?.severity === "block");
  assert("message names both venues", /Uffizi.*Trattoria/.test(aFlags[0].message));
  assert("summary pacing_impossibles incremented", next._verificationSummary?.pacing_impossibles === 1);
}

console.log("\n[applyPacingFlags -- tight gap -> warn]");
{
  // 30 min gap, 20 min travel -> slack 10 min, under TIGHT_BUFFER_MIN
  const plan = {
    days: [{
      items: [
        { type: "Activity", name: "A", time: "10:00", duration_minutes: 60, lat: 0, lng: 0 },
        { type: "Activity", name: "B", time: "11:30", lat: 0.1, lng: 0.1 },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  const routes = [{ id: pairs[0].id, found: true, duration_seconds: 20 * 60, distance_meters: 5000 }];
  const next = applyPacingFlags(plan, pairs, routes);
  const aFlags = next.days[0].items[0].flags || [];
  assert("PACING_CONFLICT (warn)", aFlags.some(f => f.code === "PACING_CONFLICT"));
  assert("warn severity", aFlags.find(f => f.code === "PACING_CONFLICT")?.severity === "warn");
  assert("not PACING_IMPOSSIBLE (gap >= travel)", !aFlags.some(f => f.code === "PACING_IMPOSSIBLE"));
}

console.log("\n[applyPacingFlags -- route not found -> no flag]");
{
  const plan = {
    days: [{
      items: [
        { type: "Activity", name: "A", time: "10:00", lat: 0, lng: 0 },
        { type: "Activity", name: "B", time: "10:05", lat: 90, lng: 90 },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  const routes = [{ id: pairs[0].id, found: false, error: "no-key" }];
  const next = applyPacingFlags(plan, pairs, routes);
  assert("no flag when route missing", !next.days[0].items[0].flags);
}

console.log("\n[applyPacingFlags -- preserves existing item flags]");
{
  const plan = {
    days: [{
      items: [
        { type: "Activity", name: "A", time: "10:00", duration_minutes: 60, lat: 0, lng: 0, flags: [{ code: "UNVERIFIED", severity: "warn" }] },
        { type: "Activity", name: "B", time: "11:00", lat: 0.5, lng: 0.5 },
      ],
    }],
  };
  const pairs = collectPacingPairs(plan);
  const routes = [{ id: pairs[0].id, found: true, duration_seconds: 30 * 60, distance_meters: 40000 }];
  const next = applyPacingFlags(plan, pairs, routes);
  const aFlags = next.days[0].items[0].flags;
  assert("original UNVERIFIED preserved", aFlags.some(f => f.code === "UNVERIFIED"));
  assert("PACING_IMPOSSIBLE added", aFlags.some(f => f.code === "PACING_IMPOSSIBLE"));
}

console.log("\n[applyPacingFlags -- empty inputs are identity]");
{
  const plan = { days: [{ items: [{ type: "Activity", name: "A", time: "10:00", lat: 0, lng: 0 }] }] };
  assert("empty pairs -> same plan", applyPacingFlags(plan, [], []) === plan);
  assert("non-array routes -> same plan", applyPacingFlags(plan, [{}], null) === plan);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
