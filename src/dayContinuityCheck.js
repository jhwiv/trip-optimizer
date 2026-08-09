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
const ARROW_RE = /→|->|—>|–>/;
const CHECKOUT_RE = /check[\s-]?out|depart(?:ure)? from (?:the )?hotel/i;
const CHECKIN_RE = /check[\s-]?in|arrive at (?:the )?hotel/i;
const RENTAL_DROPOFF_RE = /(?:drop[\s-]?off|return|turn in)[^.]{0,40}\b(?:car|rental|vehicle)\b|\b(?:car|rental|vehicle)\b[^.]{0,40}(?:drop[\s-]?off|return)/i;
// A Transport item's text describing a PICKUP ("driver pickup for X",
// "pickup at Y") names the item's location as WHERE THE JOURNEY STARTS, not
// where it ends — the opposite of a drop-off/arrival item, where location
// legitimately means the destination. Real observed case (2026-08-07, a
// London/Normandy/Nuremberg/Porto build): "Private driver pickup for Douro
// Valley — full-day tour" carried location:"Porto Marriott Hotel Palácio"
// (the hotel the driver picks up FROM). itemDestination previously used
// location as a `to` candidate unconditionally, so this pickup item
// resolved to "Porto" as a destination — a same-city day-trip's OUTBOUND
// leg looked like an ordinary, resolved arrival rather than the unresolved
// leg the day-trip-return exemption below depends on detecting.
const PICKUP_RE = /\bpick[\s-]?up\b/i;

// A same-night reminder line ("Overnight at The Yeatman Hotel") that this app
// writes as the last item of most days — restating where the traveller is
// already sleeping, not a new arrival. It matches neither CHECKIN_RE nor
// CHECKOUT_RE, so hotelEvent's fallback (any Hotel-type item carrying an
// `item.hotel` object defaults to a check-in) misclassified it as a fresh
// check-in on any day that has no OTHER, earlier Hotel item — i.e. every
// night after the first at a multi-night stay. Real observed case
// (2026-08-09, a London/Normandy/Nuremberg/Porto rebuild): three consecutive
// nights at the Sheraton Carlton Hotel Nuremberg, each day's only Hotel item
// an "Overnight at..." reminder, produced DUPLICATE_CHECKIN on every night
// after the first at a hotel nobody re-checked into.
const OVERNIGHT_REMINDER_RE = /^overnight\b/i;

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
  // A transit day's own city field is often an arrow-formatted label
  // ("Normandy → Nuremberg", per DAY_SCHEMA's documented convention) rather
  // than a real single-city name. Left in, its raw text can literally
  // contain a real city name as a substring ("Normandy → Nuremberg"
  // contains "Nuremberg") and — being longer — sorts ahead of the real
  // canonical entry, so resolveCity matches the transit label instead of
  // the actual city. Real observed case (2026-08-04, 14-night 5-city
  // build): this caused a Flight's destination to resolve to "Normandy →
  // Nuremberg" instead of "Nuremberg, Germany", leaving DAY_CITY_DISCONTINUITY
  // comparing two strings that could never match.
  if (Array.isArray(plan?.days)) {
    plan.days.forEach((d) => {
      if (typeof d?.city === "string" && !ARROW_RE.test(d.city)) push(d.city);
    });
  }
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

// Route text after the arrow often carries a trailing qualifier clause after
// a comma — "Fly Paris CDG → Nuremberg, nonstop", "Amsterdam, via Brussels"
// — which breaks resolveCity's substring match against a canonical name like
// "Nuremberg, Germany": the qualifier sits exactly where a country/region
// would need to for the match to land. Real observed case (2026-08-04, a
// 14-night 5-city build): this specific text left Day 8's Flight
// destination unresolved, so leg.transitions stayed empty, which in turn
// left DAY_CITY_DISCONTINUITY comparing an unresolved transit-day city
// label against Day 9's plain city name and blocking a correct itinerary's
// PDF export. Tried as a fallback candidate alongside the untouched string.
function beforeComma(s) {
  const t = typeof s === "string" ? s.trim() : "";
  const idx = t.indexOf(",");
  return idx > 0 ? t.slice(0, idx).trim() : "";
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
      to: firstResolvable([route.to, beforeComma(route.to), fl.to_airport, item.location], canonical),
      from: firstResolvable([route.from, beforeComma(route.from), fl.from_airport], canonical),
    };
  }
  const isPickup = PICKUP_RE.test(String(item?.text || ""));
  return {
    to: firstResolvable([route.to, beforeComma(route.to), ...(isPickup ? [] : [item.location])], canonical),
    from: firstResolvable([route.from, beforeComma(route.from), ...(isPickup ? [item.location] : [])], canonical),
  };
}

function hotelEvent(item) {
  const type = String(item?.type || "");
  if (!/^Hotel$/i.test(type)) return null;
  const name = item?.hotel?.name || item?.text || "";
  const text = `${item?.text || ""} ${item?.hotel?.name || ""}`;
  // Check-out is the narrower phrasing, so test it first; a bare Hotel item
  // with neither phrase is a check-in (the model's default shape) UNLESS it's
  // a same-night "Overnight at..." reminder, which is neither — see
  // OVERNIGHT_REMINDER_RE above.
  const kind = CHECKOUT_RE.test(text) ? "out"
    : OVERNIGHT_REMINDER_RE.test(String(item?.text || "").trim()) ? null
    : (CHECKIN_RE.test(text) || item?.hotel ? "in" : null);
  return kind ? { kind, name: String(name).trim() } : null;
}

// Left-to-right pass. One entry per day: the day's city, the hotel check-in /
// check-out that happened on it, and every inter-city transition it contains.
//
// A sequential loop (not .map()), because the same-city exemption below needs
// to know where the traveller already is BEFORE today's first item runs —
// carried forward from the previous day's own resolved ending point, not
// re-derived from a separate pass over the finished legs.
export function buildDayLegs(plan) {
  const canonical = canonicalCities(plan);
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const legs = [];
  // Where the traveller is as of the start of the day being processed —
  // the previous day's last resolved transition, or its city label if it
  // had none. null for Day 1 (nothing to carry in yet).
  let priorDayEnd = null;
  days.forEach((day, dayIdx) => {
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
    // Tracks whether an EARLIER Transport/Flight item the same day had an
    // unresolved destination — the signature of "went somewhere not on the
    // canonical city list" (a day-trip outbound leg to a non-canonical side
    // destination, e.g. Bletchley Park). A LATER same-day item that resolves
    // back to this day's own base city with no resolved origin is then
    // recognized as that outbound leg's return half, not a genuine new
    // arrival — see isDaytripReturn below.
    let sawUnresolvedTransportEarlierToday = false;
    // Where the traveller currently is, updated as resolved transitions are
    // recorded through the day — starts as wherever the previous day left
    // them (see isSameCityNoMove below).
    let currentCity = priorDayEnd;
    items.forEach((item, itemIdx) => {
      if (!item || typeof item !== "object") return;
      const isTransportType = TRANSPORT_TYPES.test(String(item.type || ""));
      const isFlightType = /^Flight$/i.test(String(item.type || ""));
      if (isTransportType) leg.hasTransport = true;
      const dest = itemDestination(item, canonical);
      // Real observed case (2026-08-04): "Private car London to Bletchley
      // Park" (outbound, unresolved — Bletchley Park isn't a canonical
      // city) followed later the same day by "Return drive Bletchley Park
      // to London" (resolves to "London", today's own base city, origin
      // unresolved). Recording the return half alone looked exactly like a
      // brand-new arrival into London, which ORPHANED_TRANSITION then
      // flagged against Day 1's real arrival, even though the traveller
      // never left their London base — a same-day round trip, not a move.
      //
      // Deliberately keyed off "an earlier same-day unresolved-destination
      // transport leg exists", NOT off "the previous day was already this
      // city" — the latter looks identical for a genuine repeat-arrival bug
      // this module exists to catch (Day 6 AND Day 7 both labeled
      // "Amsterdam", but Day 7 is a real second arrival — a rental-car
      // drop-off in Normandy and a flight FROM Caen prove the traveller
      // wasn't continuing an Amsterdam stay at all). A single flight with
      // no matching earlier-that-day outbound leg is not a round trip.
      //
      // ALSO requires no hotel check-out yet today (!leg.hotelOut). Real
      // observed case (2026-08-07): a hallucinated day that opens "Return to
      // hotel, collect luggage" at a Paris property that doesn't belong on
      // this itinerary at all (Transport type, unresolved — Paris isn't a
      // canonical city on this trip), checks OUT of that phantom hotel, then
      // flies to Porto — the day's real, genuine arrival. Porto also happens
      // to be the day's own city label, and an earlier unresolved Transport
      // item existed, so this satisfied every condition above and got
      // swallowed as if it were a Bletchley-Park-style same-day round trip.
      // A real day trip never checks out of a hotel — the traveller is still
      // based where they started. A day that DOES check out is describing an
      // actual departure from somewhere, so its later "arrival" must not be
      // exempted, however unresolvable or coincidentally-named that
      // somewhere turns out to be.
      const isDaytripReturn =
        dest?.to && !dest.from && sawUnresolvedTransportEarlierToday && !leg.hotelOut && norm(dest.to) === norm(leg.city);
      // A Transport item (never Flight — see below) whose resolved
      // destination is exactly where the traveller already is describes a
      // local errand or a transfer to one's own departure point, not a
      // change of city. Two real observed shapes (2026-08-09, a
      // London/Normandy/Nuremberg/Porto rebuild): "Drive to Memorium
      // Nuremberg Trials" (a museum whose own name contains the city,
      // visited on an ordinary day with no travel at all) and "Taxi to
      // London Heathrow" / "Drive to Nuremberg Airport" (a transfer TO one's
      // own city's departure airport, misread as arriving in that city
      // because the airport's name contains it). Both resolved to the
      // SAME city the traveller was already in — carried forward from the
      // previous day via currentCity — with nothing about them describing
      // an actual move.
      //
      // Deliberately Transport-only, never Flight: a Flight item resolving
      // to a city the traveller is already in is a much stronger signal of
      // a real duplicated-content bug (an overnight flight's arrival
      // re-listed as its own item on the next day, or an entire arrival
      // sequence duplicated across a chunked build's leg boundary) and must
      // keep being recorded so ORPHANED_TRANSITION can still catch it.
      const isSameCityNoMove =
        isTransportType && !isFlightType && !!dest?.to && !!currentCity && norm(dest.to) === norm(currentCity);
      if (dest && dest.to && !isDaytripReturn && !isSameCityNoMove) {
        leg.transitions.push({ ...dest, itemIdx, label: String(item.text || "").trim(), type: item.type });
        currentCity = dest.to;
      }
      if (isTransportType && (!dest || !dest.to)) sawUnresolvedTransportEarlierToday = true;
      const hotel = hotelEvent(item);
      if (hotel?.kind === "in" && !leg.hotelIn) leg.hotelIn = { ...hotel, itemIdx, time: item.time || "" };
      if (hotel?.kind === "out" && !leg.hotelOut) leg.hotelOut = { ...hotel, itemIdx, time: item.time || "" };
    });
    legs.push(leg);
    priorDayEnd = (leg.transitions.length > 0 ? leg.transitions[leg.transitions.length - 1].to : null) || leg.city || priorDayEnd;
  });
  return legs;
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

  // Each day's resolved ENDING city — the last transition's destination if
  // the day travelled anywhere, else the day's own city label. Computed once
  // and shared by every check below that needs "where did this day actually
  // leave the traveller" rather than the day's raw city field, which for a
  // transit day is often an arrow-formatted label ("Normandy → Nuremberg",
  // per DAY_SCHEMA's own convention) that will never string-equal the next
  // day's plain destination name ("Nuremberg, Germany") even when the two
  // days are perfectly continuous.
  const dayEnd = legs.map((leg) => {
    const last = leg.transitions.length > 0 ? leg.transitions[leg.transitions.length - 1].to : "";
    return last || leg.city || "";
  });

  // 1. DAY_CITY_DISCONTINUITY — the traveller changed city without travelling.
  //    Compares the PREVIOUS day's resolved ending city (dayEnd), not its
  //    raw city label — a transit day's "X → Y" label never equals the next
  //    day's plain "Y" city name as strings, even when Y is exactly where it
  //    ended. Real observed case (2026-08-04, a 14-night 5-city build): Day
  //    8's city was "Normandy → Nuremberg" and Day 9's was "Nuremberg,
  //    Germany" — a correct, continuous itinerary that this comparison
  //    blocked from PDF export before dayEnd was introduced here.
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1];
    const leg = legs[i];
    const prevEnd = dayEnd[i - 1];
    if (!prevEnd || !leg.city) continue;
    if (norm(prevEnd) === norm(leg.city)) continue;
    if (leg.hasTransport) continue;
    // A travel day that both moved (hasTransport) AND ended by checking
    // into a new hotel (hotelIn) is strong evidence the traveller genuinely
    // arrived somewhere new, even when route text can't be resolved to a
    // canonical city name — dayEnd's substring matching only works when
    // the itinerary text repeats the city/region name verbatim, which real
    // routing text often doesn't (a multi-stop ferry-and-drive day into a
    // region like "Normandy" is described via its actual towns — Caen,
    // Ouistreham, Bayeux — none of which contain the substring "normandy").
    // Real observed case (2026-08-04): a Portsmouth-to-Normandy travel day
    // (ferry + drives + late hotel check-in at Villa Lara, Bayeux) left
    // dayEnd stuck on an intra-Portsmouth transition (the last leg text
    // that DID resolve), false-blocking a correct, continuous itinerary.
    if (prev.hasTransport && prev.hotelIn) continue;
    add(
      "DAY_CITY_DISCONTINUITY",
      "block",
      leg,
      leg.city,
      `Day ${leg.day} is set in ${leg.city} but Day ${prev.day} ended in ${prevEnd}, and Day ${leg.day} has no flight or transport item that gets the traveller there.`,
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

  // 4. CITY_BACKTRACK — an item is physically located in a city the plan has
  //    already finished with. This is the belt-and-suspenders rule for the
  //    Day 6/7 shape: both days declare Amsterdam, so DAY_CITY_DISCONTINUITY
  //    sees nothing wrong, yet Day 7 opens at Pointe du Hoc and returns a
  //    rental in Bayeux — a city the plan left two days earlier.
  //
  //    Scoped tightly to avoid false positives:
  //      • only item.location, never free text (a "London-style pub" in
  //        Lisbon must not read as a trip back to London);
  //      • Flight/Transport items are skipped — naming the origin city is
  //        exactly what they are for;
  //      • a day's own start city, end city, and every city its transitions
  //        touch are all allowed, so departure mornings don't trip it.
  const runs = []; // ordered city runs, derived from each day's END city
  const runIdxOf = new Map(); // normalized city → last run index
  const dayRun = legs.map((leg, i) => {
    const end = dayEnd[i];
    if (!end) return runs.length - 1;
    if (runs.length === 0 || norm(runs[runs.length - 1]) !== norm(end)) runs.push(end);
    runIdxOf.set(norm(end), runs.length - 1);
    void leg;
    return runs.length - 1;
  });

  legs.forEach((leg, i) => {
    const startRun = i === 0 ? dayRun[0] : dayRun[i - 1];
    if (startRun < 0) return;
    const allowed = new Set();
    const allow = (c) => { if (c) allowed.add(norm(c)); };
    allow(dayEnd[i]);
    allow(i === 0 ? dayEnd[0] : dayEnd[i - 1]);
    allow(leg.city);
    leg.transitions.forEach((t) => { allow(t.to); allow(t.from); });

    const items = Array.isArray(days[leg.dayIdx]?.items) ? days[leg.dayIdx].items : [];
    const reported = new Set();
    for (const item of items) {
      if (!item || TRANSPORT_TYPES.test(String(item.type || ""))) continue;
      const where = resolveCity(item.location, canonical);
      if (!where || allowed.has(norm(where)) || reported.has(norm(where))) continue;
      const lastRun = runIdxOf.get(norm(where));
      if (lastRun === undefined || lastRun >= startRun) continue;
      reported.add(norm(where));
      add(
        "CITY_BACKTRACK",
        "block",
        leg,
        where,
        `Day ${leg.day} has an item in ${where} ("${String(item.text || item.location).trim()}"), but the plan left ${where} before Day ${leg.day} and never travels back.`,
      );
    }
  });

  // 5. VEHICLE_STATE_CONFLICT — a rental returned in a city the plan has
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
