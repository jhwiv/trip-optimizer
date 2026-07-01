# Build stall watchdog & KV-poll resume (#24)

**Status:** Code shipped via PR #97 (merged 2026-06-30) · awaiting live verification on www.routesmith.ai
**Surfaced:** 2026-06-30, during live testing of a Sedona build that stalled mid-stream
**Severity:** Medium (transient; not actively breaking prod, but the failure mode is silent and confusing)

## Symptom

During a live build (Sedona, late 2026-06-29 / early 2026-06-30), the streaming build job appeared to stall after the model's last delta. No further progress was rendered on screen for >3 minutes; the watchdog fired and the UI surfaced a generic failure. A subsequent retry succeeded on the same prompt with no infrastructure change — production Cloudflare Pages + Workers + Anthropic were healthy at the time. The stall was transient.

## What's already in place

`streamBuildJob` in `src/App.jsx` (~7855–8015) is the single entry point for the streaming build pipeline. It already:

- Wraps the SSE/streaming fetch with a stall watchdog: `MAX_STALL_MS = 180 * 1000` (~7975), measured from the last delta event.
- Falls back to a KV poll against the `JOBS` namespace once the live stream drops, so the result can still land if the job completed server-side after the client lost the stream.
- Has a 15-minute max-poll ceiling above the stall watchdog (search "15-min poll ceiling" in the same file).

A second copy of the same 180s constant lives at ~11627 / ~11737 / ~11739 inside the apply-pipeline path (`handleApply` family). Both paths are intentionally aligned today.

## What the fix actually does (revised diagnosis vs the original note)

Reading the code carefully revised the original diagnosis. The first version of this page said "harden the 180s threshold" and "decouple #8 auto-review." The reality after a closer read:

- The 180s `MAX_STALL_MS` only existed inside the **KV-poll fallback**. The **live stream itself had no client-side stall watchdog at all**. A live stream that went silent (no deltas AND no pings) hung `reader.read()` indefinitely — no transport error ever surfaced. That's the Sedona stall report.
- The #8 auto-review is **already structurally decoupled**. `ReviewPanel` only mounts inside `ItineraryView`, which only renders after the main `streamBuildJob` resolves and commits `rawData`. Its own `streamBuildJob` call (inside `handleRunReview`) is a separate fetch with a separate AbortController and a separate stall watchdog. It cannot extend the main build's stall counter.

## What shipped in PR #97

1. **Live-stream stall watchdog (the actual bug).** In `streamBuildJob`, `reader.read()` is now wrapped in `readWithStallWatchdog()` which races each read against a 90s timer (six missed 15s server heartbeats). On trip, it rejects with a new `StallError` sentinel exported from `replanControl.js`. `shouldResumeViaPoll` treats `StallError` as a recoverable drop — the loop breaks out, the reader is cancelled to free the connection, and the existing KV-poll fallback resumes the job server-side.
2. **Adaptive KV-poll stall budget.** The poll loop tracks the most recent server-reported `status`. When status is `running`, the stall budget extends from 180s → 300s. Heavy multi-city builds get the room they need; truly dead jobs still get killed at 180s. Falls back to 180s when status is missing or anything other than `running`.
3. **New `onStallNotice` callback option on `streamBuildJob`.** Fires once when the read loop breaks via `shouldResumeViaPoll` and a `jobId` is known. The main build wiring (in `generateChunk`) routes it into `setLoadingMsg` so the UI shows "Live stream paused — polling for the result…" instead of looking dead during the transport switch.
4. **#8 auto-review invariant comment.** Added next to `ReviewPanel`'s auto-run effect documenting that it cannot extend the main build's stall counter. Locks in the property against future regression.
5. **Tests.** `tests/test_replan_control.mjs` gains 8 assertions exercising `StallError` + `shouldResumeViaPoll`. CI: 1307 / 0 (was 1299 / 0).

## Specific anchors

- `src/App.jsx` ~7855 — `streamBuildJob` function start
- `src/App.jsx` ~7973–7975 — `MAX_STALL_MS` constant + comment
- `src/App.jsx` ~7907 — KV-poll rejection propagation path
- `src/App.jsx` ~11627 / ~11737 — duplicate constants in apply pipeline (keep aligned)
- `ReviewPanel` (~5070) — auto-review entry point (#8 part 1)

## Why this is in the wiki and not just memory

The Sedona stall is documented in personal memory (`memory/notes/projects/routesmith/reliability/build_stall_watchdog.md`), but #24 belongs in the project's tracked 23→24-item update list because:

- It changes a hot-path reliability constant in `App.jsx`.
- It crosses paths with the #8 auto-review change (a shipped feature).
- A future thread picking up the work needs the diagnosis, anchors, and "what's already in place" context — not just a one-line bug title.

## Process note

This page was added before any code change, per the user's build-process rule (minimal, focused PRs; no code without explicit "go"; capture diagnosis in the wiki first). The handoff table is updated in the same PR.
