// Activity-count constraint classifier. Deterministic pre-build
// classification of the user's narrative + guidelines to extract any
// explicit cap on activity counts.
//
// Why this module exists: the prompt rules at App.jsx ~12004-12005
// (DAY-SCOPED REQUESTS and TRIP-TOTAL REQUESTS) rely entirely on the
// model recognizing the user's phrasing as one of the listed examples.
// Novel phrasings like "during the entire itinerary" slip through the
// pattern-match and the model falls back to per-day pacing defaults.
//
// User reported 2026-06-30 ~6:54 PM EDT: "I told it to give me one
// activity during the entire itinerary; it gave me at least one per
// day instead."
//
// The structural fix is two-fold:
//
//   1. (THIS MODULE) Pre-build classifier. Scans narrative + guidelines
//      with a richer regex set than the prompt examples cover. Returns
//      a structured constraint the prompt assembly can inject as a
//      hard machine-readable cap.
//   2. Post-build cap enforcement in applyQualityLayer. After the
//      model returns, count actual Activity items and trim if the
//      model exceeded the user's cap. Belt + suspenders.
//
// Pure function: never throws, never mutates inputs.

// Phrasings that scope a count to the ENTIRE trip. Captures the count
// in group 1 if present, leaves it null for "minimal" / soft phrasings.
//
// Patterns matched (case-insensitive):
//   "N activities total"
//   "N activities in total"
//   "N total activities"
//   "N activities for the (entire/whole) trip|itinerary|vacation|stay|week|trip"
//   "N activities (across|during|throughout|in|for) the (entire/whole) (trip|itinerary|vacation|stay|week)"
//   "N activities across the week"
//   "just N (things|activities|stops|outings)"
//   "only N (things|activities|stops|outings)"
//   "N (or fewer|or less) activities"
//   "(only|just) one|two|... activity|activities" (word-form numbers)
//   "one activity (during|across|for|in) the (entire|whole) (itinerary|trip|...)"
//
// Returns the matched phrasing-anchor for the test suite to assert against.
const WORD_TO_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  "a single": 1, "a couple": 2, "a few": 3,
};

// Map a digit-or-word match to an integer, or null.
function toCount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (WORD_TO_NUM[s] !== undefined) return WORD_TO_NUM[s];
  return null;
}

// Trip-total phrasings, ordered most-specific first so the first match
// wins. Each pattern captures the COUNT (digits or word) in group 1.
// The "scope marker" is part of the pattern itself — we don't need
// to capture it.
//
// Whole-trip nouns we recognize as scope markers: itinerary, trip,
// vacation, stay, week, weekend, getaway, holiday, journey.
const SCOPE_WORDS = "(?:itinerary|trip|vacation|stay|week|weekend|getaway|holiday|journey|stays?)";
const COUNT_DIGIT = "(\\d{1,2})";
const COUNT_WORD = "(one|two|three|four|five|six|seven|eight|nine|ten)";
const COUNT_ANY = `(?:${COUNT_DIGIT}|${COUNT_WORD})`;

const TRIP_TOTAL_PATTERNS = [
  // "N activities total" / "N activities in total" / "N total activities"
  new RegExp(`\\b${COUNT_ANY}\\s+(?:activities|things|stops|outings|excursions)\\s+(?:in\\s+)?total\\b`, "i"),
  new RegExp(`\\b${COUNT_ANY}\\s+total\\s+(?:activities|things|stops|outings|excursions)\\b`, "i"),
  // "a total of N activities"
  new RegExp(`\\ba\\s+total\\s+of\\s+${COUNT_ANY}\\s+(?:activities|things|stops|outings|excursions)\\b`, "i"),
  // "N activities (for|across|during|throughout|in) the (entire|whole) <scope>"
  new RegExp(`\\b${COUNT_ANY}\\s+(?:activities|things|stops|outings|excursions)\\s+(?:for|across|during|throughout|in|over)\\s+the\\s+(?:entire|whole|full|complete)\\s+${SCOPE_WORDS}\\b`, "i"),
  // "N activities (for|across|during|throughout|in) the <scope>" (no entire/whole adjective)
  new RegExp(`\\b${COUNT_ANY}\\s+(?:activities|things|stops|outings|excursions)\\s+(?:across|throughout|over)\\s+the\\s+${SCOPE_WORDS}\\b`, "i"),
  // "N activities for the (trip|stay|week)" — bare "for" with no "entire"/"whole"
  new RegExp(`\\b${COUNT_ANY}\\s+(?:activities|things|stops|outings|excursions)\\s+for\\s+the\\s+${SCOPE_WORDS}\\b`, "i"),
  // "(just|only) N (activities|things)"
  new RegExp(`\\b(?:just|only)\\s+${COUNT_ANY}\\s+(?:activity|activities|thing|things|stop|stops|outing|outings|excursion|excursions)\\b(?!\\s+(?:on|each|per))`, "i"),
  // "N activities or (fewer|less)"
  new RegExp(`\\b${COUNT_ANY}\\s+(?:activities|things)\\s+or\\s+(?:fewer|less)\\b`, "i"),
  // "no more than N activities" / "at most N activities"
  new RegExp(`\\b(?:no\\s+more\\s+than|at\\s+most|max(?:imum)?\\s+of)\\s+${COUNT_ANY}\\s+(?:activities|things)\\b`, "i"),
  // "N activities max/maximum/only/tops"
  new RegExp(`\\b${COUNT_ANY}\\s+(?:activities|things)\\s+(?:max|maximum|only|tops)\\b`, "i"),
  // "limit (to) N activities" / "keep (it) to N activities" / "cap (at) N activities"
  new RegExp(`\\b(?:limit(?:ed)?\\s+(?:to|activities?\\s+to)|keep\\s+(?:it\\s+)?to|cap(?:ped)?\\s+(?:at\\s+)?)\\s*${COUNT_ANY}\\s+(?:activity|activities|things?)\\b`, "i"),
  // Constraining verbs: "want/need/prefer/include/plan/schedule/give me N activities"
  // Negative lookahead blocks per-day qualifiers ("on Day 3", "each day", "per day", "a day", "daily")
  new RegExp(`\\b(?:want|need|prefer|include|plan|schedule)\\s+(?:only\\s+|just\\s+)?${COUNT_ANY}\\s+(?:activity|activities|thing|things|outing|outings|excursion|excursions)\\b(?!\\s+(?:on\\s+day|each\\s+day|per\\s+day|a\\s+day|daily|on\\s+(?:mon|tue|wed|thu|fri|sat|sun)))`, "i"),
  new RegExp(`\\bgive\\s+me\\s+(?:only\\s+|just\\s+)?${COUNT_ANY}\\s+(?:activity|activities|thing|things|outing|outings)\\b(?!\\s+(?:on\\s+day|each\\s+day|per\\s+day|a\\s+day|daily))`, "i"),
  // "(only|just) one activity (during|across|for|in|throughout|over) the (entire|whole) <scope>"
  new RegExp(`\\b(?:only|just)?\\s*${COUNT_ANY}\\s+activity\\s+(?:during|across|for|in|throughout|over)\\s+the\\s+(?:entire|whole|full|complete)?\\s*${SCOPE_WORDS}\\b`, "i"),
  // "one activity (during|in|for|across) the (entire|whole)? <scope>"
  new RegExp(`\\b${COUNT_ANY}\\s+activity\\s+(?:during|across|for|in|throughout|over)\\s+the\\s+(?:entire|whole|full|complete)?\\s*${SCOPE_WORDS}\\b`, "i"),
  // "one (thing|stop|outing) (for|during|across|in) the trip" — flexible noun
  new RegExp(`\\b${COUNT_ANY}\\s+(?:thing|stop|outing|excursion)\\s+(?:for|during|across|in|throughout|over)\\s+the\\s+(?:entire|whole|full|complete)?\\s*${SCOPE_WORDS}\\b`, "i"),
];

// Day-scoped phrasings: count is anchored to a SPECIFIC day. The
// prompt rule already handles these reasonably (PR #14 / #81); we
// classify them defensively so the trip-total enforcement does NOT
// fire on these by mistake. The classifier returns "day-scoped"
// without trimming \u2014 the day-scoped prompt rule continues to handle
// the actual enforcement, and the post-build cap stays off.
//
// Patterns matched:
//   "N activities on Day X" / "N activities on Tuesday"
//   "only N activity on Day X"
//   "keep (Day X|the Nth|Tuesday) light"
const DAY_SCOPED_PATTERNS = [
  new RegExp(`\\b${COUNT_ANY}\\s+(?:activity|activities|thing|things)\\s+on\\s+(?:day\\s+\\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the\\s+\\d{1,2}(?:st|nd|rd|th))\\b`, "i"),
  new RegExp(`\\b(?:just|only)\\s+${COUNT_ANY}\\s+(?:activity|thing)\\s+on\\s+(?:day\\s+\\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b`, "i"),
];

// Classify an inputs blob into a structured activity-count constraint.
//
// Returns:
//   { scope: "trip-total", count: N, matchedPhrase: string }
//   { scope: "day-scoped", count: N, matchedPhrase: string }
//   { scope: "none" }
//
// Trip-total wins over day-scoped if both match (rare, but defensible:
// an explicit "10 activities total, just one on Tuesday" should cap
// at 10 globally and let day-scoped handle Tuesday).
export function classifyActivityCountConstraint(inputs) {
  if (!inputs || typeof inputs !== "object") return { scope: "none" };
  const blob = `${inputs.narrative || ""}\n${inputs.guidelines || ""}`.trim();
  if (!blob) return { scope: "none" };

  // Try trip-total first.
  for (const re of TRIP_TOTAL_PATTERNS) {
    const m = blob.match(re);
    if (m) {
      const count = toCount(m[1]) ?? toCount(m[2]);
      if (count !== null && count > 0 && count <= 20) {
        return { scope: "trip-total", count, matchedPhrase: m[0] };
      }
    }
  }

  // Then day-scoped (informational only; the prompt handles enforcement).
  for (const re of DAY_SCOPED_PATTERNS) {
    const m = blob.match(re);
    if (m) {
      const count = toCount(m[1]) ?? toCount(m[2]);
      if (count !== null && count > 0 && count <= 20) {
        return { scope: "day-scoped", count, matchedPhrase: m[0] };
      }
    }
  }

  return { scope: "none" };
}

// Render a hard machine-readable prompt rule that the model MUST honor.
// Injected when the classifier returns a trip-total constraint.
//
// Returns null when no constraint applies (caller injects nothing).
//
// The injected text is intentionally short, explicit, and machine-
// readable so the model has zero room to misinterpret. It complements
// the longer existing TRIP-TOTAL REQUESTS rule rather than replacing
// it \u2014 the existing rule keeps its explanatory framing, this adds a
// hard numeric ceiling.
export function renderActivityCountPromptRule(constraint) {
  if (!constraint || constraint.scope !== "trip-total") return null;
  const n = constraint.count;
  return `\n\nACTIVITY-COUNT HARD CAP (overrides per-day pacing for the whole trip): The traveler specified exactly ${n} activity item(s) across the ENTIRE trip. The complete days[].items[] arrays MUST sum to exactly ${n} entries of type "Activity" (not more, not fewer). Place those ${n} activities on the ${n} most appropriate days. Every other day has ZERO Activity items \u2014 those days are arrival/departure + Hotel + Dinner, or Hotel + Dinner + morning ambiance only. The "at least 3 items per day" guideline YIELDS to this cap. Detected from the narrative: "${(constraint.matchedPhrase || "").slice(0, 120)}".`;
}

// Count Activity items across a plan's days. Pure function; never
// mutates. Returns total count and a per-day breakdown.
export function countActivities(days) {
  if (!Array.isArray(days)) return { total: 0, perDay: [] };
  const perDay = days.map((d, i) => {
    const items = Array.isArray(d?.items) ? d.items : [];
    const count = items.filter((it) => it?.type === "Activity").length;
    return { dayIndex: i, count, label: d?.label || `Day ${i + 1}` };
  });
  const total = perDay.reduce((acc, p) => acc + p.count, 0);
  return { total, perDay };
}

// Enforce a trip-total activity cap on a plan. If the plan has more
// Activity items than the cap, trim the excess.
//
// Trimming policy:
//   1. Sort days by activity count DESCENDING. Remove from the days
//      with the most activities first \u2014 levels out the distribution.
//   2. Within a day, remove the LAST Activity item (model tends to
//      list highest-priority first). This is a heuristic; the model's
//      ordering is the only signal we have.
//   3. Repeat until total \u2264 cap.
//
// Returns a new days array (immutable update) plus a fixes log.
// Never mutates the input.
export function enforceTripTotalActivityCap(days, cap) {
  if (!Array.isArray(days) || typeof cap !== "number" || cap < 0) {
    return { days, fixes: [], trimmed: 0 };
  }
  const { total } = countActivities(days);
  if (total <= cap) return { days, fixes: [], trimmed: 0 };

  // Work on a shallow clone we can mutate locally; final result is
  // returned as a new array.
  const cloned = days.map((d) => ({
    ...d,
    items: Array.isArray(d?.items) ? d.items.slice() : d?.items,
  }));

  let excess = total - cap;
  const fixes = [];
  let safetyCounter = 200; // prevent any infinite loop

  while (excess > 0 && safetyCounter > 0) {
    safetyCounter -= 1;
    // Rebuild per-day counts each pass (cheap; tiny arrays).
    const counts = cloned.map((d, i) => ({
      i,
      count: Array.isArray(d.items) ? d.items.filter((it) => it?.type === "Activity").length : 0,
    }));
    counts.sort((a, b) => b.count - a.count || a.i - b.i);
    const top = counts[0];
    if (!top || top.count === 0) break;

    // Find the LAST Activity item in that day's items[] and remove it.
    const items = cloned[top.i].items;
    let removedAt = -1;
    for (let k = items.length - 1; k >= 0; k -= 1) {
      if (items[k]?.type === "Activity") {
        removedAt = k;
        break;
      }
    }
    if (removedAt < 0) break;
    const removed = items[removedAt];
    cloned[top.i].items = items.slice(0, removedAt).concat(items.slice(removedAt + 1));
    const label = cloned[top.i].label || `Day ${top.i + 1}`;
    const headName =
      removed?.activity?.name ||
      removed?.activity?.title ||
      removed?.text ||
      "activity";
    fixes.push(`${label}: trimmed "${headName}" to honor trip-total cap of ${cap}`);
    excess -= 1;
  }

  return { days: cloned, fixes, trimmed: total - cap - excess };
}
