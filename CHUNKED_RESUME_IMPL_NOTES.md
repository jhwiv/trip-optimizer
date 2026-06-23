# Chunked Build Auto-Resume — Implementation Notes

Implements the spec in `CHUNKED_RESUME_SPEC.md`: a chunked build interrupted by a
closed tab / crash / PWA update / timeout now resumes when the page reopens,
recovering already-finished chunks from KV and re-running ONLY the
missing/errored ones, then the wrapper, then stitching via the same path a fresh
build uses.

All edits are in `src/App.jsx`. `src/chunkPlan.js` and its tests were NOT
modified — `classifyChunkResume` and `stitchPlan` were already present with
passing tests (`tests/test_chunk_resume.mjs` 10, `tests/test_chunk_plan.mjs` 44).

## Files touched

- `src/App.jsx` only.

## Import

- `src/App.jsx:6` — added `classifyChunkResume` to the existing `chunkPlan.js`
  import:
  `import { shouldChunk, planDayChunks, chunkMaxTokens, stitchPlan, collectRestaurantNames, classifyChunkResume } from "./chunkPlan.js";`

## Shared helpers extracted (used by BOTH fresh build + resume)

### `generateChunk({ body, controller, maxPollMsForTrip, onJob, chunkLabel })` — NEW (~`src/App.jsx:11419`)
Wraps a single per-chunk `streamBuildJob` call. Throws the existing cut-off error
when `stopReason === "max_tokens"` (a truncated chunk must fail loudly, never be
stitched). Returns `{ toolJson, stopReason }`.

### `finishChunkedBuild({ chunkPlans, wrapperParsed, expectedDays, nightsNum })` — NEW (~`src/App.jsx:11443`)
The convergence tail: `stitchPlan(...)` then `applyBuiltPlan(...)`. A thrown
stitch error (assembled day count != `expectedDays` → a chunk came back short)
is mapped to the existing "plan was cut off … one of the day chunks came back
short" message rather than shipping a broken plan. Because both paths only call
this AFTER the loop has a `chunkPlan` for every chunk, stitchPlan's own
day-count check enforces the "wait for the full set" requirement.

## Persistence (version 2) — `runChunkedBuild` (~`src/App.jsx:11467`)

The chunked `ACTIVE_JOB_KEY` payload was upgraded so a resume can replay a
missing chunk FAITHFULLY (no prompt reconstruction / drift). Shape:

```
{
  chunked: true,
  version: 2,
  startedAt, nightsNum, citiesCount, destination,
  expectedDays,                       // nightsNum + 1
  chunks: [ { startDay, endDay, cityNames, maxTokens, jobId|null, status } ],
  chunkBodies: [ <exact per-chunk Anthropic body> ],   // index-aligned to chunks
  wrapperBody: <exact wrapper Anthropic body>,
  wrapperJobId: <id|null>,
}
```

- `persist()` is quota-safe: it tries the full payload (with `chunkBodies` +
  `wrapperBody`) first; if `localStorage.setItem` throws (quota), it retries with
  the slim base payload (no bodies). Resume then degrades to "re-run missing
  chunks from inputs" only for chunks whose body was dropped — recovery of
  already-finished chunks from KV still works.
- The payload is re-persisted: before each chunk call (stores its body), when a
  chunk's `jobId` arrives (`onJob`), after a chunk finishes (`status:"done"`),
  before the wrapper call (stores `wrapperBody`), and when the wrapper `jobId`
  arrives. So a mid-run interruption always knows exactly which chunks are done.

The fresh `runChunkedBuild` loop now calls `generateChunk(...)` and the
wrapper/stitch tail calls `finishChunkedBuild(...)` — externally unchanged
(same progress messages, AbortController/abortRef, catch/finally with
abort-preserves-key behavior).

## New: `resumeChunkedBuild(saved)` (~`src/App.jsx:11668`)

`saved` is the parsed version-2 payload (validated by the effect: `chunked`,
fresh, non-empty `chunks[]`). Algorithm:

1. Set up its own `AbortController` → `abortRef.current` (so Cancel + hard
   timeout work), elapsed timer, `maxPollMsForTrip`, and a local `persist()`
   that rewrites the same version-2 shape (preserving stored bodies for chunks
   not yet re-run). `setStep(2)` + `setLoadingMsg("Resuming build for …")`.
2. SEQUENTIAL loop over `saved.chunks`. For each chunk with a `jobId`, probe
   `GET /api/build/{jobId}?cursor=0` and pass the result to
   `classifyChunkResume`:
   - `"recover"` (status `done`) → `parseToolJson(statusObj.delta)` — the delta
     at cursor 0 is the complete tool JSON; no re-run.
   - `"reattach"` (status `running`) → `pollJob(..., startCursor:0)` accumulating
     `delta` into a string, then parse.
   - `"rerun"` (no jobId / notFound / error / network blip) → replay the EXACT
     `saved.chunkBodies[i]` via `generateChunk`. If that body is missing (quota
     fallback dropped it) → throw "Cannot resume — saved plan data is
     incomplete. Tap Build again." A re-run that hits `max_tokens` throws the
     cut-off error (no partial stitch).
   - Each finished chunk: push plan, append `collectRestaurantNames`, mark
     `status:"done"`, `persist()`.
3. Wrapper: same recover / reattach / rerun decision on `wrapperJobId`; a
   `"rerun"` replays `saved.wrapperBody`. The wrapper is non-essential — ANY
   failure soft-fails to `{}` (an `AbortError` is re-thrown so cancel still
   surfaces correctly).
4. `finishChunkedBuild({ chunkPlans, wrapperParsed, expectedDays:
   saved.expectedDays, nightsNum: saved.nightsNum })`. On success
   `applyBuiltPlan` clears `ACTIVE_JOB_KEY`.
5. `catch`/`finally` identical to `runChunkedBuild`: an abort/timeout keeps the
   key (so reopening can resume again); `err.notFound` → "expired" copy + clear;
   any other error → clear + the error message; `finally` clears timers, resets
   `abortRef.current`, and resets loading/progress state.

## Resume-on-mount wiring (~`src/App.jsx:12217`)

In the existing resume effect, immediately after `saved` is parsed and BEFORE
the single-call `if (!saved?.jobId) return;` guard:

```js
if (saved?.chunked) {
  const chunkedAge = Date.now() - (saved.startedAt || 0);
  if (chunkedAge > 30 * 60 * 1000 || !Array.isArray(saved.chunks) || !saved.chunks.length) {
    try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
    return;
  }
  Promise.resolve().then(() => resumeChunkedBuild(saved));
  return;
}
```

- 30-min staleness + shape guard mirror the single-call path.
- The call is deferred with `Promise.resolve().then(...)` so `resumeChunkedBuild`'s
  synchronous `setState` calls run outside the effect body — matching how the
  single-call branch only flips state inside its async probe `.then` (this also
  satisfies the `react-hooks/set-state-in-effect` lint rule, which traces into
  the local function). `resumeChunkedBuild` itself calls `setStep(2)`.
- The `resumedRef` guard and the single-call branch (which requires
  `saved.jobId`) are unchanged and remain reachable for single-call payloads.

## What is NOT changed

- Single-call resume (`saved.jobId` path) — untouched.
- Fresh chunked build — externally unchanged; internally now shares
  `generateChunk` + `finishChunkedBuild`, with version-2 persistence.
- `src/chunkPlan.js` and its tests — untouched.

## Verification

- `npx eslint src/` → 0 errors (24 warnings, all pre-existing — unused vars /
  unused eslint-disable directives elsewhere in the file; none in the new code).
- `npm run build` → succeeds.
- `npm test` → 828 passed, 0 failed across 23 suites, including
  `test_chunk_plan.mjs` (44) and `test_chunk_resume.mjs` (10).
