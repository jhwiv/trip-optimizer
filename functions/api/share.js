// POST /api/share — publish a trip itinerary as a shareable URL.
//
// Accepts the plan JSON and inputs, generates a self-contained HTML page
// using the same logic as the client-side "Export as web app" button, stores
// it in the SHARES KV namespace with a 90-day TTL, and returns a URL.
//
// KV namespace binding required: env.SHARES
// Key format: share:<8-char hex id>  →  full HTML string
// Served by: functions/s/[id].js  →  GET /s/:id
//
// Request body: { plan: object, inputs?: object }
// Response 200: { id: string, url: string }
// Response 400: { error: string }
// Response 503: { error: string }  — SHARES binding not configured

import { buildWebApp } from "../../src/webExport.js";

const SHARE_TTL_SECONDS = 90 * 24 * 60 * 60;

export async function onRequestPost({ request, env }) {
  if (!env.SHARES) {
    return json({ error: "Share feature not configured (SHARES KV binding missing)" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { plan, inputs } = body || {};
  if (!plan || typeof plan !== "object") {
    return json({ error: "plan is required and must be an object" }, 400);
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);

  let html;
  try {
    html = buildWebApp(plan, inputs || {});
  } catch (err) {
    return json({ error: "Failed to generate HTML: " + String(err) }, 500);
  }

  await env.SHARES.put(`share:${id}`, html, { expirationTtl: SHARE_TTL_SECONDS });

  const origin = new URL(request.url).origin;
  const url = `${origin}/s/${id}`;

  return json({ id, url }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
