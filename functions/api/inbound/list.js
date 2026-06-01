// GET /api/inbound/list?userId=<id>
//
// Returns the most recent parsed confirmations for a user. The client uses
// this to render an "Inbox → Itinerary" view where the traveler accepts or
// edits each extracted booking before it lands in their trip.
//
// Body params (query string):
//   userId   defaults to "default" (matches the inbound parser's fallback)
//   limit    default 50, max 200
//
// Returns:
//   { items: [<record>...], userId }

import { json, corsOptions } from "../experiences/_shared.js";

export async function onRequestOptions() { return corsOptions(); }

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const userId = (url.searchParams.get("userId") || "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  if (!env.INBOUND_KV) {
    return json({ items: [], userId, warning: "INBOUND_KV not bound" });
  }

  const indexKey = `confirmation:${userId}:index`;
  const idsRaw = (await env.INBOUND_KV.get(indexKey)) || "";
  const ids = idsRaw.split("\n").filter(Boolean).slice(0, limit);

  const items = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const v = await env.INBOUND_KV.get(`confirmation:${userId}:${id}`);
        if (v) items.push(JSON.parse(v));
      } catch {
        // Skip unreadable records.
      }
    }),
  );

  items.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  return json({ items, userId });
}
