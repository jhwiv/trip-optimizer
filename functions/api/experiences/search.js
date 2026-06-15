// POST /api/experiences/search
//
// Unified experiences-search endpoint. Fan-outs in parallel to every provider
// adapter (Viator, GetYourGuide, Tiqets, Private), normalizes each result to
// the same Experience shape (see _shared.js), then merges + ranks them.
//
// Why one endpoint and not four:
//   The client (and the build-prompt) shouldn't have to know which providers
//   are wired up today vs tomorrow. Drop a token into the Pages secrets, the
//   provider lights up automatically; no client change needed. Providers
//   without keys are soft-skipped — never an error.
//
// Body:
//   {
//     destination: "Lisbon, Portugal",      // required
//     interests?: ["food", "history"],      // optional, used for ranking
//     startDate?: "2026-09-12",             // ISO date
//     endDate?: "2026-09-15",
//     maxPriceUsd?: 500,
//     limit?: 24,                           // total results across all providers
//     providers?: ["viator", "private"]     // optional subset
//   }
//
// Response:
//   {
//     results: Experience[],
//     debug: { providers: [{ provider, queried, count, error }] },
//     elapsed_ms: number
//   }

import { viatorSearch } from "./viator.js";
import { tiqetsSearch } from "./tiqets.js";
import { getYourGuideSearch } from "./getyourguide.js";
import { privateSearch } from "./private.js";
import { json, corsOptions } from "./_shared.js";

const ALL_PROVIDERS = ["viator", "getyourguide", "tiqets", "private"];

export async function onRequestOptions() { return corsOptions(); }

export async function onRequestPost({ request, env }) {
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const destination = String(body?.destination || "").trim();
  if (!destination) return json({ error: "Missing destination" }, 400);

  const requested = Array.isArray(body?.providers) && body.providers.length
    ? body.providers.filter((p) => ALL_PROVIDERS.includes(p))
    : ALL_PROVIDERS;

  const args = {
    destination,
    interests: Array.isArray(body?.interests) ? body.interests : [],
    startDate: body?.startDate || undefined,
    endDate: body?.endDate || undefined,
    maxPriceUsd: Number.isFinite(body?.maxPriceUsd) ? body.maxPriceUsd : undefined,
    limit: Math.min(body?.limit || 24, 60),
  };

  // Per-provider concurrency cap is left to each adapter's own timeout. We
  // collect via Promise.allSettled so one slow/dead provider can't block the
  // others — the user gets whatever responds within ~10 seconds.
  const tasks = requested.map((provider) => runProvider(provider, args, env));
  const settled = await Promise.allSettled(tasks);

  const providerDebug = [];
  let merged = [];
  for (let i = 0; i < settled.length; i++) {
    const provider = requested[i];
    const s = settled[i];
    if (s.status === "fulfilled") {
      providerDebug.push(s.value.debug);
      merged = merged.concat(s.value.results || []);
    } else {
      providerDebug.push({
        provider,
        queried: false,
        count: 0,
        error: String(s.reason?.message || s.reason),
      });
    }
  }

  // Rank: a soft composite score so good private operators surface alongside
  // commodity Viator products instead of being buried.
  //
  // Score components:
  //   rating       (0..5)  *0.6
  //   reviewCount  log10   *0.3   (saturates so 50k reviews ≠ 50× a 100-review tour)
  //   privateBoost +0.5            (push private operators up — Jeff's stated UX goal)
  //   skipTheLine  +0.15
  //   interestMatch overlap of categories with body.interests, scaled *0.5
  //
  // We deliberately do NOT down-rank by price; the user's price filter already
  // happens at the adapter level and tier is shown to the user separately.
  const scored = merged.map((e) => ({
    e,
    score: scoreExperience(e, args.interests),
  }));
  scored.sort((a, b) => b.score - a.score);

  // De-dupe near-duplicates by name (Viator and GYG often carry the same tour
  // from the same operator). Keep the higher-scoring one.
  const seen = new Set();
  const deduped = [];
  for (const { e } of scored) {
    const key = normalizeName(e.name);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
    if (deduped.length >= args.limit) break;
  }

  return json({
    results: deduped,
    debug: { providers: providerDebug },
    elapsed_ms: Date.now() - startedAt,
  });
}

async function runProvider(provider, args, env) {
  switch (provider) {
    case "viator":       return viatorSearch(args, env);
    case "tiqets":       return tiqetsSearch(args, env);
    case "getyourguide": return getYourGuideSearch(args, env);
    case "private":      return privateSearch(args, env);
    default:             return { results: [], debug: { provider, queried: false, count: 0, error: "unknown provider" } };
  }
}

function scoreExperience(e, interests) {
  let score = 0;
  if (Number.isFinite(e.rating)) score += e.rating * 0.6;
  if (Number.isFinite(e.reviewCount) && e.reviewCount > 0) {
    score += Math.log10(e.reviewCount) * 0.3;
  }
  if (e.provider === "private") score += 0.5;
  if (e.privateTour) score += 0.2;
  if (e.skipTheLine) score += 0.15;
  if (Array.isArray(interests) && interests.length) {
    const cats = (e.categories || []).join(" ").toLowerCase();
    let overlap = 0;
    for (const i of interests) {
      if (cats.includes(String(i).toLowerCase())) overlap++;
    }
    score += (overlap / interests.length) * 0.5;
  }
  return score;
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
