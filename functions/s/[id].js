// GET /s/:id — serve a shared itinerary page from KV.
//
// The page was published by POST /api/share and stored in the SHARES KV
// namespace as a self-contained HTML string. Entries expire after 90 days.
//
// KV namespace binding required: env.SHARES

export async function onRequestGet({ params, env }) {
  if (!env.SHARES) {
    return new Response("Share feature not configured.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const id = params.id;
  if (!id || !/^[a-f0-9]{8}$/.test(id)) {
    return new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const html = await env.SHARES.get(`share:${id}`);
  if (!html) {
    return new Response("This itinerary has expired or does not exist.", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
