// Real-world drive-time verification (added 2026-08-28).
//
// CLAUDE.md's KNOWN FAILURE MODE #18 documented an explicitly unfixed gap:
// a model-written narrative claimed an "11-hour drive" for the same leg its
// own Transport item described as "~7 hours" — and the writeup says outright
// "this app has no routing/distance API computing an authoritative drive
// duration," so neither number could be checked against anything real.
//
// TomTom's routing API closes that gap for the ITEM's own claimed duration
// (a structured, narrower problem than reconciling two pieces of free
// prose against each other, which stays out of scope here). Empirically
// verified against the real Bayeux → Nuremberg leg that KNOWN FAILURE MODE
// #18 was about: TomTom's real driving route is 1,066 km / 9h19m — meaning
// BOTH the narrative's "11 hours" and the item's own "~7 hours" were wrong.
//
// This module is pure client-side logic — no network. The actual TomTom
// calls live server-side in functions/api/drive-time-verify.js, following
// the exact architecture of src/bookingUrlCheck.js's stripDeadBookingUrls:
// collect candidates → an async hook POSTs them → a merge step turns the
// server's verdicts into day.structural_flags[] entries.
//
// Deliberately conservative, matching this codebase's established posture
// for any live-data check:
//   - Transport items only, never Flight (a flight's duration is airline
//     data, not a driving question) and never Note/Activity (too likely to
//     be describing something that isn't a point-to-point drive at all).
//   - Mode classification is scoped to the portion of the item's text
//     BEFORE the first dash — the "what is happening" clause — so a
//     duration/via clause mentioning an unrelated word can't flip the
//     classification.
//   - A short local hop (under MIN_CLAIMED_MINUTES) is skipped entirely —
//     address-level imprecision in geocoding a hotel-to-station taxi ride
//     dominates any signal at that scale, and it isn't the class of error
//     this check exists to catch.
//   - severity: "warn", never "block" — a routing API's estimate carries
//     real-world variance (exact addresses vs. city centers, live vs.
//     typical traffic, the traveler's actual route choice) that a Places
//     businessStatus field simply doesn't have.

const DASH_SPLIT_RE = /\s+[—–-]\s+/;
const ARROW_RE = /→|->|—>|–>/;

// Portion of the item's text BEFORE the first dash — mode classification
// and origin/destination extraction both work off this clause, not the
// "X min via Y" tail that follows it.
function leadClause(text) {
  const s = typeof text === "string" ? text : "";
  const parts = s.split(DASH_SPLIT_RE);
  return parts[0] || s;
}

// A genuine point-to-point drive: a car, taxi, rideshare, or private
// transfer. Excludes train/rail/ferry/flight/transit explicitly — those
// have their own real-world time profiles that TomTom's CAR routing would
// wrongly contradict every time.
const DRIVE_MODE_RE = /\b(drive|driving|driver|road trip|self-drive|private car|private transfer|car service|taxi|uber|lyft|rental car|van transfer|chauffeur|shuttle)\b/i;
const NON_DRIVE_MODE_RE = /\b(train|rail|ferry|flight|fly|metro|subway|tram|walk|bus)\b/i;

export function isDriveTransportItem(item) {
  if (!item || String(item.type || "").toLowerCase() !== "transport") return false;
  const lead = leadClause(item.text);
  if (!DRIVE_MODE_RE.test(lead)) return false;
  if (NON_DRIVE_MODE_RE.test(lead)) return false;
  return true;
}

// Parse a claimed duration out of item text. Handles "2h 45m", "1h",
// "11-hour drive", "~7 hours", "35 min", "90 minutes". Returns minutes, or
// null if nothing recognizable is present.
export function parseClaimedMinutes(text) {
  const s = typeof text === "string" ? text : "";
  const hourMatch = s.match(/(\d+(?:\.\d+)?)[\s-]*h(?:ours?|rs?)?\b(?:[\s,]*(\d+)\s*m(?:in(?:utes?)?)?\b)?/i);
  if (hourMatch) {
    const hours = parseFloat(hourMatch[1]);
    const mins = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
    if (Number.isFinite(hours)) return Math.round(hours * 60 + mins);
  }
  const minMatch = s.match(/(\d+)\s*m(?:in(?:utes?)?)?\b/i);
  if (minMatch) return parseInt(minMatch[1], 10);
  return null;
}

// Common leading mode-words that end up on the FROM side of an arrow split
// ("Taxi The Yeatman → Porto Campanhã station") — stripped so the leftover
// text is a plausible geocodable place name rather than "Taxi X".
const LEADING_MODE_WORDS_RE = /^(private\s+)?(transfer|taxi|uber|lyft|drive|driving|driver|rental\s+car(?:\s+pickup)?|van\s+transfer|shuttle|chauffeur|return\s+drive|car\s+service)\s*/i;

function cleanEndpoint(s) {
  return String(s || "")
    .replace(LEADING_MODE_WORDS_RE, "")
    .replace(/^(to|from)\s+/i, "")
    .trim();
}

// Extract rough origin/destination text from a drive item's lead clause.
// Mirrors src/dayContinuityCheck.js's parseRoute in spirit (arrow-split,
// else "to"-split) but returns raw place text for geocoding rather than
// resolving against a canonical city list — a different, narrower job.
function extractRoute(text) {
  const lead = leadClause(text);
  const arrow = lead.split(/\s*(?:→|->|—>|–>)\s*/);
  if (ARROW_RE.test(lead) && arrow.length >= 2) {
    return { from: cleanEndpoint(arrow[0]), to: cleanEndpoint(arrow[arrow.length - 1]) };
  }
  const toSplit = lead.split(/\s+to\s+/i);
  if (toSplit.length >= 2) {
    return { from: cleanEndpoint(toSplit[0]), to: cleanEndpoint(toSplit.slice(1).join(" to ")) };
  }
  return { from: "", to: "" };
}

// A cleaned endpoint too short to plausibly geocode ("A5", "the") is
// dropped rather than sent — better to skip a leg than send geocoding
// noise and risk a bogus "real" distance built on the wrong two points.
const MIN_ENDPOINT_LEN = 4;
const MIN_CLAIMED_MINUTES = 45;

// Walk the plan and return candidate drive legs to verify:
//   [{ dayIdx, itemIdx, day, origin, destination, claimedMinutes, label }]
//
// `cityContext(dayIdx)` optionally supplies the day's city/region to append
// to each endpoint for geocoding disambiguation ("Bayeux" alone is more
// reliably resolved as "Bayeux, France" than bare).
export function collectDriveLegs(plan, cityHint) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const out = [];
  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    const hint = typeof cityHint === "function" ? cityHint(day, dayIdx) : (cityHint || "");
    items.forEach((item, itemIdx) => {
      if (!isDriveTransportItem(item)) return;
      const claimedMinutes = parseClaimedMinutes(item.text);
      if (!claimedMinutes || claimedMinutes < MIN_CLAIMED_MINUTES) return;
      const { from, to } = extractRoute(item.text);
      if (from.length < MIN_ENDPOINT_LEN || to.length < MIN_ENDPOINT_LEN) return;
      out.push({
        dayIdx,
        itemIdx,
        day: dayIdx + 1,
        origin: hint ? `${from}, ${hint}` : from,
        destination: hint ? `${to}, ${hint}` : to,
        claimedMinutes,
        label: String(item.text || "").trim(),
      });
    });
  });
  return out;
}

// How far the server's real minutes must diverge from the claimed minutes
// before it's worth telling the traveler. Generous on purpose — routing
// APIs estimate typical driving conditions for SOME route choice, not
// necessarily the one a human would actually take, and this is a warn,
// not a block. Whichever is larger of a flat floor or a proportional
// margin, so short-ish legs aren't flagged by ordinary rounding.
const MISMATCH_FLOOR_MINUTES = 60;
const MISMATCH_RATIO = 0.35;

function isMismatch(claimedMinutes, realMinutes) {
  if (!Number.isFinite(realMinutes) || realMinutes <= 0) return false;
  const diff = Math.abs(claimedMinutes - realMinutes);
  const margin = Math.max(MISMATCH_FLOOR_MINUTES, realMinutes * MISMATCH_RATIO);
  return diff > margin;
}

function formatHM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Apply the server's real-drive-time verdicts to the plan. `results` is
// keyed the same way useDriveTimeVerification returns them: a Map from
// `${dayIdx}:${itemIdx}` to { realMinutes, realKm, error }.
//
// Returns { data, flags } — `data` is the input plan untouched (same
// reference) when nothing mismatched, matching stripDeadBookingUrls's
// cheap-memo contract.
export function applyDriveTimeFlags(plan, legs, results) {
  if (!plan || !Array.isArray(plan.days) || !results || typeof results.get !== "function" || legs.length === 0) {
    return { data: plan, flags: [] };
  }
  const mismatches = [];
  for (const leg of legs) {
    const r = results.get(`${leg.dayIdx}:${leg.itemIdx}`);
    if (!r || r.error || !Number.isFinite(r.realMinutes)) continue; // fail safe — no verdict, no flag
    if (!isMismatch(leg.claimedMinutes, r.realMinutes)) continue;
    mismatches.push({ ...leg, realMinutes: r.realMinutes, realKm: r.realKm });
  }
  if (mismatches.length === 0) return { data: plan, flags: [] };

  const byDay = new Map();
  for (const m of mismatches) {
    if (!byDay.has(m.dayIdx)) byDay.set(m.dayIdx, []);
    byDay.get(m.dayIdx).push(m);
  }

  const days = plan.days.map((day, dayIdx) => {
    const dayMismatches = byDay.get(dayIdx);
    if (!dayMismatches) return day;
    const prior = Array.isArray(day?.structural_flags) ? day.structural_flags : [];
    const newFlags = dayMismatches.map((m) => ({
      code: "DRIVE_TIME_IMPLAUSIBLE",
      severity: "warn",
      dayIdx: m.dayIdx,
      itemIdx: m.itemIdx,
      day: m.day,
      target: m.label,
      message: `"${m.label}" claims ${formatHM(m.claimedMinutes)}, but real driving time is ${formatHM(m.realMinutes)}${Number.isFinite(m.realKm) ? ` (${Math.round(m.realKm)} km)` : ""}.`,
    }));
    return { ...day, structural_flags: [...prior, ...newFlags] };
  });

  const flags = mismatches.map((m) => ({
    code: "DRIVE_TIME_IMPLAUSIBLE",
    severity: "warn",
    dayIdx: m.dayIdx,
    itemIdx: m.itemIdx,
    day: m.day,
    target: m.label,
    message: `"${m.label}" claims ${formatHM(m.claimedMinutes)}, but real driving time is ${formatHM(m.realMinutes)}${Number.isFinite(m.realKm) ? ` (${Math.round(m.realKm)} km)` : ""}.`,
  }));

  return { data: { ...plan, days }, flags };
}
