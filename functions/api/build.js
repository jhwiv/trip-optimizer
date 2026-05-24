// POST /api/build — start a resumable build job.
//
// Architecture:
//   - Client POSTs an Anthropic messages-API body.
//   - We mint a jobId, return it immediately, and kick off the actual Anthropic
//     stream inside ctx.waitUntil(...) so the work continues if the client
//     disconnects (window closed, network drops, etc.).
//   - Stream deltas are buffered and flushed to KV every ~750ms or 800 chars,
//     whichever comes first — that keeps us well under KV's 1 write/sec/key
//     limit while giving the client smooth polling progress.
//   - On completion, status flips to "done"; on error, "error".
//   - Client polls GET /api/build/<id>?cursor=N to incrementally fetch text.
//
// KV namespace binding required: env.JOBS (key/value namespace).
//   Dashboard -> Pages -> trip-optimizer -> Settings -> Functions ->
//     KV namespace bindings -> add binding `JOBS` -> point at the namespace.
//
// Keys written:
//   job:<id>:status   -> JSON { status: 'running'|'done'|'error', error?, len, model, startedAt, updatedAt, completedAt? }
//   job:<id>:text     -> string (full accumulated text so far)
//
// TTL: 24h. Plenty of time for a user to reopen and resume; nothing here is
// long-lived sensitive data.

const JOB_TTL_SECONDS = 24 * 60 * 60;

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

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
  const now = Date.now();

  // Seed status BEFORE responding so polls right after POST find the key.
  await env.JOBS.put(
    `job:${jobId}:status`,
    JSON.stringify({ status: "running", len: 0, model: body.model || "", startedAt: now, updatedAt: now }),
    { expirationTtl: JOB_TTL_SECONDS },
  );
  await env.JOBS.put(`job:${jobId}:text`, "", { expirationTtl: JOB_TTL_SECONDS });

  // Run the actual Anthropic stream in the background. waitUntil keeps the
  // function alive after the response is sent so the build survives a client
  // disconnect (window close, network blip, etc.).
  waitUntil(runBuild({ env, jobId, body, startedAt: now }));

  return json({ jobId });
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

async function runBuild({ env, jobId, body, startedAt }) {
  const statusKey = `job:${jobId}:status`;
  const textKey = `job:${jobId}:text`;
  const upstreamBody = { ...body, stream: true };

  let accumulated = "";
  let lastFlush = 0;
  let lastFlushedLen = 0;

  const FLUSH_INTERVAL_MS = 750;
  const FLUSH_CHARS = 800;

  // Helper to push current state to KV. Throttled — caller decides when.
  async function flush(final = false) {
    const now = Date.now();
    await env.JOBS.put(textKey, accumulated, { expirationTtl: JOB_TTL_SECONDS });
    await env.JOBS.put(
      statusKey,
      JSON.stringify({
        status: final ? "done" : "running",
        len: accumulated.length,
        model: body.model || "",
        startedAt,
        updatedAt: now,
        ...(final ? { completedAt: now } : {}),
      }),
      { expirationTtl: JOB_TTL_SECONDS },
    );
    lastFlush = now;
    lastFlushedLen = accumulated.length;
  }

  async function fail(message) {
    await env.JOBS.put(textKey, accumulated, { expirationTtl: JOB_TTL_SECONDS });
    await env.JOBS.put(
      statusKey,
      JSON.stringify({
        status: "error",
        error: String(message || "Unknown error"),
        len: accumulated.length,
        model: body.model || "",
        startedAt,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      }),
      { expirationTtl: JOB_TTL_SECONDS },
    );
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
    await fail(`Upstream fetch failed: ${err?.message || err}`);
    return;
  }

  if (!anthropicRes.ok || !anthropicRes.body) {
    const text = await anthropicRes.text().catch(() => "");
    await fail(`Anthropic ${anthropicRes.status}: ${text.slice(0, 500)}`);
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

      // SSE messages are separated by double-newline. Each message has
      // `event: <type>` and `data: <json>` lines. We only care about
      // content_block_delta events with text_delta payloads.
      let sep;
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
            // tool_use path: input_json_delta carries the streaming JSON.
            if (evt.delta?.type === "input_json_delta") {
              accumulated += evt.delta.partial_json || "";
            } else if (evt.delta?.type === "text_delta") {
              // Some models emit a small text preamble before the tool call —
              // we still capture it so the client salvage path has it if the
              // model ever skips the tool call entirely.
              accumulated += evt.delta.text || "";
            }
          } else if (evt.type === "message_stop") {
            // Stream is logically done — outer loop will exit on next read.
          } else if (evt.type === "error" || evt.error) {
            throw new Error(evt.error?.message || evt.message || "Stream error");
          }
        }
      }

      const now = Date.now();
      if (
        now - lastFlush >= FLUSH_INTERVAL_MS ||
        accumulated.length - lastFlushedLen >= FLUSH_CHARS
      ) {
        await flush(false);
      }
    }
    await flush(true);
  } catch (err) {
    await fail(`Stream read failed: ${err?.message || err}`);
  }
}

function makeJobId() {
  // 16 hex chars from crypto.getRandomValues — plenty for ~24h job uniqueness.
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

