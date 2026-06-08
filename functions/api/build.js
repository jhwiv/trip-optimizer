// POST /api/build — start a build job and stream progress back to the client.
//
// Architecture (rewritten 2026-05-24 — see Context for the original bug):
//   - Client POSTs an Anthropic messages-API body and KEEPS THE CONNECTION OPEN.
//   - We mint a jobId and immediately stream back NDJSON (one JSON object per
//     line):
//       {"type":"job","jobId":"<id>"}
//       {"type":"delta","text":"..."}                  // repeated
//       {"type":"done","len":12345}
//       {"type":"error","error":"..."}
//   - In parallel we mirror the accumulated text to KV (job:<id>:text and
//     job:<id>:status) so that if the client drops mid-build the resume path
//     (GET /api/build/<id>?cursor=N) still works.
//
// Why this design:
//   Cloudflare Pages Functions cancel background work (waitUntil) ~30 seconds
//   after the client disconnects. Our old design returned the jobId immediately
//   and ran the Anthropic stream inside waitUntil(), which meant every build
//   was killed at the 30-second mark — confirmed by per-job debug logs in KV.
//   Keeping the client connected removes that cap: a Worker can run for as
//   long as the client stays connected (no wall-clock limit for HTTP).
//
// KV namespace binding required: env.JOBS.
// Keys written:
//   job:<id>:status   -> JSON { status, len, model, startedAt, updatedAt, completedAt?, error? }
//   job:<id>:text     -> accumulated text so far
//
// TTL: 24h.

const JOB_TTL_SECONDS = 24 * 60 * 60;
// KV flush cadence. Cloudflare's free-tier KV is hard-capped at 1000 puts/day
// per namespace. Aggressive flushing (every 750ms / 800 chars) blew that cap
// in a single afternoon and surfaced as Worker error 1101 ("KV put() limit
// exceeded for the day") to the client. With 5s / 5000 chars a typical
// 90-second build does ~20 puts, leaving headroom for many builds/day.
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_CHARS = 5000;
// Heartbeat cadence. If Anthropic is mid-generation but hasn't emitted a
// content_block_delta for a while (large prefill, slow tool-arg generation,
// big menu object), we still need to keep the NDJSON stream alive so:
//   1. The client's poll-fallback stall detector (~90s without bytes) stays
//      quiet — there ARE bytes flowing, just heartbeat ones.
//   2. Any intermediate proxy/CDN that idle-kills connections sees activity.
// Heartbeats are {"type":"ping"} lines the client silently ignores. 15s is
// well under any commonly-observed idle limit.
const HEARTBEAT_INTERVAL_MS = 15000;

// Safely write to KV. If the namespace is over quota or otherwise unhappy,
// log it and continue — the client is still receiving the live NDJSON stream,
// so the build succeeds even when KV mirroring is dead. Resume-via-poll is
// the only thing that degrades, and the client already falls back gracefully.
async function safeKvPut(env, key, value, opts, state) {
  if (!env.JOBS) return;
  if (state?.kvDisabled) return;
  try {
    await env.JOBS.put(key, value, opts);
  } catch (err) {
    const msg = String(err?.message || err);
    // Latch the disabled flag so we stop hammering KV for the rest of the job.
    if (state) {
      state.kvDisabled = true;
      state.kvError = msg;
    }
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: { message: "Server missing ANTHROPIC_API_KEY" } }, 500);
  }
  // env.JOBS is preferred but no longer required — the build still works
  // without it (resume-via-poll is the only feature that degrades).

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON in request body" } }, 400);
  }

  const jobId = makeJobId();
  const startedAt = Date.now();
  const kvState = { kvDisabled: !env.JOBS, kvError: null };

  // Seed status in KV BEFORE we start streaming so any concurrent poll finds
  // the job immediately. Safe-wrapped: if KV is over quota, we skip and the
  // build continues on the live NDJSON stream alone.
  await safeKvPut(
    env,
    `job:${jobId}:status`,
    JSON.stringify({ status: "running", len: 0, model: body.model || "", startedAt, updatedAt: startedAt }),
    { expirationTtl: JOB_TTL_SECONDS },
    kvState,
  );
  await safeKvPut(env, `job:${jobId}:text`, "", { expirationTtl: JOB_TTL_SECONDS }, kvState);

  // Streaming response back to the client. We use TransformStream so the
  // Response is constructed and returned IMMEDIATELY with a readable body
  // that we then write into asynchronously. The runtime keeps the function
  // alive while the response body is still being written.
  //
  // Why not ReadableStream({ async start }):
  //   Cloudflare's runtime can throw an unhandled exception (Worker error
  //   1101) when `start` is async AND awaits I/O like KV writes or upstream
  //   fetch before the first enqueue. The TransformStream pattern below
  //   sidesteps that: writer.write() is called from a detached async IIFE
  //   while the Response body is already being delivered to the client.
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const writeEvent = async (obj) => {
    try { await writer.write(encoder.encode(JSON.stringify(obj) + "\n")); } catch {}
  };

  // Fire-and-forget the build. We don't await this — the Response below
  // returns instantly with the streamed body. The function stays alive as
  // long as the writer hasn't closed.
  (async () => {
    try {
      // First event: jobId, so the client can record it for resume.
      await writeEvent({ type: "job", jobId });
      await runBuild({ env, jobId, body, startedAt, writeEvent, kvState });
    } catch (err) {
      await writeEvent({ type: "error", error: String(err?.message || err) });
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function runBuild({ env, jobId, body, startedAt, writeEvent, kvState }) {
  const statusKey = `job:${jobId}:status`;
  const textKey = `job:${jobId}:text`;
  const upstreamBody = { ...body, stream: true };

  let accumulated = "";
  let lastFlush = 0;
  let lastFlushedLen = 0;
  // Captured from Anthropic's message_delta event when present. Persisted to
  // KV so the resume path (/api/build/[id]) can return it to a reconnecting
  // client. "end_turn" = clean finish; "max_tokens" = hit the budget; etc.
  let stopReason = null;
  let lastClientWriteAt = Date.now();

  // Heartbeat timer — fires {type:"ping"} to the client every
  // HEARTBEAT_INTERVAL_MS if no real delta has been written. Stops when the
  // build ends (writer.close() will fail silently inside writeEvent).
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastClientWriteAt >= HEARTBEAT_INTERVAL_MS) {
      writeEvent({ type: "ping", t: Date.now() });
      lastClientWriteAt = Date.now();
    }
  }, Math.floor(HEARTBEAT_INTERVAL_MS / 2));

  async function flushKV(final = false, extra = {}) {
    const now = Date.now();
    await safeKvPut(env, textKey, accumulated, { expirationTtl: JOB_TTL_SECONDS }, kvState);
    await safeKvPut(
      env,
      statusKey,
      JSON.stringify({
        status: final ? (extra.error ? "error" : "done") : "running",
        len: accumulated.length,
        model: body.model || "",
        startedAt,
        updatedAt: now,
        ...(final ? { completedAt: now } : {}),
        ...(extra.error ? { error: String(extra.error) } : {}),
        ...(stopReason ? { stopReason } : {}),
      }),
      { expirationTtl: JOB_TTL_SECONDS },
      kvState,
    );
    lastFlush = now;
    lastFlushedLen = accumulated.length;
  }

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    await flushKV(true, { error: `Upstream fetch failed: ${err?.message || err}` });
    writeEvent({ type: "error", error: `Upstream fetch failed: ${err?.message || err}` });
    return;
  }

  if (!anthropicRes.ok || !anthropicRes.body) {
    const text = await anthropicRes.text().catch(() => "");
    const msg = `Anthropic ${anthropicRes.status}: ${text.slice(0, 500)}`;
    await flushKV(true, { error: msg });
    writeEvent({ type: "error", error: msg });
    return;
  }

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE messages separated by \n\n. We parse each `data:` JSON line and
      // accumulate text from content_block_delta events.
      let sep;
      let pendingDelta = "";
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawMsg = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawMsg.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          let evt;
          try { evt = JSON.parse(dataStr); } catch { continue; }
          if (evt.type === "content_block_delta") {
            let chunk = "";
            if (evt.delta?.type === "input_json_delta") chunk = evt.delta.partial_json || "";
            else if (evt.delta?.type === "text_delta") chunk = evt.delta.text || "";
            if (chunk) {
              accumulated += chunk;
              pendingDelta += chunk;
            }
          } else if (evt.type === "message_delta") {
            // message_delta carries the FINAL stop_reason once the model
            // finishes (or hits a limit). Forward it so the client can
            // distinguish a clean end_turn vs a truncating max_tokens
            // hit and surface a precise error message instead of the
            // generic JSON-salvage "plan was cut off" path.
            const sr = evt.delta?.stop_reason || null;
            if (sr) {
              stopReason = sr; // captured for the final flushKV / resume path
              writeEvent({ type: "stop_reason", reason: sr });
            }
          } else if (evt.type === "error" || evt.error) {
            throw new Error(evt.error?.message || evt.message || "Stream error");
          }
        }
      }

      // Push any new bytes from this read to the client immediately. This is
      // the low-latency path — KV is a secondary mirror.
      if (pendingDelta) {
        writeEvent({ type: "delta", text: pendingDelta });
        lastClientWriteAt = Date.now();
      }

      const now = Date.now();
      if (
        now - lastFlush >= FLUSH_INTERVAL_MS ||
        accumulated.length - lastFlushedLen >= FLUSH_CHARS
      ) {
        await flushKV(false);
      }
    }
    await flushKV(true);
    writeEvent({ type: "done", len: accumulated.length });
  } catch (err) {
    const msg = `Stream read failed: ${err?.message || err}`;
    await flushKV(true, { error: msg });
    writeEvent({ type: "error", error: msg });
  } finally {
    try { clearInterval(heartbeatTimer); } catch {}
  }
}

function makeJobId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
