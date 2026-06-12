// Pass 1 tests for v3: separate local-expert state, /api/menu, /api/activity-details.
import { onRequestPost as findPost } from "../functions/api/find.js";
import { onRequestPost as menuPost } from "../functions/api/menu.js";
import { onRequestPost as detailsPost } from "../functions/api/activity-details.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function mockReq(body) {
  return new Request("https://x/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function callFind(body, env, fetchImpl) {
  const orig = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    const res = await findPost({ request: mockReq(body), env });
    return { status: res.status, json: await res.json() };
  } finally {
    globalThis.fetch = orig;
  }
}
async function callMenu(body, env, fetchImpl) {
  const orig = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    const res = await menuPost({ request: mockReq(body), env });
    return { status: res.status, json: await res.json() };
  } finally {
    globalThis.fetch = orig;
  }
}
async function callDetails(body, env, fetchImpl) {
  const orig = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    const res = await detailsPost({ request: mockReq(body), env });
    return { status: res.status, json: await res.json() };
  } finally {
    globalThis.fetch = orig;
  }
}

console.log("=== /api/menu input validation + happy path ===");

// 1. Missing key
{
  const { status, json } = await callMenu({ name: "X", location: "Y" }, {});
  assert("missing ANTHROPIC_API_KEY → 500", status === 500 && /ANTHROPIC_API_KEY/.test(json?.error?.message));
}
// 2. Missing name
{
  const { status, json } = await callMenu({ location: "Y" }, { ANTHROPIC_API_KEY: "k" });
  assert("missing name → 400", status === 400 && /name/.test(json?.error?.message));
}
// 3. Missing location
{
  const { status, json } = await callMenu({ name: "X" }, { ANTHROPIC_API_KEY: "k" });
  assert("missing location → 400", status === 400 && /location/.test(json?.error?.message));
}
// 4. Happy path
{
  let captured = null;
  const mock = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "submit_restaurant_menu", input: {
        style_note: "Modern Southwestern small plates.",
        signature_dishes: [
          "Green chile cheeseburger",
          { name: "Carne adovada", description: "Slow-braised pork in red chile", price: "$28" },
        ],
        mains: [{ name: "Trout almondine", price: "$34" }],
        source_note: "Representative; menu rotates seasonally.",
      } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { status, json } = await callMenu(
    { name: "Cafe Pasqual's", location: "Santa Fe, NM", cuisine: "Modern Southwestern" },
    { ANTHROPIC_API_KEY: "k" }, mock,
  );
  assert("menu happy path → 200", status === 200);
  assert("menu has signature_dishes", Array.isArray(json?.menu?.signature_dishes) && json.menu.signature_dishes.length === 2);
  assert("string + object mixed items both work", typeof json.menu.signature_dishes[0] === "string" && typeof json.menu.signature_dishes[1] === "object");
  assert("user prompt includes restaurant name", /Cafe Pasqual/.test(captured?.messages?.[0]?.content || ""));
  assert("system prompt includes cuisine context", /Modern Southwestern/.test(captured?.system || ""));
}
// 5. Empty menu → 422
{
  const mock = async () => new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "submit_restaurant_menu", input: { style_note: "" } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const { status, json } = await callMenu(
    { name: "Empty Bistro", location: "Nowhere" },
    { ANTHROPIC_API_KEY: "k" }, mock,
  );
  assert("empty menu → 422", status === 422 && /Couldn't generate/.test(json?.error?.message));
}
// 6. Upstream error → 502
{
  const mock = async () => new Response("Anthropic angry", { status: 500 });
  const { status } = await callMenu(
    { name: "X", location: "Y" }, { ANTHROPIC_API_KEY: "k" }, mock,
  );
  assert("upstream 500 → 502", status === 502);
}

console.log("\n=== /api/activity-details input validation + happy path ===");

// 7. Missing key
{
  const { status } = await callDetails({ name: "X", location: "Y" }, {});
  assert("missing ANTHROPIC_API_KEY → 500", status === 500);
}
// 8. Missing name
{
  const { status, json } = await callDetails({ location: "Y" }, { ANTHROPIC_API_KEY: "k" });
  assert("missing name → 400", status === 400);
}
// 9. Happy path
{
  let captured = null;
  const mock = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "submit_activity_details", input: {
        best_time: "Weekday mornings before 10am",
        typical_duration: "2-3 hours",
        booking_tips: "Walk-up fine except July weekends",
        locals_tips: "Park at the south lot - free vs $15 north",
        nearby_pairings: ["Lunch at Smith's", "Prospect Mountain after"],
        source_note: "General knowledge of the area.",
      } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { status, json } = await callDetails(
    { name: "Lake George Steamboat Cruise", location: "Lake George, NY", type: "Activity" },
    { ANTHROPIC_API_KEY: "k" }, mock,
  );
  assert("details happy path → 200", status === 200);
  assert("details.best_time present", typeof json?.details?.best_time === "string" && json.details.best_time.length > 0);
  assert("nearby_pairings is array", Array.isArray(json?.details?.nearby_pairings) && json.details.nearby_pairings.length === 2);
  assert("user prompt includes activity name", /Steamboat Cruise/.test(captured?.messages?.[0]?.content || ""));
}
// 10. Empty details → 422
{
  const mock = async () => new Response(JSON.stringify({
    content: [{ type: "tool_use", name: "submit_activity_details", input: { source_note: "Unknown activity." } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const { status } = await callDetails(
    { name: "Bogus Place", location: "Nowhere" },
    { ANTHROPIC_API_KEY: "k" }, mock,
  );
  assert("empty details → 422", status === 422);
}

console.log("\n=== /api/find still works the same (no regression) ===");

const HAPPY = {
  content: [{ type: "tool_use", name: "submit_find_results", input: {
    restaurants: [{ name: "Test Restaurant", type: "Restaurant", why: "Test.", contact: {} }],
    activities: [{ text: "Test Activity", type: "Activity", why: "Test.", contact: {} }],
  } }],
};

// 11. Standard mode still works
{
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { status, json } = await callFind(
    { location: "Lake George, NY" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  assert("/api/find standard → 200", status === 200);
  assert("local_expert null for standard", json.local_expert === null);
  assert("restaurants returned", json.results?.restaurants?.length === 1);
}

// 12. local_expert mode still works with curated source
{
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) return new Response(JSON.stringify({ results: [{ title: "T", url: "https://x", snippet: "S" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { status, json } = await callFind(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  assert("/api/find local_expert → 200", status === 200);
  assert("local_expert curated", json.local_expert?.source_set === "curated");
  assert("local_expert sources populated", (json.local_expert?.sources?.length || 0) === 6);
}

// 13. Hotel filter still drops hotels
{
  const HOTEL_RESP = {
    content: [{ type: "tool_use", name: "submit_find_results", input: {
      restaurants: [
        { name: "Real Restaurant", type: "Restaurant", why: "Real.", contact: {} },
        { name: "Sagamore Resort", type: "Hotel", why: "Lodging.", contact: {} },
      ],
      activities: [],
    } }],
  };
  const mock = async () => new Response(JSON.stringify(HOTEL_RESP), { status: 200, headers: { "content-type": "application/json" } });
  const { json } = await callFind({ location: "X" }, { ANTHROPIC_API_KEY: "k" }, mock);
  assert("hotel still filtered out", json.results?.restaurants?.length === 1 && json.results.restaurants[0].name === "Real Restaurant");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
