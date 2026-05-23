// Cloudflare Pages Function — proxies to Anthropic with streaming.
// Streaming is critical: avoids the 30s response timeout and lets the
// client render progress as tokens arrive.

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON in request body" } }, 400);
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: { message: "Server missing ANTHROPIC_API_KEY" } }, 500);
  }

  // Force streaming on. Client always handles streamed responses.
  const upstreamBody = { ...body, stream: true };

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
    return json({ error: { message: `Upstream fetch failed: ${err?.message || err}` } }, 502);
  }

  // If Anthropic returned a non-2xx, body is JSON (not SSE). Pass it through.
  if (!anthropicRes.ok) {
    const text = await anthropicRes.text();
    return new Response(text, {
      status: anthropicRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Stream the SSE response straight through to the client.
  return new Response(anthropicRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
