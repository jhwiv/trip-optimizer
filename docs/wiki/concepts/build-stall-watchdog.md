# Build stall watchdog & KV-poll resume (#24)

**Status:** Open · diagnosis only · no code shipped yet
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

## What needs hardening (the actual #24 change, not yet implemented)

Two related improvements, scoped narrowly:

1. **Harden the 180s stall watchdog in `streamBuildJob`.**
   - The current watchdog treats *any* gap >180s as a stall. Real Anthropic Sonnet 4.5 pauses on long-context plans can legitimately exceed this on heavy multi-day itineraries. Either:
     - Raise the threshold to ~240s, OR
     - Make it adaptive: start at 180s, extend to 300s once the KV-poll fallback confirms the server-side job is still `running`.
   - When the watchdog fires, do not surface a generic failure — explicitly transition to KV-poll mode and surface a "stream dropped, polling for result" microcopy so the user knows the build isn't dead.
   - On KV-poll resume, if the server-side job has `status: "complete"`, hydrate the result the same way the live stream would have. If it's `running`, keep polling up to the existing 15-min ceiling.

2. **Decouple the #8 auto-review from the main build stream.**
   - PR #90 added an auto-run of the expert review immediately on build completion. Today that review runs *inside* the same component lifecycle as the build, which means the main build stream can stay "in flight" from the user's perspective while review retrieval runs. This makes the perceived stall window longer than the actual build time.
   - Fix: fire the auto-review after the build's terminal `complete` event has resolved and the result has been committed to state, in a separate effect, gated on `autoReview && !initialReview` (already the current guard). It should not extend or contribute to `streamBuildJob`'s stall counter.

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
