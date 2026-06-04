// POST /api/extract-trip
// ------------------------------------------------------------------
// Takes a freeform narrative (the hero "Trip guidelines" box) and uses
// Claude to extract the structured fields the build pipeline needs:
// destination, dates, nights, travelers, home airport, budget, style,
// hotel preferences, restaurants requested, activities requested.
//
// Powers the "Build from this →" shortcut. The user types a paragraph
// like "Paris Sept 12–19, UA 57 EWR→CDG, Four Seasons George V, Le Cinq
// for our anniversary night 3" and the app extracts enough to skip the
// form and go straight to a build.
//
// Returns:
//   200 { extracted: { basics, flights, hotel, restaurants, activities } }
//   400 { error: { message } } — bad request body
//   422 { error: { message }, partial?: {...} } — couldn't find a destination
//   500 { error: { message } } — upstream / config failure
//
// Non-streaming, single Anthropic call with a strict tool. ~1–3s typical.
// Soft-fail philosophy: every extracted field is optional. The build can
// run on just destination + nights because the guidelines text itself
// flows through to the build prompt as SOURCE OF TRUTH — extraction is
// only here to satisfy the form's structural requirements.

const EXTRACT_TOOL = {
  name: "submit_trip_extract",
  description:
    "Extract structured trip fields from a freeform traveler narrative. Every field is optional except destination. Only fill a field when the narrative explicitly says so — do not invent. Leave anything ambiguous blank.",
  input_schema: {
    type: "object",
    properties: {
      basics: {
        type: "object",
        properties: {
          destination: {
            type: "string",
            description:
              "Primary city or region. For multi-city trips, the first stop. Examples: 'Paris', 'Rome', 'Aspen', 'Tuscany'. Leave blank if not stated.",
          },
          startDate: {
            type: "string",
            description:
              "ISO YYYY-MM-DD. The traveler's departure date or trip start date. Only fill if explicitly stated. If only month + day are given without a year, assume the next occurrence (forward-looking). Leave blank if no date.",
          },
          endDate: {
            type: "string",
            description: "ISO YYYY-MM-DD. Return date or trip end date. Same rules as startDate.",
          },
          nights: {
            type: "string",
            description:
              "Number of nights as a string (e.g. '7'). Derive from startDate/endDate when both are present, otherwise pull from explicit '7-night', '5 nights', 'long weekend' (=3) phrasing. Leave blank if unclear.",
          },
          travelers: {
            type: "string",
            description:
              "Free-text traveler description. Examples: '2 adults', '2 adults + 2 kids (ages 8, 11)', 'solo'. Leave blank if not stated.",
          },
          baseArea: {
            type: "string",
            description:
              "Specific neighborhood or sub-area within the destination if explicitly named. Example: 'Saint-Germain' for Paris, 'Trastevere' for Rome. Leave blank if not stated.",
          },
          budget: {
            type: "string",
            enum: ["", "$$ — value", "$$$ — mid range", "$$$$ — luxury", "$$$$$ — ultra high end"],
            description:
              "Budget tier. Infer from named hotels (Four Seasons / Ritz / Aman / Rosewood → $$$$$ or $$$$; Marriott / Westin / Hyatt → $$$ or $$$$; boutique / Hilton Garden Inn → $$$ or $$). Leave blank if no hotel/budget cue.",
          },
          style: {
            type: "array",
            items: { type: "string" },
            description:
              "Trip style multi-select. Pick zero or more from this exact list: ['Cultural / sightseeing', 'Golf / sport', 'Food & wine', 'Beach / relaxation', 'Adventure / outdoor', 'Mixed']. Infer from named activities and restaurants. Leave empty array if nothing clear.",
          },
          pace: {
            type: "string",
            enum: ["", "Relaxed (1–2 things/day)", "Moderate (2–3 things/day)", "Full (3–4 things/day)"],
            description:
              "Pace preference. Infer from cues like 'downtime', 'lots planned', 'one anchor per day'. Leave blank if unclear.",
          },
        },
        required: [],
      },
      flights: {
        type: "object",
        properties: {
          homeAirport: {
            type: "string",
            description:
              "IATA code or city of the departure airport. Examples: 'EWR', 'JFK', 'SFO', 'Newark'. Pull from explicit mentions ('EWR→CDG', 'flying out of Newark'). Leave blank if not stated.",
          },
          airline: {
            type: "string",
            description: "Airline name if explicitly stated. Examples: 'United', 'Delta', 'Air France'. Leave blank if not stated.",
          },
          cabin: {
            type: "string",
            description: "Cabin class if explicitly stated. Examples: 'Polaris', 'business', 'first', 'premium economy', 'economy'. Leave blank if not stated.",
          },
          noFlight: {
            type: "boolean",
            description: "True only if the narrative explicitly says no flights / driving / train. Default false.",
          },
        },
        required: [],
      },
      hotel: {
        type: "object",
        properties: {
          mustHave: {
            type: "string",
            description:
              "Free-text hotel notes. If the narrative names a specific hotel ('Le Bristol', 'Four Seasons George V', 'Ritz-Carlton Half Moon Bay'), put the hotel name here so the planner uses it. Include any room/view requests too.",
          },
          tier: {
            type: "string",
            description: "Tier hint like 'Hotel', 'Resort', 'Boutique'. Leave blank if unclear.",
          },
        },
        required: [],
      },
      restaurants: {
        type: "array",
        items: { type: "string" },
        description:
          "Named restaurants the traveler mentioned. Use the exact name as written. Empty array if none mentioned.",
      },
      activities: {
        type: "array",
        items: { type: "string" },
        description:
          "Named activities, tours, day trips, or experiences the traveler mentioned (e.g. 'Vatican private tour', 'Versailles day trip', 'wine tasting in Chianti'). Empty array if none mentioned.",
      },
    },
    required: ["basics"],
  },
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
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

  const text = String(body?.text || "").trim();
  if (!text) {
    return json({ error: { message: "Missing 'text' in request body" } }, 400);
  }
  // Soft cap — the guidelines NarrativeBox client-side max is 4000.
  if (text.length > 8000) {
    return json({ error: { message: "Narrative too long (max 8000 chars)" } }, 400);
  }

  const system = `You extract structured trip-planning fields from a traveler's freeform narrative. Today's date is ${todayISO()}. Call submit_trip_extract exactly ONCE with whatever you can extract.

EXTRACTION RULES — STRICT:
• Every field is OPTIONAL except basics.destination. Leave a field empty / blank rather than guessing.
• When a name appears in the narrative (hotel, restaurant, airline, airport, neighborhood, activity), use it EXACTLY as written. Do not normalize, abbreviate, or substitute.
• Dates: convert relative or partial dates to ISO YYYY-MM-DD using today's date as the anchor. If a date is in the past relative to today, roll it forward by one year (the traveler means the upcoming occurrence).
• Nights: derive from startDate + endDate when both are present (end - start). Otherwise pull from explicit phrasing.
• Budget: infer from named hotels using the hotel→tier mapping in the schema. Do not invent a budget if no hotel is named.
• Style: only include items from the exact enum list. Don't invent new styles.
• If the narrative names multiple hotels in different cities, treat it as multi-city: put the FIRST city in basics.destination and put all hotels in hotel.mustHave separated by ' / '.

DO NOT emit any prose. Only call the tool.`;

  const upstreamBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    system,
    messages: [
      {
        role: "user",
        content: `Extract trip fields from this narrative:\n\n"""\n${text}\n"""`,
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "submit_trip_extract" },
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
    return json(
      {
        error: {
          message: `Upstream ${upstream.status}`,
          detail: errText.slice(0, 500),
        },
      },
      502,
    );
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return json({ error: { message: "Upstream returned non-JSON" } }, 502);
  }

  // Pluck the tool_use block. Anthropic returns content[] with mixed types;
  // we want the one whose type === "tool_use" and name matches.
  const block = Array.isArray(payload?.content)
    ? payload.content.find((c) => c?.type === "tool_use" && c?.name === EXTRACT_TOOL.name)
    : null;

  if (!block || !block.input || typeof block.input !== "object") {
    return json(
      {
        error: { message: "Extraction tool did not return structured input" },
        raw: payload,
      },
      502,
    );
  }

  const extracted = block.input;

  // Hard gate: destination is the one required field. Without it the build
  // cannot resolve geography or weather. Return 422 so the client knows to
  // surface a friendly "couldn't figure out where you're going" message.
  if (!extracted?.basics?.destination || !String(extracted.basics.destination).trim()) {
    return json(
      {
        error: {
          message:
            "Couldn't find a destination in your narrative. Try adding a city or region name and try again.",
        },
        partial: extracted,
      },
      422,
    );
  }

  return json({ extracted });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
