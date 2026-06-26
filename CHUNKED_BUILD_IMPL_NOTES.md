# Chunked Build — Client Wiring Implementation Notes

Wires the pure planner/stitcher in `src/chunkPlan.js` into the client build
orchestration in `src/App.jsx`. Large trips now split into day-range chunks +
a wrapper pass instead of one maxed single call that times out. Small/medium
trips are untouched.

## Files touched

- `src/App.jsx` only. `src/chunkPlan.js` and its tests were not modified.

## Imports

- `src/App.jsx:6` — added
  `import { shouldChunk, planDayChunks, chunkMaxTokens, stitchPlan, collectRestaurantNames } from "./chunkPlan.js";`

## Functions touched / added

### `applyBuiltPlan(parsed, { nightsNum })` — NEW, `src/App.jsx:11213`
Extracted verbatim from the old post-parse tail of `runBuildForJob` (day-count
validation → `setResult`/`setStep(3)` → the two fire-and-forget grounding IIFEs:
confirm-booking and Places-verify/geocode/pacing). This is the single
convergence point both build paths feed their final plan into, so a chunked
plan renders and verifies identically to a single-call plan. No behavior change
for single-call — the code is the same, just relocated and called.

### `runBuildForJob(...)` — MODIFIED, `src/App.jsx:10962`
The streaming/parse/salvage logic is unchanged. The large inline downstream
block was replaced by a single call: `applyBuiltPlan(parsed, { nightsNum });`
(`src/App.jsx:11179`). Its own `try/catch/finally` (error messaging, timer
cleanup, wake-lock release) is preserved.

### `runChunkedBuild({ nightsNum, citiesCount, chunks, staticRules, dynamicPreamble, userPromptForBuild })` — NEW, `src/App.jsx:11408`
The chunked orchestrator:
1. Sets up its own `AbortController` (stored in `abortRef.current` so the
   existing Cancel button + hard-timeout abort work) and an elapsed timer.
2. Computes `systemBlocks = cachedSystemBlocks(staticRules, dynamicPreamble)`
   and `tools = cachedTools([TRIP_PLAN_TOOL])` ONCE and reuses them across every
   chunk + the wrapper, preserving the prompt-cache prefix.
3. Runs chunks SEQUENTIALLY. Per chunk: `user content = userPromptForBuild +
   CHUNK CONSTRAINT block` (spec §3 — "GENERATE ONLY Day s–e", omit wrapper
   fields, copy weekday stamps, do-not-reuse `{usedRestaurants}` list),
   `max_tokens = chunkMaxTokens(c)`, same `tools`/`tool_choice`. Calls
   `streamBuildJob(body, { signal, maxPollMs, onJob, onDelta })`, parses via the
   SAME `parseToolJson(toolJson)` helper the revision flows use, then appends
   `collectRestaurantNames(chunkPlan)` to `usedRestaurants`.
4. Wrapper pass: one call, `max_tokens: 6000`, user content = compact summary of
   the assembled days (label + city + up to 2 key item names) + "GENERATE ONLY
   the wrapper fields … return EMPTY days[]". Parsed with `parseToolJson`;
   wrapper parse failure soft-fails to `{}` (itinerary is the product).
5. `stitchPlan({ dayChunks: chunkPlans, wrapper, expectedDays: nightsNum + 1 })`;
   `console.warn`s any returned warnings; feeds `plan` into `applyBuiltPlan`.
6. Progress UI via `setLoadingMsg`: per chunk
   `Building days {s}–{e} (chunk i/n)…`, then `Assembling final plan…`.

### `handleBuild()` — MODIFIED, `src/App.jsx:11578`
After `userPromptForBuild` is finalized (incl. local-knowledge injection) and
`staticRules`/`dynamicPreamble` are computed, branch added at
`src/App.jsx:11746`:

```js
if (shouldChunk({ nights: nightsNum, citiesCount })) {
  const chunks = planDayChunks({ nights: nightsNum, cities: isMultiCity ? cities : null });
  await runChunkedBuild({ nightsNum, citiesCount, chunks, staticRules, dynamicPreamble, userPromptForBuild });
  return;
}
// existing single-call body + POST + runBuildForJob — UNCHANGED
```

`nightsNum`/`citiesCount` reuse the values `handleBuild` already computes
(multi-city derives total nights from `cities[]`).

## How the two paths converge

Single-call: `handleBuild` → POST `/api/build` → `runBuildForJob` (stream +
parse + salvage) → **`applyBuiltPlan(parsed)`**.

Chunked: `handleBuild` → `runChunkedBuild` (sequential `streamBuildJob` per
chunk + wrapper, each via `parseToolJson`) → `stitchPlan` → **`applyBuiltPlan(plan)`**.

Both terminate in `applyBuiltPlan`, which owns render + all grounding passes —
so downstream verification/booking/pacing behavior is identical.

## Error handling

If `stitchPlan` throws (a chunk came back short → assembled day count !=
nights+1), `runChunkedBuild` rethrows a clear "plan was cut off … one of the day
chunks came back short" message which surfaces through the existing
`setError` path / truncation copy, rather than shipping a broken plan.

## Cancel / abort

`runChunkedBuild` installs its own `AbortController` into `abortRef.current`,
and every `streamBuildJob` call receives `controller.signal`. An abort
mid-chunk throws `AbortError` out of the await, which the `catch` maps to the
existing "Build cancelled…" message and the `finally` cleans up timers + loading
state. The existing `handleCancel` (which calls `abortRef.current.abort()`)
works unchanged.

## NOT fully wired (intentional)

- **Chunked reconnect.** Per spec §6 we persist an array of chunk jobIds under
  `ACTIVE_JOB_KEY` (`{ chunked: true, jobIds: [...], ... }`) via `persistJobIds`
  as each chunk's jobId arrives. However the on-mount resume effect
  (`src/App.jsx` ~`useEffect` reading `ACTIVE_JOB_KEY`) only knows how to resume
  a single `saved.jobId` and bails early when `jobId` is absent — so the chunked
  shape does NOT auto-resume a reopened window, but it also does NOT break the
  existing single-call reconnect (the early `if (!saved?.jobId) return;` guard
  handles it). Full sequential chunk resume was judged too invasive for this
  change; the persisted jobIds are in place for a future follow-up. The key is
  cleared on success and on error.

## Verification

- `npx eslint src/` → 9 errors, all pre-existing at `src/App.jsx:1230–1279`
  (conditional hooks / URLSearchParams — fixed on a different branch). 0 new
  errors in the chunked code (~11200–11770).
- `npm run build` → succeeds.
- `npm test` → 801 passed, 1 failed (`test_form_defaults.mjs` — pre-existing,
  documented). `test_chunk_plan.mjs` 28/28 pass. No new failures.
