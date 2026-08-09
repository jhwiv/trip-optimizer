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
          destinations: {
            type: "array",
            items: { type: "string" },
            description:
              "ALL distinct cities/regions/countries the trip visits, IN VISITING ORDER, when the narrative describes more than one stop. The first entry must equal basics.destination. Examples: for 'London, then Paris, then Normandy, then Porto' → ['London', 'Paris', 'Normandy', 'Porto']. Leave as an empty array (or a single-item array matching basics.destination) for a genuinely single-destination trip — do not pad it with invented stops.",
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
      name_checks: {
        type: "array",
        description:
          "Names from the narrative you are NOT confident are both real AND workable as stated. Use this whenever the traveler writes a hotel/restaurant/airline/activity name that might be misspelled, ambiguous between multiple real properties, doesn't match any property you know, OR \u2014 for airline \u2014 is a real, correctly-spelled carrier that does not plausibly operate on the route(s) this itinerary implies (e.g. a transatlantic or intercontinental leg that carrier doesn't fly). NEVER silently correct or silently drop the preference \u2014 always echo the original text verbatim in the relevant field AND list it here with candidate alternatives so the traveler can confirm. Empty array if every named entity is clearly identified AND workable.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["hotel", "restaurant", "airline", "activity", "other"],
              description: "What kind of named entity this is.",
            },
            original: {
              type: "string",
              description: "The exact text the traveler wrote, verbatim.",
            },
            reason: {
              type: "string",
              description:
                "One short sentence on why you're uncertain. Examples: 'Marriott has multiple properties in Park City \u2014 unclear which one', 'No restaurant by this exact name in Santa Fe \u2014 possible misspelling of Sazon', 'Hotel brand named but specific property not stated', 'LOT Polish Airlines does not operate this route \u2014 not a spelling issue, a route-plausibility issue'.",
            },
            candidates: {
              type: "array",
              items: { type: "string" },
              description:
                "Up to 4 likely real-world names/carriers the traveler might have meant, OR \u2014 for a route-implausible airline \u2014 up to 4 real carriers that DO plausibly operate the route(s) instead. Order by likelihood. Examples: ['Marriott's MountainSide Resort, Park City', 'Marriott Vacation Club at Park City'] or ['United', 'British Airways', 'Virgin Atlantic'].",
            },
          },
          required: ["kind", "original", "reason"],
        },
      },
      destination_notes: {
        type: "array",
        items: { type: "string" },
        description:
          "One short sentence per implied stop you added to basics.destinations that the traveler did NOT explicitly list as a country/region/city. This happens when a named must-visit venue, activity, or landmark is clearly located somewhere outside every stop already named \u2014 e.g. the traveler lists 'England, France, Portugal' as the countries but also says a specific Nuremberg museum is a must-visit (Nuremberg is in Germany, never mentioned). In that case, ADD the implied stop to basics.destinations in its correct visiting-order position (do not silently drop the must-visit requirement, and do not silently leave the destination list incomplete either) AND add one entry here explaining the addition, e.g. 'Added Germany to destinations \u2014 required by the must-visit \"Nuremberg Trials Memorial,\" which is not in Germany-free England/France/Portugal.' Empty array when every named must-visit is already covered by the traveler's own stated destinations.",
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
  // Soft cap — the guidelines NarrativeBox client-side max is 40,000.
  // We accept up to 40,000 here too so a full pasted itinerary / Word doc
  // can flow straight into extraction without being rejected. Claude is
  // comfortable with that input length for a single tool-use turn.
  if (text.length > 40000) {
    return json({ error: { message: "Narrative too long (max 40,000 chars)" } }, 400);
  }

  const system = `You extract structured trip-planning fields from a traveler's freeform narrative. Today's date is ${todayISO()}. Call submit_trip_extract exactly ONCE with whatever you can extract.

EXTRACTION RULES — STRICT:
• Every field is OPTIONAL except basics.destination. Leave a field empty / blank rather than guessing.
• When a name appears in the narrative (hotel, restaurant, airline, airport, neighborhood, activity), use it EXACTLY as written. Do not normalize, abbreviate, or substitute.
• Dates: convert relative or partial dates to ISO YYYY-MM-DD using today's date as the anchor. If a date is in the past relative to today, roll it forward by one year (the traveler means the upcoming occurrence).
• Nights: derive from startDate + endDate when both are present (end - start). Otherwise pull from explicit phrasing.
• Budget: infer from named hotels using the hotel→tier mapping in the schema. Do not invent a budget if no hotel is named.
• Style: only include items from the exact enum list. Don't invent new styles.
• MULTI-CITY — CRITICAL, CHECK EVERY TIME: does the narrative name, or clearly imply, more than one city/region/country as part of the itinerary (multiple hotels in different places, a route like "London then Paris then Normandy", multiple countries mentioned as destinations, a day-by-day pasted itinerary spanning several places)? If so, you MUST populate basics.destinations with EVERY distinct stop, in the order visited — this is not optional and is easy to forget when focused on the single basics.destination field. basics.destination still gets only the FIRST stop; hotel.mustHave still gets all hotel names separated by ' / '. A single-destination narrative (one city/region, one hotel, no route) leaves basics.destinations empty — do not populate it with just one entry.
  Worked example — narrative: "Two weeks this October: fly into London, a few days there, then the Eurostar to Paris, a few days, then a rental car through Normandy for the D-Day beaches, then fly Paris to Porto for the last leg. Focused on WWII history and Portuguese wine country." →
  basics.destination: "London"
  basics.destinations: ["London", "Paris", "Normandy", "Porto"]
  This applies EVEN IF the narrative describes the stops loosely by country/region rather than by city name (e.g. "starting in England, then on to France, then Portugal") — extract basics.destinations as ["England", "France", "Portugal"] in that case, matching whatever granularity the traveler actually used. Getting this field right matters: it drives what the traveler sees on the build-progress screen while their trip is generating, and an incomplete list makes a real multi-country trip look like it only covers the first stop.
• UNCERTAIN NAMES — CRITICAL: If a hotel/restaurant/airline/activity name in the narrative looks misspelled, ambiguous between multiple real properties, or doesn't match a property you can clearly identify, you MUST: (1) keep the exact original text in the relevant field (mustHave / restaurants[] / activities[] / airline), AND (2) add an entry to name_checks with the original text, the reason, and up to 4 candidate real-world names. NEVER silently substitute a 'corrected' name. A wrong silent correction is worse than asking the traveler to confirm. Example: traveler writes 'Marriot Mountainside' → keep 'Marriot Mountainside' in hotel.mustHave, add name_checks entry: { kind:'hotel', original:'Marriot Mountainside', reason:'Multiple Marriott properties could match', candidates:['Marriott\'s MountainSide at Park City','Park City Marriott'] }.
• AIRLINE ROUTE PLAUSIBILITY — CRITICAL, a DIFFERENT check from spelling: even when an airline name is real and correctly spelled, check whether it plausibly operates ANY leg implied by this itinerary (the home airport to the first destination, and between named destinations, at minimum). A real airline that doesn't serve any of these routes is still a name_check, same mechanism as a misspelling — kind:'airline', reason explaining it's a route-plausibility issue (not spelling), candidates listing 2-4 real carriers that DO plausibly serve the route(s). Example: traveler writes 'depart Newark, maybe LOT is best for a WWII history trip' with a London-first itinerary → keep 'LOT' in flights.airline, add name_checks entry: { kind:'airline', original:'LOT', reason:'LOT Polish Airlines does not operate Newark–London — route-plausibility issue, not a spelling issue', candidates:['United','British Airways','Virgin Atlantic'] }.
• DESTINATION CONSISTENCY — CRITICAL: after extracting basics.destinations (per the MULTI-CITY rule above) and any must-visit venues/activities, check whether every must-visit is actually located within one of the stated destinations. If a must-visit venue is clearly located somewhere else entirely (a different country/region never named), ADD that place to basics.destinations in the correct visiting-order position — do not silently drop the must-visit requirement, and do not silently leave the destination list incomplete either — AND add a destination_notes[] entry explaining the addition. Example: traveler writes 'countries should include England, France, Portugal' plus 'Nuremberg Trials Memorial is a must-visit' → basics.destinations must include Germany even though the traveler's own country list omitted it, with destination_notes: ["Added Germany to destinations — required by the must-visit \\"Nuremberg Trials Memorial,\\" which is not in England, France, or Portugal."].

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
