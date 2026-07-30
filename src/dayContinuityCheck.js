// Structural day-to-day continuity validation.
//
// Every validator that existed before this module checks a venue or a single
// day in isolation: placesVerify (does this venue exist), locationCheck (is it
// in the right city), pacingCheck (can I get between these two items),
// arrivalOrderCheck (is this day's ground travel after the flight lands).
// Nothing looked at how one day connects to the next, which is how the
// 2026-07-28 London→Normandy→Amsterdam→Lisbon plan shipped with Day 6 driving
// to Amsterdam and checking into the Marriott, and Day 7 waking up back in
// Normandy, flying to Amsterdam, and checking into the same Marriott again.
//
// Pure: no network, no React, no module state. Emits flag objects in the same
// shape placesVerify uses ({ code, severity, message, ... }) so they can flow
// through the existing pre-export gate vocabulary.

const TRANSPORT_TYPES = /^(Flight|Transport)$/i;
const CHECKOUT_RE = /check[\s-]?out|depart(?:ure)? from (?:the )?hotel/i;
const CHECKIN_RE = /check[\s-]?in|arrive at (?:the )?hotel/i;
const RENTAL_DROPOFF_RE = /(?:drop[\s-]?off|return|turn in)[^.]{0,40}\b(?:car|rental|vehicle)\b|\b(?:car|rental|vehicle)\b[^.]{0,40}(?:drop[\s-]?off|return)/i;

// Within how many days a repeated check-in at the same property is suspicious.
// 2 covers the observed failure (consecutive days) plus a one-day gap, without
// flagging a legitimate return to a base hotel later in the trip.
const DUPLICATE_CHECKIN_WINDOW_DAYS = 2;

const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

// The set of city names we're willing to resolve free text against: the
// model's plan-level cities[] plus every distinct days[].city. Longest first
// so "Amsterdam" wins over a shorter canonical that happens to be a substring.
function canonicalCities(plan) {
  const seen = new Set();
  const names = [];
  const push = (raw) => {
    const n = typeof raw === "string" ? raw.trim() : "";
    if (!n || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    names.push(n);
  };
  if (Array.isArray(plan?.cities)) plan.cities.forEach((c) => push(c?.name));
  if (Array.isArray(plan?.days)) plan.days.forEach((d) => push(d?.city));
  return names.sort((a, b) => b.length - a.length);
}

// Substring match in either direction, mirroring the city-normalization pass in
// applyQualityLayer: "Amsterdam Centraal" and "Ams" both resolve to
// "Amsterdam". Returns the canonical spelling, or null.
function resolveCity(token, canonical) {
  const t = norm(token);
  if (!t) return null;
  for (const name of canonical) {
    const n = norm(name);
    if (t === n || t.includes(n) || n.includes(t)) return name;
  }
  return null;
}

function firstResolvable(tokens, canonical) {
  for (const token of tokens) {
    const hit = resolveCity(token, canonical);
    if (hit) return hit;
  }
  return null;
}

// Split "Utah Beach → Amsterdam" / "Drive to Amsterdam via Belgium" /
// "Fly Caen to Amsterdam" into rough origin and destination text. Either side
// may be junk; resolveCity is what decides whether it means anything.
function parseRoute(text) {
  const s = typeof text === "string" ? text : "";
  const arrow = s.split(/\s*(?:→|->|—>|–>)\s*/);
  if (arrow.length >= 2) return { from: arrow[0], to: arrow[arrow.length - 1] };
  const to = s.split(/\s+to\s+/i);
  if (to.length >= 2) return { from: to[0], to: to.slice(1).join(" to ") };
  return { from: "", to: s };
}

// Where does this item say the traveller ends up? Flights are always
// inter-city so they get the airport codes as extra candidates; Transport
// items only count when their text actually names a canonical city.
function itemDestination(item, canonical) {
  const type = String(item?.type || "");
  if (!TRANSPORT_TYPES.test(type)) return null;
  const route = parseRoute(item?.text);
  if (/^Flight$/i.test(type)) {
    const fl = item.flight || {};
    return {
      to: firstResolvable([route.to, fl.to_airport, item.location], canonical),
      from: firstResolvable([route.from, fl.from_airport], canonical),
    };
  }
  return {
    to: firstResolvable([route.to, item.location], canonical),
    from: firstResolvable([route.from], canonical),
  };
}

function hotelEvent(item) {
  const type = String(item?.type || "");
  if (!/^Hotel$/i.test(type)) return null;
  const name = item?.hotel?.name || item?.text || "";
  const text = `${item?.text || ""} ${item?.hotel?.name || ""}`;
  // Check-out is the narrower phrasing, so test it first; a bare Hotel item
  // with neither phrase is a check-in (the model's default shape).
  const kind = CHECKOUT_RE.test(text) ? "out" : CHECKIN_RE.test(text) || item?.hotel ? "in" : null;
  return kind ? { kind, name: String(name).trim() } : null;
}

// Left-to-right pass. One entry per day: the day's city, the hotel check-in /
// check-out that happened on it, and every inter-city transition it contains.
export function buildDayLegs(plan) {
  const canonical = canonicalCities(plan);
  const days = Array.isArray(plan?.days) ? plan.days : [];
  return days.map((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    const leg = {
      day: dayIdx + 1,
      dayIdx,
      city: typeof day?.city === "string" ? day.city.trim() : "",
      hotelIn: null,
      hotelOut: null,
      transitions: [],
      hasTransport: false,
    };
    items.forEach((item, itemIdx) => {
      if (!item || typeof item !== "object") return;
      if (TRANSPORT_TYPES.test(String(item.type || ""))) leg.hasTransport = true;
      const dest = itemDestination(item, canonical);
      if (dest && dest.to) {
        leg.transitions.push({ ...dest, itemIdx, label: String(item.text || "").trim() });
      }
      const hotel = hotelEvent(item);
      if (hotel?.kind === "in" && !leg.hotelIn) leg.hotelIn = { ...hotel, itemIdx, time: item.time || "" };
      if (hotel?.kind === "out" && !leg.hotelOut) leg.hotelOut = { ...hotel, itemIdx, time: item.time || "" };
    });
    return leg;
  });
}

// Returns a flat array of flag objects:
//   { code, severity, dayIdx, day, target, message }
// severity is "block" or "warn", matching the taxonomy in CLAUDE.md.
export function findContinuityIssues(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  if (days.length < 2) return [];
  const canonical = canonicalCities(plan);
  const legs = buildDayLegs(plan);
  const issues = [];
  const add = (code, severity, leg, target, message) =>
    issues.push({ code, severity, dayIdx: leg.dayIdx, day: leg.day, target, message });

  // 1. DAY_CITY_DISCONTINUITY — the traveller changed city without travelling.
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1];
    const leg = legs[i];
    if (!prev.city || !leg.city) continue;
    if (norm(prev.city) === norm(leg.city)) continue;
    if (leg.hasTransport) continue;
    add(
      "DAY_CITY_DISCONTINUITY",
      "block",
      leg,
      leg.city,
      `Day ${leg.day} is set in ${leg.city} but Day ${prev.day} ended in ${prev.city}, and Day ${leg.day} has no flight or transport item that gets the traveller there.`,
    );
  }

  // 2. DUPLICATE_CHECKIN — same property checked into twice with no checkout
  //    in between. The Amsterdam Marriott was checked into on Day 6 at 6:00 PM
  //    and again on Day 7 at 4:30 PM.
  const lastCheckIn = new Map(); // normalized hotel name → leg
  for (const leg of legs) {
    if (leg.hotelOut) lastCheckIn.delete(norm(leg.hotelOut.name));
    if (!leg.hotelIn) continue;
    const key = norm(leg.hotelIn.name);
    if (!key) continue;
    const prior = lastCheckIn.get(key);
    if (prior && leg.day - prior.day <= DUPLICATE_CHECKIN_WINDOW_DAYS) {
      add(
        "DUPLICATE_CHECKIN",
        "block",
        leg,
        leg.hotelIn.name,
        `${leg.hotelIn.name} is checked into on Day ${prior.day} and again on Day ${leg.day} with no check-out in between.`,
      );
    }
    lastCheckIn.set(key, leg);
  }

  // 3. ORPHANED_TRANSITION — two arrivals into the same city on different days
  //    with no arrival anywhere else in between, i.e. the plan travels
  //    somewhere it has already travelled to. Day 6 drove to Amsterdam and
  //    Day 7 flew to Amsterdam. Arrivals within a single day are ignored:
  //    "drive to Amsterdam" then "taxi to Amsterdam Centraal" is one journey.
  let lastArrival = null; // { city, leg, label }
  for (const leg of legs) {
    for (const t of leg.transitions) {
      if (lastArrival && norm(lastArrival.city) === norm(t.to) && lastArrival.leg.day !== leg.day) {
        add(
          "ORPHANED_TRANSITION",
          "block",
          leg,
          t.to,
          `Day ${leg.day} travels to ${t.to} ("${t.label}"), but Day ${lastArrival.leg.day} already arrived there ("${lastArrival.label}") and the plan never leaves in between.`,
        );
      }
      lastArrival = { city: t.to, leg, label: t.label };
    }
  }

  // 4. VEHICLE_STATE_CONFLICT — a rental returned in a city the plan has
  //    already left. The Caen drop-off happened on Day 7, after Day 6 drove
  //    the same car to Amsterdam. Warn, not block: the model sometimes writes
  //    a drop-off note on the wrong day without the plan being unbuildable.
  for (const leg of legs) {
    const items = Array.isArray(days[leg.dayIdx]?.items) ? days[leg.dayIdx].items : [];
    for (const item of items) {
      const text = `${item?.text || ""} ${item?.location || ""}`;
      if (!RENTAL_DROPOFF_RE.test(text)) continue;
      const where = firstResolvable([item?.location, item?.text], canonical);
      if (!where || !leg.city) continue;
      if (norm(where) === norm(leg.city)) continue;
      add(
        "VEHICLE_STATE_CONFLICT",
        "warn",
        leg,
        where,
        `Day ${leg.day} returns the rental car in ${where}, but the plan places Day ${leg.day} in ${leg.city}.`,
      );
    }
  }

  return issues;
}

// Gate adapter. Shapes block-severity continuity flags like the venue issues
// findBlockingIssues returns ({ dayIdx, name, flag }) so the pre-export gate
// can format both lists with one code path.
export function findStructuralBlockingIssues(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const issues = [];
  days.forEach((day, dayIdx) => {
    const flags = Array.isArray(day?.structural_flags) ? day.structural_flags : [];
    for (const flag of flags) {
      if (flag && flag.severity === "block") {
        issues.push({ dayIdx, kind: "structure", name: flag.target || `Day ${dayIdx + 1}`, flag });
      }
    }
  });
  return issues;
}
