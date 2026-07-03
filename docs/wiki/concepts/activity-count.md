# Activity Count — Root Cause, Fix History, and Remaining Gap

This is the complete technical record of the "too many activities" recurrence.  
Last updated: 2026-07-03.

---

## Why this is hard

Activity count is controlled by **three competing forces** in the build prompt, and the wrong one wins when the others are silent:

| Force | Where | Strength |
|---|---|---|
| Pacing rule (`ACTIVITY COUNT PER FULL DAY`) | static system prompt | "should" / default |
| MARQUEE SIGHTS rule (`MUST explicitly schedule each`) | static system prompt | **MUST** — overrides pacing |
| Trip-total classifier (`ACTIVITY-COUNT HARD CAP`) | injected dynamically from `activityCountConstraint.js` | Hard cap — strongest |

When the user doesn't specify a count and the marquee list for the destination has 4–6 entries, the MUST-language of the MARQUEE rule beats the pace default and produces 2–4 activities per full day regardless of what the pacing rule says.

---

## Full fix history (chronological)

### Fix 1 — PR #99, 2026-06-30 (on master)
**Commit:** `f5903f2`  
**What:** Added `TRIP-TOTAL REQUESTS` rule to the system prompt. First attempt to teach the model to honor trip-total activity counts when the user phrases it certain ways ("2 activities for the trip", "just 3 things total", etc.).  
**Why it wasn't enough:** Pattern-matching only. Novel phrasings like "one activity during the entire itinerary" or "I want 2 activities" didn't match the listed examples → model silently fell back to per-day pacing.

### Fix 2 — PR #112, 2026-06-30 (on master)
**Commit:** `35457ed` (precursor in original session, then extended)  
**Files:** `src/activityCountConstraint.js` (new), `src/App.jsx` (wired in), `tests/test_activity_count_constraint.mjs` (51 assertions)  
**What:** Belt + suspenders:
- **Belt (pre-build):** `classifyActivityCountConstraint()` scans narrative + guidelines with a rich regex set. When it matches, `renderActivityCountPromptRule()` injects a machine-readable hard cap (`ACTIVITY-COUNT HARD CAP (overrides per-day pacing)`) into the dynamic preamble.
- **Suspenders (post-build):** `enforceTripTotalActivityCap()` in `applyQualityLayer` counts actual Activity items and trims the excess, removing the last Activity from whichever day has the most — so the model can never exceed the cap regardless of what it generates.

**Original regex patterns covered:** "N activities total", "N total activities", "N activities for the trip", "just/only N activities", "N activities or fewer", "no more than N activities", "one activity during/across/for the itinerary."

**Why it wasn't enough:** Only caught explicit phrasings like "give me N activities for the trip." Natural-language variants like "I want 2 activities" or "need 2 activities" or "2 activities max" still slipped through.

### Fix 3 — this session, commit `35457ed` (on feature branch `claude/cloudflare-access-setup-e41hbs`)
**What:** Extended `TRIP_TOTAL_PATTERNS` in `activityCountConstraint.js` with 5 new groups:
- `"a total of N activities"`
- `"N activities max/maximum/tops"`
- `"limit/keep/cap (to/at) N activities"`
- Verb-prefixed: `"want/need/prefer/include/plan/schedule N activities"` (with negative lookahead blocking per-day qualifiers like "per day", "each day", "on Day 3")
- `"give me N activities"` (with same negative lookahead)

**Test coverage:** 15 new cases verified. Per-day qualifiers ("I want 2 activities per day", "need 2 activities on day 3") correctly excluded.

### Fix 4 — this session, commit `e5d9e22` (on feature branch)
**What:** Tightened the pacing rule in the static system prompt. Changed the vague "at least 3 items" guidance to explicit per-pace caps:
- `"Relaxed" or no pace specified = exactly 1 Activity item per full day`
- `"Moderate" = exactly 2 Activity items per full day`
- `"Full" = 3 Activity items per full day`

Added: marquee sights count toward the limit (don't stack on top), arrival/departure days always get 0–1 regardless of pace.

### Fix 5 — this session, commit `67abd8e` (on feature branch)
**What:** Changed the user-prompt default from `Pace: No preference` (which the model interpreted as "go comprehensive") to `Pace: Relaxed (1 activity/day) — traveler did not specify; use this conservative default`.

---

## Why the Charleston build produced 12 activities (2026-07-03)

The build was done at **routesmith.ai (production)**, which deploys from `master`. Fixes 3–5 are on the feature branch and have **not yet been merged to master**. Production was running the PR #112 code (Fix 2) with no pacing defaults and no extended classifier.

Math:
- Charleston has a large marquee list (Waterfront Park, Rainbow Row, Fort Sumter, Battery, Market Street, Fort Moultrie — 6 sights)
- MARQUEE rule says **MUST** schedule each one as a dedicated Activity item
- No pace specified → production code sends `Pace: No preference` → model defaults to ~4 activities per full day
- 3 full days × 4 activities/day = **12 activities**
- The classifier (`activityCountConstraint.js`) found no trip-total phrase in the narrative, so no hard cap was injected and the post-build enforcer had nothing to trim against

---

## Remaining gap after Fixes 3–5 merge

Even after all five fixes are on production, there is a **structural conflict** between the pacing rule and the MARQUEE SIGHTS rule:

> `MARQUEE SIGHTS — NEVER ASSUME, ALWAYS SCHEDULE: Every destination has 2–6 marquee sights… You MUST explicitly schedule each one as a dedicated Activity item.`

This `MUST` language **outranks** the pacing cap's "hard maximum" framing in the model's priority ordering. For a destination like Charleston with 6 marquees and 3 full days at Relaxed pace (1 activity/day cap = 3 total), the model faces a contradiction: schedule 6 mandatory marquees OR honor the 1/day cap. The model will typically honor the MUST and violate the cap.

**The fix:** The MARQUEE rule needs an explicit yield clause:

> _"If the traveler's pace cap (from the ACTIVITY COUNT rule above) allows fewer activities than the number of marquee sights, schedule only the top N sights by significance — where N is the cap. Remaining sights go into planb[] as alternatives."_

This has not yet been implemented. Until it is, a plain "4 nights in Charleston" build will still produce more than 1 activity per day even after Fixes 3–5 merge, because the marquee list overrides the pacing cap.

---

## The two-layer pattern (belt + suspenders)

Any future recurrence of this class ("model ignores a constraint the user stated or that has a default") should follow this shape:

1. **Pre-build (belt):** Deterministic classifier or rule injection in the dynamic preamble. Machine-readable language with explicit values the model cannot misinterpret. Strong: "HARD CAP — do not exceed."
2. **Post-build (suspenders):** Code-level enforcer in `applyQualityLayer` that counts/trims/strips after the model responds. The model gets zero benefit from ignoring the belt because the code corrects it anyway.

The two work together: the belt prevents the problem, the suspenders catch it if it slips through anyway.

---

## Files

| File | Role |
|---|---|
| `src/activityCountConstraint.js` | Classifier, prompt renderer, count helper, post-build enforcer |
| `src/App.jsx` ~12795–12796 | Wires classifier into dynamic preamble |
| `src/App.jsx` ~12598 | Pacing rule (pace-driven caps) |
| `src/App.jsx` ~12643–12646 | MARQUEE SIGHTS rule (conflict source) |
| `src/App.jsx` ~12854 | User prompt pace default |
| `tests/test_activity_count_constraint.mjs` | 51+ assertions + recurrence guard |
