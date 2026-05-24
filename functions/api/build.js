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
const FLUSH_INTERVAL_MS = 750;
const FLUSH_CHARS = 800;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: { message: "Server missing ANTHROPIC_API_KEY" } }, 500);
  }
  if (!env.JOBS) {
    return json({ error: { message: "Server missing JOBS KV binding. Add it in Cloudflare Pages -> Settings -> Functions." } }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON in request body" } }, 400);
  }

  const jobId = makeJobId();
  const startedAt = Date.now();

  // Seed status in KV BEFORE we start streaming so any concurrent poll finds
  // the job immediately.
  await env.JOBS.put(
    `job:${jobId}:status`,
    JSON.stringify({ status: "running", len: 0, model: body.model || "", startedAt, updatedAt: startedAt }),
    { expirationTtl: JOB_TTL_SECONDS },
  );
  await env.JOBS.put(`job:${jobId}:text`, "", { expirationTtl: JOB_TTL_SECONDS });

  // Streaming response back to the client. We write NDJSON events to this
  // stream as Anthropic deltas arrive. The runtime keeps the function alive
  // for as long as the client is reading this body.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const writeEvent = async (obj) => {
    try { await writer.write(encoder.encode(JSON.stringify(obj) + "\n")); } catch {}
  };

  // Send the jobId event up front so the client can record it (for resume on
  // disconnect) before any deltas land.
  await writeEvent({ type: "job", jobId });

  // Kick off the actual build. We do NOT await it here — we await it at the
  // very end (in ctx.waitUntil) so the function stays alive even if the writer
  // already closed. But the primary lifeline is the connected client reading
  // `readable`.
  const buildPromise = runBuild({ env, jobId, body, startedAt, writeEvent })
    .catch(async (err) => { try { await writeEvent({ type: "error", error: String(err?.message || err) }); } catch {} })
    .finally(async () => { try { await writer.close(); } catch {} });

  // waitUntil here just guards the tail of the build if the client disconnects
  // — KV writes will still complete (up to ~30s after disconnect, which is
  // enough to flush the in-flight accumulator and set final status).
  context.waitUntil(buildPromise);

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

async function runBuild({ env, jobId, body, startedAt, writeEvent }) {
  const statusKey = `job:${jobId}:status`;
  const textKey = `job:${jobId}:text`;
  const upstreamBody = { ...body, stream: true };

  let accumulated = "";
  let lastFlush = 0;
  let lastFlushedLen = 0;

  async function flushKV(final = false, extra = {}) {
    const now = Date.now();
    await env.JOBS.put(textKey, accumulated, { expirationTtl: JOB_TTL_SECONDS });
    await env.JOBS.put(
      statusKey,
      JSON.stringify({
        status: final ? (extra.error ? "error" : "done") : "running",
        len: accumulated.length,
        model: body.model || "",
        startedAt,
        updatedAt: now,
        ...(final ? { completedAt: now } : {}),
        ...(extra.error ? { error: String(extra.error) } : {}),
      }),
      { expirationTtl: JOB_TTL_SECONDS },
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
    await writeEvent({ type: "error", error: `Upstream fetch failed: ${err?.message || err}` });
    return;
  }

  if (!anthropicRes.ok || !anthropicRes.body) {
    const text = await anthropicRes.text().catch(() => "");
    const msg = `Anthropic ${anthropicRes.status}: ${text.slice(0, 500)}`;
    await flushKV(true, { error: msg });
    await writeEvent({ type: "error", error: msg });
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
          } else if (evt.type === "error" || evt.error) {
            throw new Error(evt.error?.message || evt.message || "Stream error");
          }
        }
      }

      // Push any new bytes from this read to the client immediately. This is
      // the low-latency path — KV is a secondary mirror.
      if (pendingDelta) {
        await writeEvent({ type: "delta", text: pendingDelta });
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
    await writeEvent({ type: "done", len: accumulated.length });
  } catch (err) {
    const msg = `Stream read failed: ${err?.message || err}`;
    await flushKV(true, { error: msg });
    await writeEvent({ type: "error", error: msg });
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
