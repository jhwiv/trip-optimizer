// Tests for src/citySources.js — the verified city → grounding-source
// registry. Repo convention: custom assert, prints "N passed, M failed",
// exits non-zero on failure. Auto-discovered by tests/run-all.mjs.
//
// What this guards: the registry's whole reason for existing is that a wrong
// subreddit or a wrong press domain fails SILENTLY at the Perplexity call —
// you get plausible-looking results from the wrong place instead of an error.
// So the shape assertions below are not busywork; they are the only automated
// check standing between a typo and the model being fed another city's news.
//
// These tests deliberately do NOT assert that any particular city is present.
// Cities get added and removed as they are verified, and a test that pins the
// roster would just get force-updated. What is pinned is the shape, the
// invariants, and the fallback behaviour.

import { CITY_REGISTRY, citySlug, resolveDynamicSources } from "../src/citySources.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

const entries = Object.entries(CITY_REGISTRY);

console.log("\n[1] citySlug normalization");
{
  assert("lowercases", citySlug("Porto") === "porto");
  assert("strips punctuation and spaces", citySlug("New York City") === "newyorkcity");
  assert("strips diacritics", citySlug("München") === "munchen", citySlug("München"));
  assert("strips diacritics (Portuguese)", citySlug("Lisboã") === "lisboa", citySlug("Lisboã"));
  assert("non-string is empty", citySlug(null) === "" && citySlug(undefined) === "" && citySlug(42) === "");
  assert("empty string stays empty", citySlug("") === "");
  assert("punctuation-only is empty", citySlug("—,  .") === "", citySlug("—,  ."));
}

console.log("\n[2] registry entry shape");
{
  assert("registry is non-empty", entries.length > 0);
  assert(
    "every key is its own slug",
    entries.every(([k]) => citySlug(k) === k),
    entries.filter(([k]) => citySlug(k) !== k).map(([k]) => k).join(", ")
  );
  assert(
    "every entry has a non-empty label, subreddit and press array",
    entries.every(([, v]) =>
      v && typeof v.label === "string" && v.label.trim() &&
      typeof v.subreddit === "string" && v.subreddit.trim() &&
      Array.isArray(v.press)),
    entries.filter(([, v]) => !v || !v.label || !v.subreddit || !Array.isArray(v.press)).map(([k]) => k).join(", ")
  );
  // "r/london" pasted into the subreddit field would produce "r/r/london" in
  // the query and match nothing.
  assert(
    "no subreddit carries an r/ prefix or slash",
    entries.every(([, v]) => !/^\/?r\//i.test(v.subreddit) && !v.subreddit.includes("/")),
    entries.filter(([, v]) => v.subreddit.includes("/")).map(([k]) => k).join(", ")
  );
  assert(
    "no subreddit contains whitespace",
    entries.every(([, v]) => !/\s/.test(v.subreddit)),
    entries.filter(([, v]) => /\s/.test(v.subreddit)).map(([k]) => k).join(", ")
  );
}

console.log("\n[3] press domains are bare hosts");
{
  const allDomains = entries.flatMap(([k, v]) => v.press.map((d) => [k, d]));
  assert("at least one city ships press domains", allDomains.length > 0);
  // Sonar's search_domain_filter takes hosts. A scheme, a path, or a wildcard
  // silently matches nothing.
  assert(
    "no scheme",
    allDomains.every(([, d]) => !d.includes("://")),
    allDomains.filter(([, d]) => d.includes("://")).join(" ")
  );
  assert(
    "no path segment",
    allDomains.every(([, d]) => !d.includes("/")),
    allDomains.filter(([, d]) => d.includes("/")).join(" ")
  );
  assert(
    "no wildcard or leading dot",
    allDomains.every(([, d]) => !d.startsWith("*") && !d.startsWith(".")),
    allDomains.filter(([, d]) => d.startsWith("*") || d.startsWith(".")).join(" ")
  );
  assert(
    "every host is lowercase and has a dot",
    allDomains.every(([, d]) => d === d.toLowerCase() && d.includes(".")),
    allDomains.filter(([, d]) => d !== d.toLowerCase() || !d.includes(".")).join(" ")
  );
  assert(
    "no duplicate host within a city",
    entries.every(([, v]) => new Set(v.press).size === v.press.length),
    entries.filter(([, v]) => new Set(v.press).size !== v.press.length).map(([k]) => k).join(", ")
  );
  // 20 is Sonar's documented ceiling; the caller slices to 20 anyway, but a
  // registry entry that needs slicing is a registry entry that lost domains.
  assert("no city exceeds Sonar's 20-domain filter", entries.every(([, v]) => v.press.length <= 20));
}

console.log("\n[4] resolveDynamicSources — known city");
{
  const [firstKey, firstEntry] = entries[0];
  const out = resolveDynamicSources(firstEntry.label);
  assert(`resolves ${firstEntry.label} by label`, out.length > 0, JSON.stringify(out));
  assert("caps at two sources", out.length <= 2, String(out.length));
  const reddit = out.find((s) => s.kind === "reddit");
  assert("includes a reddit source", !!reddit);
  assert("reddit label is r/<subreddit>", reddit.label === `r/${firstEntry.subreddit}`, reddit.label);
  assert("reddit source filters on reddit.com only", JSON.stringify(reddit.domains) === '["reddit.com"]', JSON.stringify(reddit.domains));
  assert("reddit id is namespaced", /^city_reddit_[a-z0-9]+$/.test(reddit.id), reddit.id);
  const press = out.find((s) => s.kind === "press");
  if (firstEntry.press.length > 0) {
    assert("includes a press source", !!press);
    assert("press label names the city", press.label === `${firstEntry.label} local press`, press.label);
    assert("press id is namespaced", /^city_press_[a-z0-9]+$/.test(press.id), press.id);
    assert("press domains come from the registry", JSON.stringify(press.domains) === JSON.stringify(firstEntry.press));
  }
  assert(`slug lookup works too (${firstKey})`, resolveDynamicSources(firstKey).length === out.length);
  assert("lookup is case-insensitive", resolveDynamicSources(firstEntry.label.toUpperCase()).length === out.length);
}

console.log("\n[5] every registry entry resolves");
{
  const broken = entries.filter(([k]) => resolveDynamicSources(k).length === 0);
  assert("no entry is unreachable through resolveDynamicSources", broken.length === 0, broken.map(([k]) => k).join(", "));
  const badIds = entries.flatMap(([k]) => {
    const ids = resolveDynamicSources(k).map((s) => s.id);
    return new Set(ids).size === ids.length ? [] : [k];
  });
  assert("ids are unique within a city's sources", badIds.length === 0, badIds.join(", "));
}

console.log("\n[6] resolveDynamicSources — free-text destinations");
{
  const [, entry] = entries[0];
  const city = entry.label;
  const expected = resolveDynamicSources(city).length;
  assert("'<City>, <Country>' takes the city", resolveDynamicSources(`${city}, Portugal`).length === expected);
  assert("'<City> and <Other>' takes the first", resolveDynamicSources(`${city} and Nowherecity`).length === expected);
  assert("'<City> -> <Other>' takes the first", resolveDynamicSources(`${city} -> Nowherecity`).length === expected);
  assert("'<City> & <Other>' takes the first", resolveDynamicSources(`${city} & Nowherecity`).length === expected);
  assert("leading/trailing space is tolerated", resolveDynamicSources(`  ${city}  `).length === expected);
  assert("accepts a cities array of strings", resolveDynamicSources([city, "Nowherecity"]).length === expected);
  assert("accepts a cities array of objects", resolveDynamicSources([{ name: city }, { name: "Nowherecity" }]).length === expected);
  assert("skips leading blank city objects", resolveDynamicSources([{ name: "" }, { name: city }]).length === expected);
}

console.log("\n[7] unknown cities fall back to nothing");
{
  // The generic `reddit` source already covers unknown cities. Inventing
  // r/<slug> for them is exactly the fabrication this module prevents, so an
  // unknown city must return [] rather than a guess.
  assert("unknown city returns []", resolveDynamicSources("Nowherecity").length === 0);
  assert("empty string returns []", resolveDynamicSources("").length === 0);
  assert("null returns []", resolveDynamicSources(null).length === 0);
  assert("undefined returns []", resolveDynamicSources(undefined).length === 0);
  assert("number returns []", resolveDynamicSources(1234).length === 0);
  assert("empty array returns []", resolveDynamicSources([]).length === 0);
  assert("array of blanks returns []", resolveDynamicSources([{ name: "" }, ""]).length === 0);
  assert("punctuation-only returns []", resolveDynamicSources("—").length === 0);
}

console.log("\n[8] aliases resolve to the same sources as the canonical name");
{
  // Spot-check the endonym path without pinning the alias table itself: any
  // alias that resolves must produce a real registry entry's sources.
  const cases = [
    ["Lisboa", "lisbon"], ["Wien", "vienna"], ["Praha", "prague"],
    ["Roma", "rome"], ["München", "munich"], ["NYC", "newyork"],
  ];
  for (const [alias, key] of cases) {
    if (!CITY_REGISTRY[key]) continue; // city not in the registry — skip, don't fail
    const a = resolveDynamicSources(alias);
    const c = resolveDynamicSources(key);
    assert(`${alias} -> ${key}`, a.length > 0 && JSON.stringify(a) === JSON.stringify(c), JSON.stringify(a));
  }
}

console.log("\n[9] returned sources are plain serializable data");
{
  // The same objects cross a Worker boundary and get rendered in React, so
  // they must not carry closures.
  const out = resolveDynamicSources(entries[0][1].label);
  assert(
    "no function-valued fields",
    out.every((s) => Object.values(s).every((v) => typeof v !== "function")),
    JSON.stringify(out)
  );
  assert("round-trips through JSON unchanged", JSON.stringify(JSON.parse(JSON.stringify(out))) === JSON.stringify(out));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
