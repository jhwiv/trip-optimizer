// POST /api/find-providers
// ------------------------------------------------------------------
// Sibling to /api/find, scoped to LOCAL SERVICE PROVIDERS that /api/find
// is explicitly forbidden from returning: private drivers / car services
// and licensed private guides. /api/find guarantees "NO transport, NO
// lodging" in three places; rather than loosen that guarantee, this
// endpoint provides a separate, clearly-scoped path for the provider
// categories the "Local providers" feature needs.
//
// It reuses the SAME real-source + verification machinery as /api/find:
//   1. A single non-streaming Anthropic call with a strict tool returns
//      real, currently-operating providers for the location (real names
//      only; blank fields over guesses — same anti-hallucination rules).
//   2. Every provider is then run through Google Places (New) via the
//      in-process verifyOneVenue() (the SAME function /api/find uses).
//      CLOSED_PERMANENTLY / CLOSED_TEMPORARILY / NOT_FOUND providers are
//      DROPPED (never flagged-and-shipped). OPERATIONAL providers get
//      contact.{address,phone,website} overwritten with Places values and
//      _verified=true. When the Places key is missing / unreachable the
//      provider is KEPT but tagged UNVERIFIED so the client labels it
//      "verify before booking" — fail safe, never fabricate verification.
//
// Request body:
//   { location: string, kind: "drivers" | "guides" }
//
// Returns:
//   200 { results: { providers: [...] }, kind, note?, verification }
//   400 { error:{message} }  — bad request / missing location / bad kind
//   422 { error:{message} }  — model returned nothing usable / nothing verifiable
//   500 { error:{message} }  — server misconfigured (no ANTHROPIC_API_KEY)
//   502 { error:{message} }  — upstream failure
//
// Honesty (CLAUDE.md): existence/status comes from Places, NOT the model.
// If verification can't run, the provider is UNVERIFIED, never "operational".

import { verifyOneVenue } from "./places-verify.js";

const LOCATION_MAX = 200;

const KIND_SPEC = {
  drivers: {
    label: "private drivers and car services",
    description:
      "Private drivers, chauffeurs, car services, black-car / executive transport, and licensed limo operators that serve this location. Real, currently-operating businesses only — a local operator the traveler could actually phone or book. Prefer the operator's own company name (e.g. 'High Mountain Limo', 'Ground Travel Specialists'), not a generic 'a private driver'. Do NOT default to a global brand (Blacklane/Carey) for a destination it does not serve; if you are not confident a named operator serves this location, set verify_status='verify_before_booking'.",
    typeHint: "Pick one: 'Car service', 'Chauffeur', 'Limo service', 'Private driver', 'Executive transport'.",
  },
  guides: {
    label: "licensed private guides and private tour operators",
    description:
      "Licensed private guides, guide bureaus, and operators offering PRIVATE (not group-bus) guided experiences at this location — art-historian guides, licensed city guides, private walking/food/history tours, driver-guides. Real, currently-operating businesses or recognized guide agencies only (e.g. 'Context Travel', 'ToursByLocals', a city's official licensed-guide bureau). If you cannot name a real operator, return fewer — never invent one.",
    typeHint: "Pick one: 'Private guide', 'Guide bureau', 'Private tour operator', 'Driver-guide'.",
  },
};

function providersTool(kind) {
  const spec = KIND_SPEC[kind];
  return {
    name: "submit_providers",
    description: `Return ${spec.label} for a given location. Real, currently-operating providers only. When unsure a provider is still operating, set verify_status='verify_before_booking' and give a verify_url. NEVER invent an operator name.`,
    input_schema: {
      type: "object",
      properties: {
        providers: {
          type: "array",
          description: `${spec.description} Order by quality and likely traveler appeal, best first. Aim for 4-8 strong, real options — fewer is fine if you cannot name more real ones. NEVER pad the list with invented names.`,
          items: {
            type: "object",
            required: ["name", "descriptor"],
            properties: {
              name: { type: "string", description: "Operator / company / guide name. Exact spelling. A real, nameable business." },
              type: { type: "string", description: spec.typeHint },
              descriptor: { type: "string", description: "One concrete sentence on what they offer and why a traveler would pick them. No marketing fluff." },
              contact: {
                type: "object",
                properties: {
                  phone: { type: "string", description: "Phone in local format with country code. Leave blank if unknown — never guess." },
                  address: { type: "string", description: "Street address or service area. Leave blank if uncertain." },
                  website: { type: "string", description: "Official website URL. Leave blank if you cannot identify it confidently — a blank field is far safer than a fabricated URL." },
                  booking_url: { type: "string", description: "Direct booking / inquiry URL if known. Leave blank if none." },
                },
              },
              verify_status: {
                type: "string",
                enum: ["", "verify_before_booking", "permanently_closed"],
                description: "Set 'verify_before_booking' when you are not confident this provider currently operates here. Set 'permanently_closed' if you know it has closed. Blank only if confident it operates.",
              },
              verify_url: {
                type: "string",
                description: "When verify_status is set, a Google search or listing URL the traveler can use to confirm the operator.",
              },
            },
          },
        },
        note: {
          type: "string",
          description: "Optional one-sentence note about coverage, e.g. 'Sedona has no dedicated chauffeur firms; the listed operators serve the wider Verde Valley.' Leave blank if nothing useful to add.",
        },
      },
      required: ["providers"],
    },
  };
}

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

  const location = String(body?.location || "").trim();
  if (!location) {
    return json({ error: { message: "Missing 'location' in request body" } }, 400);
  }
  if (location.length > LOCATION_MAX) {
    return json({ error: { message: `Location too long (max ${LOCATION_MAX} chars)` } }, 400);
  }

  const kind = String(body?.kind || "").toLowerCase().trim();
  if (!KIND_SPEC[kind]) {
    return json({ error: { message: "Invalid 'kind' — expected 'drivers' or 'guides'" } }, 400);
  }

  const tool = providersTool(kind);
  const spec = KIND_SPEC[kind];

  const system = `You find ${spec.label} at a specific location for a traveler. Today's date is ${todayISO()}. Call submit_providers exactly ONCE.

WHAT YOU RETURN
• Real, currently-operating ${spec.label} that serve this location.

RULES
• Real, nameable operators only. If you cannot identify a specific real provider, do NOT invent one — return fewer instead.
• NEVER return hotels, lodging, restaurants, flights, or generic advice. Only ${spec.label}.
• Contact info is OPTIONAL. Leave phone / website blank rather than guessing — a blank field is safer than a hallucinated one. Do NOT invent URLs or phone numbers.
• When you are not highly confident a named operator currently serves this location, set verify_status='verify_before_booking' and provide a verify_url (a Google search or listing link). The traveler-facing UI verifies existence against Google Places after you respond, so an honest "verify" flag is always better than a confident guess.
• Prefer local operators that genuinely serve the destination over global brands that may not. Do not name a national chain in a town it does not cover.

OUTPUT
Call submit_providers exactly once. Emit no prose.`;

  const userMessage = `Location: ${location}\nProvider type: ${spec.label}`;

  const upstreamBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 3000,
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_providers" },
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
    ? payload.content.find((c) => c?.type === "tool_use" && c?.name === tool.name)
    : null;

  if (!block || !block.input || typeof block.input !== "object") {
    return json({ error: { message: "Provider tool did not return structured input" }, raw: payload }, 502);
  }

  const providers = Array.isArray(block.input.providers)
    ? block.input.providers.filter((p) => p && typeof p === "object" && typeof p.name === "string" && p.name.trim())
    : [];

  if (providers.length === 0) {
    return json(
      { error: { message: `No ${spec.label} found for that location. Try a nearby larger town or the regional hub.` } },
      422,
    );
  }

  // ---- Verification pass — identical policy to /api/find -----------------
  const verification = await verifyProviders({ env, ctx: context, location, providers });

  if (verification.providers.length === 0) {
    return json(
      {
        error: { message: `No verifiable ${spec.label} found for that location.` },
        verification: verification.summary,
      },
      422,
    );
  }

  return json({
    results: { providers: verification.providers },
    kind,
    note: typeof block.input.note === "string" ? block.input.note : "",
    verification: verification.summary,
  });
}

// Verify every provider against Google Places (New). Mirrors
// verifyVenuesForFind() in functions/api/find.js: drop block-severity
// providers, overwrite contact fields on OPERATIONAL, surface UNVERIFIED
// with a warn flag (never drop those — they stay, labeled).
async function verifyProviders({ env, ctx, location, providers }) {
  let cacheHits = 0;
  let blocked = 0;
  let warnings = 0;

  const concurrency = 6;
  const verified = new Array(providers.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= providers.length) return;
      const item = providers[i];
      try {
        const result = await verifyOneVenue({ env, ctx, name: item?.name || "", city: location });
        if (result.cached) cacheHits += 1;
        const flag = flagForVerifyResult(result);
        if (flag) {
          if (flag.severity === "block") blocked += 1;
          else if (flag.severity === "warn") warnings += 1;
        }
        verified[i] = { item, result, flag };
      } catch (err) {
        warnings += 1;
        const msg = String(err?.message || err).slice(0, 200);
        verified[i] = {
          item,
          result: { found: false, error: msg },
          flag: { code: "UNVERIFIED", severity: "warn", message: msg },
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, providers.length) }, worker));

  const out = [];
  for (const row of verified) {
    if (!row) continue;
    if (row.flag && row.flag.severity === "block") continue;

    const item = row.item;
    const result = row.result;
    let next = item;

    if (result.found && (!result.business_status || result.business_status === "OPERATIONAL")) {
      const prevContact = item && item.contact && typeof item.contact === "object" ? item.contact : {};
      const nextContact = { ...prevContact };
      if (result.address) nextContact.address = result.address;
      if (result.phone) nextContact.phone = result.phone;
      if (result.website) nextContact.website = result.website;
      if (Array.isArray(result.hours) && result.hours.length) nextContact.hours_verified = result.hours;
      next = { ...item, contact: nextContact };
      if (result.place_id) next.place_id = result.place_id;
      if (typeof result.lat === "number") next.lat = result.lat;
      if (typeof result.lng === "number") next.lng = result.lng;
      next._verified = true;
    }

    if (row.flag) {
      next = { ...next, flags: [...(Array.isArray(item?.flags) ? item.flags : []), row.flag] };
    }

    out.push(next);
  }

  return {
    providers: out,
    summary: { checked: providers.length, blocked, warnings, cache_hits: cacheHits },
  };
}

// Map a verifyOneVenue() result to the canonical flag (or null when OK).
// Kept in lockstep with flagForVerifyResult() in functions/api/find.js.
function flagForVerifyResult(result) {
  if (result.found) {
    if (result.business_status === "CLOSED_PERMANENTLY") {
      return { code: "CLOSED_PERMANENTLY", severity: "block", message: "Permanently closed per Google Places" };
    }
    if (result.business_status === "CLOSED_TEMPORARILY") {
      return { code: "CLOSED_TEMPORARILY", severity: "block", message: "Temporarily closed per Google Places" };
    }
    return null;
  }
  if (result.error === "not-found") {
    return { code: "NOT_FOUND", severity: "block", message: "Google Places returned zero matches for this name + city" };
  }
  if (result.error) {
    return { code: "UNVERIFIED", severity: "warn", message: result.error };
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
