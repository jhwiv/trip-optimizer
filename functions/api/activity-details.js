// POST /api/activity-details
// ------------------------------------------------------------------
// Lazy expanded-details fetch for a named activity at a location.
// Called from the "More details" button on activity cards on /find.
// Returns structured guidance the card itself doesn't have room for:
// best time to visit, typical duration, what to bring, booking tips,
// crowd-avoidance tactics, what locals know that tourists miss, and
// nearby spots that pair well.
//
// Why lazy: most activity cards never get expanded. Building this
// into the /api/find response would slow every search and inflate
// every result with data nobody asks for.
//
// Request:
//   { name: string, location: string, type?: string }
//
// Returns:
//   200 { details: { best_time, typical_duration, what_to_bring,
//                   booking_tips, crowd_tips, locals_tips,
//                   nearby_pairings, cost_breakdown, accessibility,
//                   source_note } }
//   400 / 422 / 500 / 502 — standard error shapes

const NAME_MAX = 200;
const LOCATION_MAX = 200;

const DETAILS_TOOL = {
  name: "submit_activity_details",
  description:
    "Return practical, traveler-useful expanded details for a real, named activity, attraction, tour, or experience. Focus on what makes the visit better — when to go, what to bring, how to avoid crowds, what locals know. AVOID generic tourism marketing language. AVOID hallucinated specifics like exact prices unless you're confident; use ranges instead. Be honest if you don't know the activity well.",
  input_schema: {
    type: "object",
    properties: {
      best_time: {
        type: "string",
        description:
          "When to go for the best experience. Time of day, day of week, season. Example: 'Weekday mornings before 10am in shoulder season (May, September) — crowds peak summer weekends and around major holidays.'",
      },
      typical_duration: {
        type: "string",
        description:
          "How long a typical visit takes, and the minimum useful time. Example: '2–3 hours typical; 60 min minimum if you skip the second gallery.'",
      },
      what_to_bring: {
        type: "string",
        description:
          "Practical items the visitor should have. Footwear notes for hikes, layers for boats, cash if needed, sun protection. Skip if nothing notable. Example: 'Sturdy walking shoes; light layers (lake breeze is cool even in summer); cash for the on-board snack bar.'",
      },
      booking_tips: {
        type: "string",
        description:
          "How and when to book. Whether walk-up is fine, how far ahead tickets sell out, which package or time slot is best value. Example: 'Book 2 weeks ahead for sunset cruises in July/August. Daytime cruises are walk-up friendly except holiday weekends.'",
      },
      crowd_tips: {
        type: "string",
        description:
          "How to avoid the worst crowds. Specific timing and entry tactics. Example: 'Last entry slot (typically 4pm) is far less crowded than midday — same content, half the people.'",
      },
      locals_tips: {
        type: "string",
        description:
          "What locals know that visitors miss. Insider angles, alternative entrances, lesser-known features. Skip if you can't say anything non-obvious. Example: 'Locals park at the southern lot (free) and walk in — the northern lot fills by 10am and charges $15.'",
      },
      nearby_pairings: {
        type: "array",
        items: { type: "string" },
        description:
          "2–4 nearby places that pair well with this activity for a half- or full-day plan. Each item is a short phrase. Example: ['Lunch at Smith's Restaurant before the cruise', 'Prospect Mountain summit drive after — 10 min away', 'Shepard Park for waterfront time between the two'].",
      },
      cost_breakdown: {
        type: "string",
        description:
          "Cost in plain English — admission, common add-ons, parking, hidden costs. Use ranges if uncertain. Example: '$22 adult / $9 child base cruise. $5 onboard drinks. Parking $5 weekdays, $10 weekends.'",
      },
      accessibility: {
        type: "string",
        description:
          "Mobility, kid-friendliness, or accessibility notes that affect who should attempt this. Skip if not notable. Example: 'Wheelchair-accessible on the main boat; the smaller heritage steamer has stairs only. Stroller-friendly on the dock; some narrow upper-deck paths.'",
      },
      source_note: {
        type: "string",
        description:
          "Honesty note about how confident the details are. Example: 'Details based on the activity's typical operating pattern through training data — confirm current hours and pricing before going.'",
      },
    },
    required: [],
  },
};

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

  const name = String(body?.name || "").trim();
  if (!name) return json({ error: { message: "Missing 'name' in request body" } }, 400);
  if (name.length > NAME_MAX) return json({ error: { message: `Name too long (max ${NAME_MAX})` } }, 400);

  const location = String(body?.location || "").trim();
  if (!location) return json({ error: { message: "Missing 'location' in request body" } }, 400);
  if (location.length > LOCATION_MAX) return json({ error: { message: `Location too long (max ${LOCATION_MAX})` } }, 400);

  const type = String(body?.type || "").trim().slice(0, 60);

  const system = `You provide practical, traveler-useful expanded details for a real, named activity. Today's date is ${new Date().toISOString().slice(0, 10)}. Call submit_activity_details exactly ONCE.

CONTEXT:
• Activity: ${name}${location ? ` (in ${location})` : ""}${type ? ` — ${type}` : ""}.

RULES:
• Focus on what makes the visit BETTER — timing, what to bring, crowd-avoidance, what locals know.
• Skip generic tourism marketing. Avoid filler.
• Be honest in source_note: if you're working from general knowledge of the area rather than specific knowledge of this activity, say so.
• Use ranges when prices/times are uncertain; do not invent specific numbers you're not confident about.
• Leave a field empty rather than padding it with weak content.
• Emit no prose. Call the tool.`;

  const userMessage = `Provide practical visitor details for "${name}"${location ? ` in ${location}` : ""}${type ? ` (${type})` : ""}.`;

  const upstreamBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: [DETAILS_TOOL],
    tool_choice: { type: "tool", name: "submit_activity_details" },
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
    return json({ error: { message: `Upstream fetch failed: ${String(err?.message || err)}` } }, 502);
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return json({ error: { message: `Upstream ${upstream.status}`, detail: errText.slice(0, 500) } }, 502);
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return json({ error: { message: "Upstream returned non-JSON" } }, 502);
  }

  const block = Array.isArray(payload?.content)
    ? payload.content.find((c) => c?.type === "tool_use" && c?.name === DETAILS_TOOL.name)
    : null;
  if (!block || !block.input || typeof block.input !== "object") {
    return json({ error: { message: "Details tool did not return structured input" } }, 502);
  }

  const details = block.input;
  // Sanity: at least one substantive field should be populated.
  const hasContent =
    (typeof details.best_time === "string" && details.best_time.length > 0) ||
    (typeof details.typical_duration === "string" && details.typical_duration.length > 0) ||
    (typeof details.booking_tips === "string" && details.booking_tips.length > 0) ||
    (typeof details.locals_tips === "string" && details.locals_tips.length > 0) ||
    (Array.isArray(details.nearby_pairings) && details.nearby_pairings.length > 0);
  if (!hasContent) {
    return json({ error: { message: "Couldn't generate useful details for this activity." } }, 422);
  }

  return json({ details });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
