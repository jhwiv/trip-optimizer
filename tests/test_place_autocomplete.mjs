// Tests for functions/api/place-autocomplete.js — mocked fetch, no KV.

import { onRequestPost } from "../functions/api/place-autocomplete.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";

function makeReq(body) {
  return new Request("http://localhost/api/place-autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockUpstream(predictions) {
  return async (url) => {
    if (url === AUTOCOMPLETE_URL) {
      return new Response(JSON.stringify({ suggestions: predictions }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function pred(text, placeId, mainText, secondaryText) {
  return {
    placePrediction: {
      text: { text },
      placeId,
      structuredFormat: {
        mainText: { text: mainText },
        secondaryText: { text: secondaryText },
      },
    },
  };
}

async function run() {
  console.log("test_place_autocomplete.mjs");

  // ---- Missing API key: soft-fail with empty suggestions, 200 ----
  {
    globalThis.fetch = async () => { throw new Error("should not be called"); };
    const res = await onRequestPost({ request: makeReq({ input: "Bolton Landing" }), env: {} });
    const body = await res.json();
    assert("no-key soft-fails with 200", res.status === 200, res.status);
    assert("no-key returns empty suggestions", Array.isArray(body.suggestions) && body.suggestions.length === 0);
  }

  // ---- Too-short input: 400 ----
  {
    const res = await onRequestPost({ request: makeReq({ input: "B" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    assert("short input returns 400", res.status === 400, res.status);
  }

  // ---- Missing input: 400 ----
  {
    const res = await onRequestPost({ request: makeReq({}), env: { GOOGLE_PLACES_API_KEY: "k" } });
    assert("missing input returns 400", res.status === 400, res.status);
  }

  // ---- Overlong input: 400 ----
  {
    const res = await onRequestPost({ request: makeReq({ input: "x".repeat(201) }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    assert("overlong input returns 400", res.status === 400, res.status);
  }

  // ---- Happy path: disambiguates Bolton Landing, NY from Bolton, UK ----
  {
    globalThis.fetch = mockUpstream([
      pred("Bolton Landing, NY, USA", "place_bolton_landing_ny", "Bolton Landing", "NY, USA"),
      pred("Bolton, Greater Manchester, UK", "place_bolton_uk", "Bolton", "Greater Manchester, UK"),
    ]);
    const res = await onRequestPost({ request: makeReq({ input: "Bolton" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("happy path returns 200", res.status === 200, res.status);
    assert("happy path returns 2 suggestions", body.suggestions.length === 2, body.suggestions.length);
    assert(
      "first suggestion is Bolton Landing NY with disambiguating secondary text",
      body.suggestions[0].main_text === "Bolton Landing" && body.suggestions[0].secondary_text === "NY, USA",
      JSON.stringify(body.suggestions[0]),
    );
    assert(
      "second suggestion is Bolton UK, distinguishable by secondary text",
      body.suggestions[1].main_text === "Bolton" && body.suggestions[1].secondary_text.includes("UK"),
      JSON.stringify(body.suggestions[1]),
    );
    assert("each suggestion carries a place_id", body.suggestions.every((s) => !!s.place_id));
  }

  // ---- Upstream non-OK: soft-fail to empty suggestions, still 200 ----
  {
    globalThis.fetch = async () => new Response("error", { status: 500 });
    const res = await onRequestPost({ request: makeReq({ input: "Bolton Landing" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("upstream 500 soft-fails with 200", res.status === 200, res.status);
    assert("upstream 500 returns empty suggestions", body.suggestions.length === 0);
  }

  // ---- Upstream malformed JSON: soft-fail to empty suggestions ----
  {
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    const res = await onRequestPost({ request: makeReq({ input: "Bolton Landing" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("malformed upstream JSON soft-fails with 200", res.status === 200, res.status);
    assert("malformed upstream JSON returns empty suggestions", body.suggestions.length === 0);
  }

  // ---- Network error / timeout: soft-fail to empty suggestions ----
  {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const res = await onRequestPost({ request: makeReq({ input: "Bolton Landing" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("network error soft-fails with 200", res.status === 200, res.status);
    assert("network error returns empty suggestions", body.suggestions.length === 0);
  }

  // ---- Predictions missing placePrediction are filtered out ----
  {
    globalThis.fetch = mockUpstream([{ notAPlacePrediction: true }, pred("Miami, FL, USA", "place_miami", "Miami", "FL, USA")]);
    const res = await onRequestPost({ request: makeReq({ input: "Miami" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("malformed prediction entries are filtered out", body.suggestions.length === 1, body.suggestions.length);
    assert("surviving suggestion is Miami", body.suggestions[0].main_text === "Miami");
  }

  // ---- Result capped at MAX_SUGGESTIONS (6) ----
  {
    const many = Array.from({ length: 10 }, (_, i) => pred(`Place ${i}`, `id_${i}`, `Place ${i}`, "State, USA"));
    globalThis.fetch = mockUpstream(many);
    const res = await onRequestPost({ request: makeReq({ input: "Place" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("suggestions capped at 6", body.suggestions.length === 6, body.suggestions.length);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
