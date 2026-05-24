// Minimal diagnostic endpoint to isolate Worker 1101 cause on /api/build.
// Tries a few patterns under a query-string flag so we can bisect quickly.
//
//   POST /api/buildtest?mode=plain         -> static JSON
//   POST /api/buildtest?mode=parsebody     -> parse JSON body, return what we saw
//   POST /api/buildtest?mode=kv            -> write/read KV
//   POST /api/buildtest?mode=transform     -> TransformStream returning hello
//   POST /api/buildtest?mode=readable      -> ReadableStream returning hello
//   POST /api/buildtest?mode=transform_kv  -> TransformStream + async KV write inside
//   POST /api/buildtest?mode=fetch         -> upstream fetch to anthropic /v1/messages
//   POST /api/buildtest?mode=fetch_stream  -> upstream stream piped through TransformStream

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") || "plain";

  try {
    if (mode === "plain") {
      return json({ ok: true, mode });
    }

    if (mode === "parsebody") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      return json({ ok: true, mode, got_keys: Object.keys(body || {}) });
    }

    if (mode === "kv") {
      if (!env.JOBS) return json({ error: "no JOBS binding" }, 500);
      const k = `diag:${Date.now()}`;
      await env.JOBS.put(k, "hello", { expirationTtl: 60 });
      const v = await env.JOBS.get(k);
      return json({ ok: true, mode, kv_read: v });
    }

    if (mode === "transform") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      (async () => {
        try {
          await writer.write(enc.encode("hello\n"));
          await writer.write(enc.encode("world\n"));
        } finally { try { await writer.close(); } catch {} }
      })();
      return new Response(readable, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (mode === "readable") {
      const enc = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          controller.enqueue(enc.encode("hello\n"));
          controller.enqueue(enc.encode("world\n"));
          controller.close();
        },
      });
      return new Response(readable, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (mode === "transform_kv") {
      if (!env.JOBS) return json({ error: "no JOBS binding" }, 500);
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      (async () => {
        try {
          await env.JOBS.put(`diag:tk:${Date.now()}`, "x", { expirationTtl: 60 });
          await writer.write(enc.encode("kv ok\n"));
        } catch (e) {
          await writer.write(enc.encode("kv err: " + (e?.message || e) + "\n"));
        } finally { try { await writer.close(); } catch {} }
      })();
      return new Response(readable, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (mode === "fetch") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "no key" }, 500);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 20,
          messages: [{ role: "user", content: "say ok" }],
        }),
      });
      const txt = await r.text();
      return new Response(`upstream status ${r.status}\n` + txt.slice(0, 300), { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (mode === "fetch_stream") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "no key" }, 500);
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      (async () => {
        try {
          await writer.write(enc.encode("start\n"));
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-5",
              max_tokens: 20,
              stream: true,
              messages: [{ role: "user", content: "say ok" }],
            }),
          });
          await writer.write(enc.encode(`upstream ${r.status}\n`));
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            await writer.write(enc.encode(dec.decode(value, { stream: true })));
          }
          await writer.write(enc.encode("\n[done]\n"));
        } catch (e) {
          await writer.write(enc.encode("err: " + (e?.message || e) + "\n"));
        } finally { try { await writer.close(); } catch {} }
      })();
      return new Response(readable, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    return json({ error: "unknown mode", mode }, 400);
  } catch (err) {
    return json({ error: "handler threw", message: String(err?.message || err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
