// Pure control helpers for the Review "Apply" / "Re-plan to apply the rest"
// flow (ReviewPanel.handleApply and ChangeRequestCard.handleSubmit).
//
// Background — the "Load failed" report:
//   The full re-plan runs through streamBuildJob(), which ALREADY bounds itself:
//   a ~15-minute KV-poll ceiling (MAX_POLL_MS) and a 180-second stall guard
//   (MAX_STALL_MS), both of which throw honest, specific errors. The Apply
//   handlers wrapped that call in their OWN fixed 300-second AbortController
//   hard-timeout. Because 300 s is SHORTER than streamBuildJob's own budget, a
//   legitimately long full re-plan (these got bigger once PR #64 made add-on
//   output sections persist correctly instead of silently resetting to flight
//   + hotel) could blow past 300 s while the stream/poll was still making
//   progress. The hard-timeout then called controller.abort() mid-flight.
//
//   An aborted fetch does not surface uniformly across engines: Safari / iOS
//   reject the in-flight fetch() with a TypeError whose message is the bare
//   "Load failed" (NOT a DOMException named "AbortError"). The catch blocks
//   only special-cased err.name === "AbortError", so that bare "Load failed"
//   string fell through straight to the UI.
//
// These helpers fix both halves and are pure so they can be unit-tested
// without a network or a DOM (matching the tests/ convention, e.g.
// outputsState.js + test_outputs_state.mjs from PR #64).

// Fresh, never-reused AbortController per build / re-plan invocation. Reusing
// a controller that a prior build already aborted would make the next fetch
// reject immediately, so every invocation MUST mint a new one. Centralizing
// the construction here gives the tests a single chokepoint to assert that
// each call yields a distinct, non-aborted controller.
export function freshAbortController() {
  return new AbortController();
}

// Abort hard-timeout budget (ms) for an Apply / re-plan invocation, by mode.
//
// This is a BACKSTOP only — streamBuildJob enforces its own poll ceiling and
// stall guard and emits honest errors when they trip. The backstop must sit
// ABOVE streamBuildJob's ~15-minute ceiling so it never fires mid-stream on a
// legitimately long full re-plan (the bug above). Surgical patches are small
// (8k max_tokens) and finish in well under a minute, so they keep a tight
// 5-minute bound.
export function replanTimeoutMs(mode) {
  return mode === "full" ? 16 * 60 * 1000 : 5 * 60 * 1000;
}

// True when an error looks like an aborted fetch. Safari / iOS report an
// aborted in-flight fetch as a TypeError "Load failed" rather than a DOMException
// named "AbortError", so name alone is unreliable — but when WE aborted on
// purpose the caller passes that intent in explicitly (see classifyApplyError),
// so this name/message check is only a secondary signal.
export function isAbortLikeError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes("the user aborted") || msg.includes("aborted a request") || msg === "aborted";
}

// True when an error is a transport-level fetch failure (no HTTP response was
// received): the connection dropped, DNS failed, CORS blocked, or the request
// was aborted. Each engine phrases it differently:
//   - Safari / iOS:  TypeError "Load failed"
//   - Chromium:      TypeError "Failed to fetch"
//   - Firefox:       TypeError "NetworkError when attempting to fetch resource."
export function isNetworkLoadError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes("load failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network request failed")
  );
}

// Decide whether a thrown LIVE-STREAM read error is recoverable by resuming
// the job via KV polling instead of hard-failing.
//
// Background — the surgical-apply "connection dropped" report (persists after
// PR #66): streamBuildJob reads the open POST /api/build NDJSON stream. When
// the connection drops mid-stream (mobile sleep, iOS Safari backgrounding, a
// CDN idle-kill on a ~2-min surgical revision), reader.read() REJECTS with a
// transport TypeError — Safari/iOS "Load failed", Chromium "Failed to fetch".
// PR #66 only fixed the messaging (relabeling that reject) and the premature
// 300s abort; the drop itself was still a hard failure because streamBuildJob's
// KV-poll fallback only ran on a CLEAN stream end (a `done` break), never on a
// thrown read. But the server job keeps running and mirroring to KV, so as long
// as we already captured a jobId we can poll it to completion — exactly what
// the fresh-build path (runBuildForJob → pollJob) already does.
//
// Resumable ONLY when:
//   - we have a jobId (the server told us which job to poll), AND
//   - the stream hadn't already completed (no `done` seen), AND
//   - the error is a recognized transport drop (not an abort we caused, not an
//     explicit server `{type:"error"}` event).
// A drop BEFORE the jobId arrived, or an abort we triggered, is NOT resumable.
export function shouldResumeViaPoll(err, { jobId, doneSeen = false } = {}) {
  if (!jobId || doneSeen) return false;
  if (isAbortLikeError(err)) return false;
  return isNetworkLoadError(err);
}

// Map a thrown error from an Apply / re-plan fetch to an honest, specific
// user-facing classification. `aborted` is controller.signal.aborted (did WE
// abort?) and `timedOut` is set by the hard-timeout callback. We classify by
// OUR intent first because the engine's error string can't distinguish an
// abort we caused from a genuine network drop (both are "Load failed" on
// Safari / iOS).
//
// Returns { kind, message } where kind is one of:
//   "timeout"   — our hard-timeout fired; message is set.
//   "cancelled" — user (or another abort) stopped it; message is null so the
//                 caller can keep its existing per-surface cancel string.
//   "network"   — transport failure with no HTTP response; message is set.
//   "other"     — anything else; message is null so the caller can run the
//                 raw err.message through its own cleanErrorMessage().
export function classifyApplyError(err, { aborted = false, timedOut = false } = {}) {
  if (timedOut) {
    return {
      kind: "timeout",
      message:
        "This ran longer than expected and was stopped. Any changes already applied are kept — please try again.",
    };
  }
  if (aborted || isAbortLikeError(err)) {
    return { kind: "cancelled", message: null };
  }
  if (isNetworkLoadError(err)) {
    return {
      kind: "network",
      message:
        "Couldn't reach the planner — the connection dropped before it finished. Check your network and try again.",
    };
  }
  return { kind: "other", message: null };
}
