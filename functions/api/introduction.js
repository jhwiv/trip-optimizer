// POST /api/introduction
// ------------------------------------------------------------------
// Lightweight, SEPARATE post-build call that generates the two-part trip
// Introduction (page 2 of the PDF — see renderIntroduction in
// src/pdf/itineraryPdf.js):
//   • Part 1 — The Arc of the Journey
//   • Part 2 — What Makes This Itinerary Different
//
// History: the Introduction used to be generated inside the streaming
// /api/build, but it was REMOVED (PR #20) because the extra ~600 output
// tokens contributed to max_tokens truncations on large trips. This endpoint
// brings it back as an isolated, single, non-streaming Anthropic call so it
// NEVER touches /api/build or the TRIP_PLAN_TOOL schema. If it fails, the
// itinerary is unaffected — the introduction is purely additive.
//
// Request body (the shaped payload from src/introduction.js shapeIntroRequest —
// only data already in the finished plan, so the model invents nothing):
//   {
//     destination?: string,
//     route?: string,
//     nights?: string,
//     dates?: string,
//     travelers?: string,
//     style?: string,
//     pace?: string,
//     budget?: string,
//     days: string[],          // one line per scheduled day — REQUIRED for grounding
//     flags?: string[]
//   }
//
// Returns:
//   200 { arc: string, differentiators: string }   — differentiators may be
//                                                     "" or the literal NONE_FLAGGED
//   400 { error: { message } }   — bad request / no day-by-day routing to ground on
//   500 { error: { message } }   — server misconfigured (no ANTHROPIC_API_KEY)
//   502 { error: { message } }   — upstream failure / unusable model output
//
// Patterns mirrored from functions/api/find.js + find-providers.js:
//   - tool_choice forces the single tool call
//   - block.input parsed + validated
//   - same Anthropic model + headers + error shape

const INTRO_TOOL = {
  name: "submit_introduction",
  description:
    "Return the two-part trip Introduction, grounded ONLY in the provided day-by-day routing. Call exactly once.",
  input_schema: {
    type: "object",
    properties: {
      arc: {
        type: "string",
        description:
          "Part 1 — The Arc of the Journey. 3–4 sentences, ~80–120 words. Explain why THIS specific route is sequenced the way it is and what the traveler moves through geographically, culturally, and atmospherically from first day to last. A narrative arc grounded in the actual day-by-day routing — NOT a destination description, NOT a list of stops.",
      },
      differentiators: {
        type: "string",
        description:
          "Part 2 — What Makes This Itinerary Different. ONE compact paragraph (not a bullet list), ~150–250 words, weaving 5–8 SPECIFIC moments / off-the-beaten-path stops / insider access / sequencing choices a generic itinerary would miss — each named specifically using the actual restaurant / winery / site / sequencing decision from the routing. Invent nothing. If the itinerary has no genuinely distinctive off-path elements, return EXACTLY the literal string NONE_FLAGGED instead of fabricating distinction.",
      },
    },
    required: ["arc", "differentiators"],
  },
};

const DAYS_MAX = 60; // generous cap — a 60-day trip is well beyond normal use
const LINE_MAX = 400; // per-day / per-flag line length cap

function cleanLine(s) {
  return String(s || "")
    .replace(/"{3,}/g, '""')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "") // strip ctrl chars except \t,\n
    .trim()
    .slice(0, LINE_MAX);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: { message: "Server missing ANTHROPIC_API_KEY" } }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON in request body" } }, 400);
  }

  // Day-by-day routing is the grounding substrate. Without it we refuse —
  // an introduction with no routing to reflect would be generic marketing,
  // which CLAUDE.md's anti-guessing rule forbids.
  const dayLines = (Array.isArray(body?.days) ? body.days : [])
    .map(cleanLine)
    .filter(Boolean)
    .slice(0, DAYS_MAX);
  if (dayLines.length === 0) {
    return json(
      { error: { message: "Missing day-by-day routing ('days') to ground the introduction on" } },
      400,
    );
  }

  const flagLines = (Array.isArray(body?.flags) ? body.flags : [])
    .map(cleanLine)
    .filter(Boolean)
    .slice(0, 6);

  const factLines = [
    body?.destination && `Destination: ${cleanLine(body.destination)}`,
    body?.route && `Route: ${cleanLine(body.route)}`,
    body?.nights && `Nights: ${cleanLine(body.nights)}`,
    body?.dates && `Dates: ${cleanLine(body.dates)}`,
    body?.travelers && `Travelers: ${cleanLine(body.travelers)}`,
    body?.style && `Style: ${cleanLine(body.style)}`,
    body?.pace && `Pace: ${cleanLine(body.pace)}`,
    body?.budget && `Budget tier: ${cleanLine(body.budget)}`,
  ].filter(Boolean);

  const system = `You write the two-part Introduction page (page 2) for a finished, already-built travel itinerary. Call submit_introduction exactly ONCE. Emit no prose outside the tool call.

GROUNDING — HARD RULE
• Use ONLY the trip facts and the day-by-day routing provided in the user message. Reference the stops, restaurants, and sequencing that are actually listed.
• Invent NOTHING. Do not name a place, venue, neighborhood, or experience that does not appear in the provided routing — this applies even to a venue you know to be real, famous, or a highly plausible fit for this kind of trip in this destination. Being a well-known name for the region is not grounding; appearing in the ITINERARY lines below is the only thing that is. If a day's line doesn't name a lunch stop, a specific tasting room, or any other detail, do not supply one from general knowledge — describe that day only in terms of what IS listed, or leave it out of your narrative entirely.
• This is an introduction to a SPECIFIC itinerary, not generic destination marketing.

FORMAT (strict)
Part 1 — The Arc of the Journey: 3–4 sentences, ~80–120 words. Why THIS route is sequenced the way it is and what the traveler moves through from first day to last. A narrative arc grounded in the routing — NOT a destination description, NOT a list of stops.
Part 2 — What Makes This Itinerary Different: ONE compact paragraph (not bullets), ~150–250 words, weaving 5–8 SPECIFIC moments / off-path stops / insider access / sequencing choices from the routing, each named specifically. If the itinerary has no genuinely distinctive off-path elements, return EXACTLY the literal string NONE_FLAGGED for differentiators rather than fabricating distinction.

TOTAL: 350–450 words combined (arc + differentiators).

VOICE: Second person ("you", "your group") or third person using traveler names. NEVER first person. Warm, confident, specific — a well-traveled friend explaining WHY each decision was made to a sophisticated traveler.

BANNED phrases (never use): world-class, once-in-a-lifetime, breathtaking, incredible, amazing, unforgettable, magical, journey of a lifetime, hidden gem, bucket list. No passive voice. No bullet points. No markdown. No headers.`;

  const userParts = [];
  if (factLines.length) userParts.push(`TRIP FACTS:\n${factLines.join("\n")}`);
  userParts.push(
    `ITINERARY (one line per day — reference these specifically; do not invent new stops):\n${dayLines
      .map((l) => `• ${l}`)
      .join("\n")}`,
  );
  if (flagLines.length) {
    userParts.push(`Key flags from the build:\n${flagLines.map((l) => `• ${l}`).join("\n")}`);
  }
  const userMessage = userParts.join("\n\n");

  const upstreamBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: [INTRO_TOOL],
    tool_choice: { type: "tool", name: "submit_introduction" },
  };

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    return json(
      { error: { message: `Upstream fetch failed: ${String(err?.message || err)}` } },
      502,
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return json(
      { error: { message: `Upstream ${upstream.status}`, detail: errText.slice(0, 500) } },
      502,
    );
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return json({ error: { message: "Upstream returned non-JSON" } }, 502);
  }

  const block = Array.isArray(payload?.content)
    ? payload.content.find((c) => c?.type === "tool_use" && c?.name === INTRO_TOOL.name)
    : null;

  if (!block || !block.input || typeof block.input !== "object") {
    return json({ error: { message: "Introduction tool did not return structured input" } }, 502);
  }

  const arc = typeof block.input.arc === "string" ? block.input.arc.trim() : "";
  if (!arc) {
    return json({ error: { message: "Model returned an empty introduction" } }, 502);
  }
  const diffRaw =
    typeof block.input.differentiators === "string" ? block.input.differentiators.trim() : "";
  let differentiators;
  if (!diffRaw) differentiators = "";
  else if (diffRaw.toUpperCase() === "NONE_FLAGGED") differentiators = "NONE_FLAGGED";
  else differentiators = diffRaw;

  return json({ arc, differentiators });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
