# Chunked Build — Implementation Spec (verified against the repo)

## Problem (confirmed, not guessed)
Large trips time out. Root cause is a MODEL OUTPUT-CEILING problem, documented
in `src/App.jsx` around the `maxTokensForTrip` comment block:
- `max_tokens` formula: `min(64000, max(8000, 5000 + (nights+1)*2200 + max(0,cities-1)*1200))`.
- 64000 is the Sonnet-4-5 hard output max. Cap has already been raised
  24k→32k→40k→48k→64k as real trips saturated each ceiling.
- At ~60 tok/s, 64k ≈ 17.5 min generation. Client polling ceiling
  (`MAX_POLL_MS`, src/App.jsx ~line 7166 and ~10830) is 15 min. So a maxed
  trip generates longer than the client waits → timeout.

Single-call builds cannot be fixed by raising a number. Fix = split the build.

## Output contract — `submit_trip_plan` (TRIP_PLAN_TOOL, src/App.jsx ~7875)
Plan object shape:
```
{
  destination: string,            // "A → B → C"
  meta: string,
  cities?: [{name,nights,days_range,focus,transport_in,stay}]  // multi-city, maxItems 3
  days: [ DAY_SCHEMA ],           // EXACTLY nights+1 entries. Token-dominant (~2200/day).
  logistics?: string[<=6],
  weather_window?: string,
  pack?: string[3..8],
  flags?: string[],
  planb?: string[>=5],
  snobs?: string[],
  tonight?: string[]
}
```
DAY_SCHEMA (src/App.jsx ~7857): `{ label, city?, headline*, weather*, pace_note?, items[>=3] }`.
Day `label` MUST copy the weekday stamp from the injected COMPUTED DATE TABLE.

Schema field order is deliberate: days[] before the small wrapper fields, so
truncation loses the tail (planb/snobs) not the itinerary. Chunking must
preserve this philosophy.

## Prompt builders (reuse, do NOT rewrite)
- `buildSystemPrompt()` → `{ staticRules, dynamicPreamble }` (src/App.jsx ~10171)
- `buildUserPrompt()` → string (src/App.jsx ~10644). Contains the COMPUTED
  DATE TABLE, city/leg ranges, all constraints (NO TRAINS, private driver, etc).
- `cachedSystemBlocks(staticRules, dynamicPreamble)` (src/App.jsx ~115) — keep
  using so the static rulebook stays the cached prefix.
- `cachedTools([TRIP_PLAN_TOOL])` (src/App.jsx ~88) — cache breakpoint on tools.

## Server (functions/api/build.js — verified)
- POST /api/build mints jobId, streams NDJSON, runs Anthropic in background
  (ctx.waitUntil pattern), persists chunks to `JOBS` KV under
  `job:<id>:text` / `job:<id>:status`. Reconnect via GET /api/build/[id].
- `upstreamBody = { ...body, stream: true }` — model + max_tokens come from the
  CLIENT body. Bindings: `JOBS` (KV), `ANTHROPIC_API_KEY`. Both soft-fail.

## DESIGN — implement this

### 1. Threshold (only chunk big trips; small/medium untouched)
- `SINGLE_CALL_TOKEN_BUDGET = 28000` (comfortably inside the time window).
- Compute `maxTokensForTrip` as today. If `<= SINGLE_CALL_TOKEN_BUDGET`, use the
  EXISTING single-call path unchanged (zero regression). Else, chunk.

### 2. Chunk planner (pure, unit-testable) — add to a NEW module
Create `src/chunkPlan.js` (lint-clean; eslint scans src/) exporting:
- `planDayChunks({ nights, cities })` → array of `{ startDay, endDay, cityNames }`.
  Rules:
  - Total days = nights + 1.
  - Respect leg boundaries: prefer to break chunks at city/leg boundaries
    using each city's nights (Leg ranges already computed in the user prompt:
    Leg 1 = Day 1..nights[0]+1, etc.). Never produce a chunk larger than
    ~6 days OR ~13200 est. tokens (6*2200), whichever is smaller.
  - Single-city: split into <=6-day windows (e.g. 14 nights → 15 days →
    [1-5][6-10][11-15]).
  - Each chunk is contiguous and non-overlapping; union == 1..(nights+1).
- `estimateChunkTokens(chunk)` → `5000_base_not_included`; per-chunk budget =
  `max(8000, (chunk.endDay-chunk.startDay+1)*2200 + 1500 continuity overhead)`.

### 3. Per-chunk generation
For each chunk, call /api/build with:
- Same system blocks (cached), same tools (cached, tool_choice submit_trip_plan).
- User prompt = `buildUserPrompt()` + an injected CHUNK CONSTRAINT block:
  ```
  CHUNK MODE — GENERATE ONLY Day {startDay}–Day {endDay}.
  Return days[] containing ONLY those days (in order). Do NOT include any other
  day. Omit logistics/weather_window/pack/flags/planb/snobs/tonight in chunk mode
  (a final pass produces them). Still copy weekday stamps from the DATE TABLE.
  Restaurants already used on earlier days (do NOT reuse): {usedRestaurantsList}.
  ```
- `max_tokens` = per-chunk budget (well under ceiling, fast).
- Run chunks SEQUENTIALLY so each can be told the prior chunk's used restaurants
  (dedupe) and last-day context. (Sequential keeps dedupe correct; the per-chunk
  calls are short so total wall-clock stays in-window and each chunk independently
  survives reconnect.)

### 4. Wrapper pass
One final call, small `max_tokens` (~6000), tool_choice submit_trip_plan, user
prompt = compact summary of the assembled days (labels + city + key picks) +
"GENERATE ONLY the wrapper fields: destination, meta, cities[], logistics,
weather_window, pack, flags, planb(>=5), snobs, tonight. Do NOT regenerate days."

### 5. Stitcher (pure, unit-testable) — add to `src/chunkPlan.js`
- `stitchPlan({ dayChunks: [planObj...], wrapper: planObj })`:
  - Concatenate all `days[]` in chunk order.
  - Validate `days.length === nights+1`; if a chunk came back short, surface a
    clear error (don't silently ship a truncated plan).
  - Merge wrapper fields over the days. cities[] from wrapper.
  - De-dupe restaurants defensively (case-insensitive on item name) — keep first
    occurrence, log dups.
  - Return one canonical plan object identical in shape to single-call output.

### 6. Client orchestration (src/App.jsx build call site ~11415–11575)
- Branch on threshold. Big trip → run chunk planner, then sequential per-chunk
  `streamBuildJob`/poll calls (reuse existing helpers), then wrapper call, then
  `stitchPlan`. Feed stitched plan into the SAME downstream parse/render path.
- Progress UI: setLoadingMsg(`Building days ${s}–${e} (chunk k/n)…`), then
  "Assembling final plan…". Keep cancel working (AbortController already used).
- Keep reconnect: each chunk is its own job; persist an array of jobIds in
  ACTIVE_JOB_KEY so a reopened window can resume the in-flight chunk.

## Tests (tests/test_*.mjs, repo assert convention, run-all.mjs autodiscovers)
Create `tests/test_chunk_plan.mjs`:
- planDayChunks: 3n/1c → single chunk [1-4] (under threshold caller wouldn't
  chunk, but planner still correct); 14n/1c → [1-5][6-10][11-15];
  12n/7c Croatia → chunks break on legs, none >6 days, union == 1..13.
- No overlap, full coverage, ordered, each <=6 days invariant.
- stitchPlan: concatenates days in order; rejects when day count != nights+1;
  dedupes a duplicated restaurant; merges wrapper fields; output shape matches
  contract (destination/meta/days present).
- Threshold boundary: a trip at 28000 uses single-call; 28001 chunks.

## Constraints
- Do NOT change the single-call path for small/medium trips.
- Keep prompt caching intact (cachedSystemBlocks + cachedTools).
- New src module must pass `eslint src/` (0 errors). Browser globals only;
  URLSearchParams/URL already added to eslint globals.
- `npm test`, `npm run lint`, `npm run build` must all pass.
- Match existing code style (2-space indent, double quotes, .mjs tests).
```
