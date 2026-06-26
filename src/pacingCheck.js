// Pacing check: detect adjacent-item time conflicts using real travel
// times from /api/routes-verify.
//
// Spec 3, 2026-06-14. Closes the failure pattern where the model gives
// you "Activity ends 13:30 in Florence, lunch 13:45 in Siena" (75 km
// drive). Three new flags:
//
//   PACING_CONFLICT  warn   adjacent items overlap or have <15 min buffer
//   PACING_IMPOSSIBLE block  adjacent items physically cannot be reached
//
// What this module does:
//   collectPacingPairs(plan, opts)
//     Walk each day's items[] and produce a list of pair-check requests
//     in the shape /api/routes-verify expects. Pure, no fetch.
//
//   applyPacingFlags(plan, pairs, routes)
//     Given the route results, attach PACING_* flags to the affected
//     items. Returns a NEW plan object.
//
// Scope (user decisions, 2026-06-14):
//   - Auto-infer travel mode per destination.
//   - Strict block threshold: impossible = block, tight = warn.
//   - No flight/ferry checking. Skip TRANSPORT, FLIGHT, NOTE items.

// Cities/locales where "walking" is the natural in-city mode. Anything
// in this list -> in-city pairs use WALK; cross-city pairs use DRIVE.
// Conservative list: only cities where I'm confident walking is the
// right default (Venice = boats but distances are walkable; Manhattan
// dense; old-town Mediterranean cores).
const WALK_DEFAULT_CITIES = new Set([
  "venice", "venezia",
  "florence", "firenze",
  "rome", "roma",
  "manhattan", "new york",
  "paris",
  "amsterdam",
  "barcelona",
  "lisbon", "lisboa",
  "prague", "praha",
  "vienna", "wien",
  "edinburgh",
  // Croatian old towns where the city is the size of a few blocks:
  "dubrovnik", "rovinj", "korčula", "korcula", "split", "hvar", "zadar",
  // Italian small centro storico:
  "siena", "lucca", "bologna",
]);

function normalizeCity(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();
}

// Decide the travel mode for one pair given the items' cities.
// In-city + city is on the walk list -> WALK. Otherwise -> DRIVE.
function pickMode(originCity, destCity) {
  const a = normalizeCity(originCity);
  const b = normalizeCity(destCity);
  if (a && b && a === b && WALK_DEFAULT_CITIES.has(a)) return "WALK";
  if (a && b && a === b) return "DRIVE"; // unknown small-city default
  return "DRIVE"; // cross-city is always drive
}

// Parse a 24h time string like "19:00" to minutes-since-midnight.
// Returns null on garbage.
function parseTimeMin(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Best-effort item duration in minutes. Looks at, in order:
//   1. item.duration_minutes (numeric, if present)
//   2. item.end_time minus item.time
//   3. Reasonable default per item.type
function inferDurationMin(item) {
  if (!item) return null;
  if (typeof item.duration_minutes === "number" && item.duration_minutes > 0) {
    return item.duration_minutes;
  }
  if (typeof item.end_time === "string" && typeof item.time === "string") {
    const start = parseTimeMin(item.time);
    const end = parseTimeMin(item.end_time);
    if (start !== null && end !== null && end > start) return end - start;
  }
  const defaults = {
    Activity: 60,
    Dinner: 120,
    Lunch: 90,
    Breakfast: 60,
    Brunch: 90,
  };
  return defaults[item.type] || null;
}

// Item types we never check (no fixed location, or transit handled
// separately).
const SKIP_TYPES = new Set([
  "Flight", "Transport", "Note", "Hotel", "Optional",
]);

// Pull lat/lng from a verified item. Items get .lat/.lng on themselves
// (Activity) or on .restaurant (Dinner/Lunch/Breakfast).
function itemCoords(item) {
  if (!item) return null;
  if (typeof item.lat === "number" && typeof item.lng === "number") {
    return { lat: item.lat, lng: item.lng };
  }
  if (item.restaurant && typeof item.restaurant.lat === "number" && typeof item.restaurant.lng === "number") {
    return { lat: item.restaurant.lat, lng: item.restaurant.lng };
  }
  return null;
}

// Get the canonical name for an item (used for messages + flag attach).
function itemName(item) {
  if (!item) return "(unknown)";
  if (typeof item.name === "string" && item.name) return item.name;
  if (item.restaurant && typeof item.restaurant.name === "string") return item.restaurant.name;
  if (typeof item.text === "string" && item.text) return item.text.slice(0, 60);
  return item.type || "(unknown)";
}

// Walk the plan and produce route-pair requests. Each pair represents
// an A->B adjacency we want to time-check.
//
// Returned shape:
//   [
//     {
//       id: "d{dayIdx}-i{itemIdx}-to-{nextItemIdx}",
//       dayIdx, fromItemIdx, toItemIdx,
//       originLat, originLng, destLat, destLng,
//       travelMode,
//       fromName, toName,
//       fromEndMin, toStartMin,  // for the later conflict check
//     },
//     ...
//   ]
//
// Caller posts the pairs to /api/routes-verify and feeds the response
// to applyPacingFlags() below.
export function collectPacingPairs(plan, _opts = {}) {
  if (!plan || !Array.isArray(plan.days)) return [];
  const pairs = [];
  for (let dayIdx = 0; dayIdx < plan.days.length; dayIdx++) {
    const day = plan.days[dayIdx];
    if (!Array.isArray(day?.items)) continue;
    const items = day.items;
    // The "city" field on the day tells us in-city vs cross-city.
    // For transit days the city is "From -> To"; the first item belongs
    // to From, the rest to To. We don't try to disambiguate that here;
    // the mode picker treats every same-day pair as same-city unless
    // both items explicitly carry different `city` fields. (Plan items
    // don't reliably carry that.)
    const dayCity = typeof day.city === "string" ? day.city.split(/\s*(?:→|->|\u2013|-)\s*/)[0] : "";

    let prevIdx = -1;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== "object") continue;
      if (SKIP_TYPES.has(item.type)) continue;
      // Need coords and a start time.
      const coords = itemCoords(item);
      const startMin = parseTimeMin(item.time);
      if (!coords || startMin === null) continue;
      if (prevIdx === -1) { prevIdx = i; continue; }

      const prev = items[prevIdx];
      const prevCoords = itemCoords(prev);
      const prevStart = parseTimeMin(prev.time);
      const prevDur = inferDurationMin(prev);
      if (!prevCoords || prevStart === null || prevDur === null) {
        prevIdx = i;
        continue;
      }
      // Same-venue check: identical place_id or identical coords -> skip.
      const samePlace = (typeof prev.place_id === "string" && typeof item.place_id === "string" && prev.place_id === item.place_id)
        || (Math.abs(prevCoords.lat - coords.lat) < 1e-6 && Math.abs(prevCoords.lng - coords.lng) < 1e-6);
      if (samePlace) { prevIdx = i; continue; }

      const fromEndMin = prevStart + prevDur;
      const mode = pickMode(dayCity, dayCity); // same-day default; refinement below
      pairs.push({
        id: `d${dayIdx}-i${prevIdx}-to-i${i}`,
        dayIdx,
        fromItemIdx: prevIdx,
        toItemIdx: i,
        originLat: prevCoords.lat,
        originLng: prevCoords.lng,
        destLat: coords.lat,
        destLng: coords.lng,
        travelMode: mode,
        fromName: itemName(prev),
        toName: itemName(item),
        fromEndMin,
        toStartMin: startMin,
      });
      prevIdx = i;
    }
  }
  return pairs;
}

// Threshold below which a buffer becomes a warn.
const TIGHT_BUFFER_MIN = 15;

// Apply route results to a plan and produce flags. Returns a NEW plan
// with PACING_* flags attached to the affected items.
//
// `routes` is the array from /api/routes-verify (the response.routes).
//
// Behavior:
//   - For each pair, look up its route by id.
//   - If route not found / error, no flag (don't false-positive on
//     missing data).
//   - Compute slack = (toStartMin - fromEndMin) * 60 - travel_seconds.
//   - slack < 0: PACING_IMPOSSIBLE (block) on both items.
//   - slack < TIGHT_BUFFER_MIN * 60: PACING_CONFLICT (warn) on both.
//   - Otherwise: pass.
export function applyPacingFlags(plan, pairs, routes) {
  if (!plan || !Array.isArray(plan.days)) return plan;
  if (!Array.isArray(pairs) || pairs.length === 0) return plan;
  if (!Array.isArray(routes)) return plan;

  const routeById = new Map();
  for (const r of routes) {
    if (r && typeof r.id === "string") routeById.set(r.id, r);
  }

  // Group flags by (dayIdx, itemIdx) so we can attach in one pass.
  const flagsByLoc = new Map(); // `${dayIdx}-${itemIdx}` -> [flags]
  const pushFlag = (dayIdx, itemIdx, flag) => {
    const k = `${dayIdx}-${itemIdx}`;
    if (!flagsByLoc.has(k)) flagsByLoc.set(k, []);
    flagsByLoc.get(k).push(flag);
  };

  let conflicts = 0;
  let impossibles = 0;

  for (const pair of pairs) {
    const r = routeById.get(pair.id);
    if (!r || !r.found || typeof r.duration_seconds !== "number") continue;
    const travelMin = r.duration_seconds / 60;
    const gapMin = pair.toStartMin - pair.fromEndMin;
    const slackMin = gapMin - travelMin;
    const km = typeof r.distance_meters === "number" ? Math.round(r.distance_meters / 1000) : null;
    const distLabel = km !== null ? ` (~${km} km)` : "";

    if (slackMin < 0) {
      impossibles += 1;
      const msg = `Travel from "${pair.fromName}" to "${pair.toName}"${distLabel} takes ~${Math.round(travelMin)} min, but only ${Math.round(gapMin)} min is scheduled between them.`;
      const flag = { code: "PACING_IMPOSSIBLE", severity: "block", message: msg };
      pushFlag(pair.dayIdx, pair.fromItemIdx, flag);
      pushFlag(pair.dayIdx, pair.toItemIdx, flag);
    } else if (slackMin < TIGHT_BUFFER_MIN) {
      conflicts += 1;
      const msg = `Only ~${Math.round(slackMin)} min buffer after travel from "${pair.fromName}" to "${pair.toName}"${distLabel} (travel ~${Math.round(travelMin)} min).`;
      const flag = { code: "PACING_CONFLICT", severity: "warn", message: msg };
      pushFlag(pair.dayIdx, pair.fromItemIdx, flag);
      pushFlag(pair.dayIdx, pair.toItemIdx, flag);
    }
  }

  if (flagsByLoc.size === 0) return plan;

  // Build a new plan with flags attached.
  const nextDays = plan.days.map((day, dayIdx) => {
    if (!Array.isArray(day?.items)) return day;
    let touched = false;
    const nextItems = day.items.map((item, itemIdx) => {
      const k = `${dayIdx}-${itemIdx}`;
      const newFlags = flagsByLoc.get(k);
      if (!newFlags) return item;
      touched = true;
      const existing = Array.isArray(item.flags) ? item.flags : [];
      return { ...item, flags: [...existing, ...newFlags] };
    });
    return touched ? { ...day, items: nextItems } : day;
  });

  const prevSummary = plan._verificationSummary || {};
  return {
    ...plan,
    days: nextDays,
    _verificationSummary: {
      ...prevSummary,
      pacing_conflicts: conflicts,
      pacing_impossibles: impossibles,
    },
  };
}

// Exported for tests.
export const _internals = {
  pickMode,
  parseTimeMin,
  inferDurationMin,
  itemCoords,
  itemName,
  WALK_DEFAULT_CITIES,
};
