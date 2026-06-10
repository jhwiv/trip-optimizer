// POST /api/menu
// ------------------------------------------------------------------
// Lazy menu fetch for a named restaurant at a location. Called from
// FindRestaurantCard's "View Menu" button. Returns a structured menu
// shaped to what MenuModal in src/App.jsx already renders.
//
// Why lazy: most search results never get a menu view. Building the
// menu into the /api/find response would slow every search and waste
// tokens for menus nobody ever opens.
//
// Request:
//   { name: string, location: string, cuisine?: string }
//
// Returns:
//   200 { menu: { style_note, signature_dishes, appetizers, mains,
//                desserts, wine_and_drinks, source_note } }
//   400 { error: { message } }   — bad input
//   422 { error: { message } }   — model returned no usable menu
//   500 / 502 — standard upstream errors

const NAME_MAX = 200;
const LOCATION_MAX = 200;

const MENU_TOOL = {
  name: "submit_restaurant_menu",
  description:
    "Return a representative menu for a real restaurant. Use what you know about the restaurant from training data and from typical offerings at this style of place. If the exact current menu is uncertain (which it often is — menus change seasonally), provide a representative sample and note that in source_note. NEVER invent items the restaurant clearly does not serve (e.g., do not put steak on a vegetarian restaurant's menu). Skip categories the restaurant does not offer.",
  input_schema: {
    type: "object",
    properties: {
      style_note: {
        type: "string",
        description:
          "One sentence describing the restaurant's culinary style or menu philosophy. Examples: 'Modern Southwestern small plates with red and green chile throughout.' or 'New American tasting menu changing weekly with farm partners.'",
      },
      signature_dishes: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                price: { type: "string" },
              },
            },
          ],
        },
        description:
          "The 2–5 items the restaurant is best known for. Use the object form when you have a credible description or price; the string form is fine for famous-by-name items.",
      },
      appetizers: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                price: { type: "string" },
              },
            },
          ],
        },
        description: "Appetizers, small plates, or shareable starters. 3–6 items.",
      },
      mains: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                price: { type: "string" },
              },
            },
          ],
        },
        description: "Main courses. 4–8 items spanning typical proteins and pasta/pizza if applicable.",
      },
      desserts: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                price: { type: "string" },
              },
            },
          ],
        },
        description: "Desserts. 2–4 items. Skip if this is not a dessert-serving venue (e.g., bar, taco stand).",
      },
      wine_and_drinks: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                price: { type: "string" },
              },
            },
          ],
        },
        description:
          "Notable wines, cocktails, beers, or non-alcoholic drinks the restaurant is known for. 2–6 items. Skip if not a drinks-focused venue or you have no specific knowledge.",
      },
      source_note: {
        type: "string",
        description:
          "Short transparency note. Examples: 'Menu items representative — actual menu rotates seasonally. Confirm with the restaurant.' or 'Based on the restaurant's published menu as of training data — check their website for current pricing.' Always include this when prices or specific items are listed.",
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

  const cuisine = String(body?.cuisine || "").trim().slice(0, 100);

  const system = `You provide menus for real, named restaurants. Today's date is ${new Date().toISOString().slice(0, 10)}. Call submit_restaurant_menu exactly ONCE.

RULES:
• Restaurant: ${name}${location ? ` (in ${location})` : ""}${cuisine ? ` — ${cuisine}` : ""}.
• Use the restaurant's known cuisine and price tier as anchors. If you don't recognize the specific restaurant, build a representative menu for that style at that location.
• Skip categories the restaurant clearly does not offer. A coffee shop has no Mains. A taco stand has no Desserts.
• Prefer the object form { name, description, price } when you can give credible specifics. Use strings for famous-by-name items where description would be redundant.
• Be honest in source_note: if the menu is best-guess vs. published, say so. Always recommend the traveler verify current offerings.
• Do NOT invent fundamentally incompatible items (no steak at a vegetarian place, no Italian pasta at a Japanese restaurant).
• Emit no prose. Call the tool.`;

  const userMessage = `Provide a menu for "${name}"${location ? ` in ${location}` : ""}${cuisine ? ` (${cuisine})` : ""}.`;

  const upstreamBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: [MENU_TOOL],
    tool_choice: { type: "tool", name: "submit_restaurant_menu" },
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
    ? payload.content.find((c) => c?.type === "tool_use" && c?.name === MENU_TOOL.name)
    : null;
  if (!block || !block.input || typeof block.input !== "object") {
    return json({ error: { message: "Menu tool did not return structured input" } }, 502);
  }

  const menu = block.input;
  // Sanity: at least one of signature_dishes/mains/appetizers must have content.
  const hasAnyContent =
    (Array.isArray(menu.signature_dishes) && menu.signature_dishes.length > 0) ||
    (Array.isArray(menu.mains) && menu.mains.length > 0) ||
    (Array.isArray(menu.appetizers) && menu.appetizers.length > 0) ||
    (Array.isArray(menu.wine_and_drinks) && menu.wine_and_drinks.length > 0);
  if (!hasAnyContent) {
    return json({ error: { message: "Couldn't generate a usable menu for this restaurant." } }, 422);
  }

  return json({ menu });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
