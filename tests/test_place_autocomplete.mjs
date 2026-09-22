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

// Records the body of every upstream call and returns predictions per attempt.
// `perTier` is an array: entry i is the prediction list for the i-th call, so
// an empty entry forces the endpoint to fall through to the next type filter.
function mockTiers(perTier) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (url !== AUTOCOMPLETE_URL) return new Response("not found", { status: 404 });
    const body = JSON.parse(opts?.body || "{}");
    calls.push(body);
    const predictions = perTier[calls.length - 1] || [];
    return new Response(JSON.stringify({ suggestions: predictions }), { status: 200 });
  };
  return calls;
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

  // ---- Tier 1 hits: no widening, only one upstream call ----
  {
    const calls = mockTiers([[pred("Chatham, MA, USA", "id_chatham", "Chatham", "MA, USA")]]);
    const res = await onRequestPost({ request: makeReq({ input: "Chatham" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("tier 1 hit makes exactly one upstream call", calls.length === 1, calls.length);
    assert("tier 1 hit reports tier 0", body.tier === 0, JSON.stringify(body));
    assert(
      "tier 1 sends locality-family primary types",
      calls[0].includedPrimaryTypes?.includes("locality"),
      JSON.stringify(calls[0]),
    );
  }

  // ---- Tier 2 fires when the locality filter finds nothing ----
  // This is the "cape cod" symptom: a region that no locality-type filter
  // matches, which previously returned zero suggestions and forced the user
  // into freeform typing.
  {
    const calls = mockTiers([
      [],
      [pred("Cape Cod, MA, USA", "id_cape_cod", "Cape Cod", "MA, USA")],
    ]);
    const res = await onRequestPost({ request: makeReq({ input: "cape cod" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("tier 2 fallback fires after an empty tier 1", calls.length === 2, calls.length);
    assert("tier 2 fallback returns the region suggestion", body.suggestions.length === 1, JSON.stringify(body));
    assert("tier 2 fallback reports tier 1", body.tier === 1, JSON.stringify(body));
    assert(
      "tier 2 asks for (regions)",
      JSON.stringify(calls[1].includedPrimaryTypes) === JSON.stringify(["(regions)"]),
      JSON.stringify(calls[1]),
    );
  }

  // ---- Tier 3 (unfiltered) fires when both typed tiers come back empty ----
  {
    const calls = mockTiers([
      [],
      [],
      [pred("Cape Cod National Seashore, MA", "id_seashore", "Cape Cod National Seashore", "MA, USA")],
    ]);
    const res = await onRequestPost({ request: makeReq({ input: "cape cod national" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("tier 3 fallback fires after two empty tiers", calls.length === 3, calls.length);
    assert("tier 3 fallback returns a suggestion", body.suggestions.length === 1, JSON.stringify(body));
    assert("tier 3 fallback reports tier 2", body.tier === 2, JSON.stringify(body));
    assert(
      "tier 3 sends no type filter at all",
      calls[2].includedPrimaryTypes === undefined,
      JSON.stringify(calls[2]),
    );
  }

  // ---- All tiers empty: 200 with a note, no invented suggestions ----
  {
    const calls = mockTiers([[], [], []]);
    const res = await onRequestPost({ request: makeReq({ input: "zzzzz nowhere" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("exhausting every tier still returns 200", res.status === 200, res.status);
    assert("exhausting every tier tries all three", calls.length === 3, calls.length);
    assert("exhausting every tier returns empty suggestions", body.suggestions.length === 0, JSON.stringify(body));
    assert("exhausting every tier notes why", body.note === "autocomplete-no-matches", JSON.stringify(body));
  }

  // ---- Type-collection contract: (regions) must never share the list ----
  // Places rejects the request outright if a collection is combined with any
  // other type, and silently returning 400s is exactly how symptom #2 hid.
  {
    const calls = mockTiers([[], [], []]);
    await onRequestPost({ request: makeReq({ input: "anything" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const collectionsShared = calls.some((c) => {
      const types = c.includedPrimaryTypes;
      if (!Array.isArray(types)) return false;
      return types.some((t) => t.startsWith("(")) && types.length > 1;
    });
    assert("(regions) is never sent alongside another type", !collectionsShared, JSON.stringify(calls));
    const withinCap = calls.every(
      (c) => !Array.isArray(c.includedPrimaryTypes) || c.includedPrimaryTypes.length <= 5,
    );
    assert("no tier exceeds Places' 5-primary-type cap", withinCap, JSON.stringify(calls));
  }

  // ---- Every tier pins the response language ----
  {
    const calls = mockTiers([[], [], []]);
    await onRequestPost({ request: makeReq({ input: "anything" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    assert(
      "every tier sends languageCode 'en'",
      calls.length === 3 && calls.every((c) => c.languageCode === "en"),
      JSON.stringify(calls),
    );
    assert(
      "every tier forwards the user's input",
      calls.every((c) => c.input === "anything"),
      JSON.stringify(calls),
    );
  }

  // ---- A non-OK tier doesn't abort the ladder ----
  {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts?.body || "{}"));
      if (calls.length === 1) return new Response("upstream sad", { status: 400 });
      return new Response(
        JSON.stringify({ suggestions: [pred("Cape Cod, MA, USA", "id_cc", "Cape Cod", "MA, USA")] }),
        { status: 200 },
      );
    };
    const res = await onRequestPost({ request: makeReq({ input: "cape cod" }), env: { GOOGLE_PLACES_API_KEY: "k" } });
    const body = await res.json();
    assert("a rejected tier falls through instead of failing the request", res.status === 200, res.status);
    assert("a rejected tier still yields the later tier's suggestions", body.suggestions.length === 1, JSON.stringify(body));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
