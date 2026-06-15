// POST /api/inbound/email — SendGrid Inbound Parse webhook.
//
// What this is:
//   The "forward your confirmation to trips@your-domain" feature. SendGrid's
//   Inbound Parse hands us a multipart/form-data POST containing the parsed
//   email (headers, from, to, subject, text, html, attachments). We extract
//   the confirmation details with an Anthropic call and write a record into
//   KV keyed by the user's incoming email address (e.g. trips+jeff@…).
//
// Why this exists:
//   Booking flows that redirect to Viator / GYG / Tiqets / hotel sites for
//   checkout leave Trip Optimizer in the dark about what was actually booked.
//   The cleanest fix on the user side is forwarding the confirmation email —
//   they already do this for TripIt and Wanderlog. We auto-parse it so the
//   itinerary updates without copy-paste.
//
// SendGrid setup (do this once):
//   1. Add an MX record pointing trips.<your-domain> at mx.sendgrid.net.
//   2. In SendGrid → Inbound Parse, add hostname trips.<your-domain> with the
//      URL set to https://<your-pages-host>/api/inbound/email
//      Toggle "POST the raw, full MIME message" OFF (we want the parsed form).
//      Toggle "Check spam" ON.
//   3. Set the SENDGRID_INBOUND_SECRET env var on Pages (anything random;
//      we expose it in the URL like ?secret=… so SendGrid can reach it
//      without us trusting referer headers).
//
// Routing convention:
//   trips@trips.<domain>            → owner inbox (single-user setup; the user is implied)
//   trips+<userId>@trips.<domain>   → routed to a specific user
//
// Env:
//   ANTHROPIC_API_KEY          required for parsing the email body
//   SENDGRID_INBOUND_SECRET    required for the ?secret= guard
//   INBOUND_KV                 KV namespace binding (optional but recommended)
//
// KV keys written:
//   confirmation:<userId>:<id>   JSON with the extracted confirmation fields
//   confirmation:<userId>:index  newline-delimited list of ids (latest first)

const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export async function onRequestPost({ request, env }) {
  // Guard with a shared secret so random POSTs from the internet can't spam
  // our parser. SendGrid lets you embed query params in the parse URL.
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  if (!env.SENDGRID_INBOUND_SECRET || secret !== env.SENDGRID_INBOUND_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY not set" }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return json({ error: `bad form data: ${err?.message || err}` }, 400);
  }

  const from = String(form.get("from") || "");
  const to = String(form.get("to") || "");
  const subject = String(form.get("subject") || "");
  const text = String(form.get("text") || "");
  const html = String(form.get("html") || "");
  const envelope = safeJson(String(form.get("envelope") || "{}"));
  // SendGrid also exposes form.get("spam_report") for free-text reasons; we
  // only act on the numeric score and ignore the rest.
  const spamScore = Number(form.get("spam_score") || 0);

  // Reject obvious spam.
  if (Number.isFinite(spamScore) && spamScore > 5) {
    return json({ ok: true, skipped: "spam" });
  }

  const userId = extractUserId(to, envelope);
  const id = makeId();

  // Hand the email body to Anthropic with a tight extraction prompt. We give
  // it both subject and text (HTML is fallback) and ask for a structured
  // booking JSON in our existing Itinerary shape.
  const bodyForLlm = (text && text.length > 50) ? text : htmlToText(html);
  let extracted;
  try {
    extracted = await extractConfirmation({ subject, from, body: bodyForLlm }, env);
  } catch (err) {
    extracted = { error: String(err?.message || err) };
  }

  const record = {
    id,
    userId,
    receivedAt: Date.now(),
    from,
    subject,
    extracted,
    // Keep the raw text for debugging / future re-parse. Cap to avoid
    // bloating KV.
    rawText: bodyForLlm.slice(0, 20000),
  };

  if (env.INBOUND_KV) {
    try {
      await env.INBOUND_KV.put(
        `confirmation:${userId}:${id}`,
        JSON.stringify(record),
        { expirationTtl: TTL_SECONDS },
      );
      // Update an index of ids for quick listing in the client.
      const indexKey = `confirmation:${userId}:index`;
      const prev = (await env.INBOUND_KV.get(indexKey)) || "";
      const next = [id, ...prev.split("\n").filter(Boolean)].slice(0, 200).join("\n");
      await env.INBOUND_KV.put(indexKey, next, { expirationTtl: TTL_SECONDS });
    } catch (err) {
      // KV is best-effort. We still return 200 so SendGrid doesn't retry.
      return json({ ok: true, id, userId, warning: `kv failed: ${err?.message || err}` });
    }
  }

  return json({ ok: true, id, userId, extracted });
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

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a booking-confirmation extractor for a luxury travel companion app. From the email below, extract a single confirmation as JSON. The email may be a flight, hotel, car/transfer, tour/activity, or restaurant reservation. Return STRICT JSON only — no prose, no markdown.

Schema:
{
  "type": "Flight" | "Hotel" | "Activity" | "Transport" | "Dining" | "Other",
  "provider": "<vendor name, e.g. United, Marriott, Viator, GetYourGuide, Tock, OpenTable>",
  "confirmation_number": "<string or null>",
  "name": "<short title, e.g. 'Ritz-Carlton Lisbon' or 'Lisbon food tour'>",
  "start_iso": "<ISO datetime or date>",
  "end_iso": "<ISO datetime or date or null>",
  "location": "<city, country>",
  "address": "<full street address if present, else null>",
  "phone": "<E.164-style phone if present, else null>",
  "booking_url": "<URL if present, else null>",
  "passengers_or_party_size": <number or null>,
  "price": { "amount": <number>, "currency": "<ISO code>" } | null,
  "notes": "<one short sentence with anything the traveler might want at a glance, e.g. 'King bed, 2 adults, breakfast included'>"
}

If the email is clearly NOT a booking confirmation (newsletter, marketing, password reset, etc.), return:
{ "type": "Other", "name": "Non-booking email", "skip": true }

EMAIL SUBJECT: $SUBJECT
EMAIL FROM: $FROM
EMAIL BODY:
"""
$BODY
"""

Return only the JSON object.`;

async function extractConfirmation({ subject, from, body }, env) {
  const prompt = EXTRACTION_PROMPT
    .replace("$SUBJECT", subject.slice(0, 400))
    .replace("$FROM", from.slice(0, 200))
    .replace("$BODY", body.slice(0, 12000));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.INBOUND_MODEL || "claude-3-5-haiku-latest",
      max_tokens: 1200,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data?.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();

  // The model is asked for raw JSON but occasionally wraps in fences. Strip.
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return { error: "json-parse-failed", raw: text.slice(0, 2000) };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractUserId(to, envelope) {
  // Prefer the envelope's `to` (the actual delivery target) over the To
  // header, which may have been munged through forwarders.
  const target = (envelope?.to && envelope.to[0]) || to;
  // Strip <> brackets and pull local-part.
  const clean = String(target).replace(/.*<([^>]+)>.*/, "$1").trim();
  const local = clean.split("@")[0] || "default";
  // "trips+jeff" → "jeff"; "trips" → "default"
  const plusIdx = local.indexOf("+");
  if (plusIdx === -1) return "default";
  const id = local.slice(plusIdx + 1).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return id || "default";
}

function htmlToText(html) {
  // Cheap HTML → text. Good enough for confirmation emails, which are
  // table-based and mostly text. The LLM tolerates light noise.
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function makeId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
