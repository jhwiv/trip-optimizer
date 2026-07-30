// Fail-safe marking for flights the resolver could not confirm
// (report bug 6, validator V6).
//
// The 2026-07-28 build shipped "AF7652 CFR → CDG → AMS" — Air France does not
// fly Caen. Both /api/flights-search attempts came back empty, but because the
// model had invented plausible clock times, the old _timesUnconfirmed marker
// (scoped to missing times only) never fired, and the card and PDF rendered the
// route exactly like a schedule-confirmed one.
//
// _flightUnverified is the widened marker: set whenever both attempts miss,
// times or no times. _timesUnconfirmed still rides along when the clocks are
// genuinely absent so the existing PDF line and any in-flight plan objects
// survive one more release.

import {
  buildUnverifiedFlightPayload,
  buildUnconfirmedTimesPayload,
  findUnverifiedFlights,
  filterPoolByAirline,
  pickFromPool,
} from "../src/flightResolver.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const AF7652 = {
  carrier: "Air France",
  flight_number: "AF7652",
  from_airport: "CFR",
  to_airport: "AMS",
  depart_time: "10:15",
  arrive_time: "13:05",
};

console.log("=== the shipped failure: a complete-looking flight nobody flies ===");
{
  const payload = buildUnverifiedFlightPayload(AF7652, { routeExists: false });
  assert("the flight is marked unverified", payload?._flightUnverified === true, JSON.stringify(payload));
  assert("the reason records that the route has no service",
    payload?._unverifiedReason === "no-scheduled-route", payload?._unverifiedReason);
  // The whole point of widening the marker: the old one keyed off missing
  // times, and this flight has both.
  assert("_timesUnconfirmed is NOT set — the times are present",
    payload._timesUnconfirmed === undefined, JSON.stringify(payload));
  assert("the legacy helper stays silent here, which is the bug",
    buildUnconfirmedTimesPayload(AF7652) === null);
}

console.log("\n=== the three failure shapes the route-only retry can tell apart ===");
{
  const reason = (opts) => buildUnverifiedFlightPayload(AF7652, opts)?._unverifiedReason;
  assert("routeExists:true → carrier-not-on-route", reason({ routeExists: true }) === "carrier-not-on-route");
  assert("routeExists:false → no-scheduled-route", reason({ routeExists: false }) === "no-scheduled-route");
  assert("routeExists undefined → schedule-unavailable", reason({}) === "schedule-unavailable");
  assert("no opts at all → schedule-unavailable", reason(undefined) === "schedule-unavailable");
  assert("a non-boolean routeExists is treated as unknown, not as false",
    reason({ routeExists: null }) === "schedule-unavailable");
}

console.log("\n=== _timesUnconfirmed back-compat ===");
{
  const noTimes = { carrier: "Air France", flight_number: "AF7652", from_airport: "CFR", to_airport: "AMS" };
  const payload = buildUnverifiedFlightPayload(noTimes, { routeExists: true });
  assert("both markers ride together when the clocks are missing",
    payload._flightUnverified === true && payload._timesUnconfirmed === true, JSON.stringify(payload));
  assert("the legacy helper still returns its narrow payload",
    JSON.stringify(buildUnconfirmedTimesPayload(noTimes)) === JSON.stringify({ _timesUnconfirmed: true }));
  assert("the legacy helper never leaks the new keys",
    buildUnconfirmedTimesPayload(noTimes)._flightUnverified === undefined);

  const departOnly = { ...noTimes, depart_time: "10:15" };
  assert("one clock is still 'missing times'", buildUnverifiedFlightPayload(departOnly)._timesUnconfirmed === true);
  const blankTimes = { ...noTimes, depart_time: "   ", arrive_time: "" };
  assert("whitespace clocks count as missing",
    buildUnverifiedFlightPayload(blankTimes)._timesUnconfirmed === true);

  assert("null flight → null", buildUnverifiedFlightPayload(null) === null);
  assert("non-object flight → null", buildUnverifiedFlightPayload("AF7652") === null);
  assert("legacy helper is null-safe", buildUnconfirmedTimesPayload(null) === null);
}

console.log("\n=== findUnverifiedFlights ===");
{
  const plan = {
    days: [
      {
        day: 1,
        items: [{
          type: "Flight",
          text: "Fly to Amsterdam",
          flight: { ...AF7652, ...buildUnverifiedFlightPayload(AF7652, { routeExists: false }) },
        }],
      },
      {
        day: 2,
        items: [{
          type: "Flight",
          text: "Fly to Lisbon",
          flight: { carrier: "TAP", flight_number: "TP1234", from_airport: "AMS", to_airport: "LIS", _scheduleVerified: true },
        }],
      },
    ],
  };
  const hits = findUnverifiedFlights(plan);
  assert("only the unconfirmed flight is flagged", hits.length === 1, JSON.stringify(hits));
  assert("code is FLIGHT_UNVERIFIED", hits[0]?.code === "FLIGHT_UNVERIFIED");
  // Warn, not block: an unconfirmable regional hop is usually still the right
  // plan. What must not happen is it printing as schedule-confirmed.
  assert("severity is warn", hits[0]?.severity === "warn", hits[0]?.severity);
  assert("dayIdx is 0-based", hits[0]?.dayIdx === 0);
  assert("day is 1-based and numeric", hits[0]?.day === 1, JSON.stringify(hits[0]?.day));
  assert("itemIdx points at the flight", hits[0]?.itemIdx === 0);
  assert("target names carrier and number", hits[0]?.target === "Air France AF7652", hits[0]?.target);
  assert("message states the route", /CFR→AMS/.test(hits[0]?.message || ""), hits[0]?.message);
  assert("message explains which failure it was",
    /no service on this route/.test(hits[0]?.message || ""), hits[0]?.message);
  assert("message tells the traveller what to do",
    /Verify with the airline/.test(hits[0]?.message || ""), hits[0]?.message);

  const carrierMiss = structuredClone(plan);
  carrierMiss.days[0].items[0].flight._unverifiedReason = "carrier-not-on-route";
  assert("carrier-not-on-route gets its own copy",
    /not by this carrier/.test(findUnverifiedFlights(carrierMiss)[0]?.message || ""),
    findUnverifiedFlights(carrierMiss)[0]?.message);
  const unknownReason = structuredClone(plan);
  unknownReason.days[0].items[0].flight._unverifiedReason = "who-knows";
  assert("an unrecognized reason falls back to the generic copy",
    /lookup could not be completed/.test(findUnverifiedFlights(unknownReason)[0]?.message || ""));

  const unnamed = { days: [{ day: 1, items: [{ type: "Flight", text: "Hop to Amsterdam", flight: { _flightUnverified: true } }] }] };
  assert("a flight with no carrier falls back to the item text",
    findUnverifiedFlights(unnamed)[0]?.target === "Hop to Amsterdam", findUnverifiedFlights(unnamed)[0]?.target);
  assert("a flight with no route omits the arrow",
    !/→/.test(findUnverifiedFlights(unnamed)[0]?.message || ""), findUnverifiedFlights(unnamed)[0]?.message);

  const notAFlight = structuredClone(plan);
  notAFlight.days[0].items[0].type = "Transport";
  assert("only Flight items are walked", findUnverifiedFlights(notAFlight).length === 0);

  assert("null plan → []", findUnverifiedFlights(null).length === 0);
  assert("no days → []", findUnverifiedFlights({}).length === 0);
  assert("null day entries survive", findUnverifiedFlights({ days: [null] }).length === 0);
  assert("an item with no flight object → []",
    findUnverifiedFlights({ days: [{ items: [{ type: "Flight", text: "TBD" }] }] }).length === 0);
}

console.log("\n=== the airline-filter retry that makes the reason meaningful ===");
{
  // buildUnverifiedFlightPayload can only distinguish carrier-not-on-route from
  // no-scheduled-route because the resolver retries the route without the
  // airline filter. These two helpers are that retry.
  const pool = [
    { flightNumber: "KL1234", origin: "CFR", destination: "AMS" },
    { flightNumber: "AF9999", origin: "CFR", destination: "AMS" },
  ];
  assert("filtering by a carrier that isn't on the route returns empty",
    filterPoolByAirline(pool, "BA").length === 0);
  assert("filtering is case-insensitive", filterPoolByAirline(pool, "kl").length === 1);
  assert("a null airline returns the whole pool", filterPoolByAirline(pool, null).length === 2);
  assert("a non-array pool returns []", filterPoolByAirline(null, "AF").length === 0);

  // The empty-filter → full-pool fallback is what lets a codeshare still match.
  const picked = pickFromPool({
    flights: pool,
    airlineIata: "BA",
    approxMinutes: 615,
    pickScheduledFlight: (eligible) => eligible[0],
  });
  assert("an empty airline filter falls back to the full pool",
    picked?.flightNumber === "KL1234", JSON.stringify(picked));
  assert("an empty pool picks nothing — this is the no-scheduled-route case",
    pickFromPool({ flights: [], airlineIata: "AF", approxMinutes: 615, pickScheduledFlight: (e) => e[0] }) === null);
  assert("a pick with no flight number is rejected",
    pickFromPool({ flights: pool, airlineIata: null, approxMinutes: 615, pickScheduledFlight: () => ({}) }) === null);
  assert("a missing pickScheduledFlight is safe",
    pickFromPool({ flights: pool, airlineIata: "AF", approxMinutes: 615 }) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
