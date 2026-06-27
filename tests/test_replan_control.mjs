// Tests for src/replanControl.js — the pure control helpers behind the
// Review "Apply" / "Re-plan to apply the rest" flow.
//
// These guard the fix for the production "Load failed" report:
//   - every invocation gets a FRESH, non-aborted controller (never a reused
//     already-aborted one);
//   - the hard-timeout backstop sits ABOVE streamBuildJob's own ~15-min poll
//     ceiling, so it can't fire mid-stream on a long full re-plan;
//   - an aborted/network fetch (Safari/iOS reports it as TypeError "Load
//     failed") is classified honestly instead of dumping the raw string.

import {
  freshAbortController,
  replanTimeoutMs,
  classifyApplyError,
  isAbortLikeError,
  isNetworkLoadError,
  shouldResumeViaPoll,
} from "../src/replanControl.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== freshAbortController ===");
{
  const a = freshAbortController();
  const b = freshAbortController();
  assert("returns an AbortController", typeof a.abort === "function" && !!a.signal);
  assert("a fresh controller is NOT already aborted", a.signal.aborted === false);
  assert("two invocations yield distinct controllers", a !== b);
  // Aborting one must not affect the next invocation's controller — the
  // reused-aborted-controller bug class.
  a.abort();
  const c = freshAbortController();
  assert("aborting a prior controller leaves the next one clean", a.signal.aborted === true && c.signal.aborted === false);
}

console.log("=== replanTimeoutMs ===");
{
  const STREAMBUILDJOB_POLL_CEILING_MS = 15 * 60 * 1000; // MAX_POLL_MS in streamBuildJob
  assert("full re-plan backstop exceeds streamBuildJob's 15-min poll ceiling", replanTimeoutMs("full") > STREAMBUILDJOB_POLL_CEILING_MS);
  assert("surgical keeps a tight 5-min bound", replanTimeoutMs("surgical") === 5 * 60 * 1000);
  assert("unknown/default mode is treated as non-full (tight bound)", replanTimeoutMs(undefined) === 5 * 60 * 1000);
  assert("full backstop is the OLD fixed 300s bug value times >3", replanTimeoutMs("full") > 300000 * 3);
}

console.log("=== isAbortLikeError ===");
{
  const domAbort = new Error("aborted"); domAbort.name = "AbortError";
  assert("DOMException-style AbortError", isAbortLikeError(domAbort) === true);
  assert("'The user aborted a request.' (Chromium abort text)", isAbortLikeError(new Error("The user aborted a request.")) === true);
  assert("plain network TypeError is NOT abort-like by string alone", isAbortLikeError(new TypeError("Load failed")) === false);
  assert("null is safe", isAbortLikeError(null) === false);
}

console.log("=== isNetworkLoadError ===");
{
  assert("Safari/iOS 'Load failed'", isNetworkLoadError(new TypeError("Load failed")) === true);
  assert("Chromium 'Failed to fetch'", isNetworkLoadError(new TypeError("Failed to fetch")) === true);
  assert("Firefox 'NetworkError...'", isNetworkLoadError(new TypeError("NetworkError when attempting to fetch resource.")) === true);
  assert("an ordinary message is not a network error", isNetworkLoadError(new Error("Revision returned no plan.")) === false);
  assert("null is safe", isNetworkLoadError(null) === false);
}

console.log("=== classifyApplyError ===");
{
  // Our hard-timeout fired: classify by intent, not the engine's error string.
  const t = classifyApplyError(new TypeError("Load failed"), { aborted: true, timedOut: true });
  assert("timedOut wins even when the engine reports 'Load failed'", t.kind === "timeout" && /try again/i.test(t.message));

  // User cancel (or any abort we caused) — keep the caller's own cancel string.
  const cAbort = classifyApplyError(new TypeError("Load failed"), { aborted: true, timedOut: false });
  assert("aborted-by-us is classified cancelled (no message, caller keeps its string)", cAbort.kind === "cancelled" && cAbort.message === null);
  const cName = classifyApplyError(Object.assign(new Error("x"), { name: "AbortError" }), {});
  assert("AbortError name is cancelled", cName.kind === "cancelled");

  // Genuine network drop with NO abort on our side → honest network message,
  // never the bare "Load failed".
  const n = classifyApplyError(new TypeError("Load failed"), { aborted: false, timedOut: false });
  assert("unsolicited 'Load failed' becomes an honest network message", n.kind === "network" && !!n.message);
  assert("network message does not leak the raw 'Load failed' string", !/load failed/i.test(n.message));

  // Anything else falls through so the caller can run cleanErrorMessage().
  const o = classifyApplyError(new Error("Revision returned no patches."), {});
  assert("other errors fall through (kind 'other', null message)", o.kind === "other" && o.message === null);
}

console.log("=== shouldResumeViaPoll (surgical-apply connection-drop recovery) ===");
{
  const drop = new TypeError("Load failed"); // Safari/iOS mid-stream drop

  // The bug: a mid-stream drop with a known jobId must resume via KV poll,
  // not hard-fail. The server job keeps running and mirroring to KV.
  assert("transport drop WITH a jobId and no `done` → resume via poll",
    shouldResumeViaPoll(drop, { jobId: "abc123", doneSeen: false }) === true);
  assert("Chromium 'Failed to fetch' drop with a jobId also resumes",
    shouldResumeViaPoll(new TypeError("Failed to fetch"), { jobId: "abc123" }) === true);

  // Not resumable: drop happened before the server sent the jobId, so there's
  // nothing in KV to poll. Honest hard error is correct here.
  assert("drop BEFORE jobId arrived → NOT resumable (no job to poll)",
    shouldResumeViaPoll(drop, { jobId: null, doneSeen: false }) === false);

  // Not resumable: an abort we caused (user cancel or hard-timeout). Resuming
  // would defeat the cancel and re-surface the cancelled work.
  const domAbort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert("abort we caused is NOT resumed (respects cancel/timeout)",
    shouldResumeViaPoll(domAbort, { jobId: "abc123" }) === false);

  // Not resumable: stream already completed — nothing left to poll for.
  assert("a completed stream (doneSeen) is not resumed",
    shouldResumeViaPoll(drop, { jobId: "abc123", doneSeen: true }) === false);

  // Not resumable: a non-transport application error (e.g. a parse failure)
  // is a real failure, not a recoverable drop.
  assert("ordinary application error is NOT treated as a resumable drop",
    shouldResumeViaPoll(new Error("Revision returned no patches."), { jobId: "abc123" }) === false);

  // After resume is exhausted, classification stays honest: an unsolicited
  // transport drop that could NOT be resumed surfaces the honest network
  // message, never the bare engine string.
  const afterExhausted = classifyApplyError(drop, { aborted: false, timedOut: false });
  assert("drop that can't resume still classifies as honest network error",
    afterExhausted.kind === "network" && !/load failed/i.test(afterExhausted.message));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
