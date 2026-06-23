# Chunked Build Auto-Resume — Implementation Spec (verified against the repo)

Goal: if a chunked build is interrupted (tab closed, crash, PWA update, timeout),
reopening the page resumes it — recovering already-finished chunks from KV and
re-running ONLY the incomplete/missing/errored ones, then runs the wrapper +
stitch. Recover from partial failures without rebuilding the whole trip.

## Verified mechanics (do not re-derive)
- `ACTIVE_JOB_KEY = "trip-optimizer-active-job-v1"` (src/App.jsx ~10737).
- Single-call resume effect (~11946): reads ACTIVE_JOB_KEY; **bails if no `jobId`**
  (so a `{chunked:true}` payload does NOT trigger it); discards if age > 30 min;
  probes `GET /api/build/{jobId}?cursor=0` and only resumes if `status === "running"`,
  via `runBuildForJob`. KEEP THIS PATH WORKING UNCHANGED.
- `pollJob({ jobId, signal, onDelta, startCursor, maxPollMs })` (~10821): polls the
  GET endpoint, returns `{ len, stopReason }`, throws on error / `err.notFound`.
- GET `/api/build/[id]?cursor=N` (functions/api/build/[id].js): returns
  `{ ...status, cursor: full.length, delta: full.slice(N), stopReason? }`.
  - For a **done** chunk: `status.status === "done"` and `delta` (cursor 0) is the
    COMPLETE tool JSON → recover without re-running.
  - **running** → re-attach via pollJob.
  - **404 / notFound / error / absent jobId** → re-run that chunk.
- `parseToolJson(toolJson)` (~7253) → `{ parsed }`.
- `stitchPlan({ dayChunks, wrapper, expectedDays })` and `applyBuiltPlan(parsed,{nightsNum})`
  already exist and are the convergence point. `chunkMaxTokens`, `collectRestaurantNames`,
  `planDayChunks`, `isGenericMealName` in src/chunkPlan.js.
- `streamBuildJob(body, { signal, maxPollMs, onJob, onDelta })` → `{ toolJson, stopReason, jobId }`.

## Persistence change (in runChunkedBuild, ~11462 persistJobIds)
Extend the chunked ACTIVE_JOB_KEY payload so a resume can replay a missing chunk
FAITHFULLY (no prompt reconstruction / drift). Persist:
```
{
  chunked: true,
  version: 2,
  startedAt, nightsNum, citiesCount, destination,
  expectedDays,                       // nightsNum + 1
  chunks: [ { startDay, endDay, cityNames, maxTokens, jobId|null, status } ],
  // EXACT request bodies so a re-run is a replay, not a rebuild:
  chunkBodies: [ <the per-chunk Anthropic body> ],   // index-aligned to chunks
  wrapperBody: <the wrapper Anthropic body>,
}
```
- Total size ~32 KB for Croatia (3 chunks) — fine vs the ~5 MB localStorage cap.
  Guard the setItem in try/catch (already done); if it throws (quota), just skip
  persisting the bodies (resume degrades to "re-run from inputs" — acceptable).
- Update the payload after each chunk completes (mark that chunk status:"done",
  store its jobId) so a mid-run interruption knows exactly which chunks are done.

## Refactor: extract a resumable core from runChunkedBuild
Split `runChunkedBuild` so the generation+wrapper+stitch tail is callable from both
fresh and resume paths. Suggested shape:

- `generateChunk({ chunk, body, controller, maxPollMsForTrip, onJob })` →
  returns `{ toolJson, stopReason }`. Wraps the per-chunk `streamBuildJob`.
  Throws the cut-off error if `stopReason === "max_tokens"` (existing guard).
- `finishChunkedBuild({ chunkPlans, wrapperParsed, expectedDays, nightsNum })` →
  runs `stitchPlan` (mapping a thrown stitch error to the existing cut-off message)
  and calls `applyBuiltPlan`. Used by BOTH fresh and resume.
- `runChunkedBuild(...)` (fresh): unchanged externally; internally builds chunkBodies,
  persists them (version 2 payload), loops generateChunk, builds wrapper, parses,
  calls finishChunkedBuild. Keep the existing AbortController, progress messages,
  and the catch/finally (with the abort-preserves-key behavior already added).

## New helper: resumeChunkedBuild(saved)
`saved` is the parsed version-2 payload. Algorithm:
1. Set up controller (abortRef), elapsed timer, maxPollMs as in runChunkedBuild.
   setStep(2); setLoadingMsg(`Resuming build for ${saved.destination}…`).
2. const chunkPlans = []; const usedRestaurants = [];
3. For i in chunks (SEQUENTIAL, preserve order):
   - jobId = saved.chunks[i].jobId.
   - If jobId: GET `/api/build/{jobId}?cursor=0`.
       - status "done": parse delta → chunkPlan. (recovered, no re-run)
       - status "running": pollJob to accumulate, then parse → chunkPlan.
       - notFound/error/!ok: treat as MISSING → re-run.
   - If no jobId OR missing: re-run via generateChunk using
     `saved.chunkBodies[i]` (faithful replay). On a re-run we may want a FRESH
     usedRestaurants-injected body — but to keep it a faithful replay, just
     replay the stored body (dedupe is best-effort; stitchPlan dedupes anyway).
   - On max_tokens for a re-run: throw the cut-off error (don't stitch partial).
   - Push chunkPlan; append collectRestaurantNames(chunkPlan) to usedRestaurants.
   - Update persisted payload marking chunk i done with its (new) jobId.
4. Wrapper: if a wrapper jobId was persisted and is done/running, recover/poll it;
   else re-run `saved.wrapperBody`. Parse → wrapperParsed (soft-fail to {}).
5. finishChunkedBuild({ chunkPlans, wrapperParsed, expectedDays: saved.expectedDays,
   nightsNum: saved.nightsNum }). On success applyBuiltPlan clears ACTIVE_JOB_KEY.
6. Same catch/finally as runChunkedBuild (abort preserves key; notFound copy;
   else clear key + generic msg).

WAIT-FOR-FULL-SET: stitchPlan already throws if assembled days != expectedDays, so
the "stitcher waits for the full set" requirement is enforced — we only call
finishChunkedBuild after the loop has a chunkPlan for every chunk. Do NOT stitch
partial sets.

## Wire the resume-on-mount effect (~11946)
At the TOP of the existing effect, after parsing `saved`, branch:
```
if (saved?.chunked) {
  // age + basic shape guard (30 min staleness like single-call)
  if (age > 30*60*1000 || !Array.isArray(saved.chunks) || !saved.chunks.length) {
    localStorage.removeItem(ACTIVE_JOB_KEY); return;
  }
  // Only resume if at least one chunk job is still running OR recoverable.
  // Probe is done inside resumeChunkedBuild; just route to it.
  setStep(2);
  resumeChunkedBuild(saved);
  return;
}
// ...existing single-call path unchanged (requires saved.jobId)...
```
Keep `resumedRef` guard. The single-call branch must remain reachable and unchanged
for `saved.jobId` payloads.

## Tests (tests/test_*.mjs, repo assert style)
The resume logic is mostly in App.jsx (not easily unit-tested offline), but the
DECISION logic is pure and should be extracted + tested. Add to src/chunkPlan.js:
- `classifyChunkResume(statusObj)` → "recover" | "reattach" | "rerun".
  - null/notFound/!ok → "rerun"; status==="done" → "recover";
    status==="running" → "reattach"; status==="error" → "rerun".
Add `tests/test_chunk_resume.mjs` covering classifyChunkResume for each case, plus a
guard test that stitchPlan still rejects a partial set (already covered, re-assert).

## HARD REQUIREMENTS
- Single-call resume + fresh chunked build behavior UNCHANGED.
- `npx eslint src/` 0 errors. `npm test` green. `npm run build` ok.
- 2-space indent, double quotes. No new lint errors.
- Persisted bodies setItem must be quota-safe (try/catch; degrade gracefully).
```
