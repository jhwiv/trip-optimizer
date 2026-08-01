// City-specific grounding sources for the pre-build local-knowledge pass.
//
// WHY THIS IS DATA AND NOT A TEMPLATE
//
// The obvious implementation is `r/${citySlug(destination)}` plus a guessed
// press domain. That is unsafe here for a reason specific to how the sources
// are consumed: Perplexity's `search_domain_filter` and its query string both
// fail SILENTLY. A subreddit that does not exist returns no error — it returns
// unrelated results, which then read to the model as local knowledge. A press
// domain that 404s or belongs to a different city does the same. There is no
// runtime signal that would let us fail safe, so the check has to happen here,
// before shipping.
//
// Every entry below was verified before it was written down. Subreddits were
// confirmed to exist with their canonical capitalization and to be city
// forums rather than same-named hobby subs; press domains were confirmed to
// resolve and to be the publication they claim to be. Cities that could not
// be confirmed were omitted rather than guessed — an omitted city falls back
// to the generic `reddit` source, which is correct, just less local. See the
// PR that introduced this file for the per-entry audit trail.
//
// This mirrors the venue-verification discipline in CLAUDE.md: an unverified
// fact is not shipped as a fact.
//
// TO ADD A CITY: confirm the subreddit resolves and is a city forum, confirm
// each press host returns the publication (not a parking page, interstitial,
// or redirect to a rebrand), then add it. Do not add from memory.

// Keyed by the slug of the city's common English name. `subreddit` is stored
// with Reddit's canonical capitalization because search engines index the
// cased form. `press` hosts are apex domains unless the apex was confirmed
// NOT to serve the publication, in which case the working host is stored.
export const CITY_REGISTRY = {
  amsterdam: { label: "Amsterdam", subreddit: "Amsterdam", press: ["parool.nl", "at5.nl", "nrc.nl"] },
  barcelona: { label: "Barcelona", subreddit: "Barcelona", press: ["lavanguardia.com", "elperiodico.com"] },
  berlin: { label: "Berlin", subreddit: "berlin", press: ["tagesspiegel.de", "berliner-zeitung.de", "rbb24.de"] },
  boston: { label: "Boston", subreddit: "boston", press: ["bostonglobe.com", "boston.com", "boston.eater.com"] },
  chicago: { label: "Chicago", subreddit: "chicago", press: ["chicagotribune.com", "blockclubchicago.org", "chicagoreader.com"] },
  copenhagen: { label: "Copenhagen", subreddit: "copenhagen", press: ["cphpost.dk", "politiken.dk", "berlingske.dk"] },
  kyoto: { label: "Kyoto", subreddit: "Kyoto", press: ["kyoto-np.co.jp", "kyotojournal.org"] },
  lisbon: { label: "Lisbon", subreddit: "lisboa", press: ["publico.pt", "dn.pt", "observador.pt"] },
  london: { label: "London", subreddit: "london", press: ["standard.co.uk"] },
  losangeles: { label: "Los Angeles", subreddit: "AskLosAngeles", press: ["laist.com", "latimes.com", "la.eater.com"] },
  madrid: { label: "Madrid", subreddit: "Madrid", press: ["elpais.com", "abc.es"] },
  miami: { label: "Miami", subreddit: "Miami", press: ["miamiherald.com", "miaminewtimes.com", "miami.eater.com"] },
  munich: { label: "Munich", subreddit: "Munich", press: ["sueddeutsche.de", "merkur.de"] },
  newyork: { label: "New York City", subreddit: "AskNYC", press: ["gothamist.com", "amny.com", "ny.eater.com"] },
  nuremberg: { label: "Nuremberg", subreddit: "Nurnberg", press: ["nn.de"] },
  paris: { label: "Paris", subreddit: "paris", press: ["leparisien.fr", "lemonde.fr"] },
  porto: { label: "Porto", subreddit: "porto", press: ["jn.pt", "porto.pt"] },
  prague: { label: "Prague", subreddit: "Prague", press: ["expats.cz", "praguemorning.cz", "idnes.cz"] },
  rome: { label: "Rome", subreddit: "rome", press: ["romatoday.it", "ilmessaggero.it"] },
  sanfrancisco: { label: "San Francisco", subreddit: "sanfrancisco", press: ["sfchronicle.com", "sfstandard.com", "missionlocal.org"] },
  seattle: { label: "Seattle", subreddit: "Seattle", press: ["seattletimes.com", "thestranger.com", "seattle.eater.com"] },
  stockholm: { label: "Stockholm", subreddit: "stockholm", press: ["dn.se", "svd.se", "www.mitti.se"] },
  sydney: { label: "Sydney", subreddit: "sydney", press: ["smh.com.au"] },
  tokyo: { label: "Tokyo", subreddit: "Tokyo", press: ["japantimes.co.jp", "tokyoweekender.com"] },
  toronto: { label: "Toronto", subreddit: "toronto", press: ["thestar.com", "blogto.com"] },
  vancouver: { label: "Vancouver", subreddit: "vancouver", press: ["vancouversun.com", "dailyhive.com", "straight.com"] },
  vienna: { label: "Vienna", subreddit: "wien", press: ["derstandard.at", "kurier.at", "diepresse.com"] },
};

// Endonyms and the abbreviations travelers actually type. Only aliases that
// unambiguously mean the mapped city — no airport codes, no two-letter forms
// that collide with other words.
const ALIASES = {
  lisboa: "lisbon",
  munchen: "munich",
  muenchen: "munich",
  nurnberg: "nuremberg",
  nuernberg: "nuremberg",
  wien: "vienna",
  praha: "prague",
  roma: "rome",
  kobenhavn: "copenhagen",
  koebenhavn: "copenhagen",
  nyc: "newyork",
  newyorkcity: "newyork",
  manhattan: "newyork",
  brooklyn: "newyork",
  la: "losangeles",
  sf: "sanfrancisco",
  bcn: "barcelona",
};

// Normalize a free-text city name to a lookup key: strip diacritics, drop
// everything that isn't a letter or digit, lowercase.
export function citySlug(name) {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// A destination is free text: "Porto", "Porto, Portugal", "Lisbon & Porto",
// "Rome -> Florence". Take the first named place — the cap is one city's
// worth of sources per build, and the first city is the one the trip is
// anchored on.
function firstCityOf(destination) {
  if (Array.isArray(destination)) {
    const head = destination.find((c) => (typeof c === "string" ? c : c && c.name));
    if (!head) return "";
    return typeof head === "string" ? head : head.name || "";
  }
  if (typeof destination !== "string") return "";
  return destination.split(/[,/&+;]|→|->|\band\b|\bthen\b/i)[0] || "";
}

// Resolve a destination to at most two extra grounding sources: the city's
// subreddit and its local press.
//
// Returns plain data, no closures, so the same call works in the browser (to
// render "auto-added" labels) and in a Cloudflare Pages Function (to build
// Perplexity queries). Returns [] for any city not in the registry — the
// generic `reddit` source already covers the unknown-city case, and inventing
// a subreddit for it is the exact failure this module exists to prevent.
export function resolveDynamicSources(destination) {
  const key = citySlug(firstCityOf(destination));
  if (!key) return [];
  const entry = CITY_REGISTRY[ALIASES[key] || key];
  if (!entry) return [];

  const slug = citySlug(entry.label);
  const out = [
    {
      id: `city_reddit_${slug}`,
      kind: "reddit",
      label: `r/${entry.subreddit}`,
      city: entry.label,
      subreddit: entry.subreddit,
      // Host-level filtering can't target a subreddit — reddit.com is one
      // host. The subreddit has to be named in the query text instead.
      domains: ["reddit.com"],
    },
  ];
  if (entry.press.length > 0) {
    out.push({
      id: `city_press_${slug}`,
      kind: "press",
      label: `${entry.label} local press`,
      city: entry.label,
      domains: entry.press,
    });
  }
  return out;
}
