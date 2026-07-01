import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, Fragment, createContext, useContext } from "react";
import { useViewport } from "./useViewport.js";
import { collectPlanVenues, collectPlanLegCities, mergePlacesVerifications, findBlockingIssues, findVenuesOutsideRadius, computeLegRadii } from "./placesVerify.js";
import { collectPacingPairs, applyPacingFlags } from "./pacingCheck.js";
import { buildDateTable } from "./dateFacts.js";
import { pickScheduledFlight, parseClockToMinutes, resolveAirlineIata, normalizeAirportCode } from "./flightSelect.js";
import { shouldChunk, planDayChunks, chunkMaxTokens, stitchPlan, collectRestaurantNames, classifyChunkResume } from "./chunkPlan.js";
import { selectAlternatives, buildSwapItem, findRawItemIndex, resolveLegCity, activityHeadName, itemVenueName } from "./swapAlternatives.js";
import { groupItemsByCategory } from "./categoryGroups.js";
import { relevantProviderCategories, bucketProviders, providerCategoryMeta } from "./localProviders.js";
import { resolveOutputs } from "./outputsState.js";
import { freshAbortController, replanTimeoutMs, classifyApplyError, shouldResumeViaPoll, StallError } from "./replanControl.js";
import { flightNeedsResolve, pickFromPool, buildMergePayload, buildUnconfirmedTimesPayload } from "./flightResolver.js";
import { applyFlightNumberStrip } from "./flightNumberStrip.js";
import { classifyActivityCountConstraint, renderActivityCountPromptRule, enforceTripTotalActivityCap } from "./activityCountConstraint.js";
import { buildFlightCardTitle } from "./flightCardTitle.js";
import { shapeIntroRequest, applyGeneratedIntroduction, shouldAutoGenerateIntroduction, isPdfDownloadReady } from "./introduction.js";
import { shouldShowWelcome, markWelcomeDismissed, detectPlatform } from "./appIntro.js";
import { partitionTabs, isActiveTabInOverflow, activeOverflowLabel } from "./tabStrip.js";

// URL verification context. The ItineraryView builds a Map<url, "ok"|"dead"|"pending">
// by POSTing every vendor URL it finds in the plan to /api/verify-url, then makes
// it available to ContactBlock / restaurant reservation links so dead links can be
// swapped for a safe Google "official site" search fallback instead of shipping a
// broken link to the user.
const URLVerifyContext = createContext({
  status: new Map(),
  // When status for a URL isn't known yet, the renderer should treat it as ok
  // (link still works) but the renderer can show a subtle "verifying" hint.
  isReady: false,
  destination: "",
});
function useURLVerify() { return useContext(URLVerifyContext); }
// Build a Google search URL that lets the traveler find the official site
// when the model-supplied URL is dead.
function urlSearchFallback(name, destination) {
  const q = [name, destination, "official site"].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

// --color-gold retired (branding sweep). These constants now resolve to the
// navy/silver palette. GOLD = navy (accents, borders, eyebrows, rules).
// GOLD_LIGHT = silver-grey surface (was cream). GOLD_DARK = navy (unchanged).
// Where GOLD was used as a solid FILL, those sites set their own light text
// color so navy fill stays readable; see ON_NAVY constant below.
const GOLD = "var(--color-text-primary)";
const GOLD_LIGHT = "var(--color-surface-2)";
const GOLD_DARK = "var(--color-text-primary)";
// Text/icon color to use ON a navy (GOLD) fill so it stays legible.
const ON_NAVY = "var(--color-background-primary)";

// --------------------------------------------------------------------------
// Anthropic prompt-caching helper.
//
// Anthropic's Messages API accepts `system` as either a string OR an array of
// content blocks. Adding `cache_control: { type: "ephemeral" }` to a block
// tells Anthropic to cache the entire prompt prefix up to and including that
// block for ~5 minutes. Subsequent calls with the same prefix pay ~10% of the
// normal input-token price for the cached portion.
//
// Why we wrap every call site instead of caching by default:
//   • Cache WRITES cost ~25% more than uncached input. Break-even is ~2 reads
//     within the 5-minute TTL. Our review→revise pipeline and the
//     surgical→full fallback both fire within seconds of each other on the
//     same plan JSON, so they hit cache reliably.
//   • We pass the system prompt as ONE block here for safety. A follow-up
//     refactor can split static-reference vs dynamic-trip portions of
//     buildSystemPrompt into two blocks to enable cache hits across builds
//     for different trips (the bulky reference data is identical).
//   • Min cacheable prefix is 1024 tokens (~4000 chars) for sonnet-4. Our
//     smallest system prompt (review) is comfortably above that.
//
// Safe to call with any string — returns the array form Anthropic expects.
// --------------------------------------------------------------------------
function cachedSystem(systemString) {
  if (typeof systemString !== "string" || systemString.length < 4000) {
    // Below the cacheable threshold; pass through as-is. Anthropic accepts
    // both string and array forms so this is a no-op shape change.
    return systemString;
  }
  return [
    {
      type: "text",
      text: systemString,
      cache_control: { type: "ephemeral" },
    },
  ];
}

// --------------------------------------------------------------------------
// Tools-array cache helper.
//
// Anthropic's prompt cache covers tools too — and the planner's TRIP_PLAN_TOOL
// schema alone is ~150 lines of constant JSON that ships on every /api/build
// call. Adding cache_control to the LAST tool in the array tells Anthropic
// to cache the entire request prefix up to and including tools.
//
// Why this is a free win:
//   • Our tool schemas (TRIP_PLAN_TOOL, REVIEW_TOOL, REVISION_TOOL_SURGICAL,
//     REVISION_TOOL_FULL) are module-level constants — byte-identical on every
//     call within the same deploy. Cache hits are deterministic.
//   • cachedSystem() above already marks the system prompt as cached; the
//     two breakpoints stack. The system breakpoint catches review→revise on
//     the same plan; the tools breakpoint catches every same-tool call even
//     when the system prompt differs.
//   • Adds a non-enumerable cache_control field by cloning the last tool —
//     never mutates the module-level tool constants.
// --------------------------------------------------------------------------
function cachedTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const out = tools.slice(0, -1);
  const last = tools[tools.length - 1];
  out.push({ ...last, cache_control: { type: "ephemeral" } });
  return out;
}

// --------------------------------------------------------------------------
// Two-block cached system prompt: STATIC (cross-trip cacheable) + DYNAMIC.
//
// Anthropic supports up to 4 cache breakpoints per request. We use ONE here
// for the static rulebook so it becomes the cached prefix, and emit the
// per-trip dynamic preamble as a second uncached block. Result:
//   • First build of any trip on a fresh deploy   → cache write on staticRules
//   • Every subsequent build within 5 min         → cache read on staticRules
//     (regardless of destination, dates, travelers, etc.)
//
// The dynamic preamble is small (typically 2–10k chars) so cache misses on
// the second block are cheap. The static rulebook is ~15–20k chars — that's
// where the savings come from.
//
// Used by the build (/api/build) call site only. Review/revision call sites
// keep using cachedSystem() because their value-per-call comes from the
// embedded plan JSON (which is dynamic but identical between review→revise),
// not the static rulebook.
// --------------------------------------------------------------------------
function cachedSystemBlocks(staticText, dynamicText) {
  // If either piece is missing or too small to cache, fall back to a single
  // concatenated block so we always send something sensible.
  if (typeof staticText !== "string" || staticText.length < 4000) {
    return cachedSystem(
      [staticText, dynamicText].filter(s => typeof s === "string" && s).join("\n\n"),
    );
  }
  const blocks = [
    {
      type: "text",
      text: staticText,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (typeof dynamicText === "string" && dynamicText.length > 0) {
    blocks.push({ type: "text", text: dynamicText });
  }
  return blocks;
}

// Curated city list for autocomplete. Free-text entries are still allowed.
const CITIES = [
  { name: "Lisbon", country: "Portugal" },
  { name: "Porto", country: "Portugal" },
  { name: "Madrid", country: "Spain" },
  { name: "Barcelona", country: "Spain" },
  { name: "Seville", country: "Spain" },
  { name: "San Sebastián", country: "Spain" },
  { name: "Paris", country: "France" },
  { name: "Nice", country: "France" },
  { name: "Bordeaux", country: "France" },
  { name: "Provence", country: "France" },
  { name: "Rome", country: "Italy" },
  { name: "Florence", country: "Italy" },
  { name: "Venice", country: "Italy" },
  { name: "Milan", country: "Italy" },
  { name: "Amalfi Coast", country: "Italy" },
  { name: "Lake Como", country: "Italy" },
  { name: "Sicily", country: "Italy" },
  { name: "London", country: "United Kingdom" },
  { name: "Edinburgh", country: "United Kingdom" },
  { name: "Dublin", country: "Ireland" },
  { name: "Amsterdam", country: "Netherlands" },
  { name: "Brussels", country: "Belgium" },
  { name: "Bruges", country: "Belgium" },
  { name: "Copenhagen", country: "Denmark" },
  { name: "Stockholm", country: "Sweden" },
  { name: "Oslo", country: "Norway" },
  { name: "Helsinki", country: "Finland" },
  { name: "Reykjavik", country: "Iceland" },
  { name: "Berlin", country: "Germany" },
  { name: "Munich", country: "Germany" },
  { name: "Vienna", country: "Austria" },
  { name: "Salzburg", country: "Austria" },
  { name: "Zurich", country: "Switzerland" },
  { name: "Geneva", country: "Switzerland" },
  { name: "Lucerne", country: "Switzerland" },
  { name: "St. Moritz", country: "Switzerland" },
  { name: "Prague", country: "Czechia" },
  { name: "Budapest", country: "Hungary" },
  { name: "Krakow", country: "Poland" },
  { name: "Athens", country: "Greece" },
  { name: "Santorini", country: "Greece" },
  { name: "Mykonos", country: "Greece" },
  { name: "Crete", country: "Greece" },
  { name: "Istanbul", country: "Turkey" },
  { name: "Dubrovnik", country: "Croatia" },
  { name: "Split", country: "Croatia" },
  { name: "Hvar", country: "Croatia" },
  { name: "Rovinj", country: "Croatia" },
  { name: "Zadar", country: "Croatia" },
  { name: "Plitvice Lakes", country: "Croatia" },
  { name: "Korčula", country: "Croatia" },
  { name: "Tokyo", country: "Japan" },
  { name: "Kyoto", country: "Japan" },
  { name: "Osaka", country: "Japan" },
  { name: "Hakone", country: "Japan" },
  { name: "Seoul", country: "South Korea" },
  { name: "Hong Kong", country: "China" },
  { name: "Singapore", country: "Singapore" },
  { name: "Bangkok", country: "Thailand" },
  { name: "Chiang Mai", country: "Thailand" },
  { name: "Bali", country: "Indonesia" },
  { name: "Hanoi", country: "Vietnam" },
  { name: "Ho Chi Minh City", country: "Vietnam" },
  { name: "Dubai", country: "UAE" },
  { name: "Abu Dhabi", country: "UAE" },
  { name: "Marrakech", country: "Morocco" },
  { name: "Cape Town", country: "South Africa" },
  { name: "Nairobi", country: "Kenya" },
  { name: "Sydney", country: "Australia" },
  { name: "Melbourne", country: "Australia" },
  { name: "Auckland", country: "New Zealand" },
  { name: "Queenstown", country: "New Zealand" },
  // US — disambiguated by state where common name collisions exist.
  { name: "New York, NY", country: "USA" },
  { name: "Boston, MA", country: "USA" },
  { name: "Washington, DC", country: "USA" },
  { name: "Chicago, IL", country: "USA" },
  { name: "Miami, FL", country: "USA" },
  { name: "New Orleans, LA", country: "USA" },
  { name: "Charleston, SC", country: "USA" },
  { name: "Charleston, WV", country: "USA" },
  { name: "Savannah, GA", country: "USA" },
  { name: "Asheville, NC", country: "USA" },
  { name: "Greenville, SC", country: "USA" },
  { name: "Greenville, NC", country: "USA" },
  { name: "Nashville, TN", country: "USA" },
  { name: "Memphis, TN", country: "USA" },
  { name: "Atlanta, GA", country: "USA" },
  { name: "Austin, TX", country: "USA" },
  { name: "Dallas, TX", country: "USA" },
  { name: "Houston, TX", country: "USA" },
  { name: "San Antonio, TX", country: "USA" },
  { name: "Santa Fe, NM", country: "USA" },
  { name: "Taos, NM", country: "USA" },
  { name: "Albuquerque, NM", country: "USA" },
  { name: "Aspen, CO", country: "USA" },
  { name: "Denver, CO", country: "USA" },
  { name: "Boulder, CO", country: "USA" },
  { name: "Telluride, CO", country: "USA" },
  { name: "Vail, CO", country: "USA" },
  { name: "Park City, UT", country: "USA" },
  { name: "Salt Lake City, UT", country: "USA" },
  { name: "Jackson Hole, WY", country: "USA" },
  { name: "San Francisco, CA", country: "USA" },
  { name: "Los Angeles, CA", country: "USA" },
  { name: "San Diego, CA", country: "USA" },
  { name: "Santa Barbara, CA", country: "USA" },
  { name: "Carmel, CA", country: "USA" },
  { name: "Monterey, CA", country: "USA" },
  { name: "Palm Springs, CA", country: "USA" },
  { name: "Napa Valley, CA", country: "USA" },
  { name: "Sonoma, CA", country: "USA" },
  { name: "Lake Tahoe, CA/NV", country: "USA" },
  { name: "Las Vegas, NV", country: "USA" },
  { name: "Portland, OR", country: "USA" },
  { name: "Portland, ME", country: "USA" },
  { name: "Seattle, WA", country: "USA" },
  { name: "Maui, HI", country: "USA" },
  { name: "Kauai, HI", country: "USA" },
  { name: "Oahu, HI", country: "USA" },
  { name: "Big Island, HI", country: "USA" },
  { name: "Naples, FL", country: "USA" },
  { name: "Key West, FL", country: "USA" },
  { name: "Orlando, FL", country: "USA" },
  { name: "Sarasota, FL", country: "USA" },
  { name: "Philadelphia, PA", country: "USA" },
  { name: "Pittsburgh, PA", country: "USA" },
  { name: "Newport, RI", country: "USA" },
  { name: "Cape Cod, MA", country: "USA" },
  { name: "Nantucket, MA", country: "USA" },
  { name: "Martha’s Vineyard, MA", country: "USA" },
  { name: "Stowe, VT", country: "USA" },
  { name: "Burlington, VT", country: "USA" },
  { name: "Acadia, ME", country: "USA" },
  { name: "Bar Harbor, ME", country: "USA" },
  { name: "Kennebunkport, ME", country: "USA" },
  { name: "Hudson Valley, NY", country: "USA" },
  { name: "Hamptons, NY", country: "USA" },
  { name: "Saratoga Springs, NY", country: "USA" },
  { name: "Sedona, AZ", country: "USA" },
  { name: "Scottsdale, AZ", country: "USA" },
  { name: "Phoenix, AZ", country: "USA" },
  { name: "Tucson, AZ", country: "USA" },
  { name: "Sun Valley, ID", country: "USA" },
  { name: "Big Sky, MT", country: "USA" },
  { name: "Bozeman, MT", country: "USA" },
  { name: "Anchorage, AK", country: "USA" },
  { name: "Juneau, AK", country: "USA" },
  { name: "Detroit, MI", country: "USA" },
  { name: "Minneapolis, MN", country: "USA" },
  { name: "St. Louis, MO", country: "USA" },
  { name: "Kansas City, MO", country: "USA" },
  { name: "Louisville, KY", country: "USA" },
  { name: "Lexington, KY", country: "USA" },
  { name: "Baltimore, MD", country: "USA" },
  { name: "Annapolis, MD", country: "USA" },
  { name: "Raleigh-Durham, NC", country: "USA" },
  { name: "Wilmington, NC", country: "USA" },
  { name: "Outer Banks, NC", country: "USA" },
  { name: "Hilton Head, SC", country: "USA" },
  { name: "Charlottesville, VA", country: "USA" },
  { name: "Richmond, VA", country: "USA" },
  { name: "Virginia Beach, VA", country: "USA" },
  { name: "Seaside Park, NJ", country: "USA" },
  { name: "Cape May, NJ", country: "USA" },
  { name: "Vancouver", country: "Canada" },
  { name: "Toronto", country: "Canada" },
  { name: "Montreal", country: "Canada" },
  { name: "Quebec City", country: "Canada" },
  { name: "Mexico City", country: "Mexico" },
  { name: "Cabo San Lucas", country: "Mexico" },
  { name: "Tulum", country: "Mexico" },
  { name: "Buenos Aires", country: "Argentina" },
  { name: "Rio de Janeiro", country: "Brazil" },
  { name: "Lima", country: "Peru" },
  { name: "Cusco", country: "Peru" },
  { name: "Cartagena", country: "Colombia" },
  // Caribbean & island destinations — typically searched by island/country name.
  { name: "Aruba", country: "Aruba" },
  { name: "Curaçao", country: "Curaçao" },
  { name: "Bonaire", country: "Bonaire" },
  { name: "Bermuda", country: "Bermuda" },
  { name: "Bahamas", country: "Bahamas" },
  { name: "Nassau", country: "Bahamas" },
  { name: "Harbour Island", country: "Bahamas" },
  { name: "Exuma", country: "Bahamas" },
  { name: "Turks & Caicos", country: "Turks & Caicos" },
  { name: "Providenciales", country: "Turks & Caicos" },
  { name: "Barbados", country: "Barbados" },
  { name: "St. Barts", country: "Saint Barthélemy" },
  { name: "St. Lucia", country: "Saint Lucia" },
  { name: "St. Martin", country: "Saint Martin" },
  { name: "Sint Maarten", country: "Sint Maarten" },
  { name: "Antigua", country: "Antigua and Barbuda" },
  { name: "Anguilla", country: "Anguilla" },
  { name: "British Virgin Islands", country: "BVI" },
  { name: "Grand Cayman", country: "Cayman Islands" },
  { name: "Jamaica", country: "Jamaica" },
  { name: "Montego Bay", country: "Jamaica" },
  { name: "Punta Cana", country: "Dominican Republic" },
  { name: "Puerto Rico", country: "Puerto Rico" },
  { name: "San Juan, PR", country: "Puerto Rico" },
  { name: "St. Thomas", country: "US Virgin Islands" },
  { name: "St. John", country: "US Virgin Islands" },
  { name: "St. Croix", country: "US Virgin Islands" },
  // Other commonly-searched islands & small destinations.
  { name: "Maldives", country: "Maldives" },
  { name: "Seychelles", country: "Seychelles" },
  { name: "Mauritius", country: "Mauritius" },
  { name: "Fiji", country: "Fiji" },
  { name: "Bora Bora", country: "French Polynesia" },
  { name: "Tahiti", country: "French Polynesia" },
  { name: "Ibiza", country: "Spain" },
  { name: "Mallorca", country: "Spain" },
  { name: "Capri", country: "Italy" },
  { name: "Positano", country: "Italy" },
  { name: "Madeira", country: "Portugal" },
  { name: "Azores", country: "Portugal" },
  { name: "Galápagos", country: "Ecuador" },
];

// Airports — major US + key international hubs. Keyed by code; searchable by code, city, or name.
const AIRPORTS = [
  { code: "EWR", city: "Newark", name: "Newark Liberty Intl" },
  { code: "JFK", city: "New York", name: "John F. Kennedy Intl" },
  { code: "LGA", city: "New York", name: "LaGuardia" },
  { code: "BOS", city: "Boston", name: "Logan Intl" },
  { code: "PHL", city: "Philadelphia", name: "Philadelphia Intl" },
  { code: "BWI", city: "Baltimore", name: "Baltimore/Washington" },
  { code: "DCA", city: "Washington DC", name: "Reagan National" },
  { code: "IAD", city: "Washington DC", name: "Dulles Intl" },
  { code: "ATL", city: "Atlanta", name: "Hartsfield-Jackson" },
  { code: "MIA", city: "Miami", name: "Miami Intl" },
  { code: "FLL", city: "Fort Lauderdale", name: "Hollywood Intl" },
  { code: "MCO", city: "Orlando", name: "Orlando Intl" },
  { code: "TPA", city: "Tampa", name: "Tampa Intl" },
  { code: "RSW", city: "Fort Myers", name: "Southwest Florida" },
  { code: "CLT", city: "Charlotte", name: "Douglas Intl" },
  { code: "RDU", city: "Raleigh-Durham", name: "Raleigh-Durham Intl" },
  { code: "CHS", city: "Charleston", name: "Charleston Intl" },
  { code: "SAV", city: "Savannah", name: "Savannah/Hilton Head" },
  { code: "BNA", city: "Nashville", name: "Nashville Intl" },
  { code: "MSY", city: "New Orleans", name: "Louis Armstrong" },
  { code: "AUS", city: "Austin", name: "Bergstrom Intl" },
  { code: "DFW", city: "Dallas", name: "Dallas/Fort Worth" },
  { code: "IAH", city: "Houston", name: "Bush Intercontinental" },
  { code: "ORD", city: "Chicago", name: "O’Hare Intl" },
  { code: "MDW", city: "Chicago", name: "Midway Intl" },
  { code: "DTW", city: "Detroit", name: "Metro Wayne County" },
  { code: "MSP", city: "Minneapolis", name: "Minneapolis-St. Paul" },
  { code: "DEN", city: "Denver", name: "Denver Intl" },
  { code: "PHX", city: "Phoenix", name: "Sky Harbor" },
  { code: "LAS", city: "Las Vegas", name: "Harry Reid Intl" },
  { code: "SLC", city: "Salt Lake City", name: "Salt Lake City Intl" },
  { code: "LAX", city: "Los Angeles", name: "Los Angeles Intl" },
  { code: "SAN", city: "San Diego", name: "San Diego Intl" },
  { code: "SFO", city: "San Francisco", name: "San Francisco Intl" },
  { code: "OAK", city: "Oakland", name: "Oakland Intl" },
  { code: "SJC", city: "San Jose", name: "Norman Y. Mineta" },
  { code: "SEA", city: "Seattle", name: "Seattle-Tacoma" },
  { code: "PDX", city: "Portland", name: "Portland Intl" },
  { code: "HNL", city: "Honolulu", name: "Daniel K. Inouye" },
  { code: "OGG", city: "Maui", name: "Kahului" },
  { code: "LIH", city: "Kauai", name: "Lihue" },
  { code: "ABQ", city: "Albuquerque", name: "Albuquerque Intl Sunport" },
  { code: "SAF", city: "Santa Fe", name: "Santa Fe Regional" },
  { code: "ASE", city: "Aspen", name: "Pitkin County" },
  { code: "JAC", city: "Jackson Hole", name: "Jackson Hole Airport" },
  { code: "YYZ", city: "Toronto", name: "Pearson Intl" },
  { code: "YUL", city: "Montreal", name: "Pierre Elliott Trudeau" },
  { code: "YVR", city: "Vancouver", name: "Vancouver Intl" },
  { code: "LHR", city: "London", name: "Heathrow" },
  { code: "LGW", city: "London", name: "Gatwick" },
  { code: "CDG", city: "Paris", name: "Charles de Gaulle" },
  { code: "ORY", city: "Paris", name: "Orly" },
  { code: "AMS", city: "Amsterdam", name: "Schiphol" },
  { code: "FRA", city: "Frankfurt", name: "Frankfurt am Main" },
  { code: "MUC", city: "Munich", name: "Franz Josef Strauss" },
  { code: "ZRH", city: "Zurich", name: "Zürich Airport" },
  { code: "GVA", city: "Geneva", name: "Cointrin" },
  { code: "FCO", city: "Rome", name: "Fiumicino" },
  { code: "MXP", city: "Milan", name: "Malpensa" },
  { code: "VCE", city: "Venice", name: "Marco Polo" },
  { code: "BCN", city: "Barcelona", name: "El Prat" },
  { code: "MAD", city: "Madrid", name: "Barajas" },
  { code: "LIS", city: "Lisbon", name: "Humberto Delgado" },
  { code: "OPO", city: "Porto", name: "Francisco Sá Carneiro" },
  { code: "CPH", city: "Copenhagen", name: "Kastrup" },
  { code: "ARN", city: "Stockholm", name: "Arlanda" },
  { code: "DUB", city: "Dublin", name: "Dublin Airport" },
  { code: "EDI", city: "Edinburgh", name: "Edinburgh Airport" },
  { code: "KEF", city: "Reykjavik", name: "Keflavík Intl" },
  { code: "IST", city: "Istanbul", name: "Istanbul Airport" },
  { code: "ATH", city: "Athens", name: "Eleftherios Venizelos" },
  { code: "DBV", city: "Dubrovnik", name: "Dubrovnik Airport" },
  { code: "NRT", city: "Tokyo", name: "Narita Intl" },
  { code: "HND", city: "Tokyo", name: "Haneda" },
  { code: "KIX", city: "Osaka", name: "Kansai Intl" },
  { code: "ICN", city: "Seoul", name: "Incheon Intl" },
  { code: "HKG", city: "Hong Kong", name: "Hong Kong Intl" },
  { code: "SIN", city: "Singapore", name: "Changi" },
  { code: "BKK", city: "Bangkok", name: "Suvarnabhumi" },
  { code: "DXB", city: "Dubai", name: "Dubai Intl" },
  { code: "AUH", city: "Abu Dhabi", name: "Zayed Intl" },
  { code: "DOH", city: "Doha", name: "Hamad Intl" },
  { code: "SYD", city: "Sydney", name: "Kingsford Smith" },
  { code: "MEL", city: "Melbourne", name: "Tullamarine" },
  { code: "AKL", city: "Auckland", name: "Auckland Airport" },
  { code: "CPT", city: "Cape Town", name: "Cape Town Intl" },
  { code: "GRU", city: "São Paulo", name: "Guarulhos" },
  { code: "EZE", city: "Buenos Aires", name: "Ministro Pistarini" },
  { code: "MEX", city: "Mexico City", name: "Benito Juárez" },
  { code: "SJD", city: "Cabo San Lucas", name: "Los Cabos Intl" },
  { code: "CUN", city: "Cancun", name: "Cancún Intl" },
  // Regional / smaller-market airports referenced by DEST_AIRPORTS and the
  // arrival-airport guidance block. Adding them here makes them searchable
  // in the Home Airport autocomplete.
  { code: "AVL", city: "Asheville", name: "Asheville Regional" },
  { code: "HHH", city: "Hilton Head", name: "Hilton Head Airport" },
  { code: "PVD", city: "Providence", name: "T.F. Green / Rhode Island Intl" },
  { code: "EYW", city: "Key West", name: "Key West Intl" },
  // Maine / New England
  { code: "BGR", city: "Bangor", name: "Bangor Intl" },
  { code: "BHB", city: "Bar Harbor", name: "Hancock County–Bar Harbor" },
  { code: "PWM", city: "Portland ME", name: "Portland Intl Jetport" },
  { code: "HYA", city: "Hyannis", name: "Barnstable Muni" },
  { code: "PVC", city: "Provincetown", name: "Provincetown Muni" },
  { code: "MVY", city: "Martha's Vineyard", name: "Martha's Vineyard Airport" },
  { code: "ACK", city: "Nantucket", name: "Nantucket Memorial" },
  { code: "HTO", city: "East Hampton", name: "East Hampton Airport" },
  { code: "ISP", city: "Islip", name: "Long Island MacArthur" },
  // US ski / mountain markets
  { code: "EGE", city: "Vail / Eagle", name: "Eagle County Regional" },
  { code: "HDN", city: "Steamboat Springs", name: "Yampa Valley / Hayden" },
  { code: "MTJ", city: "Montrose", name: "Montrose Regional" },
  { code: "TEX", city: "Telluride", name: "Telluride Regional" },
  { code: "GJT", city: "Grand Junction", name: "Grand Junction Regional" },
  { code: "COD", city: "Cody", name: "Yellowstone Regional" },
  { code: "BZN", city: "Bozeman", name: "Bozeman Yellowstone Intl" },
  { code: "GPI", city: "Kalispell", name: "Glacier Park Intl" },
  { code: "FCA", city: "Kalispell", name: "Glacier Park Intl (alt code)" },
  { code: "SUN", city: "Sun Valley", name: "Friedman Memorial" },
  { code: "BOI", city: "Boise", name: "Boise Airport" },
  // New Mexico
  { code: "TAOS", city: "Taos", name: "Taos Regional" },
  // Wine country / California regionals
  { code: "STS", city: "Santa Rosa", name: "Charles M. Schulz–Sonoma County" },
  // Italy regionals
  { code: "FLR", city: "Florence", name: "Amerigo Vespucci" },
  { code: "PSA", city: "Pisa", name: "Galileo Galilei" },
  { code: "GOA", city: "Genoa", name: "Cristoforo Colombo" },
  { code: "NAP", city: "Naples", name: "Naples Intl" },
  { code: "CTA", city: "Catania", name: "Catania-Fontanarossa" },
  { code: "PMO", city: "Palermo", name: "Falcone-Borsellino" },
  // Spain / Balearics / Greek islands
  { code: "PMI", city: "Mallorca", name: "Palma de Mallorca" },
  { code: "IBZ", city: "Ibiza", name: "Ibiza Airport" },
  { code: "JMK", city: "Mykonos", name: "Mykonos Airport" },
  { code: "JTR", city: "Santorini", name: "Santorini (Thira) Airport" },
  // Switzerland / Austria regionals
  { code: "BRN", city: "Bern", name: "Bern Airport" },
  { code: "SMV", city: "St. Moritz", name: "Samedan / St. Moritz" },
  { code: "VIE", city: "Vienna", name: "Vienna Intl" },
  { code: "SZG", city: "Salzburg", name: "Salzburg W.A. Mozart" },
  // Montenegro
  { code: "TIV", city: "Tivat", name: "Tivat Airport" },
  // Mexico / Caribbean leisure
  { code: "PVR", city: "Puerto Vallarta", name: "Lic. Gustavo Díaz Ordaz" },
  { code: "NAS", city: "Nassau", name: "Lynden Pindling Intl" },
  { code: "SXM", city: "St. Maarten", name: "Princess Juliana Intl" },
  { code: "AUA", city: "Aruba", name: "Reina Beatrix Intl" },
  { code: "BGI", city: "Barbados", name: "Grantley Adams Intl" },
  // Canada secondary
  { code: "YYC", city: "Calgary", name: "Calgary Intl" },
  // Pacific Northwest secondary
  { code: "GEG", city: "Spokane", name: "Spokane Intl" },
  // Mid-Atlantic / South
  { code: "RIC", city: "Richmond", name: "Richmond Intl" },
  { code: "ORF", city: "Norfolk", name: "Norfolk Intl" },
  { code: "PIT", city: "Pittsburgh", name: "Pittsburgh Intl" },
  { code: "CVG", city: "Cincinnati", name: "Cincinnati/N. Kentucky" },
  { code: "CLE", city: "Cleveland", name: "Cleveland Hopkins" },
  { code: "IND", city: "Indianapolis", name: "Indianapolis Intl" },
  { code: "MKE", city: "Milwaukee", name: "General Mitchell Intl" },
  { code: "STL", city: "St. Louis", name: "Lambert Intl" },
  { code: "MCI", city: "Kansas City", name: "Kansas City Intl" },
  { code: "OMA", city: "Omaha", name: "Eppley Airfield" },
  // Texas secondary
  { code: "DAL", city: "Dallas", name: "Love Field" },
  { code: "HOU", city: "Houston", name: "Hobby" },
  { code: "SAT", city: "San Antonio", name: "San Antonio Intl" },
  // Mountain West secondary
  { code: "TUS", city: "Tucson", name: "Tucson Intl" },
  { code: "COS", city: "Colorado Springs", name: "Colorado Springs Muni" },
  // Asia secondary
  { code: "TPE", city: "Taipei", name: "Taoyuan Intl" },
  { code: "PEK", city: "Beijing", name: "Capital Intl" },
  { code: "PVG", city: "Shanghai", name: "Pudong Intl" },
  { code: "DEL", city: "Delhi", name: "Indira Gandhi Intl" },
  { code: "BOM", city: "Mumbai", name: "Chhatrapati Shivaji Maharaj" },
];

// Airlines — major carriers globally.
const AIRLINES = [
  // Spirit (NK) removed 2026-06-09 — carrier ceased operations.
  "United", "American", "Delta", "JetBlue", "Alaska", "Southwest", "Frontier", "Hawaiian",
  "Air Canada", "WestJet",
  "British Airways", "Virgin Atlantic", "Lufthansa", "Swiss", "Austrian", "Brussels Airlines",
  "Air France", "KLM", "Iberia", "TAP Air Portugal", "Aer Lingus",
  "ITA Airways", "Alitalia", "Finnair", "SAS", "Icelandair", "Norwegian",
  "Turkish Airlines", "Emirates", "Etihad", "Qatar Airways", "Saudia",
  "Japan Airlines", "ANA", "Korean Air", "Asiana", "Cathay Pacific", "Singapore Airlines",
  "Thai Airways", "EVA Air", "China Airlines",
  "Qantas", "Air New Zealand", "Fiji Airways",
  "LATAM", "Aeroméxico", "Avianca", "Copa",
  "Ethiopian", "South African Airways", "Kenya Airways",
];

// Rental-car companies with regional coverage. Most majors operate at virtually all
// commercial airports in their listed regions — so we filter the suggestion list by
// the *region* of the chosen home airport, and label brands that are airport-specialist
// vs. only available downtown.
// regions: us, eu, uk, asia, oceania, mideast, latam, africa, global
const RENTAL_COMPANIES = [
  { name: "Hertz", regions: ["global"], airportDesks: true, note: "Gold Plus Rewards" },
  { name: "Hertz Dream Cars", regions: ["us", "eu"], airportDesks: true, note: "Exotic / luxury — select airports" },
  { name: "Enterprise", regions: ["us", "uk", "eu", "latam"], airportDesks: true },
  { name: "National", regions: ["us", "uk", "eu", "latam"], airportDesks: true, note: "Emerald Club" },
  { name: "Alamo", regions: ["us", "eu", "latam"], airportDesks: true },
  { name: "Avis", regions: ["global"], airportDesks: true, note: "Preferred" },
  { name: "Budget", regions: ["global"], airportDesks: true },
  { name: "Sixt", regions: ["global"], airportDesks: true, note: "Strong in Europe" },
  { name: "Sixt Black", regions: ["eu", "us", "mideast"], airportDesks: true, note: "Premium tier" },
  { name: "Europcar", regions: ["eu", "uk", "africa", "asia", "oceania"], airportDesks: true },
  { name: "Thrifty", regions: ["global"], airportDesks: true },
  { name: "Dollar", regions: ["global"], airportDesks: true },
  { name: "Silvercar by Audi", regions: ["us"], airportDesks: true, note: "Audi only, select US airports" },
  { name: "Auto Europe", regions: ["eu", "uk"], airportDesks: true, note: "Aggregator — best European rates" },
  { name: "Kemwel", regions: ["eu"], airportDesks: true, note: "European specialist" },
  { name: "Turo", regions: ["us", "uk", "eu"], airportDesks: false, note: "Peer-to-peer — some airport delivery" },
  { name: "Times Car Rental", regions: ["asia"], airportDesks: true, note: "Japan" },
  { name: "Nippon Rent-A-Car", regions: ["asia"], airportDesks: true, note: "Japan" },
  { name: "Lotte Rent-a-Car", regions: ["asia"], airportDesks: true, note: "Korea" },
];

// Map of airport IATA code → region key, used to filter rental-company suggestions.
const AIRPORT_REGIONS = {
  // US
  EWR:"us", JFK:"us", LGA:"us", BOS:"us", PHL:"us", BWI:"us", DCA:"us", IAD:"us", ATL:"us",
  MIA:"us", FLL:"us", MCO:"us", TPA:"us", RSW:"us", CLT:"us", RDU:"us", CHS:"us", SAV:"us",
  BNA:"us", MSY:"us", AUS:"us", DFW:"us", IAH:"us", ORD:"us", MDW:"us", DTW:"us", MSP:"us",
  DEN:"us", PHX:"us", LAS:"us", SLC:"us", LAX:"us", SAN:"us", SFO:"us", OAK:"us", SJC:"us",
  SEA:"us", PDX:"us", HNL:"us", OGG:"us", LIH:"us", ABQ:"us", SAF:"us", ASE:"us", JAC:"us",
  // Canada
  YYZ:"us", YUL:"us", YVR:"us",
  // UK / Europe
  LHR:"uk", LGW:"uk",
  CDG:"eu", ORY:"eu", AMS:"eu", FRA:"eu", MUC:"eu", ZRH:"eu", GVA:"eu", FCO:"eu", MXP:"eu",
  VCE:"eu", BCN:"eu", MAD:"eu", LIS:"eu", OPO:"eu", CPH:"eu", ARN:"eu", DUB:"eu", EDI:"uk",
  KEF:"eu", IST:"eu", ATH:"eu", DBV:"eu",
  // Asia
  NRT:"asia", HND:"asia", KIX:"asia", ICN:"asia", HKG:"asia", SIN:"asia", BKK:"asia",
  // Middle East
  DXB:"mideast", AUH:"mideast", DOH:"mideast",
  // Oceania / Africa / LatAm
  SYD:"oceania", MEL:"oceania", AKL:"oceania",
  CPT:"africa",
  GRU:"latam", EZE:"latam", MEX:"latam", SJD:"latam", CUN:"latam",
};

function getAirportRegion(airportInput) {
  if (!airportInput) return null;
  // Accept full code or first 3 chars of input.
  const code = airportInput.trim().toUpperCase().slice(0, 3);
  return AIRPORT_REGIONS[code] || null;
}

function getRentalCompanies(airportInput) {
  const region = getAirportRegion(airportInput);
  if (!region) return RENTAL_COMPANIES; // unknown — show all
  return RENTAL_COMPANIES.filter(c =>
    c.regions.includes("global") || c.regions.includes(region)
  );
}

// Vehicle types for rental car / ground transport.
const VEHICLE_TYPES = [
  "Sedan", "Compact", "Midsize SUV", "Full-size SUV", "Luxury SUV",
  "Luxury sedan", "Convertible", "Sports car", "Minivan", "Pickup truck",
  "EV — Tesla Model 3", "EV — Tesla Model Y", "EV — Tesla Model S",
  "Wagon / estate", "7-seater", "4WD / off-road",
];

// Universal restaurant / dining types.
const RESTAURANT_TYPES_BASE = [
  "Michelin-starred", "Fine dining", "Wine bar", "Tasting menu",
  "Local seafood", "Steakhouse", "Sushi / omakase", "Italian — trattoria",
  "Italian — osteria", "French bistro", "Brasserie", "Tapas / pintxos",
  "Farm-to-table", "Waterfront dining", "Rooftop bar", "Speakeasy",
  "Hotel bar", "Cafe / breakfast", "Brunch spot", "Bakery / pastries",
  "Market hall", "Street food", "Beer garden", "Casual lunch",
];

// Destination-specific restaurant suggestions (matched by substring of destination string).
const RESTAURANT_BY_DEST = {
  lisbon:    ["Petiscos / tasca", "Pastel de nata stop", "Seafood marisqueira", "Fado dinner", "Port wine bar"],
  porto:     ["Francesinha lunch", "Port wine cellar tasting", "Riverside seafood", "Tasca / petiscos"],
  paris:     ["Classic brasserie", "Bistrot de quartier", "Boulangerie breakfast", "Wine bar / cave à manger", "Café terrace", "Steak frites"],
  rome:      ["Trastevere trattoria", "Roman carbonara / cacio e pepe", "Aperitivo bar", "Gelateria", "Wood-fired pizza al taglio"],
  florence:  ["Bistecca alla Fiorentina", "Enoteca", "Tuscan trattoria", "Aperitivo at sunset", "Gelateria"],
  venice:    ["Cicchetti bacaro crawl", "Seafood risotto", "Spritz on the canal", "Osteria for fresh pasta"],
  milan:     ["Aperitivo Navigli", "Risotto alla Milanese", "Brera enoteca", "Panzerotti lunch"],
  barcelona: ["Tapas crawl", "Pintxos bar", "Catalan seafood", "Vermut hour", "Boqueria market lunch"],
  madrid:    ["Tapas crawl La Latina", "Cocido madrile\u00f1o", "Jam\u00f3n ib\u00e9rico bar", "Mercado de San Miguel"],
  london:    ["Sunday roast", "Indian curry house", "Gastropub", "Afternoon tea", "Pie & mash", "Cocktail bar"],
  edinburgh: ["Scottish seafood", "Whisky bar", "Gastropub", "Modern Scottish tasting menu"],
  amsterdam: ["Brown caf\u00e9", "Rijsttafel (Indonesian)", "Canal-side bistro", "Bitterballen bar"],
  copenhagen:["New Nordic tasting menu", "Smushi / sm\u00f8rrebr\u00f8d lunch", "Natural wine bar", "Bakery (Hart, Juno)"],
  zurich:    ["Z\u00fcrcher Geschnetzeltes", "Swiss fondue / raclette", "Lake-view bistro", "Caf\u00e9 / Confiserie"],
  tokyo:     ["Sushi omakase", "Tempura counter", "Tonkatsu specialist", "Ramen shop", "Izakaya", "Kaiseki dinner", "Yakitori alley"],
  kyoto:     ["Kaiseki ryokan dinner", "Tofu specialist", "Kyo-kaiseki lunch", "Matcha tea house", "Pontoch\u014d alley dining"],
  osaka:     ["Okonomiyaki", "Takoyaki stand", "Kushikatsu bar", "Dotonbori street food"],
  "new york": ["Steakhouse classic", "Pizza slice joint", "Bagel + lox breakfast", "Omakase counter", "Speakeasy cocktail bar", "Italian red sauce"],
  "new orleans": ["Creole classic", "Po-boy lunch", "Beignets at Caf\u00e9 du Monde", "Jazz brunch", "Cajun seafood boil"],
  miami:     ["Cuban sandwich lunch", "Stone crab", "Cuban steakhouse", "Wynwood food hall", "Cafecito stop"],
  charleston:["Lowcountry seafood", "She-crab soup", "Southern fine dining", "Shrimp & grits brunch"],
  napa:      ["Winery tasting room lunch", "Michelin tasting menu", "Farm-to-table bistro"],
  "santa fe":["New Mexican \u2014 red & green chile", "Modern Southwestern", "Margarita & rooftop", "Posole / sopaipillas"],
  naples:    ["Old Naples bistro", "Gulf seafood", "Fifth Avenue South dining", "Beach club lunch"],
  dubrovnik: ["Konoba (tavern)", "Adriatic seafood", "Peka (under the bell)", "Sea-view fine dining"],
  split:     ["Riva caf\u00e9 stop", "Dalmatian seafood", "Konoba dinner", "Marjan hill bistro"],
  sydney:    ["Modern Australian tasting menu", "Harbour-view dining", "Coffee culture caf\u00e9", "Bondi brunch"],
  "cape town":["Cape Malay cuisine", "Wine farm lunch", "Braai (BBQ)", "Camps Bay sunset dining"],
};

function getRestaurantSuggestions(destination) {
  const d = (destination || "").toLowerCase();
  const extra = [];
  for (const [k, list] of Object.entries(RESTAURANT_BY_DEST)) {
    if (d.includes(k)) { extra.push(...list); break; }
  }
  return [...extra, ...RESTAURANT_TYPES_BASE];
}

// Universal activities.
const ACTIVITY_TYPES_BASE = [
  "Private city walking tour", "Food tour", "Wine tasting", "Cooking class",
  "Museum — skip-the-line", "Art gallery visit", "Architecture tour",
  "Sunset boat cruise", "Private driver day trip", "Day trip to nearby town",
  "Golf — 18 holes", "Spa day", "Hot springs / thermal bath",
  "Hiking — half day", "Bike tour", "E-bike rental",
  "Live music / jazz club", "Theater / opera", "Local market visit",
  "Photography walk", "Beach day", "Snorkeling", "Helicopter tour",
  "Hot air balloon", "Horseback riding", "Ski / snowboard day",
];

// Destination-specific iconic activities.
const ACTIVITY_BY_DEST = {
  lisbon:   ["Tram 28 ride", "Day trip to Sintra", "Belem & Jer\u00f3nimos Monastery", "Time Out Market", "LX Factory afternoon"],
  porto:    ["Douro Valley wine day", "Port wine cellar tour", "Livraria Lello visit", "S\u00e3o Bento azulejos"],
  paris:    ["Louvre \u2014 timed entry", "Mus\u00e9e d'Orsay", "Versailles day trip", "Seine evening cruise", "Montmartre walk", "Wine cellar tasting"],
  rome:     ["Vatican Museums + Sistine", "Colosseum underground tour", "Trastevere food walk", "Borghese Gallery (book ahead)", "Aperitivo at sunset"],
  florence: ["Uffizi reserved entry", "Accademia \u2014 see David", "Chianti wine day", "Boboli Gardens", "Duomo dome climb"],
  venice:   ["Doge's Palace early", "Gondola at sunset", "Murano + Burano boat", "Cicchetti crawl"],
  barcelona:["Sagrada Fam\u00edlia timed entry", "Park G\u00fcell", "Tapas walking tour", "Picasso Museum"],
  madrid:   ["Prado timed entry", "Royal Palace + Almudena", "Toledo day trip", "Flamenco show"],
  london:   ["Westminster + Churchill War Rooms", "British Museum highlights", "West End show", "Borough Market", "Afternoon tea"],
  edinburgh:["Edinburgh Castle", "Royal Mile walk", "Whisky tasting", "Arthur's Seat hike"],
  amsterdam:["Rijksmuseum", "Van Gogh Museum (book)", "Anne Frank House (book early)", "Canal cruise"],
  copenhagen:["Tivoli Gardens evening", "Nyhavn stroll", "Louisiana Museum day trip", "Bike the city"],
  zurich:   ["Lake Zurich boat", "Uetliberg sunset", "Day trip to Lucerne / Rigi", "Lindt Home of Chocolate"],
  tokyo:    ["teamLab digital art", "Tsukiji outer market breakfast", "Meiji Shrine + Harajuku", "Shibuya crossing + Hachiko", "Day trip to Hakone"],
  kyoto:    ["Fushimi Inari sunrise", "Arashiyama bamboo + monkeys", "Kinkaku-ji + Ryoan-ji", "Gion geisha walk", "Tea ceremony"],
  osaka:    ["Osaka Castle", "Dotonbori night walk", "Day trip to Nara (deer + Todai-ji)"],
  "new york": ["Broadway show", "Top of the Rock at sunset", "MoMA + Frick", "High Line walk", "Yankee / Mets game"],
  "new orleans": ["Frenchmen Street jazz", "Garden District walk", "Steamboat Natchez", "Cooking class"],
  miami:     ["South Beach Art Deco walk", "Vizcaya Museum", "Wynwood walls", "Everglades airboat"],
  napa:      ["3-winery tasting day", "Hot air balloon at dawn", "Castello di Amorosa", "Calistoga mud bath"],
  "santa fe":["Canyon Road galleries", "Georgia O'Keeffe Museum", "Bandelier ruins day trip", "Ten Thousand Waves spa"],
  naples:    ["Naples Pier sunset", "Marco Island day", "Naples Botanical Garden", "Tin City", "Beach club day"],
  aspen:     ["Maroon Bells", "Ski / snowboard", "Snowmass gondola", "Apr\u00e8s-ski at Aj\u0061x Tavern"],
  dubrovnik: ["Walk the City Walls early", "Lokrum island ferry", "Game of Thrones tour", "Kayak around Old Town"],
  sydney:    ["Sydney Harbour Bridge climb", "Opera House tour + show", "Bondi-to-Coogee walk", "Manly ferry day"],
  "cape town": ["Table Mountain cable car", "Cape Point / Boulders penguins", "Stellenbosch wine day", "Robben Island"],
};

function getActivitySuggestions(destination) {
  const d = (destination || "").toLowerCase();
  const extra = [];
  for (const [k, list] of Object.entries(ACTIVITY_BY_DEST)) {
    if (d.includes(k)) { extra.push(...list); break; }
  }
  return [...extra, ...ACTIVITY_TYPES_BASE];
}

// Return the matched key (e.g. "copenhagen") for a given destination string,
// or "" if no destination-specific bucket matched. We use the dining map as
// the canonical source; both dining and activity maps use the same keys.
function destinationKey(destination) {
  const d = (destination || "").toLowerCase();
  for (const k of Object.keys(RESTAURANT_BY_DEST)) {
    if (d.includes(k)) return k;
  }
  return "";
}

// Given an array of currently-added chips and the previous destination key,
// return which chips came from THAT destination's specific list and are NOT
// in the new destination's specific list (i.e. stale picks worth flagging).

// Find chips that belong to SOME destination bucket other than the current
// destination's bucket. Returns { staleChips, sourceKey } where sourceKey is
// the bucket those chips came from (e.g. "santa fe"). Used at mount + when
// the destination changes to catch chips that don't belong to the current
// destination at all -- even if we never observed the destination transition.
function findOrphanedChips(chips, currentKey, byDestMap) {
  if (!Array.isArray(chips) || chips.length === 0) return { staleChips: [], sourceKey: "" };
  const currentList = currentKey ? (byDestMap[currentKey] || []) : [];
  // Tally which OTHER bucket each chip belongs to; pick the most-represented one as source.
  const tally = new Map(); // bucketKey -> count
  const staleByKey = new Map(); // bucketKey -> chips[]
  for (const chip of chips) {
    if (currentList.includes(chip)) continue;
    for (const [k, list] of Object.entries(byDestMap)) {
      if (k === currentKey) continue;
      if (list.includes(chip)) {
        tally.set(k, (tally.get(k) || 0) + 1);
        const arr = staleByKey.get(k) || [];
        arr.push(chip);
        staleByKey.set(k, arr);
        break;
      }
    }
  }
  if (tally.size === 0) return { staleChips: [], sourceKey: "" };
  // Pick the bucket with the most chips; ties broken by first-seen.
  let bestKey = "";
  let bestCount = 0;
  for (const [k, n] of tally) {
    if (n > bestCount) { bestCount = n; bestKey = k; }
  }
  return { staleChips: staleByKey.get(bestKey) || [], sourceKey: bestKey };
}

// Cuisine preferences suggestions (single-field, comma-friendly).
const CUISINE_SUGGESTIONS = [
  "Local / traditional", "Seafood-focused", "Wine-focused",
  "Vegetarian-friendly", "Pescatarian", "Gluten-free options",
  "Adventurous / chef's choice", "Family-style sharing", "Romantic dinners",
  "Light lunches, big dinners", "Bakeries & caf\u00e9s", "Street food",
  "Michelin-focused", "Mixed — casual + a few splurges",
];

// Hotel must-have suggestions.
const HOTEL_MUSTHAVE_SUGGESTIONS = [
  "Walkable to dining", "Pool / rooftop pool", "Spa on-site",
  "Lounge access / club level", "Suite upgrade preferred", "Connecting rooms",
  "Late check-out", "Kitchenette / full kitchen", "Quiet floor",
  "Sea view", "City view", "Old Town location", "Fitness center",
  "Free breakfast", "24-hour room service", "Family-friendly",
  "Pet-friendly", "Concierge desk", "Valet parking",
];

// Travelers / party-composition presets.
const TRAVELER_PRESETS = [
  "1 adult", "2 adults", "2 adults + 1 child", "2 adults + 2 children",
  "Family of 4", "Family of 5", "3 adults", "4 adults",
  "Couple's getaway", "Solo trip", "Group of friends",
];

// Interests free-text suggestions.
const INTEREST_SUGGESTIONS = [
  "Art & architecture", "Wine & food", "History & ruins", "Modern art / galleries",
  "Golf", "Beach & relaxation", "Hiking & nature", "Shopping",
  "Photography", "Music & nightlife", "Family-friendly activities", "Spa & wellness",
  "Adventure / outdoor sports", "Off-the-beaten-path",
];

// Hotel brands / sub-brands across major loyalty families.
const HOTEL_TIERS = [
  // Marriott family
  "Ritz-Carlton", "Ritz-Carlton Reserve", "St. Regis", "JW Marriott", "Edition", "Bvlgari Hotels",
  "W Hotels", "Luxury Collection", "Marriott", "Sheraton", "Westin", "Le Méridien",
  "Autograph Collection", "Tribute Portfolio", "Renaissance", "Marriott Bonvoy",
  "Courtyard", "Residence Inn", "Aloft", "Moxy",
  // Hilton family
  "Waldorf Astoria", "Conrad", "LXR", "Canopy", "Hilton", "DoubleTree", "Embassy Suites",
  "Curio Collection", "Tapestry Collection", "Hampton Inn",
  // Hyatt family
  "Park Hyatt", "Andaz", "Grand Hyatt", "Hyatt Regency", "Hyatt Centric", "Alila", "Thompson",
  "Miraval", "Hyatt House",
  // IHG family
  "Six Senses", "Regent", "InterContinental", "Vignette Collection", "Kimpton", "Hotel Indigo",
  "Crowne Plaza", "voco",
  // Independent / boutique
  "Aman", "Belmond", "Four Seasons", "Mandarin Oriental", "Peninsula", "Rosewood",
  "Soho House", "Auberge Resorts", "Oetker Collection", "Cheval Blanc", "Capella",
];

function formatDateForDisplay(iso) {
  if (!iso) return "";
  // iso like "2027-06-03" — keep it locale-independent
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m,10)-1]} ${parseInt(d,10)}, ${y}`;
}

const areaHints = {
  default: "e.g. Old Town, waterfront, city center, suburbs, hillside",
  lisbon: "e.g. Baixa / Chiado, Alfama, Bairro Alto, Belém, Príncipe Real",
  porto: "e.g. Ribeira, Cedofeita, Foz do Douro, Boavista",
  paris: "e.g. Le Marais, Saint-Germain, Montmartre, 7th arrondissement",
  rome: "e.g. Centro Storico, Trastevere, Prati, Testaccio",
  florence: "e.g. Duomo district, Oltrarno, Santa Croce, San Niccolò",
  barcelona: "e.g. Gothic Quarter, Eixample, Gràcia, Barceloneta",
  madrid: "e.g. Centro / Sol, Malasaña, Salamanca, La Latina",
  london: "e.g. Mayfair, Chelsea, South Bank, Notting Hill, Shoreditch",
  edinburgh: "e.g. Old Town, New Town, Leith, Stockbridge",
  amsterdam: "e.g. Canal Ring, Jordaan, De Pijp, Museum Quarter",
  tokyo: "e.g. Shinjuku, Ginza, Shibuya, Asakusa, Roppongi",
  kyoto: "e.g. Gion, Higashiyama, Arashiyama, Kawaramachi",
  osaka: "e.g. Namba, Shinsaibashi, Umeda, Shinsekai",
  "new york": "e.g. Midtown, Upper East Side, Tribeca, Brooklyn Heights",
  "new orleans": "e.g. French Quarter, Garden District, Marigny, Uptown",
  chicago: "e.g. Magnificent Mile, Gold Coast, Lincoln Park, River North",
  miami: "e.g. South Beach, Brickell, Wynwood, Coconut Grove",
  "santa fe": "e.g. Downtown / Plaza, Canyon Road, Railyard, East Side",
  naples: "e.g. Old Naples, Vanderbilt Beach, Port Royal, Pelican Bay",
  dubrovnik: "e.g. Old Town, Lapad Peninsula, Babin Kuk, Pile Gate area",
  split: "e.g. Diocletian's Palace, Meje, Spinut, Žnjan",
  zurich: "e.g. Altstadt, Zürichberg, Enge, Seefeld",
  copenhagen: "e.g. Indre By, Frederiksberg, Nørrebro, Christianshavn",
  sydney: "e.g. CBD / The Rocks, Bondi, Paddington, Surry Hills",
  "cape town": "e.g. V&A Waterfront, Atlantic Seaboard, Gardens, Sea Point",
};

function getAreaHint(dest) {
  if (!dest.trim()) return areaHints.default;
  const d = dest.toLowerCase();
  for (const [k, v] of Object.entries(areaHints)) {
    if (d.includes(k)) return v;
  }
  return areaHints.default;
}

const BADGE_COLORS = {
  Flight:     { bg: "var(--color-info-tint)",            color: "var(--color-info)" },
  // TODO: introduce --color-accent-tint token; literal #e3eef0 paired with --color-accent-hover yields 5.83:1 AA
  Hotel:      { bg: "#e3eef0",                            color: "var(--color-accent-hover)" },
  Car:        { bg: "var(--color-success-tint)",         color: "var(--color-success)" },
  Dinner:     { bg: "var(--color-warning-tint)",         color: "var(--color-warning)" },
  Lunch:      { bg: "var(--color-warning-tint)",         color: "var(--color-warning)" },
  Breakfast:  { bg: "var(--color-warning-tint)",         color: "var(--color-warning)" },
  Activity:   { bg: "var(--color-category-purple-tint)", color: "var(--color-category-purple)" },
  Flag:       { bg: "var(--color-danger-tint)",          color: "var(--color-text-danger)" },
  "Plan B":   { bg: "var(--color-border-tertiary)",      color: "var(--color-text-secondary)" },
  Snob:       { bg: "var(--color-category-rose-tint)",   color: "var(--color-category-rose)" },
  Tonight:    { bg: "var(--color-warning-tint)",         color: "var(--color-warning)" },
  Note:       { bg: "var(--color-surface-2)",            color: "var(--color-text-secondary)" },
};

function Badge({ type }) {
  const c = BADGE_COLORS[type] || { bg: "var(--color-background-secondary)", color: "var(--color-text-secondary)" };
  return (
    <span style={{
      display: "inline-block", fontSize: "10px", fontWeight: "600",
      padding: "2px 8px", borderRadius: "3px", whiteSpace: "nowrap",
      background: c.bg, color: c.color, letterSpacing: "0.04em",
    }}>{type}</span>
  );
}

// Convert '08:30' or '8:30' to '8:30 AM' / '20:15' to '8:15 PM'. Pass through anything else.
function formatTime(t) {
  if (!t || typeof t !== "string") return "";
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${mm} ${ampm}`;
}

// Sort key: convert '08:30' → 830, '14:05' → 1405. Items without time sink to the end.
// Returns -1 when no time so callers can fall back to original index for a stable sort.
function timeKey(t) {
  if (!t || typeof t !== "string") return -1;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

function TimePill({ time, end_time }) {
  if (!time) return null;
  const t = formatTime(time);
  const et = end_time ? formatTime(end_time) : "";
  return (
    <span style={{
      display: "inline-block", fontSize: "11px", fontWeight: 600,
      color: "var(--color-text-primary)", background: "var(--color-surface-2)",
      padding: "2px 7px", borderRadius: "3px", whiteSpace: "nowrap",
      letterSpacing: "0.02em", minWidth: "58px", textAlign: "center",
    }}>{et ? `${t} – ${et}` : t}</span>
  );
}

// Parse "Day 1 · Thu Jun 4 · Arrive Santa Fe" → "2026-06-04" (the date segment).
// Returns null if no date can be extracted. Year defaults to current year if
// not present (the label format doesn't usually include year).
function parseDayLabelToISODate(label) {
  if (!label || typeof label !== "string") return null;
  // Match patterns like "Thu Jun 4", "Mon Jun 14, 2026", "Jun 4", "June 4 2026"
  const m = label.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:[, ]+(\d{4}))?/i);
  if (!m) return null;
  const monthIdx = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[1].toLowerCase().slice(0, 3));
  if (monthIdx < 0) return null;
  const day = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Build a Google Flights deep-link for the route + date. Falls back to the
// generic flights search if airports or date are missing.

// Live flight status via the shared FlightAware-backed Worker that powers
// santafejune.com. Worker contract:
//   GET https://flight-status.jhwiv-online.workers.dev/?ident=AA3006&date=YYYY-MM-DD
//   → { ok, ident, status, statusLevel, scheduledOut, estimatedOut, actualOut,
//        scheduledIn, estimatedIn, actualIn, delayMinutes, gateOrigin,
//        gateDestination, terminalOrigin, terminalDestination, cancelled,
//        diverted, fetchedAt }
// We render this strip only when (a) the carrier + a flight number are
// parseable from the plan and (b) the day has a usable ISO date. AeroAPI's
// free tier is capped at 500 calls/month; the user pays per call beyond that,
// so we only fetch once per (ident,date) per page-load (in-component memo)
// and never block the rest of the card.
// NOTE (#19): the live-status call now goes through the same-origin
// /api/flight-status Pages Function (functions/api/flight-status.js), which
// owns the Worker URL server-side. We no longer reference the Worker origin
// from the browser, so the prior FLIGHT_STATUS_WORKER constant was removed to
// avoid implying a direct (CORS-blocked) browser call.

// Parse "UA 57" / "AA3006" / "Delta 215" → "UA57" / "AA3006" / null.
// We need ICAO/IATA carrier code + number, no spaces. We look at the
// carrier text first (carrier="United" → "UA"), and the confirmation_note
// for an explicit flight number like "UA 57" or "#1234".
function parseFlightIdent(f) {
  if (!f) return null;
  // HONESTY: only ever resolve an ident from the dedicated flight_number field
  // or an EXPLICIT flight reference in prose ("flight UA57", "flt #1234"). We
  // deliberately do NOT scrape arbitrary numbers out of confirmation_note/text:
  // those fields routinely carry unrelated digits (seat rows, bag counts,
  // terminals, prices), and treating "Economy Plus seats 7-15" as flight "UA7"
  // produces a phantom ident. A phantom ident is doubly harmful — it suppresses
  // the schedule fetch + picker (gated on !_knownIdent) AND routes to the live
  // panel, which renders nothing for a non-user-supplied number. The net effect
  // is a flight card with no number and no times, which is exactly the reported
  // bug. So model flights (number already stripped) fall through to the
  // schedule-fetch auto-surface path instead.
  const fn = f.flight_number != null ? String(f.flight_number) : "";
  // 1. Direct carrier-code + digits in flight_number (e.g. "UA 57", "AA3006").
  const direct = fn.match(/\b([A-Z]{2})\s*0*(\d{1,4})\b/);
  if (direct) return `${direct[1]}${direct[2]}`;
  // 2. Explicit flight reference in prose only ("flight UA 57", "flt #1234").
  for (const s of [f.confirmation_note, f.text].filter(Boolean).map(String)) {
    const explicit = s.match(/\b(?:flight|flt)\s*#?\s*([A-Z]{2})\s*0*(\d{1,4})\b/i);
    if (explicit) return `${explicit[1].toUpperCase()}${explicit[2]}`;
  }
  // 3. Compose from carrier name + a standalone number in flight_number only.
  const iata = resolveAirlineIata(f.carrier);
  if (iata) {
    const m = fn.match(/\b0*(\d{1,4})\b/);
    if (m) return `${iata}${m[1]}`;
  }
  // 4. LAST RESORT for user-supplied flight numbers: when the user gave us
  // a number but no carrier (and the model also failed to infer one), pass
  // the bare digits to AeroAPI. The worker will resolve the carrier from
  // the prefix on its end. This is gated on _userSuppliedFlightNumber so we
  // never do speculative lookups for model-emitted numbers — those should
  // have been stripped by the quality layer already.
  if (f._userSuppliedFlightNumber && f.flight_number) {
    const m = String(f.flight_number).match(/\b0*(\d{1,4})\b/);
    if (m) return m[1]; // bare digits; AeroAPI worker will hydrate carrier
  }
  return null;
}

// In-memory cache so repeat renders / multiple FlightCards for the same flight
// (return leg) don't double-fetch within one page session.
const _flightStatusCache = new Map();
async function fetchFlightStatus(ident, isoDate) {
  const key = `${ident}|${isoDate}`;
  if (_flightStatusCache.has(key)) return _flightStatusCache.get(key);
  // #19 Route through the same-origin Pages Function proxy, NOT the Worker
  // directly. The shared Worker's CORS allowlist is pinned to one app origin
  // (santafejune.com), so a direct browser call from routesmith.ai is
  // CORS-blocked and the live-status panel silently fails. The proxy is
  // same-origin (no CORS) and works regardless of the Worker's allowlist.
  const url = `/api/flight-status?ident=${encodeURIComponent(ident)}&date=${encodeURIComponent(isoDate)}`;
  const p = fetch(url, { method: "GET" })
    .then((r) => r.json())
    .then((j) => (j && j.ok ? j : null))
    .catch(() => null);
  _flightStatusCache.set(key, p);
  return p;
}

// Format an ISO timestamp as a local short time ("7:00 AM"). UTC → local
// per the user's device timezone, which is exactly what travelers expect.
function formatLiveTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    // Force 12h AM/PM regardless of locale so the live status row matches the
    // formatTime() helper used everywhere else in the UI.
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
  } catch { return ""; }
}

function LiveFlightStatus({ ident, isoDate, userSupplied }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let stale = false;
    fetchFlightStatus(ident, isoDate).then((s) => {
      if (stale) return;
      setStatus(s);
      setLoading(false);
    });
    return () => { stale = true; };
  }, [ident, isoDate]);
  if (loading) {
    return (
      <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: "8px 0 0", letterSpacing: "0.06em", textTransform: "uppercase", fontStyle: "italic" }}>
        Live status · checking…
      </p>
    );
  }
  if (!status) {
    // Worker returned no data. For a user-supplied flight number this matters
    // — the user is asking us to verify their flight is real, and a null
    // means AeroAPI either doesn't recognize this ident or the flight is
    // outside the active schedule window (more than 2 days out, or older
    // than ~10 days). Surface this explicitly so the user knows to confirm.
    if (userSupplied) {
      return (
        <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
          <p style={{ fontSize: "10.5px", margin: "0 0 4px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700, color: "var(--color-text-primary)" }}>
            Flight not verified
          </p>
          <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}>
            FlightAware did not return data for {ident} on this date. The flight may be outside the active schedule window or the number may need confirmation. Verify with the airline before relying on these times.
          </p>
        </div>
      );
    }
    return null; // model-guess number, silent
  }
  // Color the status pill by severity.
  const level = status.statusLevel || "";
  const pillBg = status.cancelled ? "var(--color-warning)"
    : level === "done" ? "var(--color-text-secondary)"
    : level === "delayed" || (status.delayMinutes && status.delayMinutes > 15) ? "var(--color-warning)"
    : level === "inair" ? GOLD
    : "var(--color-success)";
  const pillLabel = status.cancelled ? "CANCELLED" : (status.status || "").toUpperCase();
  // Pick the freshest out/in times available (actual > estimated > scheduled).
  const outNew = status.actualOut || status.estimatedOut || status.scheduledOut;
  const outOrig = status.scheduledOut;
  const inNew = status.actualIn || status.estimatedIn || status.scheduledIn;
  const inOrig = status.scheduledIn;
  const outShifted = outNew && outOrig && outNew !== outOrig;
  const inShifted = inNew && inOrig && inNew !== inOrig;
  return (
    <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "9.5px", fontWeight: 700, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase" }}>Live status</span>
        <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-background-primary)", background: pillBg, padding: "2px 7px", borderRadius: "3px", letterSpacing: "0.08em" }}>{pillLabel}</span>
        {typeof status.delayMinutes === "number" && status.delayMinutes > 0 && !status.cancelled && (
          <span style={{ fontSize: "11px", color: "var(--color-warning)", fontWeight: 600 }}>
            +{Math.floor(status.delayMinutes / 60) > 0 ? `${Math.floor(status.delayMinutes / 60)}h ` : ""}{status.delayMinutes % 60}m
          </span>
        )}
      </div>
      <p style={{ fontSize: "11.5px", color: "var(--color-text-primary)", margin: "2px 0", lineHeight: 1.5 }}>
        Depart {outShifted && <span style={{ textDecoration: "line-through", color: "var(--color-text-tertiary)", marginRight: "4px" }}>{formatLiveTime(outOrig)}</span>}
        <span style={{ fontWeight: outShifted ? 600 : 400 }}>{formatLiveTime(outNew)}</span>
        {status.gateOrigin && <span style={{ color: "var(--color-text-secondary)" }}> · Gate {status.gateOrigin}</span>}
        {status.terminalOrigin && <span style={{ color: "var(--color-text-secondary)" }}> · T{status.terminalOrigin}</span>}
      </p>
      <p style={{ fontSize: "11.5px", color: "var(--color-text-primary)", margin: "2px 0", lineHeight: 1.5 }}>
        Arrive {inShifted && <span style={{ textDecoration: "line-through", color: "var(--color-text-tertiary)", marginRight: "4px" }}>{formatLiveTime(inOrig)}</span>}
        <span style={{ fontWeight: inShifted ? 600 : 400 }}>{formatLiveTime(inNew)}</span>
        {status.gateDestination && <span style={{ color: "var(--color-text-secondary)" }}> · Gate {status.gateDestination}</span>}
        {status.terminalDestination && <span style={{ color: "var(--color-text-secondary)" }}> · T{status.terminalDestination}</span>}
      </p>
      <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", margin: "4px 0 0", fontStyle: "italic" }}>
        FlightAware · checked {formatLiveTime(status.fetchedAt)}
      </p>
    </div>
  );
}

// Parse a time string like "8:45 AM", "13:30", or an ISO timestamp into an hour (0-23).
function parseHour(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (/^\d{4}-/.test(s)) return new Date(s).getHours();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h !== 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h;
}
function hourToBucket(h) {
  if (h === null || h === undefined) return "morning";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

function FlightCard({ type, time, end_time, flight: f, text, flags, dayLabel, onFlightConfirmed }) {
  // Hooks MUST run unconditionally on every render and BEFORE any early
  // return (React rules-of-hooks). They are hoisted here and use null-safe
  // reads of `f` so they remain valid even when `f` is absent; the
  // `if (!f) return null` guard sits immediately after the hook block.
  const _isoDate = parseDayLabelToISODate(dayLabel);
  const _knownIdent = parseFlightIdent(f);
  // Carrier → IATA via the shared, broadened resolver. Returns null for
  // carriers we can't pin to a single code (unknown name, "Carrier TBD",
  // multi-carrier strings). null does NOT mean "show nothing" anymore — it
  // means "we can't attribute a schedule row to a specific carrier", which the
  // autoFlight memo handles with an honest, unattributed fallback below.
  const _airlineIata = resolveAirlineIata(f?.carrier);
  // Normalize the build's airport fields to clean IATA codes before they ever
  // reach the schedule API. A decorated value ("Newark (EWR)") would 404 the
  // lookup and silently kill the whole auto-surface.
  const _fromCode = normalizeAirportCode(f?.from_airport);
  const _toCode = normalizeAirportCode(f?.to_airport);
  const [schedFlights, setSchedFlights] = useState(null);
  const [schedLoading, setSchedLoading] = useState(false);
  const [schedError, setSchedError] = useState(null);
  const [lockedFlight, setLockedFlight] = useState(null);
  const [timeFilter, setTimeFilter] = useState(() => hourToBucket(parseHour(f?.depart_time)));
  useEffect(() => {
    if (!f || !_isoDate || _knownIdent || !_fromCode || !_toCode) return;
    let cancelled = false;
    const params = new URLSearchParams({ date: _isoDate });
    params.set("origin", _fromCode);
    params.set("destination", _toCode);
    if (_airlineIata) params.set("airline", _airlineIata);
    // Defer the loading/error state resets off the synchronous effect body
    // so they don't trigger a cascading render (react-hooks lint rule).
    Promise.resolve().then(() => {
      if (cancelled) return;
      setSchedLoading(true);
      setSchedError(null);
    });
    fetch(`/api/flights-search?${params}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j.ok && Array.isArray(j.flights)) {
          const filtered = _airlineIata
            ? j.flights.filter(fl => (fl.flightNumber || "").toUpperCase().startsWith(_airlineIata))
            : j.flights;
          setSchedFlights(filtered.length > 0 ? filtered : j.flights);
        } else {
          setSchedError(j.error || "No flights found");
        }
      })
      .catch(() => { if (!cancelled) setSchedError("Request failed"); })
      .finally(() => { if (!cancelled) setSchedLoading(false); });
    return () => { cancelled = true; };
  }, [f, _isoDate, _knownIdent, _airlineIata, _fromCode, _toCode]);
  const filteredFlights = useMemo(() => {
    if (!schedFlights) return null;
    if (timeFilter === "all") return schedFlights;
    return schedFlights.filter(fl => {
      if (!fl.scheduledOut) return false;
      return hourToBucket(new Date(fl.scheduledOut).getHours()) === timeFilter;
    });
  }, [schedFlights, timeFilter]);
  // Auto-surface a REAL scheduled flight number without a manual pill tap.
  // Precedence: a user-supplied/confirmed number always wins, so only pick
  // an auto flight when the user hasn't typed one (_userSuppliedFlightNumber)
  // and hasn't tapped a row (lockedFlight). schedFlights is already
  // route+carrier filtered; pickScheduledFlight returns a real entry from it
  // (closest to the plan's approx departure) or null — it never invents one.
  const autoFlight = useMemo(() => {
    const hasUserFn = !!(f && f._userSuppliedFlightNumber && f.flight_number);
    if (hasUserFn || lockedFlight) return null;
    if (!schedFlights || schedFlights.length === 0) return null;
    const approx = parseClockToMinutes(f?.depart_time);
    if (_airlineIata) {
      // Carrier resolved: prefix-gate to THIS carrier's rows. If none match,
      // pickScheduledFlight returns null and we surface nothing — we must never
      // show another carrier's real number under a named carrier (PR #59
      // honesty guarantee preserved).
      return pickScheduledFlight(schedFlights, approx, _airlineIata);
    }
    // Carrier unresolved: we have real schedule rows for the route but can't
    // attribute them to a specific carrier. Rather than show nothing, surface
    // the closest real flight WITHOUT a carrier claim. The flightNumber carries
    // its own operating-carrier prefix (e.g. "UA1792"), so it is self-labeled
    // and honest; the card never pairs it with a different carrier name.
    return pickScheduledFlight(schedFlights, approx, null);
  }, [f, lockedFlight, schedFlights, _airlineIata]);
  // Whether the surfaced auto flight is attributed to the card's resolved
  // carrier. When false, the schedule strip labels it as an operating-carrier
  // match rather than implying it belongs to f.carrier.
  const autoFlightAttributed = !!_airlineIata;

  if (!f) return null;
  const route = [f.from_airport, f.to_airport].filter(Boolean).join(" → ");
  const stopLabel = f.nonstop ? "Nonstop" : (f.connection ? `Connect ${f.connection}` : "Connecting");
  const note = f.confirmation_note || "";
  const carrierLower = (f.carrier || "").toLowerCase();
  // Multi-carrier strings like "SAS or Delta" — don't pick a single booking host;
  // user needs to pick the carrier first.
  const isMultiCarrier = / or | \/ |,/.test(f.carrier || "");
  const bookHost = isMultiCarrier ? null
    : carrierLower.includes("united") ? "united.com"
    : carrierLower.includes("delta") ? "delta.com"
    : carrierLower.includes("american") ? "aa.com"
    : carrierLower.includes("jetblue") ? "jetblue.com"
    : carrierLower.includes("southwest") ? "southwest.com"
    : carrierLower.includes("alaska") ? "alaskaair.com"
    : carrierLower.includes("sas") || carrierLower.includes("scandinavian") ? "flysas.com"
    : carrierLower.includes("british airways") || carrierLower === "ba" ? "britishairways.com"
    : carrierLower.includes("virgin") ? "virginatlantic.com"
    : carrierLower.includes("air france") ? "airfrance.com"
    : carrierLower.includes("klm") ? "klm.com"
    : carrierLower.includes("lufthansa") ? "lufthansa.com"
    : carrierLower.includes("swiss") ? "swiss.com"
    : carrierLower.includes("iberia") ? "iberia.com"
    : carrierLower.includes("ana") || carrierLower.includes("all nippon") ? "ana.co.jp"
    : carrierLower.includes("jal") || carrierLower.includes("japan airlines") ? "jal.com"
    : carrierLower.includes("cathay") ? "cathaypacific.com"
    : carrierLower.includes("korean") ? "koreanair.com"
    : carrierLower.includes("aer lingus") ? "aerlingus.com"
    : carrierLower.includes("ita") ? "itaspa.com"
    : carrierLower.includes("norse") ? "flynorse.com"
    : null;
  const bookUrl = bookHost ? `https://www.${bookHost}` : null;
  // Title: when the user supplied an explicit flight number (preserved by
  // the quality layer via _userSuppliedFlightNumber), show it in the title so
  // the traveler immediately sees the right number on the card. Otherwise the
  // number was stripped (model guess) and the title shows carrier · route only.
  // Title composition delegated to buildFlightCardTitle (src/flightCardTitle.js).
  // Precedence, in order:
  //   1. User-supplied number (_userSuppliedFlightNumber === true) — user-typed.
  //   2. Resolver schedule-verified number (_scheduleVerified === true) —
  //      confirmed or substituted by FlightNumberAutoResolver against the
  //      live schedule. Added 2026-06-30 late-evening to close the recurrence
  //      where FlightCard showed "United · EWR → SFO" while the trip Overview
  //      showed "United UA 337 · EWR → SFO" — two components on the same plan
  //      disagreeing because only Overview read f.flight_number directly.
  //   3. autoFlight from the card's own live-lookup (schedFlights useEffect).
  //   4. Carrier + route only, honest fallback.
  const titleLine = buildFlightCardTitle({ flight: f, autoFlight, route });
  // Banner copy: priority is carrier-correction → airport suggestion → generic look-up.
  const overrideBanner = f._carrierOverride
    ? `App corrected carrier: ${f._originalCarrier || "the model's pick"} does not operate this nonstop. Use ${f.carrier} — confirm with the live lookup below.`
    : null;
  const airportBanner = (f._airportSuspect && f._airportSuggestion)
    ? `Closer airport: ${f._airportSuggestion.iata} (${f._airportSuggestion.name}) is ${f._airportSuggestion.drive} away — ${f._airportSuggestion.note}. Consider flying into ${f._airportSuggestion.iata} instead of ${f.to_airport}.`
    : null;
  // Route-specific Google Flights lookup CTA. Only shown when we don't
  // already have a concrete flight number to track live — if parseFlightIdent
  // returns a real ident (e.g. "UA57"), the LiveFlightStatus panel below
  // gives the user authoritative AeroAPI data and the lookup button is
  // redundant + misleading. These derive from the hoisted hook inputs above.
  const isoDate = _isoDate;
  const knownIdent = _knownIdent;
  return (
    <div style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        <TimePill time={time} end_time={end_time} />
        <Badge type={type || "Flight"} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1, minWidth: 0 }}>
          {titleLine}
        </p>
      </div>
      {overrideBanner && (
        <p style={{ fontSize: "11px", color: "var(--color-warning)", margin: "0 0 6px", lineHeight: 1.4, letterSpacing: "0.02em", fontWeight: 500, padding: "6px 8px", background: "rgba(184,92,0,0.06)", borderLeft: "2px solid var(--color-warning)", borderRadius: "2px" }}>⚠︎ {overrideBanner}</p>
      )}
      {airportBanner && (
        <p style={{ fontSize: "11px", color: "var(--color-text-primary)", margin: "0 0 6px", lineHeight: 1.4, letterSpacing: "0.02em", fontWeight: 600, padding: "6px 8px", background: "rgba(91, 101, 119,0.18)", borderLeft: `2px solid ${GOLD}`, borderRadius: "2px" }}>✈ {airportBanner}</p>
      )}
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "2px 0 6px", letterSpacing: "0.02em" }}>
        {f.depart_time ? `Approx depart ${formatTime(f.depart_time)}` : ""}{f.arrive_time ? ` · arrive ${formatTime(f.arrive_time)}` : ""}{f.duration ? `  ·  ${f.duration}` : ""}  ·  {stopLabel}
      </p>
      {(f.cabin || f.aircraft) && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: "0 0 4px" }}>
          {[f.cabin, f.aircraft].filter(Boolean).join("  ·  ")}
        </p>
      )}
      {f.airport_arrival_buffer && (
        <div style={{ margin: "6px 0 4px", padding: "6px 9px", background: "var(--color-surface-2)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "4px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "10.5px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Arrive {f.airport_arrival_buffer} early</span>
          <span style={{ fontSize: "11.5px", color: "var(--color-text-primary)" }}>
            {/^A?UA$|^AUA$/.test(f.from_airport || "") ? "AUA pre-clears US Customs in Aruba — plan for the extra time before boarding." : "Lead time at the airport before scheduled departure."}
          </span>
        </div>
      )}
      {Array.isArray(f.lounge_access) && f.lounge_access.length > 0 && (
        <div style={{ margin: "6px 0 4px", padding: "7px 9px", background: "rgba(91, 101, 119,0.08)", border: `0.5px solid ${GOLD}`, borderRadius: "4px" }}>
          <p style={{ fontSize: "10.5px", fontWeight: 700, color: GOLD_DARK, letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 4px" }}>Lounge access</p>
          {f.lounge_access.map((lg, i) => (
            <div key={i} style={{ margin: i === 0 ? "3px 0" : "6px 0 3px", fontSize: "11.5px", color: "var(--color-text-primary)", lineHeight: 1.4, paddingTop: i === 0 ? 0 : 5, borderTop: i === 0 ? "none" : "0.5px dashed rgba(91, 101, 119,0.25)" }}>
              <span style={{ fontWeight: 600 }}>{lg.name}</span>
              {i === 0 && f.lounge_access.length > 1 ? <span style={{ marginLeft: 6, fontSize: "9.5px", fontWeight: 700, color: GOLD_DARK, letterSpacing: "0.06em", textTransform: "uppercase" }}>Closest to gate</span> : null}
              {lg.terminal ? <span style={{ display: "block", color: "var(--color-text-secondary)", fontSize: "11px" }}>{lg.terminal}</span> : null}
              {lg.gate_proximity ? <span style={{ display: "block", color: GOLD_DARK, fontSize: "10.5px", fontWeight: 600 }}>{lg.gate_proximity}</span> : null}
              {lg.access ? <span style={{ display: "block", color: "var(--color-text-secondary)", fontSize: "11px" }}>Access: {lg.access}</span> : null}
              {lg.notes ? <span style={{ display: "block", color: "var(--color-text-tertiary)", fontSize: "10.5px", fontStyle: "italic" }}>{lg.notes}</span> : null}
            </div>
          ))}
        </div>
      )}
      {note && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "4px 0 0", lineHeight: 1.5, fontStyle: "italic" }}>{note}</p>
      )}
      {/* Auto-surfaced flight — best schedule match, no tap required. Honesty:
          this number comes straight from schedFlights (the live schedule API),
          is clearly labelled as schedule-sourced, and is superseded by a
          user-supplied number or a tapped row. The picker below still lets the
          user override with a different scheduled flight. */}
      {autoFlight && (
        <div style={{ marginTop: "10px", borderTop: "0.5px dashed var(--color-border-tertiary)", paddingTop: "8px" }}>
          <p style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 6px" }}>{autoFlightAttributed ? "From airline schedule" : "Operating flight · from schedule"}</p>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "15px", fontWeight: 800, color: "var(--color-text-primary)", letterSpacing: "0.02em" }}>{autoFlight.flightNumber}</span>
            <span style={{ fontSize: "13.5px", color: "var(--color-text-secondary)" }}>
              {autoFlight.scheduledOut ? new Date(autoFlight.scheduledOut).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }) : ""}
              {autoFlight.scheduledIn ? ` → ${new Date(autoFlight.scheduledIn).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}` : ""}
            </span>
            {autoFlight.aircraft && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{autoFlight.aircraft}</span>}
          </div>
          <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", margin: "5px 0 0", fontStyle: "italic" }}>{autoFlightAttributed ? "Auto-matched to your approximate departure · tap a flight below to change" : "Carrier unconfirmed — number shown is the scheduled operating flight · tap a flight below to change"}</p>
        </div>
      )}
      {/* Confirmed flight — shown after user taps a row from the picker */}
      {lockedFlight && (
        <div style={{ marginTop: "10px", borderTop: `0.5px solid ${GOLD}`, paddingTop: "8px" }}>
          <p style={{ fontSize: "10.5px", fontWeight: 700, color: GOLD_DARK, letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 8px" }}>Flight selected</p>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
            <span style={{ fontSize: "15px", fontWeight: 800, color: "var(--color-text-primary)", letterSpacing: "0.02em" }}>{lockedFlight.flightNumber}</span>
            <span style={{ fontSize: "13.5px", color: "var(--color-text-secondary)" }}>
              {lockedFlight.scheduledOut ? new Date(lockedFlight.scheduledOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }) : ""}
              {lockedFlight.scheduledIn ? ` → ${new Date(lockedFlight.scheduledIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true })}` : ""}
            </span>
            {lockedFlight.aircraft && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{lockedFlight.aircraft}</span>}
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => setLockedFlight(null)} style={{ fontSize: "10px", padding: "4px 9px", borderRadius: "20px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 500, fontFamily: "inherit" }}>Change</button>
            {bookUrl && (
              <a href={bookUrl} target="_blank" rel="noopener noreferrer"
                 style={{ fontSize: "11px", padding: "4px 10px", borderRadius: "20px", border: `0.5px solid ${GOLD}`, background: "transparent", color: GOLD_DARK, textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600 }}>
                Book · {bookHost}
              </a>
            )}
          </div>
        </div>
      )}
      {/* Flight picker — auto-loaded, filtered by time of day */}
      {!lockedFlight && !knownIdent && (
        <div style={{ marginTop: "10px" }}>
          {schedLoading && (
            <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "0 0 6px", fontStyle: "italic" }}>Loading flights…</p>
          )}
          {schedError && (
            <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "6px 0 0", fontStyle: "italic" }}>{schedError}</p>
          )}
          {schedFlights && schedFlights.length > 0 && (
            <div style={{ marginTop: "4px", borderTop: `0.5px solid ${GOLD}`, paddingTop: "8px" }}>
              {/* Time-of-day filter pills */}
              <div style={{ display: "flex", gap: "5px", marginBottom: "8px", flexWrap: "wrap" }}>
                {["morning", "afternoon", "evening", "all"].map(bucket => {
                  const cnt = { morning: 0, afternoon: 0, evening: 0 };
                  schedFlights.forEach(fl => { if (fl.scheduledOut) cnt[hourToBucket(new Date(fl.scheduledOut).getHours())]++; });
                  const label = bucket === "all" ? `All (${schedFlights.length})`
                    : bucket === "morning" ? `Morning (${cnt.morning})`
                    : bucket === "afternoon" ? `Afternoon (${cnt.afternoon})`
                    : `Evening (${cnt.evening})`;
                  const active = timeFilter === bucket;
                  return (
                    <button key={bucket} onClick={() => setTimeFilter(bucket)}
                      style={{ fontSize: "10px", padding: "4px 9px", borderRadius: "20px", border: `0.5px solid ${active ? GOLD : "var(--color-border-secondary)"}`, background: active ? GOLD : "transparent", color: active ? ON_NAVY : "var(--color-text-tertiary)", cursor: "pointer", fontWeight: active ? 700 : 400, letterSpacing: "0.04em", textTransform: "capitalize", fontFamily: "inherit" }}>
                      {label}
                    </button>
                  );
                })}
              </div>
              {filteredFlights && filteredFlights.length === 0 && (
                <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "0 0 6px", fontStyle: "italic" }}>
                  No {timeFilter} flights · <button onClick={() => setTimeFilter("all")} style={{ background: "none", border: "none", color: GOLD_DARK, cursor: "pointer", fontSize: "11px", fontWeight: 600, padding: 0, fontFamily: "inherit" }}>see all</button>
                </p>
              )}
              {filteredFlights && filteredFlights.map((fl, i) => (
                <div key={i} onClick={() => {
                  setLockedFlight(fl);
                  if (typeof onFlightConfirmed === "function") onFlightConfirmed(fl);
                }}
                  style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", padding: "5px 8px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "4px", cursor: "pointer", background: "var(--color-background-primary)" }}>
                  <span style={{ fontSize: "11.5px", fontWeight: 700, minWidth: 58 }}>{fl.flightNumber}</span>
                  <span style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", flex: 1 }}>
                    {fl.scheduledOut ? new Date(fl.scheduledOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true }) : ""}
                    {fl.scheduledIn ? ` → ${new Date(fl.scheduledIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true })}` : ""}
                  </span>
                  {fl.aircraft && <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)" }}>{fl.aircraft}</span>}
                </div>
              ))}
            </div>
          )}
          {schedFlights && schedFlights.length === 0 && !schedLoading && (
            <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "6px 0 0", fontStyle: "italic" }}>No scheduled flights found for this route and date.</p>
          )}
          {bookUrl && !schedLoading && (
            <a href={bookUrl} target="_blank" rel="noopener noreferrer"
               style={{ display: "inline-block", marginTop: "8px", fontSize: "11px", padding: "6px 10px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}>
              Book · {bookHost}
            </a>
          )}
        </div>
      )}
      {knownIdent && isoDate ? <LiveFlightStatus ident={knownIdent} isoDate={isoDate} userSupplied={!!f._userSuppliedFlightNumber} /> : null}
      {text && !f.carrier && (
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "4px 0 0" }}>{text}</p>
      )}
      {Array.isArray(flags) && flags.length > 0 && (
        <div style={{ marginTop: "8px", paddingTop: "6px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
          {flags.map((fl, i) => (
            <p key={i} style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "2px 0", lineHeight: 1.4 }}>· {fl}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function HotelCard({ type, time, end_time, hotel: h, text }) {
  // #21 URL verification (same context restaurants/activities use) so the hotel
  // website link swaps to a Google search fallback if the model's URL is dead.
  const { status: urlStatus, destination } = useURLVerify();
  if (!h) return null;
  const mapsUrl = h.address ? `https://maps.google.com/?q=${encodeURIComponent(`${h.name || ""} ${h.address}`.trim())}` : null;
  const telUrl = h.phone ? `tel:${h.phone.replace(/[^0-9+]/g, "")}` : null;
  // #21 Hotel website link — mirrors the restaurant/activity "Website ↗" pattern.
  const websiteState = h.website ? (urlStatus.get(h.website) || "pending") : null;
  const websiteDead = websiteState === "dead";
  const showWebsite = !!h.website;
  const websiteHref = websiteDead ? urlSearchFallback(h.name, destination) : h.website;
  return (
    <div style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        <TimePill time={time} end_time={end_time} />
        <Badge type={type || "Hotel"} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1, minWidth: 0 }}>{h.name || text}</p>
      </div>
      {h.address && (
        mapsUrl ? (
          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 4px", textDecoration: "underline", textDecorationColor: "var(--color-border-tertiary)", textUnderlineOffset: "2px", display: "block" }}>{h.address}</a>
        ) : (
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 4px" }}>{h.address}</p>
        )
      )}
      {(h.check_in_time || h.check_out_time || h.room_type) && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: "2px 0 4px" }}>
          {[
            h.check_in_time ? `Check-in ${formatTime(h.check_in_time)}` : "",
            h.check_out_time ? `Check-out ${formatTime(h.check_out_time)}` : "",
            h.room_type,
          ].filter(Boolean).join("  ·  ")}
        </p>
      )}
      {h.confirmation_note && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "4px 0 0", fontStyle: "italic" }}>{h.confirmation_note}</p>
      )}
      {(telUrl || mapsUrl || showWebsite) && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
          {telUrl && (
            <a href={telUrl} style={{ fontSize: "11px", padding: "6px 11px", borderRadius: "4px", border: "none", background: "var(--color-text-primary)", color: "var(--color-background-primary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, display: "inline-block" }}>Call · {h.phone}</a>
          )}
          {mapsUrl && (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px", padding: "6px 11px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, display: "inline-block" }}>Open in Maps</a>
          )}
          {showWebsite && (
            <a href={websiteHref} target="_blank" rel="noopener noreferrer" title={websiteDead ? "Original site link could not be verified — search for the official site" : undefined} style={{ fontSize: "11px", padding: "6px 11px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, display: "inline-block" }}>{websiteDead ? "Find site ↗" : "Website ↗"}</a>
          )}
        </div>
      )}
    </div>
  );
}

function DayBlock({ day, dayIndex, onOpenMenu, legCity, onSwapItem }) {
  const sameDayItems = day?.items || [];
  // Build the "Find another …" control for a card, when swapping is enabled.
  const swapControlFor = (item, kind) =>
    onSwapItem
      ? <FindAnotherControl key={`swap-${itemVenueName(item, kind)}`} kind={kind} city={legCity} currentItem={item} sameDayItems={sameDayItems} onSwap={(chosen) => onSwapItem(dayIndex, item, kind, chosen)} />
      : null;
  // Sort items chronologically by `time`. Items without a time keep their
  // original order and sink to the end. Index is the stable tiebreaker.
  const sortedItems = (day?.items || [])
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const ka = timeKey(a.item?.time);
      const kb = timeKey(b.item?.time);
      if (ka === -1 && kb === -1) return a.idx - b.idx;
      if (ka === -1) return 1;
      if (kb === -1) return -1;
      if (ka !== kb) return ka - kb;
      return a.idx - b.idx;
    })
    .map(x => x.item);
  // Split the label like 'Day 1 · Thu Jun 4 · Arrive Santa Fe' into 3 parts when possible.
  const labelParts = (day?.label || "").split(" · ");
  const dayTag = labelParts[0] || `Day ${dayIndex + 1}`;
  const dateTag = labelParts[1] || "";
  const themeTag = labelParts.slice(2).join(" · ") || "";
  return (
    <div id={`day-${dayIndex + 1}`} style={{ scrollMarginTop: "60px", borderLeft: `2px solid ${GOLD}`, paddingLeft: "1rem", marginBottom: "1.75rem", borderRadius: 0 }}>
      <div style={{ marginBottom: "10px" }}>
        <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", margin: "0 0 2px" }}>{dayTag}{dateTag ? `  ·  ${dateTag}` : ""}</p>
        {themeTag && <p style={{ fontSize: "16px", fontWeight: 500, color: "var(--color-text-primary)", margin: "0 0 4px", letterSpacing: "-0.1px", lineHeight: 1.3 }}>{themeTag}</p>}
        {day?.headline && (
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "4px 0 6px", fontStyle: "italic", lineHeight: 1.5 }}>— {day.headline}</p>
        )}
        {(day?.weather || day?.pace_note) && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" }}>
            {day.weather && (
              <span style={{ fontSize: "10.5px", color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", padding: "3px 8px", letterSpacing: "0.02em" }}>☀ {day.weather}</span>
            )}
            {day.pace_note && (
              <span style={{ fontSize: "10.5px", color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", padding: "3px 8px", letterSpacing: "0.02em" }}>· {day.pace_note}</span>
            )}
          </div>
        )}
      </div>
      {sortedItems.map((item, i) => {
        // Structured flight → rich card.
        if (item.type === "Flight" && item.flight) {
          return <FlightCard key={i} type={item.type} time={item.time} end_time={item.end_time} flight={item.flight} text={item.text} flags={item.flags} dayLabel={day?.label} onFlightConfirmed={(fl) => { const toT = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }) : undefined; Object.assign(item.flight, { flight_number: fl.flightNumber, depart_time: toT(fl.scheduledOut), arrive_time: toT(fl.scheduledIn), ...(fl.aircraft ? { aircraft: fl.aircraft } : {}) }); }} />;
        }
        // Structured hotel → rich card.
        if (item.type === "Hotel" && item.hotel) {
          return <HotelCard key={i} type={item.type} time={item.time} end_time={item.end_time} hotel={item.hotel} text={item.text} />;
        }
        // Activity items: rich card whenever there's contact info or a why blurb.
        if (item.type === "Activity" && (item.contact || item.why)) {
          return <ActivityCard key={i} time={item.time} end_time={item.end_time} item={item} swapControl={swapControlFor(item, "activity")} />;
        }
        // Dining items with a structured restaurant payload render as a rich card with a time pill.
        if (item.restaurant && (item.type === "Dinner" || item.type === "Lunch" || item.type === "Breakfast" || item.type === "Brunch" || item.type === "Dining")) {
          return (
            <div key={i}>
              {item.time && (
                <div style={{ marginBottom: "4px" }}>
                  <TimePill time={item.time} end_time={item.end_time} />
                </div>
              )}
              <RestaurantCard type={item.type} restaurant={item.restaurant} onOpenMenu={onOpenMenu} swapControl={swapControlFor(item, "restaurant")} />
            </div>
          );
        }
        return (
          <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "7px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: "1.5", flexWrap: "wrap" }}>
            <TimePill time={item.time} end_time={item.end_time} />
            <Badge type={item.type} />
            <span style={{ color: "var(--color-text-secondary)", flex: 1, minWidth: 0 }}>
              {item.text}
              {item.location && (
                <span style={{ display: "block", fontSize: "11.5px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>{item.location}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Walk a parsed plan and collect every unique restaurant referenced anywhere
// in days[].items[].restaurant (and items[].restaurant.backup). Used to feed
// /api/confirm-booking so we can ground the reservation.platform on the
// actual booking system instead of the model's heuristic guess.
function collectPlanRestaurants(plan) {
  if (!plan || !Array.isArray(plan.days)) return [];
  const out = [];
  const seen = new Set();
  const cityHint = (plan.destination || (Array.isArray(plan.cities) && plan.cities[0]?.name) || "").trim();
  const push = (r) => {
    if (!r || typeof r.name !== "string" || !r.name.trim()) return;
    // Dedup by name only — the same restaurant appearing for both Dinner Day
    // 1 and Dinner Day 3 should produce a single confirm-booking lookup.
    // Neighborhood is just a hint passed to Sonar; not part of identity.
    const key = r.name.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: r.name.trim(),
      city: cityHint,
      neighborhood: r.neighborhood || "",
    });
  };
  for (const day of plan.days) {
    for (const item of (day.items || [])) {
      if (item && item.restaurant) {
        push(item.restaurant);
        if (item.restaurant.backup) push(item.restaurant.backup);
      }
    }
  }
  return out;
}

// Merge /api/confirm-booking results back into a plan. For each confirmation
// whose platform is something we trust (resy/opentable/tock/phone/walkin),
// overwrite reservation.platform and reservation.url on the matching
// restaurant object. Also fill in contact.website when the model didn't
// supply one and Sonar found a confident match.
//
// Match is by case-insensitive name; if two restaurants share a name on the
// same plan (very rare) both will receive the same confirmation, which is
// the right call — they're presumably the same venue.
//
// Returns a NEW plan object (immutable update) so React picks up the change.
function mergeBookingConfirmations(plan, confirmations) {
  if (!plan || !Array.isArray(plan.days) || !Array.isArray(confirmations) || confirmations.length === 0) return plan;
  const byName = new Map();
  for (const c of confirmations) {
    if (!c || typeof c.name !== "string") continue;
    if (c.platform === "unknown") continue;
    byName.set(c.name.trim().toLowerCase(), c);
  }
  if (byName.size === 0) return plan;

  const applyTo = (r) => {
    if (!r || typeof r.name !== "string") return r;
    const conf = byName.get(r.name.trim().toLowerCase());
    if (!conf) return r;
    // Overwrite reservation.platform + url with confirmed values. Preserve
    // any other fields the model supplied (phone, notes).
    const nextReservation = { ...(r.reservation || {}), platform: conf.platform };
    if (conf.url) nextReservation.url = conf.url;
    // Walk-in: clear the url so reservationLink() returns null and the
    // Reserve button hides.
    if (conf.platform === "walkin") delete nextReservation.url;
    // Fill in website if missing on contact.
    const nextContact = { ...(r.contact || {}) };
    if (!nextContact.website && conf.website) nextContact.website = conf.website;
    return { ...r, reservation: nextReservation, contact: nextContact, _bookingConfirmed: true };
  };

  const nextDays = plan.days.map(day => ({
    ...day,
    items: (day.items || []).map(item => {
      if (!item || !item.restaurant) return item;
      const nextRestaurant = applyTo(item.restaurant);
      if (nextRestaurant.backup) {
        nextRestaurant.backup = applyTo(nextRestaurant.backup);
      }
      return { ...item, restaurant: nextRestaurant };
    }),
  }));
  return { ...plan, days: nextDays };
}

// Slug-vs-name + city locality validator. Mirrors the server-side check in
// functions/api/confirm-booking.js. Defends against wrong-city URLs that
// slip through when the build pipeline can't run confirm-booking (no
// PERPLEXITY_API_KEY, Sonar timeout) and the model's r.reservation.url
// survives un-grounded. See server-side comment for the full bug pattern
// (Per Se NYC -> per-se-social-corner-coal-harbour in Vancouver).
const RES_SLUG_STOPWORDS = new Set([
  "the","a","an","of","and","at","on","in","by","to","for",
  "de","la","le","el","du","di","da","los","las",
  "r","rs","www","cities","city","venues","venue","restaurants",
  "restaurant","booking","restref","experience","experiences",
  "reservation","reservations","reserve","book","menu",
]);
const RES_FOREIGN_CITY_MARKERS = new Set([
  "nyc","manhattan","brooklyn","queens","bronx","harlem",
  "soho","tribeca","chelsea","midtown","uptown",
  "la","hollywood","beverly","westwood",
  "sf","oakland","berkeley","mission",
  "chicago","wicker","loop",
  "miami","brickell","wynwood",
  "vegas",
  "dallas","austin","houston",
  "boston","cambridge",
  "dc","arlington",
  "atlanta","denver","seattle","portland",
  "nashville","philadelphia","phoenix","detroit",
  "paris","london","tokyo","kyoto","osaka",
  "vancouver","toronto","montreal","ottawa","calgary",
  "rome","milan","florence","venice","madrid","barcelona",
  "amsterdam","berlin","munich","zurich","vienna",
  "coal","harbour","harbor","yaletown","gastown","kitsilano",
]);
function resTokens(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !RES_SLUG_STOPWORDS.has(t));
}
function slugMatchesVenue(urlStr, name, city) {
  try {
    const u = new URL(urlStr);
    if (/rid=\d|restaurantId=\d|venueId=\d/i.test(u.search + u.pathname)) return true;
    const pathToks = resTokens(u.pathname);
    const nameToks = resTokens(name);
    if (nameToks.length === 0 || pathToks.length === 0) return true;
    const cityToks = resTokens(city);
    const cityAliases = new Set(cityToks);
    const cityKey = (city || "").toLowerCase();
    if (/new\s*york/.test(cityKey)) cityAliases.add("nyc");
    if (/los\s*angeles/.test(cityKey)) { cityAliases.add("la"); cityAliases.add("lax"); }
    if (/san\s*francisco/.test(cityKey)) { cityAliases.add("sf"); cityAliases.add("sfo"); }
    if (/washington/.test(cityKey)) cityAliases.add("dc");
    if (/las\s*vegas/.test(cityKey)) cityAliases.add("vegas");
    const allTokensPresent = nameToks.every((t) => pathToks.includes(t));
    const pathJoined = u.pathname.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nameJoined = nameToks.join("");
    const nameSubstring = nameJoined.length >= 4 && pathJoined.includes(nameJoined);
    if (!allTokensPresent && !nameSubstring) return false;
    const allowed = new Set([...nameToks, ...cityAliases]);
    for (const t of pathToks) {
      if (!allowed.has(t) && RES_FOREIGN_CITY_MARKERS.has(t)) return false;
    }
    const extras = pathToks.filter((t) => !allowed.has(t));
    return extras.length <= 2;
  } catch {
    return false;
  }
}
// Hosts whose direct venue URLs are subject to slug+city validation.
const RES_PLATFORM_HOSTS = {
  "exploretock.com": "tock",
  "tockify.com": "tock",
  "resy.com": "resy",
  "opentable.com": "opentable",
};
function reservationUrlIsTrustworthy(url, name, destination) {
  if (!url || !name) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const matched = Object.keys(RES_PLATFORM_HOSTS).find(
      (d) => host === d || host.endsWith("." + d)
    );
    if (!matched) return true; // Not a known booking platform — trust the URL
    return slugMatchesVenue(url, name, destination || "");
  } catch {
    return false;
  }
}

// Build a reservation URL from a restaurant payload.
// Anthropic should provide reservation.url directly; this is a fallback that
// constructs a search URL on the named platform. The supplied destination is
// used to validate direct platform URLs against a wrong-city collision; pass
// "" if not available (validator falls back to name-only checks).
function reservationLink(r, destination) {
  if (!r || !r.reservation) return null;
  const platform = (r.reservation.platform || "").toLowerCase();
  if (r.reservation.url && reservationUrlIsTrustworthy(r.reservation.url, r.name, destination)) {
    return { platform, url: r.reservation.url };
  }
  const q = encodeURIComponent(r.name || "");
  if (platform === "opentable") return { platform, url: `https://www.opentable.com/s?term=${q}` };
  if (platform === "resy") return { platform, url: `https://resy.com/cities/search?query=${q}` };
  if (platform === "tock") return { platform, url: `https://www.exploretock.com/search?query=${q}` };
  if (platform === "yelp") return { platform, url: `https://www.yelp.com/search?find_desc=${q}` };
  if (platform === "phone" && r.reservation.phone) return { platform, url: `tel:${r.reservation.phone}` };
  return null;
}

// Render contact info (phone, address, hours, website, booking) as a compact
// tappable block. Used by ActivityCard and the activity About modal. Mirrors
// the visual treatment of the hotel/restaurant action rows but unified across
// all venue types so a user can call, open in Maps, or book in two taps.
function ContactBlock({ contact, name }) {
  // URL verification context — gives us a Map<url, "ok"|"dead"|"pending">.
  // When a model-supplied URL is verified dead (HTTP 4xx/5xx or network error
  // from /api/verify-url), we swap the action button to a safe Google search
  // fallback so the traveler never lands on a broken page.
  const { status: urlStatus, isReady: verifyReady, destination } = useURLVerify();
  if (!contact) return null;
  const c = contact;
  const telUrl = c.phone ? `tel:${String(c.phone).replace(/[^0-9+]/g, "")}` : null;
  const mapsUrl = (c.address || name) ? `https://maps.google.com/?q=${encodeURIComponent(`${name || ""} ${c.address || ""}`.trim())}` : null;
  // Verify each URL. "dead" = swap with search fallback. "pending"/missing = render as-is.
  const websiteState = c.website ? (urlStatus.get(c.website) || "pending") : null;
  const bookingState = c.booking_url ? (urlStatus.get(c.booking_url) || "pending") : null;
  const websiteDead = websiteState === "dead";
  const bookingDead = bookingState === "dead";
  const websiteHref = websiteDead ? urlSearchFallback(name, destination) : c.website;
  const bookingHref = bookingDead ? urlSearchFallback(name ? `${name} book reservation` : "reservation", destination) : c.booking_url;
  const showWebsite = !!c.website;
  const showBooking = !!c.booking_url;
  const hasAnyAction = telUrl || mapsUrl || showWebsite || showBooking;
  return (
    <>
      {c.address && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "0 0 4px", lineHeight: 1.5 }}>{c.address}</p>
      )}
      {(c.hours || c.price) && (
        <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "0 0 6px", letterSpacing: "0.02em" }}>
          {[c.hours && `· ${c.hours}`, c.price && `· ${c.price}`].filter(Boolean).join("  ")}
        </p>
      )}
      {c.booking_note && (
        <p style={{ fontSize: "11px", color: GOLD_DARK, margin: "4px 0 6px", fontStyle: "italic" }}>✎ {c.booking_note}</p>
      )}
      {hasAnyAction && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
          {telUrl && (
            <a href={telUrl} style={{ fontSize: "11px", padding: "6px 10px", borderRadius: "4px", border: "none", background: "var(--color-text-primary)", color: "var(--color-background-primary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}>Call</a>
          )}
          {showBooking && (
            <a href={bookingHref} target="_blank" rel="noopener noreferrer" title={bookingDead ? "Original booking link could not be verified — search for it on Google" : undefined} style={{ fontSize: "11px", padding: "6px 10px", borderRadius: "4px", border: `0.5px solid ${bookingDead ? GOLD_DARK : GOLD}`, background: bookingDead ? "transparent" : GOLD, color: bookingDead ? GOLD_DARK : ON_NAVY, textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600 }}>{bookingDead ? "Search ↗" : "Book ↗"}</a>
          )}
          {showWebsite && (
            <a href={websiteHref} target="_blank" rel="noopener noreferrer" title={websiteDead ? "Original site link could not be verified — search for the official site" : undefined} style={{ fontSize: "11px", padding: "6px 10px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: websiteDead ? GOLD_DARK : "var(--color-text-secondary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}>{websiteDead ? "Find site ↗" : "Website ↗"}</a>
          )}
          {mapsUrl && (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px", padding: "6px 10px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}>Directions</a>
          )}
        </div>
      )}
      {verifyReady && (websiteDead || bookingDead) && (
        <p style={{ fontSize: "10px", color: GOLD_DARK, margin: "6px 0 0", fontStyle: "italic", letterSpacing: "0.02em" }}>
          ⚠ {websiteDead && bookingDead ? "Both links" : websiteDead ? "Site link" : "Booking link"} could not be verified — using a search instead.
        </p>
      )}
    </>
  );
}

// "Find another restaurant / activity" — inline picker rendered on itinerary
// cards. On open it fetches real, currently-operating alternatives from the
// SAME engine that powers FindView (POST /api/find), filters out lodging and
// anything already on the day / in the slot, and lets the user swap one in.
// The actual plan mutation + persistence happens in the parent via onSwap
// (replace_item patch → onPlanRevised); this component only handles fetch,
// selection and the picker UI.
function FindAnotherControl({ kind, city, currentItem, sameDayItems, onSwap }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [alts, setAlts] = useState(null);
  const fetchedRef = useRef(false);
  const isRestaurant = kind === "restaurant";
  const label = isRestaurant ? "Find another restaurant" : "Find another activity";

  const fetchAlternatives = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/find", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: city,
          category: isRestaurant ? "restaurants" : "activities",
          guidelines: "",
          mode: "standard",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error?.message || `Couldn't load alternatives (${res.status}).`);
        return;
      }
      const pool = (isRestaurant ? json?.results?.restaurants : json?.results?.activities) || [];
      const filtered = pool.filter(findIsNotLodging);
      const picks = selectAlternatives(filtered, { currentItem, sameDayItems, kind, max: 3 });
      if (picks.length === 0) {
        setError("No fresh alternatives came back for this spot. Try again later or keep the current pick.");
      } else {
        setAlts(picks);
      }
    } catch (err) {
      setError(`Couldn't reach the search service. ${String(err?.message || err).slice(0, 80)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      if (!city) {
        setError("Couldn't determine the city for this day, so we can't search for alternatives.");
      } else {
        fetchAlternatives();
      }
    }
  };

  const handleUse = (chosen) => {
    // onSwap returns false when the item couldn't be located in the raw plan
    // (e.g. a backup the quality layer renamed) or the patch didn't apply.
    // Never close on a silent no-op — show an honest error so the user knows
    // nothing changed.
    if (onSwap(chosen) === false) {
      setError("Couldn't locate this item to swap — try again.");
      return;
    }
    setOpen(false);
  };

  return (
    <div className="no-print" style={{ marginTop: "10px", paddingTop: "10px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: `0.5px solid ${GOLD}`, background: open ? GOLD : "transparent", color: open ? ON_NAVY : GOLD, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600 }}
      >{open ? "Close" : `↻ ${label}`}</button>
      {open && (
        <div style={{ marginTop: "10px" }}>
          {loading && (
            <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontStyle: "italic", margin: 0 }}>
              <span style={{ display: "inline-block", width: "10px", height: "10px", marginRight: "7px", border: `2px solid ${GOLD}`, borderTopColor: "transparent", borderRadius: "50%", animation: "swap-spin 0.7s linear infinite", verticalAlign: "middle" }} />
              Finding {isRestaurant ? "restaurants" : "activities"} in {city}…
              <style>{"@keyframes swap-spin { to { transform: rotate(360deg); } }"}</style>
            </p>
          )}
          {error && !loading && (
            <p role="alert" style={{ fontSize: "12px", color: "var(--color-danger-hover)", background: "var(--color-danger-tint)", border: "0.5px solid var(--color-text-danger)", borderRadius: "var(--border-radius-md)", padding: "8px 12px", margin: 0 }}>{error}</p>
          )}
          {alts && !loading && !error && (
            <div>
              <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, margin: "0 0 8px" }}>
                {alts.length === 3 ? "3 alternatives" : `${alts.length} alternative${alts.length === 1 ? "" : "s"} (only ${alts.length} available)`} · pick one to swap in
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {alts.map((a, i) => {
                  const name = isRestaurant ? a.name : activityHeadName(a.text);
                  const sub = isRestaurant
                    ? [a.neighborhood, a.cuisine, a.price_range].filter(Boolean).join("  ·  ")
                    : [a.type, a.duration, a.location].filter(Boolean).join("  ·  ");
                  const why = isRestaurant ? a.why : (a.text && a.text.indexOf(" — ") > 0 ? a.text.slice(a.text.indexOf(" — ") + 3) : a.why);
                  return (
                    <div key={`${name}-${i}`} style={{ border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 12px", background: "var(--color-background-secondary)" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: "160px" }}>
                          <p style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", margin: "0 0 3px", lineHeight: 1.3 }}>{name}</p>
                          {sub && <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 3px", letterSpacing: "0.02em" }}>{sub}</p>}
                          {why && <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.45 }}>{why}</p>}
                          {(a.verify_status === "verify_before_booking") && (
                            <p style={{ fontSize: "10.5px", color: "var(--color-text-primary)", margin: "4px 0 0", fontStyle: "italic" }}>⚠︎ Verify status before booking.</p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleUse(a)}
                          style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: "none", background: GOLD, color: ON_NAVY, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap" }}
                        >Use this</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Activity card: rich treatment matching restaurant/hotel cards. Triggered
// whenever an Activity item has contact info or a why blurb — otherwise we
// fall back to the plain text-row rendering. Includes day badge for use in
// the Activities tab (where items are pulled out of day context).
function ActivityCard({ time, end_time, item, dayLabel, swapControl }) {
  if (!item) return null;
  const contact = item.contact;
  const why = item.why;
  // Title splits as 'Venue — short description' when the model writes 'Visit
  // the Acropolis — timed entry'. We render the part before the em-dash bold.
  const dashIdx = (item.text || "").indexOf(" — ");
  const head = dashIdx > 0 ? (item.text || "").slice(0, dashIdx) : (item.text || "");
  const tail = dashIdx > 0 ? (item.text || "").slice(dashIdx + 3) : "";
  return (
    <div style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        {time && <TimePill time={time} end_time={end_time} />}
        <Badge type={item.type || "Activity"} />
        {dayLabel && (
          <span style={{ fontSize: "9.5px", fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{dayLabel}</span>
        )}
      </div>
      <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: "0 0 4px", lineHeight: 1.3 }}>{head}</p>
      {tail && <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 6px", lineHeight: 1.5 }}>{tail}</p>}
      {item.location && !contact?.address && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: "0 0 6px" }}>{item.location}</p>
      )}
      {item.duration && (
        <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "0 0 6px", letterSpacing: "0.02em" }}>⏱ {item.duration}</p>
      )}
      {why && <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "4px 0 6px", lineHeight: 1.5 }}>{why}</p>}
      <ContactBlock contact={contact} name={head} />
      {swapControl}
    </div>
  );
}

function RestaurantCard({ type, restaurant: r, onOpenMenu, swapControl }) {
  // destination is read from URLVerifyContext so reservationLink() can
  // slug-validate r.reservation.url against the trip city (defense-in-depth
  // against same-name venues in a different city, e.g. Per Se NYC vs Per Se
  // Social Corner Vancouver).
  const { destination: tripCity } = useURLVerify();
  const resv = reservationLink(r, tripCity);
  const platformLabel = resv ? ({
    opentable: "OpenTable", resy: "Resy", tock: "Tock", yelp: "Yelp", phone: "Call",
  }[resv.platform] || "Reserve") : null;
  // Hard closure state: the closure gate identified this restaurant as on the
  // denylist (verify_status="permanently_closed"). Render a destructive red
  // banner across the whole card, strike through the name, and hide all
  // action buttons so the user CANNOT accidentally book a closed restaurant.
  const isClosed = r.verify_status === "permanently_closed";

  return (
    <div style={{ marginBottom: "12px", border: isClosed ? "1px solid var(--color-text-danger)" : "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: isClosed ? "var(--color-danger-tint)" : "var(--color-background-primary)", position: "relative" }}>
      {isClosed && (
        <div style={{ margin: "-2px 0 10px", padding: "7px 10px", background: "var(--color-text-danger)", color: "var(--color-background-primary)", borderRadius: "4px", fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "13px" }}>⚠</span>
          <span>Permanently closed — do not book</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        <Badge type={type} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: isClosed ? "var(--color-danger-hover)" : "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1, textDecoration: isClosed ? "line-through" : "none" }}>{r.name}</p>
        {r._weekdayMismatch && !isClosed && (
          <span style={{ fontSize: "9.5px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", background: "var(--color-warning-tint)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", whiteSpace: "nowrap" }}>Closed {DAY_LABELS_3[r._weekdayMismatch] || r._weekdayMismatch}s — verify</span>
        )}
        {r._missingBackup && !isClosed && (
          <span style={{ fontSize: "9.5px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", background: "var(--color-warning-tint)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", whiteSpace: "nowrap" }}>No backup</span>
        )}
        {r._isReturnVisit && !isClosed && (
          <span style={{ fontSize: "9.5px", fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", border: `0.5px solid ${GOLD}`, borderRadius: "3px", whiteSpace: "nowrap" }}>Return visit</span>
        )}
      </div>
      {(r.neighborhood || r.cuisine || r.price_range) && (
        <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 6px", letterSpacing: "0.02em" }}>
          {[r.neighborhood, r.cuisine, r.price_range].filter(Boolean).join("  ·  ")}
        </p>
      )}
      {r.why && !isClosed && <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>{r.why}</p>}
      {r.closure_note && (
        <p style={{ fontSize: "11px", color: isClosed ? "var(--color-danger-hover)" : (r.closure_note.toLowerCase().includes("confirm") ? "var(--color-warning)" : "var(--color-text-tertiary)"), margin: "0 0 8px", fontStyle: "italic", fontWeight: isClosed ? 600 : "normal" }}>
          ⚠︎ {r.closure_note}
        </p>
      )}
      {/* Freshness check — the model marks restaurants it can't confirm are */}
      {/* still operating, and we surface that as a tappable verify link so the */}
      {/* traveler doesn't show up to a dark storefront. The single biggest QA */}
      {/* failure this app can ship is recommending a permanently-closed */}
      {/* restaurant, so we default to the conservative "verify before booking" */}
      {/* microcopy whenever the model isn't certain. */}
      {!isClosed && (r.verify_status === "verify_before_booking" || (!r.verify_status && r.verify_url)) && (
        <div style={{ margin: "0 0 8px", padding: "6px 9px", background: "var(--color-surface-2)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "4px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "10.5px", fontWeight: 600, color: "var(--color-text-primary)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Verify</span>
          <span style={{ fontSize: "11.5px", color: "var(--color-text-primary)" }}>
            We can't confirm this spot's status — check before booking.
          </span>
          {r.verify_url && (
            <a
              href={r.verify_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "11px", color: "var(--color-text-primary)", textDecoration: "underline", fontWeight: 500, marginLeft: "auto" }}
            >Check listing →</a>
          )}
        </div>
      )}
      <div style={{ display: isClosed ? "none" : "flex", gap: "8px", flexWrap: "wrap", marginTop: "6px" }}>
        {/* View Menu always shown — if the model included a menu it renders
            instantly; otherwise the parent lazy-fetches via /api/menu. */}
        <button
          onClick={() => onOpenMenu(r)}
          style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: `0.5px solid ${GOLD}`, background: "transparent", color: GOLD, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}
        >View Menu</button>
        {r.contact?.website && (
          <a
            href={r.contact.website}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, textDecoration: "none", display: "inline-block" }}
          >Website ↗</a>
        )}
        {resv && (
          <a
            href={resv.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: "none", background: "var(--color-text-primary)", color: "var(--color-background-primary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, textDecoration: "none", display: "inline-block" }}
          >Reserve · {platformLabel}</a>
        )}
      </div>
      {r.backup && (
        <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
          <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", margin: "0 0 4px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>Backup if no table</p>
          <p style={{ fontSize: "12.5px", color: "var(--color-text-primary)", margin: "0 0 4px", fontWeight: 500 }}>
            {r.backup.name}
            {r.backup._weekdayMismatch && (
              <span style={{ marginLeft: "6px", fontSize: "9.5px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 6px", background: "var(--color-warning-tint)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", whiteSpace: "nowrap" }}>Closed {DAY_LABELS_3[r.backup._weekdayMismatch] || r.backup._weekdayMismatch}s</span>
            )}
          </p>
          {(r.backup.neighborhood || r.backup.cuisine) && (
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 6px" }}>{[r.backup.neighborhood, r.backup.cuisine].filter(Boolean).join("  ·  ")}</p>
          )}
          {r.backup.why && <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "0 0 6px", lineHeight: 1.5 }}>{r.backup.why}</p>}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {/* Backup Menu button also always shown, lazy-fetches on tap. */}
            <button
              onClick={() => onOpenMenu(r.backup)}
              style={{ fontSize: "10.5px", padding: "5px 10px", borderRadius: "4px", border: `0.5px solid var(--color-border-secondary)`, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", textTransform: "uppercase" }}
            >Menu</button>
            {r.backup.contact?.website && (
              <a
                href={r.backup.contact.website}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "10.5px", padding: "5px 10px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", textTransform: "uppercase", textDecoration: "none" }}
              >Website ↗</a>
            )}
            {reservationLink(r.backup, tripCity) && (
              <a
                href={reservationLink(r.backup, tripCity).url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "10.5px", padding: "5px 10px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", textTransform: "uppercase", textDecoration: "none" }}
              >Reserve · {({opentable:"OpenTable",resy:"Resy",tock:"Tock",yelp:"Yelp",phone:"Call"}[reservationLink(r.backup, tripCity).platform] || "Reserve")}</a>
            )}
          </div>
        </div>
      )}
      {swapControl}
    </div>
  );
}

function MenuModal({ restaurant, onClose }) {
  if (!restaurant) return null;
  const m = restaurant.menu || {};
  const sections = [
    ["Signature dishes", m.signature_dishes],
    ["Appetizers / small plates", m.appetizers],
    ["Mains", m.mains],
    ["Desserts", m.desserts],
    ["Wine & drinks", m.wine_and_drinks],
  ];
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1000, padding: 0 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--color-background-primary)", maxWidth: "640px", width: "100%", maxHeight: "90vh", overflowY: "auto", borderRadius: "16px 16px 0 0", padding: "22px 22px 32px", boxShadow: "0 -8px 32px rgba(0,0,0,0.25)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
          <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, margin: 0 }}>Menu</p>
          <button
            onClick={onClose}
            aria-label="Close menu"
            style={{ background: "transparent", border: "none", fontSize: "22px", color: "var(--color-text-secondary)", cursor: "pointer", padding: "4px 8px", lineHeight: 1 }}
          >×</button>
        </div>
        <p style={{ fontSize: "20px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 4px", color: "var(--color-text-primary)" }}>{restaurant.name}</p>
        {(restaurant.neighborhood || restaurant.cuisine || restaurant.price_range) && (
          <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 14px", letterSpacing: "0.02em" }}>
            {[restaurant.neighborhood, restaurant.cuisine, restaurant.price_range].filter(Boolean).join("  ·  ")}
          </p>
        )}
        {m.style_note && <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 14px", fontStyle: "italic", lineHeight: 1.55 }}>{m.style_note}</p>}
        {sections.map(([title, items]) => Array.isArray(items) && items.length > 0 && (
          <div key={title} style={{ marginBottom: "14px" }}>
            <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 8px", paddingBottom: "6px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{title}</p>
            {items.map((it, i) => {
              if (typeof it === "string") {
                return <p key={i} style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 6px", lineHeight: 1.5 }}>{it}</p>;
              }
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "12px", marginBottom: "8px", alignItems: "baseline" }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: 0, fontWeight: 500, lineHeight: 1.4 }}>{it.name}</p>
                    {it.description && <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "2px 0 0", lineHeight: 1.5 }}>{it.description}</p>}
                  </div>
                  {it.price && <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0, whiteSpace: "nowrap" }}>{it.price}</p>}
                </div>
              );
            })}
          </div>
        ))}
        {m.source_note && <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", marginTop: "16px", fontStyle: "italic", lineHeight: 1.5 }}>{m.source_note}</p>}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <p style={{ fontSize: "11px", fontWeight: "600", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px", paddingBottom: "8px", borderBottom: `0.5px solid var(--color-border-tertiary)` }}>{title}</p>
      {children}
    </div>
  );
}

function tonightPriority(s) {
  const t = (s || "").trim();
  if (/^⚠/.test(t) || /^must today/i.test(t)) return { rank: 0, label: "Must today", color: "var(--color-warning)", bg: "var(--color-warning-tint)" };
  if (/^this week/i.test(t) || /^·\s*this week/i.test(t)) return { rank: 1, label: "This week", color: GOLD_DARK, bg: GOLD_LIGHT };
  if (/^anytime/i.test(t)) return { rank: 2, label: "Anytime", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)" };
  return { rank: 1, label: null, color: GOLD_DARK, bg: GOLD_LIGHT };
}
function stripTonightPrefix(s) {
  return (s || "")
    .replace(/^⚠︎?\s*Must today\s*[:—–-]?\s*/i, "")
    .replace(/^·?\s*This week\s*[:—–-]?\s*/i, "")
    .replace(/^Anytime\s*[:—–-]?\s*/i, "")
    .trim();
}

// Curated truth table for routes where the LLM frequently hallucinates. Each
// entry lists the carriers that ACTUALLY operate a nonstop today. If the
// model emits a flight whose carrier is not in this set, applyQualityLayer
// rewrites it. Keep keys sorted as "AAA-BBB" with the alphabetically smaller
// IATA first — lookup is direction-agnostic.
// Curated destination → airports lookup. Keyed on lowercase destination phrase
// (city, region, or attraction). Each entry lists airports in PREFERRED order:
// the closest viable airport first, fallbacks after. Each airport has IATA +
// approx ground-time-from-destination. Used by both the system prompt (so the
// model can pick correctly) and the post-processing validator (so the app
// flags wrong choices). Match is by `includes()` on the lowercased destination
// — "bar harbor" matches "Bar Harbor, Maine" and "Bar Harbor & Acadia".
const DEST_AIRPORTS = {
  "bar harbor": [
    { iata: "BHB", name: "Hancock County–Bar Harbor", drive: "15 min", note: "seasonal Cape Air/JetBlue from BOS; closest by far" },
    { iata: "BGR", name: "Bangor Intl", drive: "50 min", note: "daily mainline service from EWR/JFK/PHL/DCA; best year-round option" },
    { iata: "PWM", name: "Portland Jetport", drive: "3 h", note: "more flight options, but long drive" },
  ],
  "acadia": [
    { iata: "BHB", name: "Hancock County–Bar Harbor", drive: "15 min", note: "closest to park" },
    { iata: "BGR", name: "Bangor Intl", drive: "50 min", note: "more flight options" },
    { iata: "PWM", name: "Portland Jetport", drive: "3 h", note: "hub backup" },
  ],
  "santa fe": [
    { iata: "SAF", name: "Santa Fe Regional", drive: "15 min", note: "limited — American from DFW, United from DEN/ORD" },
    { iata: "ABQ", name: "Albuquerque Intl Sunport", drive: "1 h", note: "primary hub; most nonstops; usually the right call" },
  ],
  "taos": [
    { iata: "TAOS", name: "Taos Regional", drive: "15 min", note: "very limited" },
    { iata: "SAF", name: "Santa Fe", drive: "1.5 h", note: "some service" },
    { iata: "ABQ", name: "Albuquerque", drive: "2.5 h", note: "most reliable" },
  ],
  "jackson hole": [
    { iata: "JAC", name: "Jackson Hole", drive: "15 min", note: "direct nonstops from many hubs" },
    { iata: "SLC", name: "Salt Lake City", drive: "5 h", note: "only if JAC is full/expensive" },
  ],
  "aspen": [
    { iata: "ASE", name: "Aspen/Pitkin", drive: "10 min", note: "seasonal service, weather-sensitive" },
    { iata: "EGE", name: "Eagle/Vail", drive: "1.25 h", note: "more reliable winter option" },
    { iata: "DEN", name: "Denver", drive: "4 h", note: "last resort" },
  ],
  "vail": [
    { iata: "EGE", name: "Eagle/Vail", drive: "45 min", note: "nonstops from many hubs in ski season" },
    { iata: "DEN", name: "Denver", drive: "2 h", note: "year-round backup" },
  ],
  "sun valley": [
    { iata: "SUN", name: "Friedman Memorial", drive: "15 min", note: "Alaska/United/Delta seasonal" },
    { iata: "BOI", name: "Boise", drive: "2.5 h", note: "more options" },
  ],
  "big sky": [
    { iata: "BZN", name: "Bozeman Yellowstone", drive: "1 h", note: "closest — nonstops year-round" },
  ],
  "yellowstone": [
    { iata: "BZN", name: "Bozeman", drive: "1.5 h", note: "north entrance — most flight options" },
    { iata: "JAC", name: "Jackson Hole", drive: "1 h", note: "south entrance" },
    { iata: "COD", name: "Cody", drive: "1 h", note: "east entrance — limited service" },
  ],
  "glacier national": [
    { iata: "FCA", name: "Glacier Park / Kalispell", drive: "30 min", note: "closest" },
    { iata: "GPI", name: "Glacier Park (same as FCA)", drive: "30 min", note: "" },
  ],
  "napa": [
    { iata: "STS", name: "Charles M. Schulz / Sonoma County", drive: "45 min", note: "smaller; Alaska/Avelo" },
    { iata: "SFO", name: "San Francisco", drive: "1.5 h", note: "most flight options" },
    { iata: "OAK", name: "Oakland", drive: "1.5 h", note: "backup" },
  ],
  "sonoma": [
    { iata: "STS", name: "Sonoma County", drive: "30 min", note: "closest" },
    { iata: "SFO", name: "San Francisco", drive: "1.5 h", note: "more options" },
  ],
  "martha's vineyard": [
    { iata: "MVY", name: "Martha's Vineyard", drive: "on-island", note: "closest — JetBlue/Delta seasonal from BOS/JFK/EWR" },
    { iata: "HYA", name: "Hyannis", drive: "ferry from Hyannis", note: "connect via ferry" },
    { iata: "BOS", name: "Boston", drive: "3 h + ferry", note: "if seasonal flights to MVY unavailable" },
  ],
  "nantucket": [
    { iata: "ACK", name: "Nantucket Memorial", drive: "on-island", note: "JetBlue/Delta/American seasonal" },
    { iata: "BOS", name: "Boston", drive: "3 h + ferry", note: "backup" },
  ],
  "hamptons": [
    { iata: "HTO", name: "East Hampton", drive: "15 min", note: "private/charter" },
    { iata: "ISP", name: "Long Island MacArthur", drive: "1.25 h", note: "Southwest/Frontier" },
    { iata: "JFK", name: "JFK", drive: "2.5 h", note: "most options" },
  ],
  "montauk": [
    { iata: "MTP", name: "Montauk", drive: "5 min", note: "GA only" },
    { iata: "ISP", name: "Long Island MacArthur", drive: "2 h", note: "limited" },
    { iata: "JFK", name: "JFK", drive: "3 h", note: "most options" },
  ],
  "cape cod": [
    { iata: "HYA", name: "Hyannis (Barnstable)", drive: "central Cape", note: "Cape Air seasonal" },
    { iata: "PVC", name: "Provincetown", drive: "P-town only", note: "Cape Air from BOS" },
    { iata: "BOS", name: "Boston", drive: "1.5–2.5 h", note: "most flight options" },
  ],
  "newport rhode": [
    { iata: "PVD", name: "T.F. Green / Providence", drive: "40 min", note: "closest" },
    { iata: "BOS", name: "Boston", drive: "1.5 h", note: "more options" },
  ],
  "hilton head": [
    { iata: "HHH", name: "Hilton Head", drive: "on-island", note: "AA/Delta/United from major hubs" },
    { iata: "SAV", name: "Savannah", drive: "50 min", note: "more options" },
  ],
  "savannah": [
    { iata: "SAV", name: "Savannah/Hilton Head", drive: "20 min", note: "primary" },
  ],
  "asheville": [
    { iata: "AVL", name: "Asheville Regional", drive: "20 min", note: "primary — nonstops from many east-coast hubs" },
    { iata: "CLT", name: "Charlotte", drive: "2 h", note: "backup" },
  ],
  "charleston": [
    { iata: "CHS", name: "Charleston Intl", drive: "20 min", note: "primary" },
  ],
  "key west": [
    { iata: "EYW", name: "Key West Intl", drive: "10 min", note: "AA/Delta/United/Silver from major hubs" },
    { iata: "MIA", name: "Miami", drive: "3.5 h", note: "if EYW pricey or sold out" },
  ],
  "jackson wyoming": [
    { iata: "JAC", name: "Jackson Hole", drive: "15 min", note: "primary" },
  ],
  "park city": [
    { iata: "SLC", name: "Salt Lake City", drive: "40 min", note: "primary — no closer airport" },
  ],
  "telluride": [
    { iata: "TEX", name: "Telluride Regional", drive: "15 min", note: "weather-sensitive seasonal" },
    { iata: "MTJ", name: "Montrose", drive: "1.5 h", note: "more reliable winter option" },
  ],
  "steamboat": [
    { iata: "HDN", name: "Yampa Valley / Hayden", drive: "30 min", note: "ski season nonstops" },
    { iata: "DEN", name: "Denver", drive: "3 h", note: "backup" },
  ],
  "hallstatt": [
    { iata: "SZG", name: "Salzburg", drive: "1 h", note: "closest — European budget hub" },
    { iata: "VIE", name: "Vienna", drive: "3 h", note: "more transatlantic options" },
    { iata: "MUC", name: "Munich", drive: "3 h", note: "transatlantic backup" },
  ],
  "interlaken": [
    { iata: "BRN", name: "Bern", drive: "1 h", note: "limited service" },
    { iata: "ZRH", name: "Zurich", drive: "2 h", note: "primary international gateway" },
    { iata: "GVA", name: "Geneva", drive: "2.5 h", note: "international gateway" },
  ],
  "st. moritz": [
    { iata: "SMV", name: "Samedan / St. Moritz", drive: "15 min", note: "GA/private only" },
    { iata: "ZRH", name: "Zurich", drive: "3.5 h", note: "primary" },
  ],
  "zermatt": [
    { iata: "GVA", name: "Geneva", drive: "3.5 h + train", note: "primary — Zermatt is car-free, take Glacier Express train" },
    { iata: "ZRH", name: "Zurich", drive: "3.5 h + train", note: "backup" },
  ],
  "chamonix": [
    { iata: "GVA", name: "Geneva", drive: "1.25 h", note: "closest international" },
  ],
  "reykjavik": [
    { iata: "KEF", name: "Keflavík", drive: "45 min", note: "all international flights" },
  ],
  "cinque terre": [
    { iata: "PSA", name: "Pisa", drive: "1.5 h", note: "closest" },
    { iata: "FLR", name: "Florence", drive: "2.5 h", note: "if Pisa unavailable" },
    { iata: "GOA", name: "Genoa", drive: "1.5 h", note: "backup" },
  ],
  "tuscany": [
    { iata: "FLR", name: "Florence", drive: "central", note: "primary" },
    { iata: "PSA", name: "Pisa", drive: "1 h", note: "budget carriers" },
  ],
  "amalfi": [
    { iata: "NAP", name: "Naples", drive: "1.5 h", note: "primary" },
  ],
  "positano": [
    { iata: "NAP", name: "Naples", drive: "1.5 h", note: "primary" },
  ],
  "capri": [
    { iata: "NAP", name: "Naples", drive: "+ ferry", note: "primary" },
  ],
  "sicily": [
    { iata: "CTA", name: "Catania", drive: "east coast", note: "main eastern gateway" },
    { iata: "PMO", name: "Palermo", drive: "west coast", note: "main western gateway" },
  ],
  "mallorca": [
    { iata: "PMI", name: "Palma de Mallorca", drive: "30 min", note: "only airport" },
  ],
  "ibiza": [
    { iata: "IBZ", name: "Ibiza", drive: "20 min", note: "only airport" },
  ],
  "mykonos": [
    { iata: "JMK", name: "Mykonos", drive: "15 min", note: "only airport" },
  ],
  "santorini": [
    { iata: "JTR", name: "Santorini", drive: "20 min", note: "only airport" },
  ],
};

const KNOWN_NONSTOPS = {
  // Transatlantic
  "CPH-EWR": ["SAS"],
  "CPH-JFK": ["SAS", "Norse Atlantic"],
  "EWR-ZRH": ["United", "Swiss", "Swiss International"],
  "JFK-ZRH": ["Swiss", "Swiss International", "Delta"],
  "EWR-LHR": ["United", "British Airways", "Virgin Atlantic"],
  "JFK-LHR": ["British Airways", "American", "Delta", "Virgin Atlantic", "JetBlue"],
  "CDG-JFK": ["Air France", "Delta", "American", "French Bee"],
  "CDG-EWR": ["United", "Air France"],
  "EWR-FRA": ["United", "Lufthansa"],
  "FRA-JFK": ["Lufthansa", "Singapore Airlines", "Condor"],
  "AMS-EWR": ["United", "KLM"],
  "AMS-JFK": ["KLM", "Delta"],
  "EWR-MUC": ["United", "Lufthansa"],
  "JFK-MUC": ["Lufthansa", "Delta"],
  "DUB-EWR": ["United", "Aer Lingus"],
  "DUB-JFK": ["Aer Lingus", "Delta", "JetBlue"],
  "FCO-JFK": ["ITA Airways", "Delta", "American"],
  "EWR-FCO": ["United", "ITA Airways"],
  "BCN-EWR": ["United"],
  "BCN-JFK": ["American", "Delta", "Iberia"],
  "JFK-MAD": ["Iberia", "American", "Delta", "Air Europa"],
  "EWR-MAD": ["United", "Iberia"],
  // Transpacific
  "HND-JFK": ["ANA", "Japan Airlines", "Delta", "American"],
  "JFK-NRT": ["ANA", "Japan Airlines"],
  "HND-LAX": ["ANA", "Japan Airlines", "Delta", "American", "United"],
  "LAX-NRT": ["ANA", "Japan Airlines", "United", "Singapore Airlines"],
  "HKG-JFK": ["Cathay Pacific"],
  "HKG-LAX": ["Cathay Pacific", "American"],
  "ICN-JFK": ["Korean Air", "Asiana"],
  "ICN-LAX": ["Korean Air", "Asiana", "Delta"],
};

// Carrier-name aliases so a model emitting "Scandinavian Airlines System" or
// "BA" still matches an entry that says "SAS" / "British Airways".
const CARRIER_ALIASES = {
  "sas": ["scandinavian", "sas"],
  "scandinavian airlines": ["sas", "scandinavian"],
  "british airways": ["ba", "british"],
  "ba": ["british airways", "british"],
  "american": ["american airlines", "aa"],
  "american airlines": ["american", "aa"],
  "united": ["united airlines", "ua"],
  "united airlines": ["united", "ua"],
  "delta": ["delta air lines", "dl"],
  "virgin atlantic": ["virgin"],
  "japan airlines": ["jal"],
  "jal": ["japan airlines"],
  "ana": ["all nippon", "all nippon airways"],
  "all nippon": ["ana"],
  "swiss": ["swiss international", "swiss air"],
  "singapore airlines": ["singapore"],
  "cathay pacific": ["cathay"],
  "korean air": ["korean"],
  "ita airways": ["ita", "alitalia"],
  "norse atlantic": ["norse"],
  "aer lingus": ["aerlingus"],
};

function routeKey(a, b) {
  if (!a || !b) return null;
  const x = String(a).toUpperCase().trim();
  const y = String(b).toUpperCase().trim();
  if (x === y) return null;
  return [x, y].sort().join("-");
}

// Look up the curated airport list for a destination string. Tries the most
// specific match first (longest matching key wins) so "South Lake Tahoe" picks
// the Tahoe entry rather than nothing. Returns null if no entry matches.
function lookupDestAirports(destination) {
  if (!destination || typeof destination !== "string") return null;
  const d = destination.toLowerCase();
  let bestKey = null;
  for (const key of Object.keys(DEST_AIRPORTS)) {
    if (d.includes(key)) {
      if (!bestKey || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey ? { key: bestKey, airports: DEST_AIRPORTS[bestKey] } : null;
}

function carrierMatchesKnown(carrier, knownList) {
  if (!carrier || !Array.isArray(knownList)) return false;
  const c = carrier.toLowerCase();
  for (const k of knownList) {
    const kl = k.toLowerCase();
    if (c.includes(kl) || kl.includes(c)) return true;
    const aliases = CARRIER_ALIASES[kl] || [];
    for (const a of aliases) {
      if (c.includes(a) || a.includes(c)) return true;
    }
  }
  return false;
}

// ===========================================================================
// CLOSED RESTAURANTS DENYLIST — the single source of truth for restaurants
// the planner must NEVER recommend. The amber Verify chip is a polite warning;
// this list is the actual gate. Anything matched here is stripped from days[]
// and replaced with the model's backup (or annotated as a fix-it-yourself QC
// warning if no backup exists). When in doubt about a closure, leave it OUT
// of this list — a false positive (removing a still-open restaurant) is worse
// than a false negative (letting a closed one through with the Verify chip).
//
// Entry format: { name, city, closed: "YYYY-MM" | "YYYY", source }.
//   - name: canonical name as commonly used. Substring matching is
//     case-insensitive and aliases (e.g. "Husk Barbeque", "Husk Greenville")
//     are handled via the aliases[] array.
//   - city: lowercase city or region substring matched against the trip's
//     destination + cities[] so we don't strip a still-open same-name spot
//     in another city (Husk Charleston, Nashville, Savannah remain open).
//   - aliases: optional additional names the model might emit.
const CLOSED_RESTAURANTS = [
  {
    name: "Husk",
    aliases: ["Husk Barbeque", "Husk BBQ", "Husk Greenville", "Husk Barbecue"],
    city: "greenville",
    closed: "2021-10",
    source: "https://southeasterndispatch.com/features/Neighborhood-Dining-Group-Shutters-Husk-Barbeque-in-Greenville",
  },
  // NYC — from The Infatuation closures list (Jan 2025) + Time Out's running list
  { name: "Frog Club", city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Absolute Bagels", city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Piccolo Angolo", city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Ugly Baby", city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "M.Wells", aliases: ["M Wells", "M. Wells"], city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Buttermilk Channel", city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "En Japanese Brasserie", city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Sushi Azabu", city: "new york", closed: "2025-01", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "La Grenouille", city: "new york", closed: "2024-09", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Holiday Bar", city: "new york", closed: "2024-09", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Contento", city: "new york", closed: "2024-12", source: "https://www.theinfatuation.com/new-york/features/nyc-restaurant-closings" },
  { name: "Khe-Yo", aliases: ["Khe Yo"], city: "new york", closed: "2024-06", source: "https://www.timeout.com/newyork/restaurants/notable-nyc-restaurants-and-bars-that-have-now-permanently-closed" },
  { name: "Momofuku Ko", city: "new york", closed: "2023", source: "https://www.thetakeout.com/1810450/michelin-star-restaurants-vanished/" },
  { name: "Contra", city: "new york", closed: "2023", source: "https://www.thetakeout.com/1810450/michelin-star-restaurants-vanished/" },
  // San Francisco — from The Takeout Michelin closures list
  { name: "Mourad", city: "san francisco", closed: "2024-10", source: "https://www.thetakeout.com/1810450/michelin-star-restaurants-vanished/" },
  // LA
  { name: "Manzke", city: "los angeles", closed: "2024", source: "https://www.thetakeout.com/1810450/michelin-star-restaurants-vanished/" },
  // London (covered in case the app ever serves UK trips)
  { name: "Le Gavroche", city: "london", closed: "2024-01", source: "https://www.thetakeout.com/1810450/michelin-star-restaurants-vanished/" },
  { name: "Locanda Locatelli", city: "london", closed: "2025-01", source: "https://www.thetakeout.com/1810450/michelin-star-restaurants-vanished/" },
];

// Normalize a name for matching: lowercase, strip punctuation, collapse spaces.
function normalizeRestaurantName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// Build a haystack of city tokens from the trip inputs so we can scope
// closure matches to the right destination (avoid stripping Husk Charleston
// when the user is going to Charleston).
function buildCityHaystack(inputs) {
  const parts = [];
  if (inputs?.destination) parts.push(String(inputs.destination));
  if (Array.isArray(inputs?.cities)) {
    inputs.cities.forEach(c => { if (c?.name) parts.push(String(c.name)); });
  }
  return parts.join(" ").toLowerCase();
}

// Determine whether a given restaurant matches a denylist entry. Both the
// name AND the city must match: we never strip a same-name restaurant in
// a different city. Matches against name + aliases via word-boundary regex
// so "Husk" matches "Husk Greenville" but not "Buschu's Husk Cellar".
function findClosedRestaurantMatch(restaurantName, cityHaystack) {
  if (!restaurantName) return null;
  const norm = normalizeRestaurantName(restaurantName);
  if (!norm) return null;
  for (const entry of CLOSED_RESTAURANTS) {
    if (!cityHaystack.includes(entry.city)) continue;
    const names = [entry.name, ...(entry.aliases || [])];
    for (const candidate of names) {
      const cNorm = normalizeRestaurantName(candidate);
      if (!cNorm) continue;
      // Word-boundary match: candidate must appear as a discrete token sequence
      // in the restaurant's normalized name.
      const re = new RegExp(`(^|\\s)${cNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
      if (re.test(norm)) return entry;
    }
  }
  return null;
}

// Pass-three quality layer: dedupe restaurant repeats with an explicit
// "Return to X for [meal]" annotation, and surface a QC summary of any
// fixes/warnings the renderer applied so the user knows the app is on it.
// Pure: never mutates input — returns { data, qc }.
// Day-of-week helpers — ported from santafejune.com's restaurants.js. The
// Santa Fe app keeps a curated JSON of restaurants with hand-verified
// open_days; we instead ask the planner LLM to populate open_days per
// restaurant. The check itself is identical: turn the visit date into a
// 3-letter weekday code and look it up in the restaurant's open_days[].
// Missing open_days is treated as 'assume open' (matches Santa Fe behavior).
const DAY_KEYS_3 = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS_3 = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
function weekdayOfISO(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  // Local-date parse, not UTC — same as Santa Fe.
  const wd = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)).getDay();
  return DAY_KEYS_3[wd];
}
function isOpenOnWeekday(restaurant, weekday) {
  const open = restaurant?.open_days;
  if (!Array.isArray(open) || open.length === 0) return true; // unknown → assume open
  return open.includes(weekday);
}
// Compute the ISO date (YYYY-MM-DD) for a given day index given the trip's
// start date string. Returns null if startDate isn't parseable. Day 0 is
// the start date itself.
function dayIndexToISO(startDateStr, dayIdx) {
  if (!startDateStr) return null;
  const m = String(startDateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  d.setDate(d.getDate() + dayIdx);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function applyQualityLayer(input, inputs) {
  if (!input || typeof input !== "object") return { data: input, qc: { fixes: [], warnings: [] } };
  const fixes = [];
  const warnings = [];

  // Deep-clone the bits we'll touch so renderer mutation is safe.
  // `let` so the strip step below can replace days with the helper's output.
  let days = Array.isArray(input.days)
    ? input.days.map(d => ({ ...d, items: Array.isArray(d.items) ? d.items.map(it => ({ ...it, restaurant: it.restaurant ? { ...it.restaurant } : it.restaurant, flight: it.flight ? { ...it.flight } : it.flight })) : d.items }))
    : input.days;

  // 1. Restaurant dedupe → annotate the 2nd+ visit so the user understands the repeat is intentional.
  if (Array.isArray(days)) {
    const seen = new Map(); // normalized name → { dayIndex, mealType }
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        const r = item.restaurant;
        const isMeal = /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(item.type || "");
        if (!r || !r.name || !isMeal) return;
        const key = r.name.trim().toLowerCase();
        const prior = seen.get(key);
        if (prior) {
          const mealLabel = (item.type || "meal").toLowerCase();
          const note = `Return visit — first appeared Day ${prior.dayIndex + 1} (${prior.mealType.toLowerCase()}).`;
          if (r.why && !/^return visit/i.test(r.why)) {
            r.why = `${note} ${r.why}`;
          } else if (!r.why) {
            r.why = note;
          }
          r._isReturnVisit = true;
          fixes.push(`Annotated repeat: ${r.name} (Day ${dayIdx + 1} ${mealLabel}) — first on Day ${prior.dayIndex + 1}`);
        } else {
          seen.set(key, { dayIndex: dayIdx, mealType: item.type || "meal" });
        }
      });
    });
  }

  // 1b. Restaurant open-day verification. The planner is instructed to emit
  //     open_days per restaurant; we cross-check against the weekday it was
  //     actually placed on and FLAG (not swap) the mismatch so the traveler
  //     sees an amber "closed [Day]s — verify hours" chip. Missing open_days
  //     is treated as 'assume open' to avoid false alarms.
  //     Mirrors Santa Fe June's isOpenOn/weekdayOf pattern.
  if (Array.isArray(days) && inputs?.basics?.startDate) {
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        const r = item.restaurant;
        const isMeal = /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(item.type || "");
        if (!r || !isMeal) return;
        const dayIso = dayIndexToISO(inputs.basics.startDate, dayIdx);
        if (!dayIso) return;
        const weekday = weekdayOfISO(dayIso);
        if (!weekday) return;
        const mealLabel = (item.type || "meal").toLowerCase();
        // Primary restaurant
        if (Array.isArray(r.open_days) && r.open_days.length > 0 && !isOpenOnWeekday(r, weekday)) {
          r._weekdayMismatch = weekday;
          warnings.push(`Day ${dayIdx + 1} ${mealLabel}: ${r.name || "restaurant"} may be closed ${DAY_LABELS_3[weekday]}s — verify hours`);
        }
        // Backup restaurant — same shape, same check
        if (r.backup && typeof r.backup === "object" && Array.isArray(r.backup.open_days) && r.backup.open_days.length > 0 && !isOpenOnWeekday(r.backup, weekday)) {
          // Deep-clone the backup before mutating so we don't poison shared refs
          r.backup = { ...r.backup, _weekdayMismatch: weekday };
          warnings.push(`Day ${dayIdx + 1} ${mealLabel}: backup ${r.backup.name || "restaurant"} may also be closed ${DAY_LABELS_3[weekday]}s`);
        }
      });
    });
  }

  // 1c. MEAL POLICY enforcement (structural, post-LLM).
  //     The planner is told (see MEAL POLICY in the prompt) that Breakfast,
  //     Brunch, and Lunch are opt-in only. The model still sometimes ignores
  //     this. Strip those meal items here UNLESS the user explicitly named
  //     the meal ("breakfast at X", "lunch on Day 3", "brunch Sunday") or a
  //     known breakfast/lunch venue. Hotel breakfast included with the room
  //     does NOT count.
  if (Array.isArray(days)) {
    const blob = `${inputs?.narrative || ""}\n${inputs?.guidelines || ""}\n${inputs?.dining || ""}`.toLowerCase();
    // Detect explicit asks. "casual lunches" / "light breakfasts" as a vibe
    // note does NOT count — we look for verbs of intent (book, reserve, want,
    // schedule, plan) OR a specific named venue paired with the meal word.
    const explicitBreakfast =
      /\b(book|reserve|plan|schedule|want|need|include|add)\b[^.]{0,40}\b(breakfast|brunch)\b/.test(blob) ||
      /\b(breakfast|brunch)\b[^.]{0,40}\b(at|in|reservation|book|reserve)\b/.test(blob) ||
      /\bbreakfast at \w/.test(blob) ||
      /\bbrunch at \w/.test(blob) ||
      /\bbrunch on (sun|mon|tue|wed|thu|fri|sat)/.test(blob);
    const explicitLunch =
      /\b(book|reserve|plan|schedule|want|need|include|add)\b[^.]{0,40}\blunch\b/.test(blob) ||
      /\blunch\b[^.]{0,40}\b(at|in|reservation|book|reserve)\b/.test(blob) ||
      /\blunch at \w/.test(blob) ||
      /\blunch on (day\s*\d|sun|mon|tue|wed|thu|fri|sat)/.test(blob);
    days.forEach((day, dayIdx) => {
      if (!Array.isArray(day.items)) return;
      day.items = day.items.filter(item => {
        const t = (item.type || "").toLowerCase();
        if ((t === "breakfast" || t === "brunch") && !explicitBreakfast) {
          fixes.push(`Day ${dayIdx + 1}: removed unrequested ${t} (${item.restaurant?.name || item.title || "meal"}) per meal policy`);
          return false;
        }
        if (t === "lunch" && !explicitLunch) {
          fixes.push(`Day ${dayIdx + 1}: removed unrequested lunch (${item.restaurant?.name || item.title || "meal"}) per meal policy`);
          return false;
        }
        return true;
      });
    });
  }

  // 1d. Dinner backup enforcement. Every Dinner item must carry a backup
  //     restaurant (same shape) so the traveler has a fallback if the
  //     reservation falls through. The planner is instructed to populate
  //     it, but enforce it here — flag any dinner missing a backup with a
  //     visible warning chip so the user knows to ask for one.
  if (Array.isArray(days)) {
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        if (!/^Dinner$/i.test(item.type || "")) return;
        const r = item.restaurant;
        if (!r) return;
        const hasBackup = r.backup && typeof r.backup === "object" && r.backup.name && String(r.backup.name).trim();
        if (!hasBackup) {
          r._missingBackup = true;
          warnings.push(`Day ${dayIdx + 1} dinner: ${r.name || "restaurant"} has no backup — add a same-tier fallback in the same neighborhood`);
        }
      });
    });
  }

  // 2. Flight verify-microcopy: if note doesn't end with the verify sentence, append it (model+renderer defense layered).
  if (Array.isArray(days)) {
    const VERIFY = "Verify flight number, times and equipment at booking — schedules change.";
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        if (item.type === "Flight" && item.flight) {
          const note = item.flight.confirmation_note || "";
          if (!/verify/i.test(note)) {
            // Ensure clean sentence boundary before appending.
            const trimmed = note.trim();
            const needsPeriod = trimmed && !/[.!?]$/.test(trimmed);
            item.flight.confirmation_note = trimmed
              ? `${trimmed}${needsPeriod ? "." : ""} ${VERIFY}`
              : VERIFY;
            // Mark so the renderer can keep the amber banner styling for emphasis.
            item.flight._verifyAppended = true;
            fixes.push(`Appended verify-at-booking microcopy to Day ${dayIdx + 1} flight`);
          }
        }
      });
    });
  }

  // 2b. UNIVERSAL flight-number strip. Logic lives in src/flightNumberStrip.js
  // (the single source of truth, tested in tests/test_flight_number_strip.mjs).
  // Importing here instead of duplicating prevents drift between the inline
  // block and the extracted helper — the past history where they diverged and
  // tests passed while production broke.
  {
    const { days: stripped, fixes: sFixes } = applyFlightNumberStrip(days, inputs);
    days = stripped;
    fixes.push(...sFixes);
  }

  // 2c. KNOWN_NONSTOPS carrier-correction (route-specific bonus layer). If the
  // model also got the carrier wrong on a route we know about, fix it. This
  // runs AFTER the universal number strip, so flight_number is already null.
  if (Array.isArray(days)) {
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        if (item.type !== "Flight" || !item.flight) return;
        const f = item.flight;
        if (f.nonstop === false) return; // model already says connecting, trust it
        const key = routeKey(f.from_airport, f.to_airport);
        if (!key || !KNOWN_NONSTOPS[key]) return;
        const known = KNOWN_NONSTOPS[key];
        if (carrierMatchesKnown(f.carrier, known)) return; // carrier is legit for this route

        // Mismatch — rewrite.
        const claimedCarrier = f.carrier || "the listed carrier";
        const allCorrect = known.slice(0, 3);
        f._originalCarrier = f.carrier;
        f._originalConfirmationNote = f.confirmation_note;
        f.carrier = allCorrect.length > 1 ? allCorrect.join(" or ") : allCorrect[0];
        f._carrierOverride = true;
        const VERIFY_SENT = "Verify flight number, times and equipment at booking — schedules change.";
        f.confirmation_note = `Book directly with ${allCorrect[0]}. ${VERIFY_SENT}`;
        item.flags = Array.isArray(item.flags) ? item.flags.slice() : [];
        const operators = allCorrect.length > 1 ? `${allCorrect.join(" / ")} are the` : `${allCorrect[0]} is the`;
        item.flags.push(`Carrier corrected: ${claimedCarrier} does not operate a nonstop ${f.from_airport}→${f.to_airport}. ${operators} actual nonstop operator${allCorrect.length > 1 ? "s" : ""}.`);
        fixes.push(`Day ${dayIdx + 1} flight: corrected carrier (${claimedCarrier} → ${f.carrier}) for ${f.from_airport}→${f.to_airport}`);
      });
    });
  }

  // 2d. ARRIVAL AIRPORT VALIDATION. The model frequently picks a big hub (BOS,
  // SFO, MIA) when a much closer regional airport exists (BHB for Bar Harbor,
  // STS for Sonoma, EYW for Key West). Cross-check the destination against the
  // curated DEST_AIRPORTS map. If the model's pick isn't the top choice, ADD a
  // visible flag listing the better option — we do NOT silently rewrite the
  // airport because that would invalidate the rest of the itinerary (timing,
  // ground transport, etc). The user sees the suggestion and decides.
  if (Array.isArray(days) && inputs) {
    const cities = Array.isArray(inputs?.basics?.cities) ? inputs.basics.cities : [];
    const destStrings = cities.length
      ? cities.map(c => c?.name).filter(Boolean)
      : [inputs?.basics?.destination].filter(Boolean);
    if (destStrings.length) {
      days.forEach((day, dayIdx) => {
        (day.items || []).forEach(item => {
          if (item.type !== "Flight" || !item.flight) return;
          const f = item.flight;
          // Try to figure out which destination this flight is heading INTO.
          // The day.city field, when present, is most reliable. Otherwise we
          // pick the destination whose curated airport list contains the
          // flight's to_airport — if none match, the model's pick is suspect.
          const arrCity = day.city || null;
          const candidates = arrCity
            ? [arrCity]
            : destStrings;
          for (const c of candidates) {
            const lookup = lookupDestAirports(c);
            if (!lookup) continue;
            const top = lookup.airports[0];
            const validIatas = lookup.airports.map(a => a.iata.toUpperCase());
            const pick = (f.to_airport || "").toUpperCase();
            if (!pick) continue;
            // Skip departures FROM this city (returning home). We only validate
            // arrivals into the destination.
            if ((f.from_airport || "").toUpperCase() === pick) continue;
            // If the model's pick isn't in our curated list at all, surface it.
            if (!validIatas.includes(pick)) {
              item.flags = Array.isArray(item.flags) ? item.flags.slice() : [];
              item.flags.push(`Closer airport available for ${c}: ${top.iata} (${top.name}) — ${top.drive} from ${c}. App suggests checking ${top.iata} instead of ${pick}.`);
              fixes.push(`Day ${dayIdx + 1} flight: flagged ${pick} — ${top.iata} is closer to ${c}`);
              f._airportSuspect = true;
              f._airportSuggestion = top;
              break;
            }
            // If the model picked a fallback when the top choice exists, surface it too
            // (e.g. BOS when BHB or BGR is the right call).
            const pickIndex = validIatas.indexOf(pick);
            if (pickIndex > 0) {
              item.flags = Array.isArray(item.flags) ? item.flags.slice() : [];
              const closer = lookup.airports.slice(0, pickIndex);
              const closerList = closer.map(a => `${a.iata} (${a.drive})`).join(", ");
              item.flags.push(`Closer airport available for ${c}: ${closerList}. App suggests ${top.iata} — ${top.note}. Current pick ${pick} is ${lookup.airports[pickIndex].drive} away.`);
              fixes.push(`Day ${dayIdx + 1} flight: flagged ${pick} — ${top.iata} is closer to ${c}`);
              f._airportSuspect = true;
              f._airportSuggestion = top;
              break;
            }
            // pickIndex === 0 — model got the top choice. Nothing to flag.
            break;
          }
        });
      });
    }
  }

  // 2.4 CLOSURE GATE — strip restaurants on the CLOSED_RESTAURANTS denylist
  // and substitute the model's backup. This is the actual fix for the
  // Husk Greenville incident: the Verify chip below is a polite warning, but
  // a recommendation that has been closed for years should NEVER reach the
  // user as a primary card. If the closure-matched restaurant has a backup
  // we know to be in a different name slot, we promote that backup to be the
  // new primary. If no backup, we leave the item but tag the restaurant with
  // verify_status="permanently_closed" so the renderer can hide the menu and
  // surface a hard red banner instead of the soft amber chip. Every removal
  // also emits a QC fix so the user sees the substitution was deliberate.
  const cityHaystack = buildCityHaystack(inputs);
  if (Array.isArray(days) && cityHaystack) {
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        const r = item.restaurant;
        if (!r || !r.name) return;
        const match = findClosedRestaurantMatch(r.name, cityHaystack);
        if (!match) return;
        const dayLabel = `Day ${dayIdx + 1}`;
        const mealLabel = (item.type || "meal").toLowerCase();
        const closedSrc = match.source ? ` (${match.source})` : "";
        const closedWhen = match.closed ? ` closed ${match.closed}` : "";
        if (r.backup && r.backup.name && !findClosedRestaurantMatch(r.backup.name, cityHaystack)) {
          // Promote the backup to be the new primary. Move the original
          // backup fields up. Note explicitly in why so the traveler
          // understands the substitution.
          const removedName = r.name;
          const promoted = r.backup;
          // Carry over fields the backup typically lacks. Don't overwrite
          // backup-provided values — the backup is its own restaurant.
          item.restaurant = {
            name: promoted.name,
            neighborhood: promoted.neighborhood || r.neighborhood,
            cuisine: promoted.cuisine || r.cuisine,
            price_range: promoted.price_range || r.price_range,
            why: `Substituted in place of ${removedName} —${closedWhen}. ${promoted.why || ""}`.trim(),
            closure_note: promoted.closure_note || "",
            reservation: promoted.reservation || r.reservation,
            menu: promoted.menu || null,
            backup: null, // backup-of-backup is too thin to trust
            verify_status: "verify_before_booking",
            verify_url: promoted.verify_url || "", // filled by 2.5 below
          };
          fixes.push(`Removed ${removedName} (${dayLabel} ${mealLabel}) —${closedWhen}. Substituted ${promoted.name} from your backup slot.${closedSrc}`);
        } else {
          // No usable backup. Don't fabricate a replacement — instead flag
          // the restaurant as permanently closed so the renderer can show a
          // hard red banner and the user knows to pick their own spot.
          r.verify_status = "permanently_closed";
          r.closure_note = `Reported permanently closed${closedWhen}. Pick a different spot before the trip.`;
          warnings.push(`${r.name} (${dayLabel} ${mealLabel}) is reported permanently closed${closedWhen} — we left it in place so you can see what to replace, but it must NOT be booked. No backup was supplied; please pick a different restaurant.${closedSrc}`);
        }
      });
    });
  }

  // 2.5 Restaurant freshness defaulter — if the model omitted verify_status,
  // default to the conservative "verify_before_booking" so the verify chip
  // shows on the card. We err on the side of asking the traveler to confirm
  // rather than blindly trusting a stale recommendation. Also propagate the
  // same default to backup restaurants.
  //
  // Belt-and-suspenders: also backfill verify_url with a Google Maps search
  // link when the model omits it. The prompt marks verify_url MANDATORY but
  // live observation shows the model still skips it on ~half of cards, which
  // leaves the amber Verify chip without its tappable "Check listing →" CTA.
  // The Google Maps search URL is universal, never 404s, and lets the
  // traveler confirm hours/status with one tap — far better than no link.
  const verifyCityHint = (() => {
    const parts = [];
    if (inputs?.destination) parts.push(String(inputs.destination));
    if (Array.isArray(inputs?.cities)) {
      inputs.cities.forEach(c => { if (c?.name) parts.push(String(c.name)); });
    }
    // Take the first non-empty token-ish chunk to keep the URL short and
    // unambiguous (the destination string itself is usually "Greenville, SC").
    return parts[0] || "";
  })();
  const buildMapsUrl = (name, neighborhood) => {
    if (!name) return "";
    const queryParts = [name];
    if (neighborhood) queryParts.push(neighborhood);
    if (verifyCityHint) queryParts.push(verifyCityHint);
    const q = queryParts.join(" ").replace(/\s+/g, " ").trim();
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  };
  if (Array.isArray(days)) {
    days.forEach(day => {
      (day.items || []).forEach(item => {
        const r = item.restaurant;
        if (r && r.name) {
          if (!r.verify_status) r.verify_status = "verify_before_booking";
          if (!r.verify_url) {
            r.verify_url = buildMapsUrl(r.name, r.neighborhood);
          }
          if (r.backup && r.backup.name) {
            if (!r.backup.verify_status) r.backup.verify_status = "verify_before_booking";
            if (!r.backup.verify_url) {
              r.backup.verify_url = buildMapsUrl(r.backup.name, r.backup.neighborhood || r.neighborhood);
            }
          }
        }
      });
    });
  }

  // 2.6 Marquee coverage check — every destination has a handful of iconic
  // sights any first-time visitor expects to see. The system prompt forces
  // the model to schedule them, but we double-check here and surface a
  // warning if the canonical marquee for a known destination is absent
  // from the days[] item names/headlines. This catches misses like
  // recommending Greenville without Falls Park / Swamp Rabbit Trail.
  //
  // The table is intentionally small — only destinations where a single
  // missing sight would be obviously wrong to a local. Each entry pairs
  // a destination-name substring with required keyword groups: each group
  // must match at least one keyword somewhere in days[].items[].name or
  // day.headline or top-level destination notes.
  const MARQUEE_REQUIRED = [
    { match: /\bgreenville\b.*\bsc\b|\bgreenville,?\s*sc\b/i, groups: [
      ["falls park", "liberty bridge", "reedy river"],
      ["swamp rabbit", "swamp-rabbit"],
    ]},
    { match: /\basheville\b/i, groups: [
      ["biltmore"],
      ["blue ridge parkway", "parkway"],
    ]},
    { match: /\bcharleston\b/i, groups: [
      ["battery", "rainbow row"],
    ]},
    { match: /\bsavannah\b/i, groups: [
      ["forsyth", "historic district", "squares"],
    ]},
    { match: /\bnashville\b/i, groups: [
      ["country music", "ryman", "opry"],
    ]},
    { match: /\bsanta\s*fe\b/i, groups: [
      ["o'keeffe", "okeeffe", "o\u2019keeffe"],
      ["canyon road", "plaza", "bandelier", "tent rocks"],
    ]},
    { match: /\bsedona\b/i, groups: [
      ["cathedral rock", "bell rock", "chapel of the holy cross"],
    ]},
    { match: /\bbozeman\b/i, groups: [
      ["museum of the rockies", "hyalite", "bridger", "big sky"],
    ]},
    { match: /\bjackson\b.*\bwy\b|\bjackson hole\b|\bgrand teton\b/i, groups: [
      ["grand teton", "snake river", "schwabacher"],
    ]},
    { match: /\baspen\b/i, groups: [
      ["maroon bells", "aspen mountain", "gondola"],
    ]},
    { match: /\bvenice\b/i, groups: [
      ["doge", "st. mark", "saint mark", "san marco"],
      ["gondola", "rialto"],
    ]},
    { match: /\brome\b/i, groups: [
      ["vatican", "sistine"],
      ["colosseum", "forum"],
    ]},
    { match: /\bflorence\b/i, groups: [
      ["uffizi", "accademia", "david"],
      ["duomo", "brunelleschi"],
    ]},
    { match: /\bparis\b/i, groups: [
      ["louvre", "orsay", "eiffel"],
    ]},
    { match: /\bbarcelona\b/i, groups: [
      ["sagrada"],
      ["park g\u00fcell", "park guell", "casa batll\u00f3", "casa batllo"],
    ]},
    { match: /\bgranada\b/i, groups: [
      ["alhambra"],
    ]},
    { match: /\bamsterdam\b/i, groups: [
      ["rijksmuseum", "van gogh", "anne frank"],
    ]},
    { match: /\bathens\b/i, groups: [
      ["acropolis"],
    ]},
    { match: /\bistanbul\b/i, groups: [
      ["hagia sophia", "blue mosque", "topkap"],
    ]},
    { match: /\btokyo\b/i, groups: [
      ["senso", "meiji", "shibuya", "shinjuku", "teamlab"],
    ]},
    { match: /\bkyoto\b/i, groups: [
      ["fushimi", "kinkaku", "arashiyama", "gion"],
    ]},
  ];

  // Combine destination + all city names (multi-city trips put per-city info
  // in inputs.cities[].name) so the matcher fires even when only the joined
  // arrow string is missing a particular substring.
  const destStr = (() => {
    const parts = [inputs?.destination, inputs?.destinations];
    if (Array.isArray(inputs?.cities)) {
      inputs.cities.forEach(c => { if (c?.name) parts.push(c.name); });
    }
    return parts.filter(Boolean).join(" ").toLowerCase();
  })();
  if (destStr && Array.isArray(days)) {
    // Flatten every text surface the model might have put a marquee mention into:
    // day headlines, item names, item notes, snobs guide, etc.
    const haystack = (() => {
      const parts = [];
      days.forEach(d => {
        if (d.headline) parts.push(String(d.headline));
        if (d.weather) parts.push(String(d.weather));
        (d.items || []).forEach(it => {
          if (it.name) parts.push(String(it.name));
          if (it.notes) parts.push(String(it.notes));
          if (it.location) parts.push(String(it.location));
        });
      });
      if (Array.isArray(input.snobs)) parts.push(input.snobs.join(" "));
      if (Array.isArray(input.flags)) parts.push(input.flags.join(" "));
      return parts.join(" ").toLowerCase();
    })();
    for (const rule of MARQUEE_REQUIRED) {
      if (!rule.match.test(destStr)) continue;
      const missing = [];
      for (const group of rule.groups) {
        const hit = group.some(kw => haystack.includes(kw.toLowerCase()));
        if (!hit) missing.push(group[0]);
      }
      if (missing.length) {
        warnings.push(`Marquee sight not scheduled: ${missing.join(", ")} — this is iconic to the destination and should appear on the itinerary. Tap Expert Review to add it.`);
      }
    }
  }

  // 3. Validators — surface as warnings, never block render.
  // Truncation / partial-plan flags propagated from the parse layer get top
  // billing so the user knows the itinerary they're looking at is incomplete.
  if (input._truncated) {
    // _truncationCause is set when we have a definitive signal from
    // Anthropic's stop_reason. Without it we only know the JSON didn't
    // parse cleanly, which could be truncation OR a transient network drop
    // — "tap Build again" is the right hint for that case. With
    // 'max_tokens' we know retrying as-is won't help and can give
    // actionable guidance.
    if (input._truncationCause === "max_tokens") {
      warnings.push("Plan hit the model's token budget mid-output. Try fewer cities or a shorter trip, or split this into a multi-leg flow.");
    } else {
      warnings.push("Plan was cut off before finishing — some sections may be incomplete. Tap Build again for a full plan.");
    }
  }
  if (input._dayCountWarning) {
    warnings.push(input._dayCountWarning);
  }
  const planbLen = Array.isArray(input.planb) ? input.planb.length : 0;
  if (planbLen < 5) warnings.push(`Plan B has only ${planbLen} entries (expected ≥5)`);
  if (!input.weather_window) warnings.push("Missing weather_window summary");
  if (!Array.isArray(input.pack) || input.pack.length < 3) warnings.push("Pack list shorter than 3 items");
  if (Array.isArray(days)) {
    days.forEach((d, i) => {
      if (!d.headline) warnings.push(`Day ${i + 1} missing headline`);
      if (!d.weather) warnings.push(`Day ${i + 1} missing weather line`);
    });
  }

  // Activity-count cap enforcement (suspenders to the prompt-side belt at
  // dynamicPreamble's ACTIVITY-COUNT HARD CAP rule). If the user's narrative
  // or guidelines named a trip-total cap and the model emitted more than
  // that, trim the excess. Closes the recurrence reported 2026-06-30 PM
  // ("one activity during the entire itinerary" → model gave one per day).
  // See src/activityCountConstraint.js for the classifier + trimmer.
  const _activityCountConstraint = classifyActivityCountConstraint(inputs);
  let cappedDays = days;
  if (_activityCountConstraint.scope === "trip-total" && Array.isArray(days)) {
    const { days: trimmed, fixes: capFixes } = enforceTripTotalActivityCap(days, _activityCountConstraint.count);
    cappedDays = trimmed;
    if (capFixes.length > 0) {
      fixes.push(...capFixes);
    }
  }

  return { data: { ...input, days: cappedDays }, qc: { fixes, warnings } };
}

// Small QC chip surfaced below the trip — shows we caught and fixed something
// instead of silently letting it through. Hidden when there's nothing to say.
function QualityBadge({ qc }) {
  if (!qc || (qc.fixes.length === 0 && qc.warnings.length === 0)) return null;
  return (
    <div style={{ marginTop: "1rem", marginBottom: "1.25rem", padding: "10px 12px", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary)" }}>
      <p style={{ fontSize: "10px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 6px" }}>Quality check</p>
      {qc.fixes.length > 0 && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "0 0 4px", lineHeight: 1.5 }}>
          ✓ Auto-fixed {qc.fixes.length} item{qc.fixes.length === 1 ? "" : "s"}: {qc.fixes.slice(0, 2).join("; ")}{qc.fixes.length > 2 ? `; +${qc.fixes.length - 2} more` : ""}.
        </p>
      )}
      {qc.warnings.length > 0 && (
        <p style={{ fontSize: "11.5px", color: "var(--color-warning)", margin: 0, lineHeight: 1.5 }}>
          ⚠︎ {qc.warnings.length} warning{qc.warnings.length === 1 ? "" : "s"}: {qc.warnings.slice(0, 2).join("; ")}{qc.warnings.length > 2 ? `; +${qc.warnings.length - 2} more` : ""}.
        </p>
      )}
    </div>
  );
}

// PDF / Print: triggers the OS print dialog. On iOS Chrome this opens the
// share sheet → 'Print' or 'Save as PDF'. On desktop it opens the native
// print dialog with PDF option. Zero new dependencies.
// Saved-trips storage. Keeps up to MAX_SAVED most recent trips in localStorage.
// Each entry: { id, name, savedAt (ISO), inputs, result }.
const SAVED_TRIPS_KEY = "trip-optimizer-saved-v2";
const MAX_SAVED = 12;
function loadSavedTrips() {
  try {
    const raw = localStorage.getItem(SAVED_TRIPS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeSavedTrips(arr) {
  try { localStorage.setItem(SAVED_TRIPS_KEY, JSON.stringify(arr.slice(0, MAX_SAVED))); } catch {}
}
function makeTripId() {
  return "trip_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}
function defaultTripName(inputs, result) {
  const dest = result?.destination || inputs?.basics?.destination || "Trip";
  const start = inputs?.basics?.startDate;
  const monthDay = start ? new Date(start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  return monthDay ? `${dest} · ${monthDay}` : dest;
}

// SaveTripButton — prompts for a name, persists trip, calls onSaved with the saved entry.
function SaveTripButton({ inputs, result, onSaved }) {
  const [justSaved, setJustSaved] = useState(false);
  const handleClick = () => {
    const fallback = defaultTripName(inputs, result);
    const name = (typeof window !== "undefined" && window.prompt) ? (window.prompt("Name this trip", fallback) || fallback) : fallback;
    const entry = { id: makeTripId(), name: name.trim() || fallback, savedAt: new Date().toISOString(), inputs, result };
    const existing = loadSavedTrips();
    writeSavedTrips([entry, ...existing]);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2200);
    if (typeof onSaved === "function") onSaved(entry);
  };
  return (
    <button
      onClick={handleClick}
      className="no-print"
      style={{
        background: justSaved ? GOLD : "var(--color-background-primary)",
        color: justSaved ? "var(--color-text-primary)" : "var(--color-text-primary)",
        border: `0.5px solid ${justSaved ? GOLD : "var(--color-border-secondary)"}`,
        borderRadius: "var(--border-radius-md)",
        padding: "10px 16px",
        fontSize: "11px",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        cursor: "pointer",
        fontFamily: "inherit",
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        transition: "background 200ms ease",
      }}
      aria-label="Save this trip"
    >
      <span aria-hidden="true">{justSaved ? "✓" : "☆"}</span> {justSaved ? "Saved" : "Save trip"}
    </button>
  );
}

// SavedTripsPanel — shown above the form on step 1 when at least one trip exists.
// Each row: name, route summary, savedAt, [Open] [×].
function SavedTripsPanel({ trips, onOpen, onDelete }) {
  if (!trips || trips.length === 0) return null;
  return (
    <div style={{ marginBottom: "1.25rem", border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", padding: "14px 16px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
        <p style={{ fontSize: "10.5px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: 0 }}>Saved trips</p>
        <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: 0 }}>{trips.length} saved</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
        {trips.map((t, i) => {
          const dest = t.result?.destination || t.inputs?.basics?.destination || "—";
          const start = t.inputs?.basics?.startDate;
          const nights = t.inputs?.basics?.nights;
          const meta = [
            start ? new Date(start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null,
            nights ? `${nights} nights` : null,
          ].filter(Boolean).join(" · ");
          const savedAgo = new Date(t.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderTop: i > 0 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "13.5px", color: "var(--color-text-primary)", margin: "0 0 2px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</p>
                <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: 0 }}>{dest !== t.name ? `${dest} · ` : ""}{meta || `saved ${savedAgo}`}</p>
              </div>
              <button onClick={() => onOpen(t)} style={{ background: "var(--color-text-primary)", color: "var(--color-background-primary)", border: "none", borderRadius: "var(--border-radius-md)", padding: "7px 12px", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>Open</button>
              <button onClick={() => onDelete(t.id)} aria-label={`Delete ${t.name}`} style={{ background: "none", border: "none", color: "var(--color-text-tertiary)", fontSize: "18px", cursor: "pointer", padding: "4px 6px", lineHeight: 1 }}>×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// StaleChipsBanner — warns when the user has chips lingering from a previous
// destination and offers a one-tap clear. Non-blocking; dismissible.
function StaleChipsBanner({ suggestion, onClear, onDismiss }) {
  if (!suggestion) return null;
  const total = (suggestion.staleRestaurants?.length || 0) + (suggestion.staleActivities?.length || 0);
  if (total === 0) return null;
  const items = [
    ...(suggestion.staleRestaurants || []),
    ...(suggestion.staleActivities || []),
  ];
  return (
    <div role="status" style={{ marginBottom: "1.25rem", border: "0.5px solid var(--color-warning)", background: "var(--color-warning-tint)", borderRadius: "var(--border-radius-md)", padding: "12px 14px" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
        <span aria-hidden="true" style={{ fontSize: "14px", color: "var(--color-warning)", marginTop: "1px" }}>⚠︎</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: "11px", color: "var(--color-text-primary)", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 4px" }}>Destination changed</p>
          <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 8px", lineHeight: 1.5 }}>
            {total} pick{total === 1 ? "" : "s"} from {suggestion.prevLabel} {total === 1 ? "is" : "are"} still selected for {suggestion.newLabel || "your new destination"}.
          </p>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
            {items.map((it, i) => (
              <span key={i} style={{ fontSize: "11px", background: "var(--color-warning-tint)", border: "0.5px solid var(--color-border-secondary)", color: "var(--color-text-primary)", borderRadius: "3px", padding: "3px 7px" }}>{it}</span>
            ))}
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button onClick={onClear} style={{ background: "var(--color-warning)", color: "var(--color-background-primary)", border: "none", borderRadius: "var(--border-radius-md)", padding: "7px 12px", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Clear those picks</button>
            <button onClick={onDismiss} style={{ background: "transparent", color: "var(--color-text-primary)", border: "0.5px solid var(--color-warning)", borderRadius: "var(--border-radius-md)", padding: "7px 12px", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Keep them</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Build a clean filename from trip basics: "trip-YYYY-MM-DD-destination-Nn.pdf".
function pdfFilename(data) {
  const dest = (data?.destination || (Array.isArray(data?.cities) && data.cities[0]?.name) || "trip").toString();
  const slug = dest.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "trip";
  const date = (data?.start_date || data?.startDate || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
  const n = data?.nights ? `-${data.nights}n` : "";
  return `trip-${date}-${slug}${n}.pdf`;
}

// Convert a Blob/Response to a data URL (needed for jsPDF.addImage).
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Build a polished, vector itinerary PDF from the trip plan data.
// This is a purpose-built print template (NOT an html2canvas screenshot) —
// sharp typography, hyperlinks (phones, addresses, booking URLs), proper
// page breaks, and a clean editorial layout. The legacy DOM-screenshot path
// is preserved below as a fallback for the unlikely case the new builder
// throws on malformed data.
async function saveItineraryAsPDF(filename, setStatus, { data, inputs, providers } = {}) {
  setStatus("Preparing…");
  // Pre-export gate — see CLAUDE.md "VENUE VERIFICATION — HARD RULE".
  // Block PDF generation if any venue still carries a severity:'block'
  // flag (CLOSED_PERMANENTLY / CLOSED_TEMPORARILY / NOT_FOUND). The merge
  // helper drops these in normal flow; this gate is the last line of
  // defense against bypassed-merge code paths or future regressions.
  if (data && Array.isArray(data.days)) {
    const blockingIssues = findBlockingIssues(data);
    if (blockingIssues.length > 0) {
      const summary = blockingIssues
        .slice(0, 5)
        .map((iss) => `Day ${iss.dayIdx + 1}: ${iss.name} (${iss.flag.code})`)
        .join("; ");
      const more = blockingIssues.length > 5 ? ` … and ${blockingIssues.length - 5} more` : "";
      const err = new Error(
        `Cannot export: ${blockingIssues.length} venue${blockingIssues.length === 1 ? "" : "s"} failed verification — ${summary}${more}. Re-run the build or remove the affected items before exporting.`
      );
      err.code = "VERIFICATION_BLOCK";
      err.issues = blockingIssues;
      throw err;
    }
  }
  // Prefer the rich template when we have structured plan data.
  if (data && Array.isArray(data.days) && data.days.length > 0) {
    try {
      const { buildItineraryPdf } = await import("./pdf/itineraryPdf.js");
      const buildId = (typeof __BUILD_ID__ !== "undefined" && __BUILD_ID__) ? String(__BUILD_ID__) : "";

      // Fetch a destination photo for the cover page hero.
      // Runs in parallel with the module warm-up; silently skipped if unavailable.
      let coverPhoto = null;
      const destination = data?.destination ||
        (Array.isArray(data?.cities) && data.cities[0]?.name) || "";
      if (destination) {
        setStatus("Fetching cover photo…");
        try {
          const photoRes = await fetch(
            `/api/destination-photo?destination=${encodeURIComponent(destination)}`
          );
          if (photoRes.ok) {
            coverPhoto = await blobToDataUrl(await photoRes.blob());
          }
        } catch { /* photo is non-critical; silently skip */ }
      }

      setStatus("Composing pages…");
      const pdf = await buildItineraryPdf(data, inputs, { setStatus, buildId, providers, coverPhoto });
      setStatus("Saving…");
      pdf.save(filename);
      return;
    } catch (err) {
      // Fall through to the DOM-screenshot fallback so the user still gets
      // *something* if the template hits an unexpected data shape.
      console.warn("Vector PDF builder failed, falling back to DOM capture", err);
    }
  }
  await saveItineraryAsPDF_LegacyDom(filename, setStatus);
}

// Legacy DOM-screenshot fallback. Used only when the vector template fails.
async function saveItineraryAsPDF_LegacyDom(filename, setStatus) {
  const root = document.getElementById("trip-print-root");
  if (!root) throw new Error("Itinerary container not found");

  // Reveal the print-only input summary, hide no-print controls during capture.
  const printOnly = Array.from(root.querySelectorAll(".print-only"));
  const noPrint = Array.from(root.querySelectorAll(".no-print"));
  const prevPrintOnly = printOnly.map(el => el.style.display);
  const prevNoPrint = noPrint.map(el => el.style.display);
  printOnly.forEach(el => { el.style.display = "block"; });
  noPrint.forEach(el => { el.style.display = "none"; });
  const prevBg = root.style.background;
  root.style.background = "#ffffff";

  try {
    const [{ default: html2canvas }, jsPDFModule] = await Promise.all([
      import("html2canvas-pro"),
      import("jspdf"),
    ]);
    const { jsPDF } = jsPDFModule;

    setStatus("Rendering…");
    const canvas = await html2canvas(root, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      windowWidth: Math.max(root.scrollWidth, 800),
    });

    setStatus("Building PDF…");
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;

    const imgW = usableW;
    const imgH = (canvas.height * imgW) / canvas.width;

    if (imgH <= usableH) {
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, imgW, imgH, undefined, "FAST");
    } else {
      const pxPerMm = canvas.width / imgW;
      const pageSliceHpx = Math.floor(usableH * pxPerMm);
      let yPx = 0;
      let pageIndex = 0;
      while (yPx < canvas.height) {
        const sliceHpx = Math.min(pageSliceHpx, canvas.height - yPx);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = sliceHpx;
        const ctx = slice.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, yPx, canvas.width, sliceHpx, 0, 0, canvas.width, sliceHpx);
        const sliceImgH = sliceHpx / pxPerMm;
        if (pageIndex > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL("image/jpeg", 0.9), "JPEG", margin, margin, imgW, sliceImgH, undefined, "FAST");
        yPx += sliceHpx;
        pageIndex++;
      }
    }

    setStatus("Saving…");
    pdf.save(filename);
  } finally {
    printOnly.forEach((el, i) => { el.style.display = prevPrintOnly[i]; });
    noPrint.forEach((el, i) => { el.style.display = prevNoPrint[i]; });
    root.style.background = prevBg;
  }
}

// Detect the specific failure where a dynamic import resolves to a chunk hash
// that's no longer in the current deploy. The user's open tab is running stale
// HTML referencing an old hash. We need to refresh the shell, but doing so
// would wipe any in-memory itinerary the user hasn't saved — so we DON'T
// auto-reload. Instead we (a) unregister the SW + clear caches in the
// background so the *next* manual refresh is clean, and (b) surface a clear
// notice to the user with a one-click refresh button.
function isStaleChunkError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    msg.includes('error loading dynamically imported module') ||
    // Chromium also emits this when MIME-checking fails on a module
    msg.includes('Failed to load module script') ||
    msg.includes('strict MIME type checking')
  );
}
// Prepare a clean refresh without actually reloading. Safe to call multiple
// times. Returns once SW + caches are evicted; caller decides when to reload.
async function clearShellCaches() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* ignore */ }
  try {
    if ('caches' in window) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((k) => window.caches.delete(k)));
    }
  } catch { /* ignore */ }
}
function hardReloadNow() {
  const url = new window.URL(window.location.href);
  url.searchParams.set('_r', Date.now().toString(36));
  window.location.replace(url.toString());
}

function PrintButton({ data, inputs, providers, plan, introIsGenerating }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  // When the PDF lib chunk is missing from the current deploy, we surface a
  // refresh prompt instead of auto-reloading (which would lose unsaved work).
  const [stale, setStale] = useState(false);

  // Closes the PR #69 race: when the headless IntroductionAutoGenerator is
  // mid-flight, disable Save as PDF (with a clear "Preparing introduction…"
  // label) so the user can't ship a PDF with no intro page. Falls open the
  // moment the intro is populated OR the generator finishes/fails — a silent
  // /api/introduction failure must never permanently block the PDF.
  // `plan` is the source-of-truth rawData (introduction lives there via
  // onPlanRevised); falling back to `data` keeps any caller that doesn't
  // pass `plan` from regressing.
  const gate = isPdfDownloadReady({ plan: plan || data, isGenerating: introIsGenerating });
  const disabledForIntro = !gate.ready;

  const handleClick = async () => {
    if (busy || disabledForIntro) return;
    setBusy(true); setError(""); setStatus("Starting…");
    try {
      // The PDF's Local-providers section needs the data, but fetching is now
      // gated on tab-open — so force a load here (no-op if already loaded) and
      // hand the freshly-loaded results to the builder.
      let providersForPdf = providers;
      if (providers && typeof providers.ensureLoaded === "function") {
        const loaded = await providers.ensureLoaded();
        providersForPdf = { ...providers, byCategory: loaded || providers.byCategory };
      }
      await saveItineraryAsPDF(pdfFilename(data), setStatus, { data, inputs, providers: providersForPdf });
    } catch (err) {
      console.error("PDF save failed", err);
      if (isStaleChunkError(err)) {
        // App shell is stale — the PDF library chunk hash changed between
        // when this tab loaded and now. DO NOT auto-reload (would wipe the
        // in-memory itinerary). Instead: silently evict SW + caches so the
        // next manual refresh is clean, then show a refresh button. Tell
        // the user to Save Trip first if they haven't.
        clearShellCaches().catch(() => {});
        setStale(true);
        setError("");
      } else {
        setError("Could not save PDF. Try again.");
      }
    } finally {
      setBusy(false);
      setStatus("");
      if (!stale) setTimeout(() => setError(""), 5000);
    }
  };

  return (
    <div className="no-print" style={{ display: "inline-flex", flexDirection: "column", gap: "4px" }}>
      <button
        onClick={handleClick}
        disabled={busy || disabledForIntro}
        style={{
          background: "var(--color-text-primary)",
          color: "var(--color-background-primary)",
          border: "none",
          borderRadius: "var(--border-radius-md)",
          padding: "10px 16px",
          fontSize: "11px",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          cursor: (busy || disabledForIntro) ? "wait" : "pointer",
          fontFamily: "inherit",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          opacity: (busy || disabledForIntro) ? 0.7 : 1,
        }}
        aria-label={disabledForIntro ? gate.label : "Save itinerary as PDF"}
        aria-busy={disabledForIntro ? "true" : undefined}
      >
        <span aria-hidden="true">⤓</span> {busy ? (status || "Working…") : (disabledForIntro ? gate.label : "Save as PDF")}
      </button>
      {error && (
        <span style={{ fontSize: "11px", color: "var(--color-warning)" }}>{error}</span>
      )}
      {stale && (
        <div
          role="alert"
          style={{
            marginTop: "6px",
            padding: "10px 12px",
            border: "1px solid var(--color-border-secondary)",
            background: "rgba(91, 101, 119,0.08)",
            borderRadius: "var(--border-radius-md)",
            fontSize: "11px",
            color: "var(--color-text-primary)",
            lineHeight: 1.5,
            maxWidth: "320px",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "4px" }}>App update required for PDF</div>
          <div style={{ color: "var(--color-text-secondary)", marginBottom: "8px" }}>
            A newer build is live. Save your trip first (so it persists), then refresh to enable PDF save.
          </div>
          <button
            type="button"
            onClick={hardReloadNow}
            style={{
              background: "var(--color-text-primary)",
              color: "var(--color-background-primary)",
              border: "none",
              borderRadius: "var(--border-radius-md)",
              padding: "7px 12px",
              fontSize: "11px",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
              fontFamily: "inherit",
              fontWeight: 600,
            }}
          >
            Refresh now
          </button>
          <button
            type="button"
            onClick={() => setStale(false)}
            style={{
              marginLeft: "6px",
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "none",
              padding: "7px 8px",
              fontSize: "11px",
              cursor: "pointer",
              fontFamily: "inherit",
              textDecoration: "underline",
            }}
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}

// Print Rides: prints a clean single-page driver sheet listing every Transport
// item across the trip (airport meet-and-greet, inter-city legs, daily driver
// pickups). Designed to be shared with the driver / car-service operator. The
// itinerary's main render stays untouched — we mount a hidden printable block
// (#rides-print-root) and use a print stylesheet so window.print() captures
// ONLY that block. No PDF library required — native browser print dialog.
function collectRides(data) {
  const days = Array.isArray(data?.days) ? data.days : [];
  const rides = [];
  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const d = days[dayIdx];
    const items = Array.isArray(d?.items) ? d.items : [];
    for (const it of items) {
      if (it?.type !== "Transport") continue;
      rides.push({
        dayIndex: dayIdx,
        dayDate: d?.date || "",
        dayLabel: d?.title || `Day ${dayIdx + 1}`,
        city: d?.city || "",
        time: it.time || "",
        end_time: it.end_time || "",
        text: it.text || "",
        location: it.location || "",
        duration: it.duration || "",
        why: it.why || "",
        contact: it.contact || null,
      });
    }
  }
  return rides;
}

function PrintRidesButton({ data, inputs }) {
  const rides = useMemo(() => collectRides(data), [data]);
  if (!rides.length) return null;

  const passengerName = (inputs?.basics?.travelers || "Guest").trim();
  const tripTitle = (() => {
    if (Array.isArray(inputs?.basics?.cities) && inputs.basics.cities.length > 1) {
      return inputs.basics.cities.map(c => c.name).filter(Boolean).join(" → ");
    }
    return inputs?.basics?.destination || "Trip";
  })();
  const dateRange = (() => {
    const s = inputs?.basics?.startDate;
    const e = inputs?.basics?.endDate;
    if (s && e) return `${s} → ${e}`;
    if (s) return s;
    return "";
  })();

  const handlePrint = () => {
    // Toggle a body-level class that swaps print stylesheet to rides-only mode.
    document.body.classList.add("printing-rides");
    // Defer print() to next tick so the class transition + repaint settles.
    setTimeout(() => {
      try { window.print(); } catch {}
      // Remove the class on the next idle so the regular itinerary view returns.
      setTimeout(() => document.body.classList.remove("printing-rides"), 100);
    }, 50);
  };

  return (
    <>
      <button
        type="button"
        onClick={handlePrint}
        className="no-print"
        style={{
          background: "transparent",
          border: `0.5px solid ${GOLD}`,
          borderRadius: "var(--border-radius-md)",
          padding: "10px 16px",
          fontSize: "11px",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          cursor: "pointer",
          fontFamily: "inherit",
          color: GOLD,
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
        }}
        aria-label={`Print rides sheet for the driver (${rides.length} ride${rides.length === 1 ? "" : "s"})`}
        title={`Print a driver-ready sheet with ${rides.length} ride${rides.length === 1 ? "" : "s"}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9V2h12v7" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="8" />
        </svg>
        Print rides ({rides.length})
      </button>

      {/*
        Hidden printable block. CSS in index.html / global style swaps which
        section prints via `body.printing-rides`. We render it always (cheap)
        and let CSS hide/show it.
      */}
      <div id="rides-print-root" className="rides-print-only" aria-hidden="true">
        <div style={{ padding: "24px 28px", fontFamily: "Georgia, 'Times New Roman', serif", color: "var(--color-text-primary)" }}>
          <div style={{ borderBottom: `2px solid ${GOLD}`, paddingBottom: "10px", marginBottom: "18px" }}>
            <div style={{ fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-text-secondary)", marginBottom: "4px" }}>Driver itinerary — share with chauffeur</div>
            <div style={{ fontSize: "22px", fontStyle: "italic", marginBottom: "6px" }}>{tripTitle}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              Passenger: <strong>{passengerName}</strong>
              {dateRange ? ` · Dates: ${dateRange}` : ""}
              {rides.length ? ` · ${rides.length} ride${rides.length === 1 ? "" : "s"}` : ""}
            </div>
          </div>

          {rides.map((r, i) => (
            <div key={i} style={{ borderBottom: "1px solid var(--color-border-tertiary)", padding: "12px 0", pageBreakInside: "avoid" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px", marginBottom: "4px" }}>
                <div style={{ fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--color-text-secondary)", fontWeight: 700 }}>
                  Ride {i + 1} · {r.dayLabel}{r.city ? ` · ${r.city}` : ""}
                </div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: GOLD_DARK, letterSpacing: "0.02em" }}>
                  {formatTime(r.time)}{r.end_time ? ` – ${formatTime(r.end_time)}` : ""}
                </div>
              </div>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>{r.text || "Transport"}</div>
              {r.location && (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "3px" }}>
                  <strong>Pickup / route:</strong> {r.location}
                </div>
              )}
              {r.contact?.address && (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "3px" }}>
                  <strong>Address:</strong> {r.contact.address}
                </div>
              )}
              {r.duration && (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "3px" }}>
                  <strong>Duration:</strong> {r.duration}
                </div>
              )}
              {r.why && (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "3px", fontStyle: "italic" }}>{r.why}</div>
              )}
              {(r.contact?.phone || r.contact?.booking_note) && (
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "6px", borderLeft: `3px solid ${GOLD}`, paddingLeft: "8px" }}>
                  {r.contact?.phone && (<><strong>Operator phone:</strong> {r.contact.phone}<br /></>)}
                  {r.contact?.booking_note && (<><strong>Notes:</strong> {r.contact.booking_note}</>)}
                </div>
              )}
            </div>
          ))}

          <div style={{ marginTop: "22px", paddingTop: "12px", borderTop: `1px dashed ${GOLD}`, fontSize: "10.5px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
            <div><strong>Passenger:</strong> {passengerName}</div>
            <div style={{ marginTop: "3px" }}>Generated by Trip Optimizer — verify each pickup time + address with the driver 24 hours ahead. Times shown are local to the destination.</div>
          </div>
        </div>
      </div>
    </>
  );
}

// Input summary — shown ONLY in print output. Recaps the form inputs that
// produced this plan so the printed PDF is a complete record of inputs+output.
function InputSummary({ inputs }) {
  if (!inputs) return null;
  const { basics, flights, hotel, transport, dining, restaurants, activities, interests, guidelines, narrative, outputs } = inputs;
  const citiesText = Array.isArray(basics?.cities) && basics.cities.length > 1
    ? basics.cities.map((c, i) => `${i + 1}) ${c.name} — ${c.nights} ${Number(c.nights) === 1 ? "night" : "nights"}${c.focus ? ` (${c.focus})` : ""}`).join("   ")
    : null;
  const rows = [
    ["Destination", basics?.destination],
    ...(citiesText ? [["Route", citiesText]] : []),
    ["Base area", basics?.baseArea || "—"],
    ["Start date", basics?.startDate],
    ["Nights", basics?.nights],
    ["Travelers", basics?.travelers],
    ["Style", basics?.style],
    ["Pace", basics?.pace],
    ["Budget", Array.isArray(basics?.budget) ? (basics.budget.length ? basics.budget.join(", ") : "\u2014") : (basics?.budget || "\u2014")],
    ["Home airport", flights?.homeAirport],
    ["Preferred airline", flights?.airline || "—"],
    ["Cabin", flights?.cabin || "—"],
    ["Date flex", flights?.flex || "—"],
    ["Hotel brand", hotel?.brand || "—"],
    ["Hotel tier", hotel?.tier || "—"],
    ["Hotel must-have", hotel?.mustHave || "—"],
    ["Transport", transport?.type + (transport?.company ? ` · ${transport.company}` : "")],
    ["Vehicle", transport?.vehicle || "—"],
    ["Cuisine focus", dining?.cuisine || "—"],
    ["Dinner budget", Array.isArray(dining?.budget) ? (dining.budget.length ? dining.budget.join(", ") : "—") : (dining?.budget || "—")],
    ["Requested restaurants", (restaurants && restaurants.length) ? restaurants.join(", ") : "—"],
    ["Requested activities", (activities && activities.length) ? activities.join(", ") : "—"],
    ["Interest level", interests?.level || "—"],
    ["Interest detail", interests?.text || "—"],
    ["Trip guidelines", guidelines ? guidelines : "—"],
    ["Trip narrative", narrative ? narrative : "—"],
    ["Sections requested", outputs ? Object.entries(outputs).filter(([, v]) => v).map(([k]) => k).join(", ") : "—"],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");

  return (
    <div className="print-only" style={{ display: "none" }}>
      <h2 style={{ fontSize: "14px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-primary)", margin: "0 0 10px", borderBottom: "1px solid var(--color-border-tertiary)", paddingBottom: "6px" }}>Input summary</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "10.5px", marginBottom: "16px" }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
              <td style={{ padding: "4px 8px 4px 0", color: "var(--color-text-secondary)", verticalAlign: "top", width: "38%", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: "9px", fontWeight: 600 }}>{k}</td>
              <td style={{ padding: "4px 0", color: "var(--color-text-primary)" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "9px", color: "var(--color-text-tertiary)", margin: "0 0 20px", fontStyle: "italic" }}>Generated {new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · trip-optimizer-6og.pages.dev</p>
    </div>
  );
}

function TripHero({ data }) {
  // Pull flight + hotel summary directly from days[].
  const items = (data.days || []).flatMap(d => (d.items || []));
  const flights = items.filter(it => it.type === "Flight" && it.flight);
  const outbound = flights[0]?.flight;
  const inbound = flights[flights.length - 1]?.flight;
  const hotelItem = items.find(it => it.type === "Hotel" && it.hotel)?.hotel;
  const mealCount = items.filter(it => /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(it.type || "")).length;
  const activityCount = items.filter(it => it.type === "Activity").length;

  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: "600", margin: "0 0 6px" }}>Your trip</p>
      <p style={{ fontSize: "24px", fontWeight: "400", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 4px", color: "var(--color-text-primary)", letterSpacing: "-0.4px", lineHeight: 1.15 }}>{data.destination}</p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{data.meta}</p>

      {(outbound || hotelItem || mealCount > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "8px", marginBottom: "14px", padding: "12px 14px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary)" }}>
          {outbound && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Fly out</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{outbound.carrier} {outbound.flight_number} · {outbound.from_airport}→{outbound.to_airport} · {formatTime(outbound.depart_time)}</span>
            </div>
          )}
          {inbound && inbound !== outbound && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Return</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{inbound.carrier} {inbound.flight_number} · {inbound.from_airport}→{inbound.to_airport} · {formatTime(inbound.depart_time)}</span>
            </div>
          )}
          {hotelItem && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Stay</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{hotelItem.name}</span>
            </div>
          )}
          {(mealCount > 0 || activityCount > 0) && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Plan</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{mealCount} meals · {activityCount} activities · {(data.days || []).length} days</span>
            </div>
          )}
        </div>
      )}

      {Array.isArray(data.cities) && data.cities.length > 1 && (
        <div style={{ marginBottom: "14px", padding: "12px 14px", border: `1px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", background: "var(--color-background-primary)" }}>
          <p style={{ fontSize: "10px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 8px" }}>Trip route · {data.cities.length} cities</p>
          {data.cities.map((c, i) => (
            <div key={i} style={{ borderTop: i > 0 ? "0.5px solid var(--color-border-tertiary)" : "none", paddingTop: i > 0 ? "8px" : 0, marginTop: i > 0 ? "8px" : 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "baseline" }}>
                <span style={{ fontSize: "13.5px", color: "var(--color-text-primary)", fontWeight: 500 }}>
                  <span style={{ color: GOLD, fontWeight: 700, marginRight: "6px" }}>{i + 1}.</span>{c.name}
                </span>
                <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{c.nights} {Number(c.nights) === 1 ? "night" : "nights"}{c.days_range ? ` · ${c.days_range}` : ""}</span>
              </div>
              {c.transport_in && (
                <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "3px 0 0", lineHeight: 1.5 }}>→ {c.transport_in}</p>
              )}
              {c.focus && (
                <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "3px 0 0", lineHeight: 1.5, fontStyle: "italic" }}>{c.focus}</p>
              )}
              {c.stay && (
                <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "3px 0 0" }}>Stay: {c.stay}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {Array.isArray(data.logistics) && data.logistics.length > 0 && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {data.logistics.map((l, i) => (
            <span key={i} style={{ fontSize: "11.5px", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "4px 9px", color: "var(--color-text-secondary)" }}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}



// ============================================================================
// Section views — pulled-out cards by category for the tabbed layout.
// ----------------------------------------------------------------------------
// Each view flattens days[].items[] into a single category list. Items keep
// their day label so the user knows which day they belong to. Refs:
// santafejune.com (Dining / Activities tabs), zurich-weekend.com (Air & Hotel).
// ============================================================================

// Helper: short day label e.g. "Day 2 · Fri Jun 5" → "Fri Jun 5"
function dayShort(d, i) {
  const parts = (d?.label || "").split(" · ");
  return parts[1] || `Day ${i + 1}`;
}

// Flights view — all Flight items across all days, grouped by direction.
function FlightsView({ data }) {
  const flights = [];
  (data.days || []).forEach((d, di) => {
    (d.items || []).forEach((item) => {
      if (item.type === "Flight" && item.flight) {
        flights.push({ item, day: d, dayIndex: di });
      }
    });
  });
  if (flights.length === 0) {
    return (
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>
        No flights on this trip — you're driving or staying local.
      </p>
    );
  }
  return (
    <div>
      <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px" }}>Flights · {flights.length}</p>
      {flights.map(({ item, day, dayIndex }, i) => (
        <div key={i} style={{ marginBottom: "10px" }}>
          <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 4px", fontWeight: 600 }}>{dayShort(day, dayIndex)}</p>
          <FlightCard type={item.type} time={item.time} end_time={item.end_time} flight={item.flight} text={item.text} flags={item.flags} dayLabel={day?.label} onFlightConfirmed={(fl) => { const toT = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }) : undefined; Object.assign(item.flight, { flight_number: fl.flightNumber, depart_time: toT(fl.scheduledOut), arrive_time: toT(fl.scheduledIn), ...(fl.aircraft ? { aircraft: fl.aircraft } : {}) }); }} />
        </div>
      ))}
    </div>
  );
}

// Lodging view — all hotel items, grouped chronologically (multi-city trips
// have multiple hotels). Shows full hotel card with check-in/check-out + tel.
function LodgingView({ data }) {
  const hotels = [];
  const seen = new Set();
  (data.days || []).forEach((d, di) => {
    (d.items || []).forEach((item) => {
      if (item.type === "Hotel" && item.hotel) {
        const key = (item.hotel.name || "") + "|" + (item.hotel.address || "");
        if (!seen.has(key)) {
          seen.add(key);
          hotels.push({ item, day: d, dayIndex: di });
        }
      }
    });
  });
  if (hotels.length === 0) {
    return (
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>
        No lodging set yet.
      </p>
    );
  }
  return (
    <div>
      <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px" }}>Lodging · {hotels.length}</p>
      {hotels.map(({ item, day, dayIndex }, i) => (
        <div key={i} style={{ marginBottom: "10px" }}>
          <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 4px", fontWeight: 600 }}>From {dayShort(day, dayIndex)}</p>
          <HotelCard type={item.type} time={item.time} end_time={item.end_time} hotel={item.hotel} text={item.text} />
        </div>
      ))}
    </div>
  );
}

// Transport view — Transport items (drives, trains, transfers, car rentals).
// Renders a compact card with time + description + any contact info (rental
// agency phone, transfer service link).
function TransportView({ data }) {
  const transport = [];
  (data.days || []).forEach((d, di) => {
    (d.items || []).forEach((item) => {
      if (item.type === "Transport") {
        transport.push({ item, day: d, dayIndex: di });
      }
    });
  });
  if (transport.length === 0) {
    return (
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>
        No structured ground transport. Check the day-by-day for walks and short drives.
      </p>
    );
  }
  return (
    <div>
      <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px" }}>Ground transport · {transport.length}</p>
      {transport.map(({ item, day, dayIndex }, i) => (
        <div key={i} style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
            {item.time && <TimePill time={item.time} end_time={item.end_time} />}
            <Badge type="Transport" />
            <span style={{ fontSize: "9.5px", fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{dayShort(day, dayIndex)}</span>
          </div>
          <p style={{ fontSize: "13.5px", color: "var(--color-text-primary)", margin: "0 0 6px", lineHeight: 1.5 }}>{item.text}</p>
          {item.location && <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: "0 0 6px" }}>{item.location}</p>}
          {item.duration && <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "0 0 6px" }}>⏱ {item.duration}</p>}
          <ContactBlock contact={item.contact} name={item.text} />
        </div>
      ))}
    </div>
  );
}

// Parse a travelers string (e.g. "2 adults", "4", "2 adults + 1 kid") into
// a covers/seats integer for OpenTable / Resy deep links. Falls back to 2.
function extractPartySize(travelers) {
  if (typeof travelers === "number" && Number.isFinite(travelers) && travelers > 0) return Math.min(travelers, 20);
  const s = String(travelers || "");
  const nums = s.match(/\d+/g);
  if (!nums || !nums.length) return 2;
  // Sum all numbers (handles "2 adults + 1 kid"); cap so we don't send weird values.
  const total = nums.reduce((a, n) => a + parseInt(n, 10), 0);
  return Math.max(1, Math.min(total || 2, 20));
}

// Derive a YYYY-MM-DD anchor date for deep-link prefill. Prefer the first
// day's explicit ISO date; fall back to inputs.basics.startDate; else "".
function tripAnchorDate(data, inputs) {
  const fromDay = (data?.days || []).map(d => d?.date).find(d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d));
  if (fromDay) return fromDay.slice(0, 10);
  const sd = inputs?.basics?.startDate;
  if (typeof sd === "string" && /^\d{4}-\d{2}-\d{2}/.test(sd)) return sd.slice(0, 10);
  return "";
}

// DiningBrowseChips — three search/booking platform shortcuts that prefill the
// destination, date, and party size. Lets the traveler shop their own
// restaurants when the AI picks don't land. Modeled on santafejune.com's
// top-of-Dining browse chips.
function DiningBrowseChips({ data, inputs }) {
  // For multi-city plans, the cities array is the source of truth and a
  // *single* search URL can only meaningfully target one city at a time —
  // OpenTable / Resy / Yelp don't accept "Lisbon → Porto" as a query.
  // Pick the first city for the URL params and let the header show all of
  // them. Future: render one chip-set per city section.
  const citiesArr = Array.isArray(inputs?.basics?.cities)
    ? inputs.basics.cities.map(c => (c?.name || "").trim()).filter(Boolean)
    : [];
  const isMultiCity = citiesArr.length > 1;

  // Display label: prefer the trip's display destination, falling back to a
  // joined city list. Used only for the card header and prefill note text.
  const displayLabelRaw =
    (data?.destination && String(data.destination).trim()) ||
    (inputs?.basics?.destination && String(inputs.basics.destination).trim()) ||
    citiesArr.join(" → ") ||
    "";
  // Strip trailing " — fall 2026" style suffixes from the display label too.
  const displayLabel = displayLabelRaw.split(/[—–|(]/)[0].trim();
  if (!displayLabel) return null;

  // URL-param city: the single city we'll send to OpenTable / Resy / Yelp.
  // Order of preference:
  //   1. First entry of inputs.basics.cities (multi-city authoritative)
  //   2. Trip destination, with all separators stripped so "Lisbon → Porto"
  //      becomes "Lisbon". Strips: em/en-dash, arrows →←→, pipe, comma-list, slash, " to ", " and ".
  let urlCity = citiesArr[0] || displayLabel;
  urlCity = urlCity
    .split(/[—–→←↔⇒|/]| to | and |,/i)[0]
    .replace(/[—–→←↔⇒]/g, "")
    .trim();
  if (!urlCity) urlCity = displayLabel;

  const party = extractPartySize(inputs?.basics?.travelers);
  const date = tripAnchorDate(data, inputs); // "" if unknown
  // Default dinner time. OpenTable accepts a full ISO local datetime.
  const dinnerTime = "19:00";
  const otDateTime = date ? `${date}T${dinnerTime}` : "";

  // Slugify the single URL city for Resy's /cities/{slug} path (best-effort).
  // Resy doesn't expose a public city list endpoint and silently geo-redirects
  // unknown slugs to the user's local Resy city. Fall back to the city index.
  const resySlug = urlCity
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const otQs = [
    `term=${encodeURIComponent(urlCity)}`,
    otDateTime ? `dateTime=${encodeURIComponent(otDateTime)}` : "",
    `covers=${party}`,
  ].filter(Boolean).join("&");
  const opentableUrl = `https://www.opentable.com/s?${otQs}`;

  // Resy: link to the city page when we can slug it; the wider /cities index otherwise.
  const resyUrl = resySlug ? `https://resy.com/cities/${resySlug}` : `https://resy.com/cities`;

  const yelpUrl = `https://www.yelp.com/search?find_desc=Restaurants&find_loc=${encodeURIComponent(urlCity)}`;

  const chips = [
    { key: "opentable", label: "OpenTable", mark: "OT", href: opentableUrl, markBg: "var(--color-text-danger)" },
    { key: "resy",      label: "Resy",      mark: "R",  href: resyUrl,      markBg: "var(--color-text-primary)" },
    { key: "yelp",      label: "Yelp",      mark: "Y",  href: yelpUrl,      markBg: "var(--color-danger-hover)" },
  ];

  // Footnote describing exactly what we prefilled — same idea as the
  // "Trip settings" disclosure in trip-restaurants, but condensed. For
  // multi-city plans we name the single city we actually sent in the URL so
  // the user isn't surprised that clicking Yelp only shows Lisbon results.
  const prefillBits = [];
  if (date) prefillBits.push(`${date} · 7:00 PM`);
  prefillBits.push(`${party} ${party === 1 ? "guest" : "guests"}`);
  const prefillLabel = isMultiCity
    ? `Searching ${urlCity} only (multi-city trip)`
    : `Prefilled: ${urlCity}`;
  const prefillNote = `${prefillLabel} · ${prefillBits.join(" · ")}`;

  return (
    <div
      data-testid="dining-browse-chips"
      className="no-print dining-browse-chips"
      style={{
        margin: "4px 0 16px",
        padding: "12px 14px",
        background: "rgba(91, 101, 119, 0.07)",
        border: "0.5px solid rgba(91, 101, 119, 0.32)",
        borderRadius: "var(--border-radius-md)",
      }}
    >
      <p
        style={{
          margin: "0 0 8px",
          fontSize: "10px",
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: GOLD_DARK,
        }}
      >
        Find your own · {displayLabel}
      </p>
      <style>{`
        .dining-browse-chips .dbc-chip { transition: transform 0.12s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
        .dining-browse-chips .dbc-chip:hover, .dining-browse-chips .dbc-chip:focus-visible {
          transform: translateY(-1px);
          box-shadow: 0 4px 10px -6px rgba(0,0,0,0.25);
          outline: none;
        }
        /* !important needed because the chip uses an inline border style,
           which would otherwise win on specificity. */
        .dining-browse-chips .dbc-chip-opentable:hover, .dining-browse-chips .dbc-chip-opentable:focus-visible { border-color: var(--color-text-danger) !important; }
        .dining-browse-chips .dbc-chip-resy:hover,      .dining-browse-chips .dbc-chip-resy:focus-visible      { border-color: var(--color-text-primary) !important; }
        .dining-browse-chips .dbc-chip-yelp:hover,      .dining-browse-chips .dbc-chip-yelp:focus-visible      { border-color: var(--color-danger-hover) !important; }
      `}</style>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {chips.map(c => (
          <a
            key={c.key}
            className={`dbc-chip dbc-chip-${c.key}`}
            data-testid={`dining-chip-${c.key}`}
            href={c.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Search ${c.label} for restaurants in ${urlCity} (opens in new tab)`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "7px 13px 7px 7px",
              borderRadius: "999px",
              background: "var(--color-background-primary, var(--color-background-primary))",
              border: "0.5px solid var(--color-border-secondary)",
              textDecoration: "none",
              fontSize: "12.5px",
              fontWeight: 600,
              color: "var(--color-text-primary)",
              letterSpacing: "0.01em",
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "20px",
                height: "20px",
                borderRadius: "50%",
                background: c.markBg,
                color: "var(--color-background-primary)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "9.5px",
                fontWeight: 700,
                letterSpacing: "0.02em",
                flexShrink: 0,
              }}
            >
              {c.mark}
            </span>
            <span>{c.label}</span>
            <span aria-hidden="true" style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginLeft: "2px" }}>↗</span>
          </a>
        ))}
      </div>
      <p
        style={{
          margin: "8px 0 0",
          fontSize: "10.5px",
          color: "var(--color-text-tertiary)",
          fontStyle: "italic",
          lineHeight: 1.4,
        }}
      >
        {prefillNote}
      </p>
    </div>
  );
}

// Dining view — every restaurant (primary + backup) flattened, with date
// grouping and full RestaurantCard. Matches the santafejune.com Dining tab.
function DiningView({ data, inputs, onOpenMenu }) {
  const meals = [];
  (data.days || []).forEach((d, di) => {
    (d.items || []).forEach((item) => {
      if (item.restaurant && /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/.test(item.type)) {
        meals.push({ item, day: d, dayIndex: di });
      }
    });
  });
  if (meals.length === 0) {
    return (
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>
        No dining picks yet.
      </p>
    );
  }
  // Group by day so the user can scan "what am I eating Fri?"
  const byDay = new Map();
  meals.forEach(({ item, day, dayIndex }) => {
    const k = `${dayIndex}|${day?.label || ""}`;
    if (!byDay.has(k)) byDay.set(k, { day, dayIndex, items: [] });
    byDay.get(k).items.push(item);
  });
  return (
    <div>
      <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px" }}>Dining · {meals.length} reservations</p>
      <DiningBrowseChips data={data} inputs={inputs} />
      {Array.from(byDay.values()).map(({ day, dayIndex, items }, di) => (
        <div key={di} style={{ marginBottom: "14px" }}>
          <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 8px", fontWeight: 600, paddingBottom: "4px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{dayShort(day, dayIndex)}</p>
          {items.map((item, i) => (
            <div key={i}>
              {item.time && (
                <div style={{ marginBottom: "4px" }}>
                  <TimePill time={item.time} end_time={item.end_time} />
                  <span style={{ marginLeft: "8px", fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>{item.type}</span>
                </div>
              )}
              <RestaurantCard type={item.type} restaurant={item.restaurant} onOpenMenu={onOpenMenu} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Activities view — every Activity flattened, grouped by day. Each renders as
// an ActivityCard with full contact info (phone, website, directions, hours).
// Mirrors the santafejune.com Activities tab. Booked-vs-paid status is not
// tracked yet; we keep it simple and let the contact.booking_note carry that.
function ActivitiesView({ data }) {
  const acts = [];
  (data.days || []).forEach((d, di) => {
    (d.items || []).forEach((item) => {
      if (item.type === "Activity") {
        acts.push({ item, day: d, dayIndex: di });
      }
    });
  });
  if (acts.length === 0) {
    return (
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>
        No standalone activities on this trip.
      </p>
    );
  }
  const byDay = new Map();
  acts.forEach(({ item, day, dayIndex }) => {
    const k = `${dayIndex}|${day?.label || ""}`;
    if (!byDay.has(k)) byDay.set(k, { day, dayIndex, items: [] });
    byDay.get(k).items.push(item);
  });
  return (
    <div>
      <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px" }}>Activities · {acts.length}</p>
      {Array.from(byDay.values()).map(({ day, dayIndex, items }, di) => (
        <div key={di} style={{ marginBottom: "14px" }}>
          <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 8px", fontWeight: 600, paddingBottom: "4px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{dayShort(day, dayIndex)}</p>
          {items.map((item, i) => (
            <ActivityCard key={i} time={item.time} end_time={item.end_time} item={item} />
          ))}
        </div>
      ))}
    </div>
  );
}

// "By category" view — the SAME plan items the day-by-day shows, re-projected
// into category groups (flights / lodging / ground transport / activities /
// dining) via the shared groupItemsByCategory helper so the on-screen tab and
// the PDF section can never drift. Reuses the existing card renderers verbatim
// (FlightCard / HotelCard / RestaurantCard / ActivityCard + the transport
// block) — no new card markup — and prefixes each with a "Day N · weekday ·
// time" context line so an item stays useful once it's pulled out of its day.
// Renders nothing it didn't already verify; it's a pure regrouping.
function CategoryView({ data, onOpenMenu }) {
  const groups = useMemo(() => groupItemsByCategory(data), [data]);
  if (groups.length === 0) {
    return (
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>
        Nothing to group yet — add flights, lodging, transport, activities, or dining.
      </p>
    );
  }
  // "Day 2 · Fri Jun 5 · 9:00 AM" — day number + the day-label's weekday/date
  // segment (when present) + the item's 12-hour start time.
  const contextLabel = (entry) => {
    const weekday = (entry.dayLabel || "").split(" · ")[1] || "";
    return [`Day ${entry.dayIndex + 1}`, weekday, formatTime(entry.time)].filter(Boolean).join(" · ");
  };
  return (
    <div>
      {groups.map((group) => (
        <div key={group.category} style={{ marginBottom: "22px" }}>
          <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px", paddingBottom: "4px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{group.label} · {group.items.length}</p>
          {group.items.map((entry, i) => (
            <div key={i} style={{ marginBottom: "10px" }}>
              <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase", margin: "0 0 4px", fontWeight: 600 }}>{contextLabel(entry)}</p>
              {group.category === "flights" && (
                <FlightCard type={entry.item.type} time={entry.item.time} end_time={entry.item.end_time} flight={entry.item.flight} text={entry.item.text} flags={entry.item.flags} dayLabel={entry.dayLabel} onFlightConfirmed={(fl) => { const toT = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }) : undefined; Object.assign(entry.item.flight, { flight_number: fl.flightNumber, depart_time: toT(fl.scheduledOut), arrive_time: toT(fl.scheduledIn), ...(fl.aircraft ? { aircraft: fl.aircraft } : {}) }); }} />
              )}
              {group.category === "lodging" && (
                <HotelCard type={entry.item.type} time={entry.item.time} end_time={entry.item.end_time} hotel={entry.item.hotel} text={entry.item.text} />
              )}
              {group.category === "transport" && (
                <div style={{ border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                    {entry.item.time && <TimePill time={entry.item.time} end_time={entry.item.end_time} />}
                    <Badge type="Transport" />
                  </div>
                  <p style={{ fontSize: "13.5px", color: "var(--color-text-primary)", margin: "0 0 6px", lineHeight: 1.5 }}>{entry.item.text}</p>
                  {entry.item.location && <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: "0 0 6px" }}>{entry.item.location}</p>}
                  {entry.item.duration && <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "0 0 6px" }}>⏱ {entry.item.duration}</p>}
                  <ContactBlock contact={entry.item.contact} name={entry.item.text} />
                </div>
              )}
              {group.category === "activities" && (
                <ActivityCard time={entry.item.time} end_time={entry.item.end_time} item={entry.item} />
              )}
              {group.category === "dining" && (
                <RestaurantCard type={entry.item.type} restaurant={entry.item.restaurant} onOpenMenu={onOpenMenu} />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Essentials view — pulls every non-itinerary block (Tonight, Weather & pack,
// Heads up, Plan B, Snob's guide) into one focused tab. This frees Overview
// from being a kitchen-sink view and gives a single "things to know" surface.
// Hoisted section heading for EssentialsView. Previously defined inside the
// component body, which made it a brand-new function reference on every
// render — causing React to unmount + remount the heading nodes any time
// the parent re-rendered. Now stable across renders.
function EssentialsSectionHeading({ children }) {
  return (
    <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "18px 0 10px" }}>{children}</p>
  );
}

// Does the plan carry any non-itinerary reference content (Tonight, Weather &
// pack, Heads up, Plan B, Snob's guide)? Used to decide whether to surface the
// always-visible "Trip reference" footer on Overview without rendering an empty
// shell when every output toggle was off at build time.
function hasEssentialsContent(data) {
  return (
    (Array.isArray(data.tonight) && data.tonight.length > 0) ||
    !!data.weather_window ||
    (Array.isArray(data.pack) && data.pack.length > 0) ||
    (Array.isArray(data.flags) && data.flags.length > 0) ||
    (Array.isArray(data.planb) && data.planb.length > 0) ||
    (Array.isArray(data.snobs) && data.snobs.length > 0)
  );
}

function EssentialsView({ data }) {
  const sortedTonight = Array.isArray(data.tonight)
    ? [...data.tonight].map((t, i) => ({ t, i, p: tonightPriority(t) })).sort((a, b) => a.p.rank - b.p.rank || a.i - b.i)
    : [];
  const hasWeather = !!data.weather_window || (Array.isArray(data.pack) && data.pack.length > 0);
  const hasFlags = Array.isArray(data.flags) && data.flags.length > 0;
  const hasPlanB = Array.isArray(data.planb) && data.planb.length > 0;
  const hasSnobs = Array.isArray(data.snobs) && data.snobs.length > 0;
  if (sortedTonight.length === 0 && !hasWeather && !hasFlags && !hasPlanB && !hasSnobs) {
    return (
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0", textAlign: "center" }}>
        No essentials yet — rebuild the plan to get weather, Plan B, and insider notes.
      </p>
    );
  }
  const H = EssentialsSectionHeading;
  return (
    <div>
      {sortedTonight.length > 0 && (
        <>
          <H>Do this tonight</H>
          <div style={{ borderRadius: "var(--border-radius-md)", overflow: "hidden", border: "0.5px solid var(--color-border-secondary)" }}>
            {sortedTonight.map(({ t, p }, i) => {
              const text = stripTonightPrefix(t);
              return (
                <div key={i} style={{ display: "flex", gap: "10px", padding: "10px 12px", borderTop: i > 0 ? "0.5px solid var(--color-border-tertiary)" : "none", background: p.bg, alignItems: "flex-start" }}>
                  {p.label && (
                    <span style={{ flex: "0 0 auto", fontSize: "9.5px", fontWeight: 700, color: p.color, letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", border: `0.5px solid ${p.color}`, borderRadius: "3px", whiteSpace: "nowrap", marginTop: "1px" }}>{p.label}</span>
                  )}
                  <span style={{ fontSize: "12.5px", color: "var(--color-text-primary)", lineHeight: 1.5, flex: 1 }}>{text}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {hasWeather && (
        <>
          <H>Weather &amp; pack</H>
          {data.weather_window && (
            <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 12px", lineHeight: 1.55 }}>☀ {data.weather_window}</p>
          )}
          {Array.isArray(data.pack) && data.pack.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "4px" }}>
              {data.pack.map((p, i) => (
                <div key={i} style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", display: "flex", gap: "8px", lineHeight: 1.5 }}>
                  <span style={{ color: GOLD, flex: "0 0 auto" }}>✓</span><span>{p}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {hasFlags && (
        <>
          <H>Heads up</H>
          {data.flags.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "6px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.5 }}>
              <span style={{ flex: "0 0 auto", color: "var(--color-warning)", fontSize: "12px", marginTop: "1px" }}>⚠︎</span>
              <span>{f}</span>
            </div>
          ))}
        </>
      )}
      {hasPlanB && (
        <>
          <H>If plans break</H>
          {data.planb.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "7px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.5 }}>
              <span style={{ flex: "0 0 auto", fontSize: "9.5px", fontWeight: 700, color: "var(--color-accent)", letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", border: "0.5px solid var(--color-accent)", borderRadius: "3px", whiteSpace: "nowrap", marginTop: "1px" }}>Plan B</span>
              <span>{p}</span>
            </div>
          ))}
        </>
      )}
      {hasSnobs && (
        <>
          <H>Snob's guide</H>
          {data.snobs.map((s, i) => (
            <div key={i} style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "8px 12px", borderLeft: `2px solid var(--color-category-rose)`, marginBottom: "8px", lineHeight: "1.6", borderRadius: 0 }}>{s}</div>
          ))}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Local providers — fetch hook + on-screen view.
// ----------------------------------------------------------------------------
// Surfaces REAL, verified local service providers (private drivers, private
// guides, tours, wine tastings) for the trip. Every provider flows through the
// existing real-source + Google Places verification pipeline:
//   • tours + tastings  → POST /api/find   { category:"activities", guidelines }
//   • drivers + guides  → POST /api/find-providers { kind }
// Both endpoints DROP closed/not-found venues and tag the rest verified /
// verify-before-booking. This layer never invents a provider — if a category
// returns nothing verifiable we render an honest empty state. Pure shaping,
// dedupe and label-mapping live in src/localProviders.js (unit-tested); only
// the network lives here.
//
// We fetch per relevant category per leg city (multi-city trips), tag each raw
// record with _city for display + dedupe, and aggregate. State is lifted into
// ItineraryView so BOTH this tab and the PDF section read the same results.
function useLocalProviders(plan, inputs, legCities, active) {
  const relevantIds = useMemo(
    () => relevantProviderCategories(plan, inputs),
    [plan, inputs],
  );

  // Stable city list: the deduped leg cities, falling back to the plan
  // destination so single-city trips still query once.
  const cities = useMemo(() => {
    const list = Array.isArray(legCities) ? legCities.filter(Boolean) : [];
    if (list.length > 0) return list.slice(0, 6);
    const dest = String(plan?.destination || "").trim();
    return dest ? [dest] : [];
  }, [legCities, plan]);

  const [byCategory, setByCategory] = useState({});
  const [status, setStatus] = useState("idle");
  // Honest error surface (FIX): a transport/server failure must be
  // distinguishable from a legitimate "nothing found". `error` is a top-level
  // message; `errorIds` lists categories that failed to load AND returned
  // nothing, so the view can say "couldn't load" instead of "we won't guess".
  const [error, setError] = useState("");
  const [errorIds, setErrorIds] = useState([]);
  // Latches true once the user opens the tab or export forces a load, so we
  // never re-fetch on tab switches and the cost is paid at most once.
  const [activated, setActivated] = useState(false);

  // Guard against overlapping fetches + stale writes on rapid plan changes.
  const reqRef = useRef(0);
  // Signature of the (relevantIds, cities) currently loaded/loading, plus the
  // in-flight promise — so repeat triggers (tab re-open, export) reuse the
  // same fetch instead of firing fresh network calls.
  const loadKeyRef = useRef("");
  const loadPromiseRef = useRef(null);
  const sig = `${relevantIds.join(",")}|${cities.join(",")}`;

  const startLoad = useCallback(() => {
    if (relevantIds.length === 0 || cities.length === 0) {
      return Promise.resolve({});
    }
    // Same trip + cities already loaded/loading — reuse, never re-fetch.
    if (loadKeyRef.current === sig && loadPromiseRef.current) {
      return loadPromiseRef.current;
    }
    loadKeyRef.current = sig;
    const reqId = ++reqRef.current;
    setStatus("loading");
    setError("");
    setErrorIds([]);

    const fetchOne = async (cat, city) => {
      const meta = providerCategoryMeta(cat);
      if (!meta) return { records: [], ok: true };
      try {
        let res, jsonResp, pool;
        if (meta.source === "providers") {
          res = await fetch("/api/find-providers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ location: city, kind: meta.kind }),
          });
          jsonResp = await res.json().catch(() => ({}));
          if (!res.ok) {
            // 422 = "no providers found / nothing verifiable" — a legitimate
            // empty result, NOT a transport error. Anything else is a failure.
            return { records: [], ok: res.status === 422 };
          }
          pool = jsonResp?.results?.providers || [];
        } else {
          res = await fetch("/api/find", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: city,
              category: "activities",
              guidelines: meta.guidelines || "",
              mode: "standard",
              // Make tours + tastings go through the SAME real Google Places
              // existence/status check as drivers/guides (activities store
              // their name in `text`, so the server must derive it).
              verify_activities_by_name: true,
            }),
          });
          jsonResp = await res.json().catch(() => ({}));
          if (!res.ok) return { records: [], ok: res.status === 422 };
          pool = jsonResp?.results?.activities || [];
        }
        // Tag each record with the leg city for per-leg display + dedupe.
        const records = (Array.isArray(pool) ? pool : []).map((p) =>
          p && typeof p === "object" ? { ...p, _city: city } : p,
        );
        return { records, ok: true };
      } catch {
        return { records: [], ok: false };
      }
    };

    const p = (async () => {
      const jobs = [];
      for (const cat of relevantIds) {
        for (const city of cities) jobs.push({ cat, city });
      }
      const results = await Promise.all(jobs.map((j) => fetchOne(j.cat, j.city)));
      const next = {};
      const erroredCat = {};
      for (const id of relevantIds) { next[id] = []; erroredCat[id] = false; }
      results.forEach((r, i) => {
        const { cat } = jobs[i];
        if (!r.ok) erroredCat[cat] = true;
        if (Array.isArray(r.records) && r.records.length) next[cat].push(...r.records);
      });
      // A category "failed" only if it returned nothing AND a fetch errored —
      // otherwise an empty result is a genuine "nothing found".
      const failedIds = relevantIds.filter((id) => next[id].length === 0 && erroredCat[id]);
      if (reqRef.current === reqId) {
        setByCategory(next);
        setErrorIds(failedIds);
        setError(failedIds.length > 0 ? "Couldn't load local providers right now — try again." : "");
        setStatus("done");
      }
      return next;
    })();
    loadPromiseRef.current = p;
    return p;
  }, [relevantIds, cities, sig]);

  // Fetch only when the tab is open (active) or export latched us on. Plain
  // itinerary render does NOT fetch — this avoids ~24 paid calls for users who
  // never open the tab.
  const shouldFetch = active === true || activated;
  useEffect(() => {
    if (!shouldFetch) return;
    startLoad();
  }, [shouldFetch, startLoad]);

  // Imperative trigger for PDF export: ensure providers are loaded even if the
  // tab was never opened, and resolve with the loaded byCategory so the caller
  // can hand fresh data to the PDF builder.
  const ensureLoaded = useCallback(() => {
    setActivated(true);
    return startLoad();
  }, [startLoad]);

  return { relevantIds, byCategory, status, error, errorIds, ensureLoaded };
}

// One provider card. Reuses the gold verify-chip visual language from the
// restaurant cards. The verify label is computed in localProviders.js from the
// pipeline's real verification state — we never upgrade it here.
function ProviderCard({ item }) {
  const verified = item.verifyLabel === "verified";
  return (
    <div style={{ border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
        <span style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.1px" }}>{item.name}</span>
        {item.city && <span style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", letterSpacing: "0.04em" }}>{item.city}</span>}
        {verified ? (
          <span style={{ fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-success)", background: "var(--color-success-tint)", border: "0.5px solid var(--color-success-tint)", borderRadius: "10px", padding: "2px 8px" }}>✓ Verified</span>
        ) : (
          <span style={{ fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-text-primary)", background: "var(--color-surface-2)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "10px", padding: "2px 8px" }}>Verify before booking</span>
        )}
      </div>
      {item.descriptor && <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>{item.descriptor}</p>}
      {(item.url || item.verifyUrl) && (
        <a
          href={item.url || item.verifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: "11px", color: GOLD, textDecoration: "underline", fontWeight: 500 }}
        >{item.url ? "Visit website →" : "Check listing →"}</a>
      )}
    </div>
  );
}

// "Local providers" tab body. Renders one section per relevant category with a
// tight set of verified options (cap PROVIDER_UI_CAP). Honest loading / empty /
// error states — never a fabricated name.
function LocalProvidersView({ providers }) {
  const { relevantIds, byCategory, status, error, errorIds } = providers || {};
  const failedIds = Array.isArray(errorIds) ? errorIds : [];
  const groups = useMemo(
    () => bucketProviders(relevantIds || [], byCategory || {}),
    [relevantIds, byCategory],
  );

  if (!relevantIds || relevantIds.length === 0) {
    return (
      <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        This trip doesn't call for private drivers, guides, tours, or wine tastings, so there's nothing to surface here.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", lineHeight: 1.6, margin: 0 }}>
        Real local operators checked against Google Places. Anything we couldn't confirm is labeled “verify before booking” — we don't guess.
      </p>
      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "var(--color-warning)", margin: 0 }}>
          {error}
        </p>
      )}
      {groups.map((g) => (
        <div key={g.id}>
          <h3 style={{ fontSize: "13px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 10px" }}>
            {g.label}{g.total > 0 ? ` · ${g.total}` : ""}
          </h3>
          {g.items.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "10px" }}>
              {g.items.map((item, i) => <ProviderCard key={`${item.name}-${i}`} item={item} />)}
              {g.total > g.items.length && (
                <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "2px 0 0" }}>
                  +{g.total - g.items.length} more found
                </p>
              )}
            </div>
          ) : (
            <p style={{ fontSize: "12px", color: failedIds.includes(g.id) ? "var(--color-warning)" : "var(--color-text-secondary)", fontStyle: "italic", margin: 0 }}>
              {status !== "done"
                ? `Finding ${g.noun}s…`
                : failedIds.includes(g.id)
                ? `Couldn't load ${g.noun}s right now — try again.`
                : `No vetted ${g.noun} found for this trip — we won't guess.`}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

// Tabbed shell. Row 1 of the sticky nav is the day-tab strip (Overview only,
// now an interactive filter — click to focus a single day, "All" to see them
// all). Row 2 is the section/reference strip. Default tab is "Overview".
function TripTabs({ data, tab, onTabChange, dayFilter, onDayFilterChange, showProviders, onOpenMenu: _onOpenMenu }) {
  const days = data.days || [];
  // Compute counts so we can show e.g. "Dining · 12" inline.
  const counts = useMemo(() => {
    let flights = 0, hotels = 0, transport = 0, dining = 0, activities = 0;
    let essentials = 0;
    const hotelSeen = new Set();
    days.forEach(d => (d.items || []).forEach(it => {
      if (it.type === "Flight" && it.flight) flights++;
      else if (it.type === "Hotel" && it.hotel) {
        const k = (it.hotel.name || "") + "|" + (it.hotel.address || "");
        if (!hotelSeen.has(k)) { hotelSeen.add(k); hotels++; }
      }
      else if (it.type === "Transport") transport++;
      else if (it.restaurant && /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/.test(it.type)) dining++;
      else if (it.type === "Activity") activities++;
    }));
    // Essentials count = number of essentials blocks present (Tonight, Weather, Flags, PlanB, Snobs).
    if (Array.isArray(data.tonight) && data.tonight.length > 0) essentials++;
    if (data.weather_window || (Array.isArray(data.pack) && data.pack.length > 0)) essentials++;
    if (Array.isArray(data.flags) && data.flags.length > 0) essentials++;
    if (Array.isArray(data.planb) && data.planb.length > 0) essentials++;
    if (Array.isArray(data.snobs) && data.snobs.length > 0) essentials++;
    return { flights, hotels, transport, dining, activities, essentials };
  }, [days, data.tonight, data.weather_window, data.pack, data.flags, data.planb, data.snobs]);
  // #11 B-prime: split the legacy 9-pill strip into 5 always-on
  // primaries (Overview · Flights · Hotels · Dining · Activities) +
  // a "More ▾" overflow popover for Transport / By category /
  // Local providers / Essentials. Pure helpers in src/tabStrip.js;
  // see tests/test_tab_strip.mjs for the partition/active-state logic.
  const partition = useMemo(
    () => partitionTabs(counts, { showProviders }),
    [counts, showProviders],
  );
  const overflowActive = isActiveTabInOverflow(tab, partition);
  const overflowLabel = activeOverflowLabel(tab, partition);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);

  // Close the More popover on click-outside and on Escape. Closing
  // when the active tab changes is folded into each onTabChange callsite
  // below (clicking a tab pill or a menu item dismisses the menu
  // inline) so we don't need a tab-change effect — React 19's
  // react-hooks/set-state-in-effect would flag that as a cascading-
  // render risk.
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDocClick = (e) => {
      if (!moreRef.current) return;
      if (!moreRef.current.contains(e.target)) setMoreOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setMoreOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  return (
    <>
      {/* Two-row sticky nav, modeled after zurich-weekend.com / maritimesgrandloop.com.
         Both rows WRAP so every tab is visible without horizontal scroll. Active tab
         gets the warm gold pill. Tabs are rendered ABOVE the hero by the parent so
         the hero itself stays compact. */}
      <div className="no-print" style={{ position: "sticky", top: 0, zIndex: 6, background: "var(--color-background-primary)", paddingTop: "8px", paddingBottom: "10px", marginBottom: "14px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        {/* Row 1 — #11 B-prime: 5 primaries + 'More ▾' overflow.
            Primaries are always visible; the More button takes the
            active-pill styling whenever the current tab lives in the
            overflow group, so the user can see at a glance that the
            active section is behind the menu. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", justifyContent: "flex-start", alignItems: "center" }}>
          {partition.primaries.map(t => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => { setMoreOpen(false); onTabChange(t.id); }}
                style={{
                  flex: "0 0 auto",
                  fontSize: "10.5px",
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  /* #23 active = navy fill, so label must be LIGHT (was navy-on-navy = invisible). */
                  color: active ? ON_NAVY : "var(--color-text-secondary)",
                  padding: "6px 12px",
                  border: active ? "none" : "0.5px solid var(--color-border-secondary)",
                  borderRadius: "20px",
                  whiteSpace: "nowrap",
                  background: active ? GOLD : "var(--color-background-primary)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  lineHeight: 1.2,
                }}
              >{t.label}</button>
            );
          })}
          {partition.overflow.length > 0 && (
            <div ref={moreRef} style={{ position: "relative", flex: "0 0 auto" }}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
                title={overflowActive
                  ? `Showing ${overflowLabel} — tap to switch tabs`
                  : "More sections (Transport, Local providers, Essentials, By category)"}
                style={{
                  flex: "0 0 auto",
                  fontSize: "10.5px",
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  color: overflowActive ? ON_NAVY : "var(--color-text-secondary)",
                  padding: "6px 12px",
                  border: overflowActive ? "none" : "0.5px solid var(--color-border-secondary)",
                  borderRadius: "20px",
                  whiteSpace: "nowrap",
                  background: overflowActive ? GOLD : "var(--color-background-primary)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  lineHeight: 1.2,
                }}
              >{overflowActive ? `${overflowLabel} ▾` : "More ▾"}</button>
              {moreOpen && (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: 0,
                    minWidth: "180px",
                    background: "var(--color-background-primary)",
                    border: "0.5px solid var(--color-border-secondary)",
                    borderRadius: "var(--border-radius-md)",
                    boxShadow: "0 6px 18px rgba(0,0,0,0.10)",
                    padding: "6px",
                    zIndex: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                  }}
                >
                  {partition.overflow.map((t) => {
                    const active = tab === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="menuitem"
                        onClick={() => { onTabChange(t.id); setMoreOpen(false); }}
                        style={{
                          textAlign: "left",
                          fontSize: "11.5px",
                          letterSpacing: "0.04em",
                          fontWeight: active ? 700 : 500,
                          color: active ? ON_NAVY : "var(--color-text-primary)",
                          background: active ? GOLD : "transparent",
                          border: "none",
                          borderRadius: "6px",
                          padding: "8px 12px",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          whiteSpace: "nowrap",
                        }}
                      >{t.label}</button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        {/* Row 2 — day filter (Overview only). "All" + one pill per day; click to focus that day. WRAPS. */}
        {tab === "overview" && days.length >= 2 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "8px", paddingTop: "8px", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            {[{ idx: -1, label: "All days" }, ...days.map((d, i) => ({ idx: i, label: `${i + 1} · ${dayShort(d, i)}` }))].map(({ idx, label }) => {
              const active = dayFilter === idx;
              return (
                <button
                  key={idx}
                  onClick={() => onDayFilterChange(idx)}
                  style={{
                    flex: "0 0 auto",
                    fontSize: "10px",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontWeight: 600,
                    /* #23 active = navy fill, label must be LIGHT (was navy-on-navy). */
                    color: active ? ON_NAVY : "var(--color-text-secondary)",
                    padding: "4px 9px",
                    border: active ? "none" : "0.5px solid var(--color-border-secondary)",
                    borderRadius: "3px",
                    whiteSpace: "nowrap",
                    background: active ? GOLD : "var(--color-background-primary)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    lineHeight: 1.2,
                  }}
                >{label}</button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// Section content router for non-overview tabs. Rendered by the parent below the
// hero/review area so the nav stays at the top of the page.
function TripSectionView({ tab, data, inputs, onOpenMenu, providers }) {
  if (tab === "flights") return <FlightsView data={data} />;
  if (tab === "lodging") return <LodgingView data={data} />;
  if (tab === "transport") return <TransportView data={data} />;
  if (tab === "dining") return <DiningView data={data} inputs={inputs} onOpenMenu={onOpenMenu} />;
  if (tab === "activities") return <ActivitiesView data={data} />;
  if (tab === "category") return <CategoryView data={data} onOpenMenu={onOpenMenu} />;
  if (tab === "providers") return <LocalProvidersView providers={providers} />;
  if (tab === "essentials") return <EssentialsView data={data} />;
  return null;
}


// ============================================================================
// ReviewPanel — the post-build Professional Review surface.
// ----------------------------------------------------------------------------
// Lives at the top of ItineraryView. Three states:
//   (1) idle    — show the banner card with reviewer picker + 'Run review'
//   (2) running — show the progress bar (~45s target for review, ~2min for re-plan)
//   (3) done    — show the verdict + findings cards, each with per-finding Apply
//                 toggle, then a single bottom Apply button.
//
// All result/state writes go up through onPlanRevised / onReviewChange so the
// parent (TripOptimizer) can persist them into saved trips.
// ============================================================================
function ReviewPanel({ plan, inputs, onPlanRevised, onReviewChange, initialReview, autoRun = false, externalSourceIds, onSourcesChange }) {
  // --- review state ------------------------------------------------------
  // 'idle' — banner card with picker
  // 'running' — review in flight
  // 'done' — review back, findings visible
  // 'applying' — revision in flight
  // 'applied' — revision back, brief success state before fading back to done
  const [status, setStatus] = useState(initialReview ? "done" : "idle");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Hyperlocal region match: did the user's destination resolve to one of the
  // curated regions (Lake George today, more later)? If yes, auto-attach the
  // region's source IDs to the default selection so the reviewer panel
  // actually uses the hyperlocal coverage we already have wired up server-
  // side. Pure derived value; safe to compute in render.
  const destinationForMatch =
    inputs?.basics?.destination ||
    (Array.isArray(inputs?.basics?.cities) ? inputs.basics.cities.map(c => c?.name).filter(Boolean).join(" ") : "") ||
    plan?.destination ||
    "";
  const hyperlocalRegion = matchHyperlocalRegion(destinationForMatch);

  const [selectedIds, setSelectedIds] = useState(() => {
    // Restoring a prior review: use exactly the sources the user picked then.
    if (initialReview?.sources) return initialReview.sources;
    // #8 If the wizard already lifted a pre-build source selection, honor it so
    // the post-build panel matches what the user chose up front (and what the
    // pre-build review-retrieve pass actually used).
    if (Array.isArray(externalSourceIds) && externalSourceIds.length) return externalSourceIds;
    // Fresh review: standard 6 defaults + (if destination matches) the
    // curated hyperlocal source set for that region.
    const baseDefaults = REVIEWER_SOURCES.filter(s => s.dflt).map(s => s.id);
    if (hyperlocalRegion) {
      return Array.from(new Set([...baseDefaults, ...hyperlocalRegion.sourceIds]));
    }
    return baseDefaults;
  });
  // #8 Keep the wizard-level source selection in sync when the user changes
  // sources from inside the panel, so a re-run / saved trip reflects the change.
  useEffect(() => {
    if (typeof onSourcesChange === "function") onSourcesChange(selectedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);
  const [review, setReview] = useState(initialReview?.review || null);
  const [applyState, setApplyState] = useState({}); // findingId -> bool
  const [appliedIds, setAppliedIds] = useState(() => initialReview?.applied_ids || []);
  // #10 — Collapse the review section to a one-line summary after a successful
  // Apply (or whenever a restored review already has applied findings). Once
  // the user has accepted changes, the plan on screen is newer than the
  // findings list above it; keeping the full findings card expanded above
  // the day-by-day pushes the just-revised plan below the fold. Default:
  // collapsed when a restored review carries applied findings, expanded
  // otherwise. Re-running the review (handleRunReview, or the existing
  // "Re-run review" button) clears this.
  const [collapsed, setCollapsed] = useState(() =>
    Array.isArray(initialReview?.applied_ids) && initialReview.applied_ids.length > 0,
  );
  // #8 part 2b — Apply-mode toggle (the BUILD-LEVEL choice, not the per-call
  // revision mode). Named `applyModeChoice` to avoid shadowing the existing
  // local `applyMode` inside handleApply (which holds "surgical" | "full").
  // Two modes:
  //   "auto":         on a fresh review, queue every finding flagged
  //                   default_apply: true and fire one handleApply
  //                   automatically (the user still sees the apply
  //                   progress + applied changelog via the existing surface).
  //   "approve_each": current behavior — user reviews findings, toggles
  //                   which to include, hits Apply manually.
  // Default: "auto" per the wiki spec. A restored saved trip carries its
  // saved choice forward via initialReview.apply_mode_choice.
  const [applyModeChoice, setApplyModeChoice] = useState(
    initialReview?.apply_mode_choice === "approve_each" ? "approve_each" : "auto",
  );
  // Once-per-review guard so auto-apply can't double-fire on re-render or a
  // brief status oscillation. Stores the review's generatedAt-or-verdict
  // signature; reset on every fresh handleRunReview.
  const autoApplySigRef = useRef("");
  const [error, setError] = useState("");
  // Honest partial-apply surface: when a surgical revision applies SOME but
  // not all selected findings, we never claim full success. `notice` carries
  // the "Applied N of M…" message; `pendingRetryIds` holds the still-unapplied
  // finding ids so the user can one-click re-plan to apply the rest.
  const [notice, setNotice] = useState("");
  const [pendingRetryIds, setPendingRetryIds] = useState([]);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef(null);

  // Initialize per-finding Apply toggles from default_apply when review
  // arrives. This is a legitimate "sync state from a new prop" effect that
  // React 19's stricter rule flags as a cascading-render risk. The flag is
  // correct in principle (the ideal pattern is useState(() => ...) keyed
  // on the review identity, with a remount-on-new-review), but applyState
  // is intentionally user-mutable after init and the existing flow has
  // shipped for months without observable issues. Keeping the effect and
  // documenting the future restructure.
  useEffect(() => {
    if (review && Array.isArray(review.findings)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setApplyState(prev => {
        // Preserve any explicit user choices; default the rest from default_apply.
        const next = { ...prev };
        for (const f of review.findings) {
          if (!(f.id in next)) next[f.id] = !!f.default_apply;
        }
        return next;
      });
    }
  }, [review]);

  const selectedSources = REVIEWER_SOURCES.filter(s => selectedIds.includes(s.id));
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const selectedForApply = findings.filter(f => applyState[f.id]);
  const revisionMode = routeRevisionMode(selectedForApply);
  const criticalCount = findings.filter(f => f.severity === "critical").length;
  const suggestedCount = findings.filter(f => f.severity === "suggested").length;
  const niceCount = findings.filter(f => f.severity === "nice").length;

  // ----- handlers --------------------------------------------------------
  // Note on the eslint-disable comments below: react-hooks/purity flags any
  // Date.now() call inside a component body, but these are inside async
  // event handlers — the rule's static analyzer can't tell handlers from
  // render-phase code. The calls are correct; the warnings are false.
  const handleRunReview = async () => {
    if (selectedSources.length === 0) { setError("Pick at least one source."); return; }
    setStatus("running");
    // #10 — a fresh review run should always land expanded so the user can
    // see the new findings; the collapse only applies to post-Apply state.
    setCollapsed(false);
    // #8 part 2b — reset the auto-apply guard so the new review can auto-fire
    // once it lands in "done" state (only when applyModeChoice === "auto").
    autoApplySigRef.current = "";
    setError("");
    setProgress(0);
    setProgressLabel("Starting review…");
    setElapsedSec(0);
    // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
    const startedAt = Date.now();
    const targetSec = 45;
    let lastTokFrac = 0;

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
      const timeFrac = Math.min(0.95, sec / targetSec);
      setProgress(prev => Math.max(prev, Math.max(lastTokFrac, timeFrac)));
    }, 250);

    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeout = setTimeout(() => controller.abort(), 300000);

    try {
      // -----------------------------------------------------------------
      // STEP 1 — Live retrieval. Hit Perplexity Sonar in parallel for each
      // selected source and inject real, current URLs + snippets into the
      // review prompt. Soft-fail on error so the review still runs even if
      // retrieval is broken (missing key, upstream down, timeout).
      // -----------------------------------------------------------------
      const sourceNames = selectedSources.map(s => s.name).slice(0, 3).join(", ");
      setProgressLabel(`Pulling ${sourceNames}${selectedSources.length > 3 ? "…" : "…"}`);
      let liveSnippets = [];
      try {
        const retrieveResp = await fetch("/api/review-retrieve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            destination: inputs?.basics?.destination || plan?.destination || "",
            hotel_name: extractPrimaryHotel(plan),
            restaurants: extractRestaurantNames(plan),
            activities: extractActivityNames(plan),
            sources: selectedSources.map(s => s.id),
          }),
        });
        if (retrieveResp.ok) {
          const data = await retrieveResp.json();
          liveSnippets = Array.isArray(data?.snippets) ? data.snippets : [];
          // Bump progress slightly so the bar doesn't feel stuck during retrieval.
          setProgress(prev => Math.max(prev, 0.15));
        }
      } catch (retrieveErr) {
        // Aborted by user → propagate. Anything else → swallow and fall back.
        if (retrieveErr?.name === "AbortError") throw retrieveErr;
        console.warn("[review-retrieve] live sources unavailable, falling back", retrieveErr);
      }

      const body = {
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        system: cachedSystem(buildReviewSystemPrompt(plan, selectedSources, inputs, liveSnippets)),
        messages: [{ role: "user", content: buildReviewUserPrompt() }],
        tools: cachedTools([REVIEW_TOOL]),
        tool_choice: { type: "tool", name: "submit_review" },
      };
      let toolJson = "";
      const { toolJson: finalJson } = await streamBuildJob(body, {
        signal: controller.signal,
        onDelta: (delta, totalLen) => {
          toolJson += delta;
          const estTokens = totalLen / 3.5;
          const tokFrac = Math.min(0.95, estTokens / 1800);
          lastTokFrac = tokFrac;
          setProgress(prev => Math.max(prev, tokFrac));
          const fMatches = toolJson.match(/"summary"\s*:\s*"/g) || [];
          if (toolJson.length < 200) setProgressLabel("Reading the plan…");
          else if (fMatches.length === 0) setProgressLabel("Forming verdict…");
          else setProgressLabel(`Drafting findings (${fMatches.length})`);
        },
      });
      toolJson = finalJson;
      setProgress(1);
      setProgressLabel("Finalizing…");
      const { parsed } = parseToolJson(toolJson);
      if (!parsed || !Array.isArray(parsed.findings)) throw new Error("Review returned no findings.");
      setReview(parsed);
      // Reset per-finding toggles to defaults on a fresh review.
      const fresh = {};
      parsed.findings.forEach(f => { fresh[f.id] = !!f.default_apply; });
      setApplyState(fresh);
      setAppliedIds([]);
      setStatus("done");
      if (typeof onReviewChange === "function") {
        onReviewChange({
          sources: selectedIds,
          review: parsed,
          applied_ids: [],
          generatedAt: new Date().toISOString(),
          apply_mode_choice: applyModeChoice,
        });
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        setError("Review cancelled.");
      } else {
        setError(cleanErrorMessage(err?.message, "Review failed."));
      }
      setStatus("idle");
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      abortRef.current = null;
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  // #8 Auto-run the expert review once a build completes, without waiting for a
  // manual 'Run review' click. Guarded so it fires exactly once per distinct
  // plan and never on a restored review (status already 'done') or while one is
  // running. Uses the region-aware default sources already selected above. The
  // manual button still works for re-runs / source changes. Mirrors the
  // once-per-build guard pattern used by IntroductionAutoGenerator.
  //
  // #24 invariant (do not regress): this effect CANNOT extend the main build's
  // streamBuildJob stall counter. ReviewPanel only mounts inside ItineraryView,
  // which is only rendered after the wizard's handleBuild has resolved the main
  // streamBuildJob promise and committed `rawData` to state. The review's own
  // streamBuildJob call (handleRunReview → line ~5252) is a separate fetch with
  // a separate AbortController and a separate stall watchdog. The two never
  // share state — a slow review cannot make the main build appear stuck.
  const autoRunSigRef = useRef("");
  useEffect(() => {
    if (!autoRun) return;
    if (status !== "idle") return;            // don't fire over a restored/in-flight review
    if (initialReview) return;                 // a recovered review is not a fresh build
    if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) return;
    if (selectedSources.length === 0) return;
    const sig = introPlanSignature(plan);      // stable per build (destination|days|first|last)
    if (autoRunSigRef.current === sig) return; // already auto-ran for this build
    autoRunSigRef.current = sig;
    handleRunReview();
    // handleRunReview is a stable closure recreated each render; we intentionally
    // depend only on the trigger inputs, guarded by the signature ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, status, plan, initialReview, selectedSources.length]);

  const handleCancelReview = () => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
  };

  const handleApply = async ({ findingsOverride, forceMode } = {}) => {
    // findingsOverride / forceMode let the "Re-plan to apply the rest" button
    // retry the still-unapplied findings via a full re-plan without depending
    // on async applyState updates. Default path uses the live selection.
    const applyFindings = findingsOverride || selectedForApply;
    const applyMode = forceMode || revisionMode;
    if (applyFindings.length === 0) { setError("Pick at least one change to apply."); return; }
    setStatus("applying");
    setError("");
    setNotice("");
    setProgress(0);
    setProgressLabel(applyMode === "surgical" ? "Applying changes…" : "Applying changes (detailed revision, ~2 min)…");
    setElapsedSec(0);
    // eslint-disable-next-line react-hooks/purity -- inside async event handler
    const startedAt = Date.now();
    const targetSec = applyMode === "surgical" ? 35 : 160;
    let lastTokFrac = 0;

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
      const timeFrac = Math.min(0.95, sec / targetSec);
      setProgress(prev => Math.max(prev, Math.max(lastTokFrac, timeFrac)));
    }, 250);

    // Fresh, never-reused controller per invocation. The hard-timeout is only
    // a BACKSTOP above streamBuildJob's own 15-min poll ceiling / 180s stall
    // guard — a fixed 300s here was shorter than that budget, so a long full
    // re-plan could be aborted mid-stream and surface as a bare "Load failed"
    // (Safari/iOS reports an aborted fetch as TypeError "Load failed").
    const controller = freshAbortController();
    abortRef.current = controller;
    let timedOut = false;
    const hardTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, replanTimeoutMs(applyMode));

    try {
      const body = applyMode === "surgical"
        ? {
            model: "claude-sonnet-4-5",
            max_tokens: 8000,
            system: cachedSystem(buildRevisionSystemPromptSurgical(plan, applyFindings, inputs)),
            messages: [{ role: "user", content: buildRevisionUserPromptSurgical() }],
            tools: cachedTools([REVISION_TOOL_SURGICAL]),
            tool_choice: { type: "tool", name: "submit_revision_patches" },
          }
        : {
            model: "claude-sonnet-4-5",
            max_tokens: 32000,
            system: cachedSystem(buildRevisionSystemPromptFull(plan, applyFindings, inputs)),
            messages: [{ role: "user", content: buildRevisionUserPromptFull() }],
            tools: cachedTools([REVISION_TOOL_FULL]),
            tool_choice: { type: "tool", name: "submit_trip_plan" },
          };
      let toolJson = "";
      const { toolJson: finalJson } = await streamBuildJob(body, {
        signal: controller.signal,
        onDelta: (delta, totalLen) => {
          toolJson += delta;
          const estTokens = totalLen / 3.5;
          const tokFrac = Math.min(0.95, estTokens / (applyMode === "surgical" ? 1500 : 7000));
          lastTokFrac = tokFrac;
          setProgress(prev => Math.max(prev, tokFrac));
          if (applyMode === "surgical") {
            const pm = toolJson.match(/"op"\s*:/g) || [];
            setProgressLabel(pm.length ? `Applying patch ${pm.length}…` : "Reading plan…");
          } else {
            const dm = toolJson.match(/"label"\s*:\s*"/g) || [];
            setProgressLabel(dm.length ? `Day ${dm.length} of plan…` : "Re-planning…");
          }
        },
      });
      toolJson = finalJson;
      setProgress(1);
      setProgressLabel("Finalizing…");
      const { parsed } = parseToolJson(toolJson);
      let newPlan;
      // Which of the findings we just submitted genuinely landed in the plan.
      // Full re-plan regenerates the whole plan, so every submitted finding is
      // addressed. Surgical mode is patch-by-patch, so only the findings whose
      // patch actually applied count — the rest stay un-applied (still selectable).
      let appliedFindings = applyFindings;
      let unappliedFindings = [];
      let partialReasons = [];
      if (applyMode === "surgical") {
        if (!parsed || !Array.isArray(parsed.patches)) throw new Error("Revision returned no patches.");
        const applyResult = applyPatchesToPlan(plan, parsed.patches);
        if (applyResult.appliedCount === 0) {
          // Model returned patches but none could be applied (out-of-range
          // indices, missing fields). Surface a clear, actionable error
          // instead of silently leaving the plan unchanged.
          throw new Error(`Revision returned ${parsed.patches.length} patch${parsed.patches.length === 1 ? "" : "es"} but none could be applied. Try a full re-plan instead.`);
        }
        newPlan = applyResult.plan;
        partialReasons = applyResult.skipped;
        if (applyResult.appliedFindingIds.length > 0) {
          // Normal path: the model copies finding_id onto each patch (required
          // by the tool schema), so attribute precisely — a selected finding is
          // "applied" only if one of its patches genuinely landed. This catches
          // BOTH dropped-by-skip and never-patched findings; never over-claim.
          const appliedSet = new Set(applyResult.appliedFindingIds);
          appliedFindings = applyFindings.filter(f => appliedSet.has(f.id));
          unappliedFindings = applyFindings.filter(f => !appliedSet.has(f.id));
        } else if (applyResult.skipped.length > 0) {
          // No attribution data AND some patches failed — can't safely claim any
          // specific finding landed, so mark none and offer a full re-plan.
          appliedFindings = [];
          unappliedFindings = applyFindings;
        }
        // else: no finding_ids returned and nothing skipped → every patch
        // landed; preserve the historical happy path (all selected applied).
      } else {
        if (!parsed || !Array.isArray(parsed.days) || parsed.days.length === 0) throw new Error("Revision returned no plan.");
        newPlan = parsed;
      }
      // Record ONLY truly-applied findings — never the full selected set when
      // some were skipped. This is the honesty-critical line.
      const newAppliedIds = Array.from(new Set([...appliedIds, ...appliedFindings.map(f => f.id)]));
      setAppliedIds(newAppliedIds);
      // Clear the apply toggles for findings we just applied so the same
      // ones don't sit checked indefinitely. Leave un-applied findings checked
      // so the user can retry them.
      setApplyState(prev => {
        const next = { ...prev };
        for (const f of appliedFindings) next[f.id] = false;
        return next;
      });
      if (unappliedFindings.length > 0) {
        // Honest partial-apply: keep the changes that landed, but tell the user
        // exactly what didn't and offer a one-click full re-plan for the rest.
        const reasonText = partialReasons.slice(0, 3).join("; ");
        setPendingRetryIds(unappliedFindings.map(f => f.id));
        setNotice(`Applied ${appliedFindings.length} of ${applyFindings.length} change${applyFindings.length === 1 ? "" : "s"}. ${unappliedFindings.length} couldn't be applied automatically${reasonText ? ` (${reasonText})` : ""}. Use "Re-plan to apply the rest" below.`);
        setStatus("done");
      } else {
        setPendingRetryIds([]);
        setStatus("applied");
        setTimeout(() => setStatus("done"), 2500);
        // #10 — once an Apply fully lands, collapse the report so the revised
        // plan is what the user sees first. A partial apply (the if-branch
        // above) stays expanded so the "Re-plan to apply the rest" affordance
        // remains visible without an extra tap.
        setCollapsed(true);
      }
      if (typeof onPlanRevised === "function") {
        onPlanRevised(newPlan);
      }
      if (typeof onReviewChange === "function") {
        onReviewChange({
          sources: selectedIds,
          review,
          applied_ids: newAppliedIds,
          generatedAt: new Date().toISOString(),
          last_mode: applyMode,
          apply_mode_choice: applyModeChoice,
        });
      }
    } catch (err) {
      const cls = classifyApplyError(err, { aborted: controller.signal.aborted, timedOut });
      if (cls.kind === "cancelled") setError("Apply cancelled.");
      else if (cls.message) setError(cls.message);
      else setError(cleanErrorMessage(err?.message, "Apply failed."));
      setStatus("done");
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      abortRef.current = null;
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  // #8 part 2b — Auto-apply effect. When applyModeChoice === "auto" and a fresh
  // review just landed in "done" state with no applies yet, queue every finding
  // flagged default_apply: true and fire one handleApply automatically. The
  // user still sees the apply progress card (status "applying") and the
  // applied changelog afterwards via the existing surface. Guarded by
  // autoApplySigRef so a re-render or status oscillation can't double-fire,
  // and by appliedIds.length === 0 so a partial-apply retry cycle can't
  // reawaken auto-apply. Placed AFTER handleApply's definition so the lint
  // rule "Cannot access variable before it is declared" stays satisfied
  // (handleApply is a const, not a hoisted function declaration).
  useEffect(() => {
    if (applyModeChoice !== "auto") return;
    if (status !== "done") return;
    if (!review || !Array.isArray(review.findings) || review.findings.length === 0) return;
    if (appliedIds.length > 0) return;          // user (or a prior auto fire) already applied for this review
    const defaultApply = review.findings.filter(f => f.default_apply && !appliedIds.includes(f.id));
    if (defaultApply.length === 0) return;       // nothing flagged default_apply: true — nothing to auto-fire
    // Stable per review: prefer generatedAt, fall back to the verdict hash.
    const sig = (review.generatedAt || review.verdict || "").slice(0, 64);
    if (!sig) return;
    if (autoApplySigRef.current === sig) return; // already auto-applied for this review
    autoApplySigRef.current = sig;
    handleApply({ findingsOverride: defaultApply });
    // handleApply is a stable closure recreated each render; the sig ref above
    // guards against double-fire. applyState is intentionally NOT a dep — we
    // pass the default-apply set explicitly via findingsOverride so a slow
    // setApplyState propagation can't make us apply the wrong subset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyModeChoice, status, review, appliedIds.length]);

  const togglePickerSource = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleFindingApply = (fid) => {
    setApplyState(prev => ({ ...prev, [fid]: !prev[fid] }));
    // Clear any stale apply error (e.g. "Apply cancelled." from a previous
    // attempt) so it doesn't sit under the queued-changes button next to
    // fresh selections, which looks like the current selection is failing.
    if (error) setError("");
    if (notice) setNotice("");
  };

  // ----- shared styles ---------------------------------------------------
  const cardStyleLocal = { border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", padding: "14px 16px", marginBottom: "1.25rem", background: "var(--color-background-primary)" };
  const sectionLabel = { fontSize: "10.5px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 6px" };

  // ----- render ----------------------------------------------------------
  return (
    <div className="no-print">
      {/* PICKER MODAL */}
      {pickerOpen && (
        <ReviewPickerModal
          selectedIds={selectedIds}
          onToggle={togglePickerSource}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* IDLE — banner with picker + Run */}
      {status === "idle" && (
        <div style={cardStyleLocal}>
          <p style={sectionLabel}>Professional review</p>
          <p style={{ fontSize: "14px", color: "var(--color-text-primary)", margin: "0 0 4px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>
            Have your plan reviewed by a panel of luxury-travel experts.
          </p>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 12px", lineHeight: 1.55 }}>
            They&rsquo;ll flag what to fix, what to upgrade, and what to skip. You pick which changes to apply.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
            {/* Pill rendering: hyperlocal sources get a slightly different
                visual treatment (lighter background, gold border + bold name)
                so the user can SEE that the picker auto-added a destination-
                specific layer on top of the generic defaults. Standard pills
                keep the solid-gold treatment. */}
            {selectedSources.map(s => s.lens === "hyperlocal" ? (
              <span key={s.id} title={`Hyperlocal source for ${hyperlocalRegion?.label || "this destination"}`} style={{ fontSize: "10.5px", color: GOLD_DARK, background: GOLD_LIGHT, padding: "3px 9px", borderRadius: "999px", border: `0.5px solid ${GOLD}`, letterSpacing: "0.02em", fontWeight: 700, whiteSpace: "nowrap" }}>{s.name}</span>
            ) : (
              <span key={s.id} style={{ fontSize: "10.5px", color: ON_NAVY, background: GOLD, padding: "3px 9px", borderRadius: "999px", letterSpacing: "0.02em", fontWeight: 600, whiteSpace: "nowrap" }}>{s.name}</span>
            ))}
            <button onClick={() => setPickerOpen(true)} style={{ fontSize: "10.5px", color: GOLD, background: "transparent", border: `0.5px dashed ${GOLD}`, padding: "3px 9px", borderRadius: "999px", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em", fontWeight: 600 }}>+ Change sources</button>
          </div>
          {hyperlocalRegion && selectedSources.some(s => s.lens === "hyperlocal") && (
            <p style={{ fontSize: "10.5px", color: GOLD_DARK, margin: "0 0 8px", fontWeight: 600, lineHeight: 1.4 }}>
              <span aria-hidden="true">◉ </span>
              Hyperlocal sources auto-added for {hyperlocalRegion.label}.
            </p>
          )}
          <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: "0 0 12px", fontStyle: "italic" }}>
            Why these? They cover taste (CN Traveler), food (Michelin), pacing (NYT 36 Hours), and ground-truth (Reddit + locals){hyperlocalRegion ? ", plus destination-specific local papers and the tourism board" : ""}. Add more for hotel-specific or scene-specific feedback.
          </p>
          {/* #8 part 2b — Apply-mode toggle. Sets what happens when findings
              land: auto-apply the default-flagged ones in one pass (with the
              changelog still visible), or approve each finding manually.
              Default auto per the wiki spec; saved trips carry the user's
              prior choice via initialReview.apply_mode_choice. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", padding: "8px 10px", marginBottom: "10px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)" }}>
            <p style={{ fontSize: "10.5px", color: "var(--color-text-secondary)", margin: 0, letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 600 }}>
              When findings land
            </p>
            <div role="radiogroup" aria-label="Apply mode" style={{ display: "flex", gap: "4px" }}>
              {[
                { id: "auto", label: "Auto-apply", title: "As soon as the review lands, apply every recommended change in one pass. You'll see what changed in the changelog." },
                { id: "approve_each", label: "Approve each", title: "Review findings one by one and pick which to apply." },
              ].map(opt => {
                const active = applyModeChoice === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setApplyModeChoice(opt.id)}
                    title={opt.title}
                    style={{
                      fontSize: "10.5px",
                      letterSpacing: "0.04em",
                      fontWeight: active ? 700 : 500,
                      color: active ? ON_NAVY : "var(--color-text-secondary)",
                      background: active ? GOLD : "transparent",
                      border: `0.5px solid ${active ? GOLD : "var(--color-border-secondary)"}`,
                      borderRadius: "999px",
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <button onClick={handleRunReview} style={{ width: "100%", border: "none", borderRadius: "var(--border-radius-md)", padding: "12px 18px", fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "var(--color-text-primary)", color: ON_NAVY }}>
            Run review (~45 sec)
          </button>
          {error && <p style={{ fontSize: "11.5px", color: "var(--color-text-danger)", margin: "8px 0 0", textAlign: "center" }}>{error}</p>}
        </div>
      )}

      {/* RUNNING (review) or APPLYING (revision) */}
      {(status === "running" || status === "applying") && (
        <div style={cardStyleLocal}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px", gap: "10px" }}>
            <p style={{ ...sectionLabel, margin: 0 }}>{status === "running" ? "Review in progress" : "Applying changes"}</p>
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0, fontVariantNumeric: "tabular-nums" }}>
              {progress > 0 ? `${Math.round(progress * 100)}%` : ""}{elapsedSec > 0 ? `  ·  ${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,'0')}` : ""}
            </p>
          </div>
          <p style={{ fontSize: "12.5px", color: "var(--color-text-primary)", margin: "0 0 8px" }}>{progressLabel || "Working…"}</p>
          <div style={{ height: "5px", borderRadius: "3px", background: "var(--color-border-tertiary, var(--color-border-tertiary))", overflow: "hidden", position: "relative" }}>
            {progress > 0 ? (
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(progress * 100)}%`, background: GOLD, transition: "width 0.3s ease-out", borderRadius: "3px" }} />
            ) : (
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "40%", background: GOLD, animation: "slideBar 1.6s ease-in-out infinite" }} />
            )}
          </div>
          <button onClick={handleCancelReview} style={{ marginTop: "10px", width: "100%", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "9px 16px", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "transparent", color: "var(--color-text-primary)" }}>
            Cancel
          </button>
        </div>
      )}

      {/* #10 — Collapsed one-line summary after a successful Apply. Shown
          when the user has applied at least one finding (so the plan on
          screen is newer than the findings list above it). "Show details"
          expands the full findings card back; "Revalidate" kicks off a fresh
          review run. */}
      {(status === "done" || status === "applied") && review && collapsed && (
        <div style={{ ...cardStyleLocal, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", padding: "10px 14px" }}>
          <p style={{ ...sectionLabel, margin: 0, color: "var(--color-text-secondary)" }}>
            Expert review
            {appliedIds.length > 0 && (
              <span style={{ color: "var(--color-text-tertiary)", fontWeight: 500, letterSpacing: "normal", textTransform: "none" }}>
                {`  ·  ${appliedIds.length} change${appliedIds.length === 1 ? "" : "s"} applied`}
              </span>
            )}
          </p>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button
              onClick={() => setCollapsed(false)}
              style={{ fontSize: "10.5px", color: "var(--color-text-secondary)", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
            >
              Show details
            </button>
            <button
              onClick={() => { setStatus("idle"); setReview(null); setCollapsed(false); }}
              style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
            >
              Revalidate
            </button>
          </div>
        </div>
      )}

      {/* DONE — verdict + findings */}
      {(status === "done" || status === "applied") && review && !collapsed && (
        <div style={cardStyleLocal}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "8px", marginBottom: "8px" }}>
            <p style={{ ...sectionLabel, margin: 0 }}>Review by {selectedSources.length} source{selectedSources.length !== 1 ? "s" : ""}</p>
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              {appliedIds.length > 0 && (
                <button
                  onClick={() => setCollapsed(true)}
                  style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
                  title="Collapse to a one-line summary"
                >
                  Collapse
                </button>
              )}
              <button onClick={() => { setStatus("idle"); setReview(null); setCollapsed(false); }} style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                Re-run review
              </button>
            </div>
          </div>
          <p style={{ fontSize: "15px", color: "var(--color-text-primary)", margin: "0 0 10px", lineHeight: 1.5, fontFamily: "var(--font-serif)", fontStyle: "italic" }}>{review.verdict}</p>
          {findings.length > 0 && (
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
              {criticalCount > 0 && <span style={{ color: "var(--color-text-danger)", fontWeight: 600 }}>{criticalCount} critical</span>}
              {criticalCount > 0 && (suggestedCount + niceCount) > 0 && <span>  ·  </span>}
              {suggestedCount > 0 && <span>{suggestedCount} suggested</span>}
              {suggestedCount > 0 && niceCount > 0 && <span>  ·  </span>}
              {niceCount > 0 && <span style={{ color: "var(--color-text-tertiary)" }}>{niceCount} nice</span>}
            </p>
          )}
          {findings.length === 0 && (
            <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 4px", fontStyle: "italic" }}>
              No notes — the panel signed off as-is.
            </p>
          )}
          {findings.length > 0 && (() => {
            const applicable = findings.filter(f => !appliedIds.includes(f.id));
            const allChecked = applicable.length > 0 && applicable.every(f => applyState[f.id]);
            const noneChecked = applicable.every(f => !applyState[f.id]);
            // User reported the 'accept all' control was 'broken'. Two issues:
            //   1. Findings ship with default_apply: true on most items, so by
            //      the time the user looks at the panel, allChecked is already
            //      true — and the button was disabled, looking dead/broken.
            //   2. Label 'Select all' didn't match the user's mental model of
            //      'accept all recommendations'.
            // Fix: never disable Queue all when it's the no-op state; instead
            // give it an inert pill-style 'All queued' label so the user can
            // see at a glance that the panel is already set up to apply
            // everything. The actual revision still fires from the bottom CTA.
            return (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", margin: "4px 0 6px", padding: "10px 12px", background: "var(--color-background-secondary, var(--color-background-secondary))", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)" }}>
                <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.4, flex: "1 1 180px" }}>
                  {allChecked
                    ? `All ${applicable.length} change${applicable.length === 1 ? "" : "s"} selected. Hit Apply at the bottom to revise the plan.`
                    : noneChecked
                      ? "Select the changes you want, then hit Apply at the bottom."
                      : `Pick which changes to include — toggle each one to add or remove it.`}
                </p>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {allChecked ? (
                    // Inert state: don't show a broken-looking grayed button.
                    // A simple checkmark pill communicates 'this is already done'.
                    <span style={{ fontSize: "10.5px", color: GOLD, background: "transparent", border: `0.5px solid ${GOLD}`, padding: "4px 10px", borderRadius: "3px", fontFamily: "inherit", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700 }}>
                      ✓ All included
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setApplyState(prev => {
                          const next = { ...prev };
                          for (const f of applicable) next[f.id] = true;
                          return next;
                        });
                      }}
                      title="Include every change"
                      style={{ fontSize: "10.5px", color: ON_NAVY, background: GOLD, border: `0.5px solid ${GOLD}`, padding: "4px 10px", borderRadius: "3px", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700 }}
                    >
                      Include all
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setApplyState(prev => {
                        const next = { ...prev };
                        for (const f of applicable) next[f.id] = false;
                        return next;
                      });
                    }}
                    disabled={noneChecked}
                    title="Remove every change"
                    style={{ fontSize: "10.5px", color: noneChecked ? "var(--color-text-tertiary)" : "var(--color-text-secondary)", background: "transparent", border: `0.5px solid ${noneChecked ? "var(--color-border-tertiary)" : "var(--color-border-secondary)"}`, padding: "4px 10px", borderRadius: "3px", cursor: noneChecked ? "default" : "pointer", fontFamily: "inherit", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}
                  >
                    Clear selection
                  </button>
                </div>
              </div>
            );
          })()}
          {findings.map(f => (
            <FindingCard
              key={f.id}
              finding={f}
              checked={!!applyState[f.id]}
              alreadyApplied={appliedIds.includes(f.id)}
              onToggle={() => toggleFindingApply(f.id)}
            />
          ))}

          {/* Bottom Apply CTA. The per-finding buttons above only TOGGLE a
              finding into the apply-queue; this button is what actually
              runs the revision against the plan. When nothing is queued we
              still show a disabled-looking hint so the user knows where the
              actual trigger lives. */}
          {selectedForApply.length > 0 ? (
            <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: `1px solid ${GOLD}` }}>
              <p style={{ fontSize: "11.5px", color: "var(--color-text-primary)", margin: "0 0 8px", fontWeight: 600 }}>
                {selectedForApply.length} change{selectedForApply.length === 1 ? "" : "s"} selected ·&nbsp;
                <span style={{ color: GOLD, fontWeight: 700 }}>
                  ~{revisionMode === "surgical" ? "30 sec" : "2 min"}
                </span>
              </p>
              <button onClick={handleApply} style={{ width: "100%", border: "none", borderRadius: "var(--border-radius-md)", padding: "14px 18px", fontSize: "12px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "var(--color-text-primary)", color: ON_NAVY }}>
                {`→ Apply ${selectedForApply.length} change${selectedForApply.length === 1 ? "" : "s"}`}
              </button>
            </div>
          ) : findings.length > 0 && (
            // Nothing queued yet — show an inert hint so the user knows the
            // per-finding 'Apply this change' buttons above just QUEUE, and
            // this footer is where the actual revision will fire from.
            <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
              <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: 0, textAlign: "center", fontStyle: "italic" }}>
                Pick one or more changes above, then the apply button will appear here.
              </p>
            </div>
          )}
          {status === "applied" && (
            <p style={{ marginTop: "10px", fontSize: "12px", color: GOLD, textAlign: "center", fontWeight: 600 }}>✓ Changes applied to your plan.</p>
          )}
          {notice && status !== "applying" && (
            <div style={{ marginTop: "10px", padding: "10px 12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary, var(--color-background-secondary))" }}>
              <p style={{ fontSize: "11.5px", color: "var(--color-text-primary)", margin: 0, lineHeight: 1.45 }}>{notice}</p>
              {pendingRetryIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const retry = findings.filter(f => pendingRetryIds.includes(f.id));
                    if (retry.length === 0) return;
                    setNotice("");
                    handleApply({ findingsOverride: retry, forceMode: "full" });
                  }}
                  style={{ marginTop: "8px", width: "100%", border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", padding: "10px 14px", fontSize: "11px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "var(--color-text-primary)", color: ON_NAVY }}
                >
                  {`↻ Re-plan to apply the rest (${pendingRetryIds.length})`}
                </button>
              )}
            </div>
          )}
          {error && <p style={{ fontSize: "11.5px", color: "var(--color-text-danger)", margin: "8px 0 0", textAlign: "center" }}>{error}</p>}

          {/* User-authored change request — lets the traveler ask for a
              specific swap on top of (or instead of) the panel findings. */}
          <ChangeRequestCard
            plan={plan}
            inputs={inputs}
            onPlanRevised={onPlanRevised}
            variant="review"
          />
        </div>
      )}
    </div>
  );
}

// Picker modal — bottom-sheet style on mobile. Multi-select gold chips,
// grouped by lens. Tap a chip to toggle. Tap Done to close.
function ReviewPickerModal({ selectedIds, onToggle, onClose }) {
  const lensOrder = ["editorial", "hotels", "restaurants", "local"];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,15,15,0.6)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "640px", maxHeight: "85vh", overflowY: "auto", background: "var(--color-background-primary, var(--color-background-primary))", borderTopLeftRadius: "16px", borderTopRightRadius: "16px", padding: "1.25rem 1.25rem 1.5rem", boxShadow: "0 -10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "1rem" }}>
          <p style={{ fontSize: "15px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: 0, color: "var(--color-text-primary)" }}>Reviewer panel</p>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: GOLD, fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>Done</button>
        </div>
        {lensOrder.map(lensId => {
          const lens = REVIEWER_LENSES.find(l => l.id === lensId);
          const sources = REVIEWER_SOURCES.filter(s => s.lens === lensId);
          return (
            <div key={lensId} style={{ marginBottom: "1.1rem" }}>
              <p style={{ fontSize: "10.5px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 3px" }}>{lens.label}</p>
              <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 8px", fontStyle: "italic", lineHeight: 1.5 }}>{lens.why}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {sources.map(s => {
                  const on = selectedIds.includes(s.id);
                  return (
                    <button key={s.id} onClick={() => onToggle(s.id)} style={{ fontSize: "11.5px", color: on ? ON_NAVY : GOLD, background: on ? GOLD : "transparent", border: `0.5px solid ${GOLD}`, padding: "6px 12px", borderRadius: "999px", cursor: "pointer", fontFamily: "inherit", fontWeight: on ? 600 : 500, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
                      {on ? "✓ " : ""}{s.name}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
                {sources.map(s => (
                  <p key={s.id + "_blurb"} style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: 0, fontStyle: "italic" }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>{s.name}</span> — {s.blurb}
                  </p>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Findings card — severity dot, target chip, source chip, summary, action, apply toggle.
// ============================================================================
// ChangeRequestCard — user-authored itinerary change requests.
//
// Lets the traveler type a specific change they want ("swap the hotel",
// "replace dinner Day 2", "slow Day 3 down") and feeds it into the same
// surgical / full-replan pipeline the Review panel uses. We synthesize a
// finding-shaped object so the existing Anthropic prompts and tool-calls
// work unchanged — no new server endpoint needed.
//
// Props:
//   plan         — current trip plan (for day/item counts, hotel/restaurant lookups)
//   inputs       — trip basics (destination, nights, budget) for prompt context
//   onPlanRevised— callback to lift the revised plan up to the parent
//   variant      — "toplevel" (always-visible above day-by-day) | "review" (inside ReviewPanel)
// ============================================================================
function ChangeRequestCard({ plan, inputs, onPlanRevised, variant = "toplevel" }) {
  const TARGETS = [
    { id: "hotel",      label: "Swap hotel",      mode_hint: "swap_hotel",      mode: "surgical", needsDay: true,  placeholder: "e.g. 'Move to a property with better ski-in/ski-out access' or 'Try the St. Regis instead'" },
    { id: "restaurant", label: "Swap restaurant", mode_hint: "swap_restaurant", mode: "surgical", needsDay: true,  placeholder: "e.g. 'Replace Day 2 dinner with something more casual' or 'Book Element 47 instead'" },
    { id: "activity",   label: "Swap activity",   mode_hint: "swap_activity",   mode: "surgical", needsDay: true,  placeholder: "e.g. 'Replace the museum visit with something outdoorsy' or 'Add a wine tasting'" },
    { id: "other",      label: "Other change",    mode_hint: "adjust_pacing",   mode: "full",     needsDay: false, placeholder: "e.g. 'Slow Day 3 down', 'Move base to a different neighborhood', 'Shift to a more family-friendly vibe'" },
    { id: "external_review", label: "Paste external review", mode_hint: "apply_external_review", mode: "full", needsDay: false, placeholder: "Paste a full evaluation from another LLM (Claude, GPT, Gemini…). Include verdict, every finding, every suggested swap. The planner will apply ALL changes in one pass." },
  ];

  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("hotel");
  const [dayIdx, setDayIdx] = useState(0);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const target = TARGETS.find(t => t.id === targetId) || TARGETS[0];
  const dayCount = Array.isArray(plan?.days) ? plan.days.length : 0;

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) { setError("Tell us what to change."); return; }
    setError("");
    setStatus("running");
    setProgress(0);
    setElapsedSec(0);
    const startedAt = Date.now();
    const targetSec = target.mode === "surgical" ? 35 : 160;
    setProgressLabel(target.mode === "surgical" ? "Applying your change…" : "Applying your change (detailed revision, ~2 min)…");
    let lastTokFrac = 0;
    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
      const timeFrac = Math.min(0.95, sec / targetSec);
      setProgress(prev => Math.max(prev, Math.max(lastTokFrac, timeFrac)));
    }, 250);

    // Fresh controller per invocation; hard-timeout is a backstop above
    // streamBuildJob's own budget (see handleApply / replanControl.js).
    const controller = freshAbortController();
    abortRef.current = controller;
    let timedOut = false;
    const hardTimeout = setTimeout(() => { timedOut = true; controller.abort(); }, replanTimeoutMs(target.mode));

    try {
      // Synthesize a finding-shaped object so we can reuse the existing
      // revision prompts/tool-calls verbatim. The day-targeted hint uses
      // {day: <1-indexed>} so the surgical patcher can find the right item.
      const isExternalReview = target.id === "external_review";
      const fakeFinding = {
        id: `user_${Date.now().toString(36)}`,
        severity: isExternalReview ? "critical" : "suggested",
        lens: isExternalReview ? "external_llm" : "user",
        source: isExternalReview ? "External LLM review" : "Traveler request",
        target: target.needsDay && dayCount > 0
          ? { day: dayIdx + 1, label: target.label }
          : (target.label || "plan-wide"),
        summary: isExternalReview
          ? "Apply the full external LLM review pasted below to this plan."
          : `Traveler-requested change: ${trimmed}`,
        action: trimmed,
        mode_hint: target.mode_hint,
        default_apply: true,
        // Stash the raw pasted text so the system prompt can include it
        // verbatim as an external-review block.
        external_review_text: isExternalReview ? trimmed : undefined,
      };

      const body = target.mode === "surgical"
        ? {
            model: "claude-sonnet-4-5",
            max_tokens: 8000,
            system: cachedSystem(buildRevisionSystemPromptSurgical(plan, [fakeFinding], inputs)),
            messages: [{ role: "user", content: buildRevisionUserPromptSurgical() }],
            tools: cachedTools([REVISION_TOOL_SURGICAL]),
            tool_choice: { type: "tool", name: "submit_revision_patches" },
          }
        : {
            model: "claude-sonnet-4-5",
            max_tokens: 32000,
            system: cachedSystem(buildRevisionSystemPromptFull(plan, [fakeFinding], inputs)),
            messages: [{ role: "user", content: buildRevisionUserPromptFull() }],
            tools: cachedTools([REVISION_TOOL_FULL]),
            tool_choice: { type: "tool", name: "submit_trip_plan" },
          };

      let toolJson = "";
      const { toolJson: finalJson } = await streamBuildJob(body, {
        signal: controller.signal,
        onDelta: (delta, totalLen) => {
          toolJson += delta;
          const estTokens = totalLen / 3.5;
          const tokFrac = Math.min(0.95, estTokens / (target.mode === "surgical" ? 1500 : 7000));
          lastTokFrac = tokFrac;
          setProgress(prev => Math.max(prev, tokFrac));
          if (target.mode === "surgical") {
            const pm = toolJson.match(/"op"\s*:/g) || [];
            setProgressLabel(pm.length ? `Applying patch ${pm.length}…` : "Reading plan…");
          } else {
            const dm = toolJson.match(/"label"\s*:\s*"/g) || [];
            setProgressLabel(dm.length ? `Day ${dm.length} of plan…` : "Re-planning…");
          }
        },
      });
      toolJson = finalJson;
      setProgress(1);
      setProgressLabel("Finalizing…");
      const { parsed } = parseToolJson(toolJson);
      let newPlan;
      if (target.mode === "surgical") {
        if (!parsed || !Array.isArray(parsed.patches)) throw new Error("Change returned no patches.");
        const applyResult = applyPatchesToPlan(plan, parsed.patches);
        if (applyResult.appliedCount === 0) {
          // Surgical mode returned zero applicable patches — most common
          // when the user picked the wrong day for the item they want to
          // change, or when the request is broader than a single card swap
          // (e.g. "remove Dry Tortugas, replace with something else" where
          // the excursion spans multiple items across days). Instead of
          // failing silently, transparently fall through to a full re-plan
          // using the same change text. Tell the user via the progress bar.
          setProgressLabel("Single-card change didn't fit \u2014 applying as a detailed revision…");
          // Build the full-replan body with the same change as a finding.
          const fullBody = {
            model: "claude-sonnet-4-5",
            max_tokens: 32000,
            system: cachedSystem(buildRevisionSystemPromptFull(plan, [fakeFinding], inputs)),
            messages: [{ role: "user", content: buildRevisionUserPromptFull() }],
            tools: cachedTools([REVISION_TOOL_FULL]),
            tool_choice: { type: "tool", name: "submit_trip_plan" },
          };
          // Reset progress for the longer call — keep elapsedTimer running so
          // the user sees continued progress instead of a frozen UI.
          lastTokFrac = 0;
          setProgress(0);
          let fullToolJson = "";
          const fullResult = await streamBuildJob(fullBody, {
            signal: controller.signal,
            onDelta: (delta, totalLen) => {
              fullToolJson += delta;
              const estTokens = totalLen / 3.5;
              const tokFrac = Math.min(0.95, estTokens / 7000);
              lastTokFrac = tokFrac;
              setProgress(prev => Math.max(prev, tokFrac));
              const dm = fullToolJson.match(/"label"\s*:\s*"/g) || [];
              setProgressLabel(dm.length ? `Re-plan: day ${dm.length}…` : "Re-planning…");
            },
          });
          fullToolJson = fullResult.toolJson;
          setProgress(1);
          const { parsed: fullParsed } = parseToolJson(fullToolJson);
          if (!fullParsed || !Array.isArray(fullParsed.days) || fullParsed.days.length === 0) {
            throw new Error("Could not apply your change. Try rephrasing (e.g. name the specific item and day) or pick 'Other change' for a full re-plan.");
          }
          newPlan = fullParsed;
        } else {
          newPlan = applyResult.plan;
        }
      } else {
        if (!parsed || !Array.isArray(parsed.days) || parsed.days.length === 0) throw new Error("Change returned no plan.");
        newPlan = parsed;
      }
      if (typeof onPlanRevised === "function") onPlanRevised(newPlan);
      setStatus("done");
      setText("");
      setTimeout(() => { setStatus("idle"); setOpen(false); }, 2500);
    } catch (err) {
      const cls = classifyApplyError(err, { aborted: controller.signal.aborted, timedOut });
      if (cls.kind === "cancelled") setError("Change cancelled.");
      else if (cls.message) setError(cls.message);
      else setError(cleanErrorMessage(err?.message, "Change failed."));
      setStatus("error");
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortRef.current) abortRef.current.abort();
  };

  // Don't render until there's a plan to act on.
  if (!plan?.days || plan.days.length === 0) return null;

  const cardStyle = {
    border: `0.5px dashed ${GOLD}`,
    borderRadius: "var(--border-radius-md)",
    padding: "14px 16px",
    marginBottom: variant === "toplevel" ? "1.25rem" : "0",
    marginTop: variant === "review" ? "14px" : "0",
    background: "var(--color-background-primary)",
  };
  const labelStyle = { fontSize: "10.5px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 6px" };

  // Collapsed teaser
  if (!open && status === "idle") {
    return (
      <div style={cardStyle}>
        <button onClick={() => setOpen(true)} style={{ width: "100%", border: "none", background: "transparent", padding: "4px 0", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <span>
            <span style={labelStyle}>Suggest a change</span>
            <span style={{ display: "block", fontSize: "12.5px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
              Want a different hotel, restaurant, activity, or pacing? Tell us what to change.
            </span>
          </span>
          <span style={{ flex: "0 0 auto", fontSize: "18px", color: GOLD, fontWeight: 300 }}>+</span>
        </button>
      </div>
    );
  }

  // Running
  if (status === "running") {
    return (
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px", gap: "10px" }}>
          <p style={{ ...labelStyle, margin: 0 }}>{target.mode === "surgical" ? "Applying your change" : "Re-planning your trip"}</p>
          <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0, fontVariantNumeric: "tabular-nums" }}>
            {progress > 0 ? `${Math.round(progress * 100)}%` : ""}{elapsedSec > 0 ? `  ·  ${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,'0')}` : ""}
          </p>
        </div>
        <p style={{ fontSize: "12.5px", color: "var(--color-text-primary)", margin: "0 0 8px" }}>{progressLabel || "Working…"}</p>
        <div style={{ height: "5px", borderRadius: "3px", background: "var(--color-border-tertiary, var(--color-border-tertiary))", overflow: "hidden", position: "relative" }}>
          {progress > 0 ? (
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(progress * 100)}%`, background: GOLD, transition: "width 0.3s ease-out", borderRadius: "3px" }} />
          ) : (
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "40%", background: GOLD, animation: "slideBar 1.6s ease-in-out infinite" }} />
          )}
        </div>
        <button onClick={handleCancel} style={{ marginTop: "10px", width: "100%", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "9px 16px", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "transparent", color: "var(--color-text-primary)" }}>
          Cancel
        </button>
      </div>
    );
  }

  // Success flash
  if (status === "done") {
    return (
      <div style={cardStyle}>
        <p style={{ margin: 0, fontSize: "13px", color: GOLD, textAlign: "center", fontWeight: 600 }}>✓ Change applied to your plan.</p>
      </div>
    );
  }

  // Open composer (idle or error)
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px", gap: "10px" }}>
        <p style={{ ...labelStyle, margin: 0 }}>Suggest a change</p>
        <button onClick={() => { setOpen(false); setStatus("idle"); setError(""); }} style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
          Close
        </button>
      </div>

      {/* Target type chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
        {TARGETS.map(t => {
          const active = t.id === targetId;
          return (
            <button
              key={t.id}
              onClick={() => {
                setTargetId(t.id);
                // Re-engaging with the composer should clear any stale
                // 'Change cancelled.' / 'Change failed.' error so the user
                // doesn't see an error message hovering over a fresh
                // selection, which reads like the new selection is failing.
                if (status === "error") { setStatus("idle"); setError(""); }
              }}
              style={{
                fontSize: "11px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                padding: "5px 11px",
                borderRadius: "999px",
                border: `0.5px solid ${active ? GOLD_DARK : "var(--color-border-secondary)"}`,
                background: active ? GOLD_LIGHT : "transparent",
                color: active ? GOLD_DARK : "var(--color-text-primary)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Day picker (only when the target is day-scoped) */}
      {target.needsDay && dayCount > 1 && (
        <div style={{ marginBottom: "10px" }}>
          <label style={{ display: "block", fontSize: "10.5px", color: "var(--color-text-secondary)", marginBottom: "4px", letterSpacing: "0.05em", textTransform: "uppercase" }}>
            Which day?
          </label>
          <select
            value={dayIdx}
            onChange={(e) => setDayIdx(parseInt(e.target.value, 10))}
            style={{ width: "100%", padding: "7px 9px", fontSize: "12.5px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-sm, 4px)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", fontFamily: "inherit" }}
          >
            {plan.days.map((d, i) => {
              const labelTxt = (d?.label && String(d.label).trim()) || (d?.date && String(d.date).trim()) || `Day ${i + 1}`;
              return <option key={i} value={i}>{`Day ${i + 1} — ${labelTxt}`}</option>;
            })}
          </select>
        </div>
      )}

      {/* Free-form description — NarrativeBox in compact mode gives us
          the same dictation affordance as the step-1 narrative box, sized
          for inline use. The mic auto-hides on browsers without Web Speech
          (e.g. Firefox), so typers see exactly the same textarea as before. */}
      <div style={{ marginBottom: "10px" }}>
        <NarrativeBox
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Same reasoning as the target-chip click handler above —
            // typing into the textarea is re-engagement and should clear
            // any stale error from the previous attempt.
            if (status === "error") { setStatus("idle"); setError(""); }
          }}
          placeholder={target.placeholder}
          size={target.id === "external_review" ? "large" : "compact"}
          minHeight={target.id === "external_review" ? "220px" : undefined}
          maxChars={target.id === "external_review" ? 8000 : undefined}
          hint={target.id === "external_review"
            ? "Paste the full evaluation — verdict, findings, suggested swaps. Up to ~8000 characters."
            : "Type or dictate. Be specific — name hotels, restaurants, times, neighborhoods, anything."}
        />
      </div>

      <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: "0 0 10px", fontStyle: "italic" }}>
        {target.id === "external_review"
          ? "Pastes the full external evaluation into the planner and re-plans the trip end-to-end — ~2 min."
          : target.mode === "surgical" ? "Quick card-level edit — ~30 sec." : "Detailed revision — ~2 min. Your existing plan stays intact; the model adjusts what you asked for."}
      </p>

      <button
        onClick={handleSubmit}
        disabled={!text.trim()}
        style={{
          width: "100%",
          border: "none",
          borderRadius: "var(--border-radius-md)",
          padding: "12px 18px",
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          cursor: text.trim() ? "pointer" : "not-allowed",
          fontFamily: "inherit",
          background: text.trim() ? "var(--color-text-primary)" : "var(--color-border-tertiary, var(--color-border-tertiary))",
          color: text.trim() ? GOLD : "var(--color-text-tertiary)",
          opacity: text.trim() ? 1 : 0.7,
        }}
      >
        {target.id === "external_review"
          ? "Apply external review"
          : target.mode === "surgical" ? "Apply change" : "Re-plan with this change"}
      </button>

      {error && <p style={{ fontSize: "11.5px", color: "var(--color-text-danger)", margin: "8px 0 0", textAlign: "center" }}>{error}</p>}
    </div>
  );
}

function FindingCard({ finding, checked, alreadyApplied, onToggle }) {
  const sev = finding.severity || "suggested";
  const sevColor = sev === "critical" ? "var(--color-text-danger)" : sev === "suggested" ? GOLD : "var(--color-text-secondary)";
  const sevLabel = sev === "critical" ? "Critical" : sev === "suggested" ? "Suggested" : "Nice";
  return (
    <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", padding: "12px 0 4px", opacity: alreadyApplied ? 0.55 : 1 }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
        <span style={{ flex: "0 0 auto", marginTop: "5px", width: "8px", height: "8px", borderRadius: "50%", background: sevColor }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "4px", alignItems: "baseline" }}>
            <span style={{ fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: sevColor, padding: "2px 6px", border: `0.5px solid ${sevColor}`, borderRadius: "3px" }}>{sevLabel}</span>
            {finding.target && <span style={{ fontSize: "10.5px", color: "var(--color-text-primary)", background: "var(--color-background-secondary, var(--color-background-secondary))", padding: "2px 7px", borderRadius: "3px", border: "0.5px solid var(--color-border-tertiary)" }}>{formatFindingTarget(finding.target)}</span>}
            {finding.source && <span style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", fontStyle: "italic" }}>via {finding.source}</span>}
          </div>
          <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 4px", lineHeight: 1.5 }}>{finding.summary}</p>
          {finding.action && <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}><span style={{ color: GOLD, fontWeight: 600, marginRight: "4px" }}>→</span>{finding.action}</p>}
          {alreadyApplied ? (
            <p style={{ marginTop: "8px", fontSize: "11px", color: GOLD, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", margin: "8px 0 0" }}>✓ Already applied</p>
          ) : (
            // Toggle button. Labels describe the CURRENT STATE so the user can
            // tell at a glance which findings are queued. When checked = the
            // finding is in the apply-queue (filled gold pill, '✓ Will apply').
            // When unchecked = not queued (outlined, '+ Apply this change'
            // — the verb is the action a click takes). After picking one or
            // more, the bottom 'Apply quick edits' / 'Apply — full re-plan'
            // button below the findings list actually runs the revision.
            <button
              type="button"
              onClick={onToggle}
              aria-pressed={checked}
              title={checked ? "Click to remove this change from the selection" : "Click to include this change"}
              style={{
                marginTop: "8px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "11px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                padding: "6px 12px",
                borderRadius: "4px",
                border: `0.5px solid ${checked ? GOLD : "var(--color-border-secondary)"}`,
                background: checked ? GOLD : "transparent",
                /* #23 checked = navy fill, so label must be LIGHT (was navy-on-navy = invisible). */
                color: checked ? ON_NAVY : "var(--color-text-secondary)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <span style={{ fontSize: "12px", lineHeight: 1 }}>{checked ? "✓" : "+"}</span>
              <span>{checked ? "Included" : "Include this change"}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// IntroductionAutoGenerator (headless)
//
// Generates the trip introduction after a build via the lightweight
// /api/introduction endpoint and persists it onto data.introduction through
// onPlanRevised, so the PDF renderer (renderIntroduction in itineraryPdf.js)
// can show it as the intro page. The PDF reads two fields off the plan:
//   data.introduction.arc             — Part 1, The Arc of the Journey
//   data.introduction.differentiators — Part 2, What Makes This Itinerary Different
// or treats data.introduction.differentiators === 'NONE_FLAGGED' as the
// honest-no-differentiators state.
//
// This component renders NOTHING on screen — the introduction is a PDF-only
// artifact. (It previously also rendered as an on-screen paste/edit card on
// the result page; that visible UI was removed by request — intro now appears
// only at the top of the PDF.) Generation runs once per distinct build and
// never clobbers an existing intro (guard lives in applyGeneratedIntroduction).
// --------------------------------------------------------------------------

// Stable signature for a built plan so the auto-generate effect fires once
// per distinct build (and after a failed auto-attempt, doesn't retry in a
// loop). Cheap fields only — destination, day count, first/last day labels.
function introPlanSignature(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const first = days[0]?.label || "";
  const last = days[days.length - 1]?.label || "";
  return `${plan?.destination || ""}|${days.length}|${first}|${last}`;
}

// #12 Headless flight-number resolver. Mirrors IntroductionAutoGenerator: a
// post-build component that fills MISSING data on the canonical plan and
// persists it via onPlanRevised so the PDF (and every consumer) sees it.
//
// Why this (not a card-level mutation): applyQualityLayer strips fabricated
// model flight numbers and the rendered `data` is a re-derived copy, so an
// in-place mutation in FlightCard never reaches the PDF. Persisting to the
// CANONICAL plan (rawData) here, with a _scheduleVerified flag, survives the
// re-memo and is exempted from the strip (see applyQualityLayer). Result: the
// number the user sees on screen is the same one written into the plan and the
// PDF — no export delay, no screen/PDF mismatch.
//
// Runs once per build, resolves only flights that have NO usable number, and
// is fully resilient — any failure is silent and never touches the itinerary.
function FlightNumberAutoResolver({ plan, onPlanRevised }) {
  const attemptedRef = useRef("");
  useEffect(() => {
    const days = Array.isArray(plan?.days) ? plan.days : [];
    if (days.length === 0 || typeof onPlanRevised !== "function") return;
    const sig = introPlanSignature(plan);
    if (attemptedRef.current === sig) return;
    attemptedRef.current = sig;
    let cancelled = false;

    // Collect flights the resolver should act on. flightNeedsResolve
    // classifies each as:
    //   - "number": model omitted the number (full resolve, may also
    //     backfill times)
    //   - "times":  model emitted the number but missing one or both
    //     clock times (Gap 2 — PR #84 used to bail entirely on these)
    //   - null: skip entirely
    // Collect targets the resolver can act on AND verify-mode flights
    // we cannot reach the API for (missing airport code or unparseable
    // day label). The latter MUST still get _scheduleVerified written
    // so applyQualityLayer's strip doesn't null the model's number —
    // that's the precondition-failure recurrence path. See peer-review
    // note 'Possibility A' in this PR's description.
    const targets = [];
    const verifyTrustOnly = [];
    days.forEach((d, di) => {
      (Array.isArray(d.items) ? d.items : []).forEach((it, ii) => {
        if (it?.type !== "Flight" || !it.flight) return;
        const mode = flightNeedsResolve(it.flight);
        if (!mode) return;
        const fromCode = normalizeAirportCode(it.flight.from_airport);
        const toCode = normalizeAirportCode(it.flight.to_airport);
        const isoDate = parseDayLabelToISODate(d.label);
        if (!fromCode || !toCode || !isoDate) {
          // Precondition failure: cannot reach the API. For verify-mode
          // (model emitted a complete-looking flight) AND times-mode
          // (model emitted a number but no times), trust the model's
          // number and mark _scheduleVerified so the strip exemption
          // fires — better to show a potentially-wrong number than to
          // strip it entirely and show nothing. Number-mode stays silent
          // because there was no number to display in the first place.
          if (mode === "verify" || mode === "times") {
            verifyTrustOnly.push({ di, ii });
          }
          return;
        }
        targets.push({ di, ii, fl: it.flight, fromCode, toCode, isoDate, mode });
      });
    });
    if (targets.length === 0 && verifyTrustOnly.length === 0) return;

    // Per-flight: call /api/flights-search with the airline filter;
    // retry route-only when the filter returns zero rows (Gap 1
    // recovery, see concepts/flight-resolver-gaps.md). Build the
    // merge payload via the pure helpers in flightResolver.js;
    // accumulate either a positive resolve or a _timesUnconfirmed
    // fallback per target.
    (async () => {
      const resolved = [];
      // Precondition-failure verify-mode flights: write _scheduleVerified +
      // _verifyTrusted with no merge of times/aircraft — we never reached
      // the API for these, so the model's emitted times stay untouched.
      for (const vt of verifyTrustOnly) {
        resolved.push({
          di: vt.di,
          ii: vt.ii,
          merge: {
            _scheduleVerified: true,
            _verifyTrusted: true,
            _resolveSource: "verify-precondition-skipped",
          },
        });
      }
      for (const t of targets) {
        const iata = resolveAirlineIata(t.fl.carrier);
        const approx = parseClockToMinutes(t.fl.depart_time);
        let pick = null;
        let source = null;

        // Attempt 1: airline-filtered query (existing behavior).
        // Special case for verify-mode: prefer the row whose number
        // exactly matches the model's emitted number first. If the
        // exact number is in the airline-filtered pool, that's the
        // confirmation case and we get _scheduleVerified without
        // _autoResolvedFlightNumber. Otherwise fall back to the
        // time-proximity pick (substitution case).
        if (iata) {
          try {
            const params = new URLSearchParams({ date: t.isoDate, origin: t.fromCode, destination: t.toCode, airline: iata });
            const res = await fetch(`/api/flights-search?${params}`);
            const j = await res.json().catch(() => ({}));
            if (j.ok && Array.isArray(j.flights) && j.flights.length > 0) {
              if (t.mode === "verify" && t.fl.flight_number) {
                const wanted = String(t.fl.flight_number).trim().toUpperCase();
                const exact = j.flights.find(x => typeof x.flightNumber === "string" && x.flightNumber.toUpperCase() === wanted);
                pick = exact || pickFromPool({ flights: j.flights, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
              } else {
                pick = pickFromPool({ flights: j.flights, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
              }
              if (pick) source = "airline";
            }
          } catch {
            // Silent — falls through to the route-only retry.
          }
        }

        // Attempt 2: route-only retry when the airline-filter miss
        // returned nothing. Recovers the false-negative case the
        // production probe surfaced (EWR-LAX-AA returns 0 with the
        // airline filter but 15 without). Carrier-match is enforced
        // strictly in BOTH modes so we never lift cross-carrier times
        // (the codeshare honesty rule applies to times the same way it
        // applies to numbers — an AA flight cannot honestly inherit an
        // NH redeye's clock times just because they share a route).
        if (!pick) {
          try {
            const params = new URLSearchParams({ date: t.isoDate, origin: t.fromCode, destination: t.toCode });
            const res = await fetch(`/api/flights-search?${params}`);
            const j = await res.json().catch(() => ({}));
            if (j.ok && Array.isArray(j.flights) && j.flights.length > 0) {
              if (t.mode === "times" && t.fl.flight_number) {
                // times-mode: ONLY accept the row whose number exactly
                // matches the model's emitted number. No cross-carrier
                // fallback — better to render an honest "check with
                // airline" line than lift wrong-carrier times.
                const wanted = String(t.fl.flight_number).trim().toUpperCase();
                const exact = j.flights.find(x => typeof x.flightNumber === "string" && x.flightNumber.toUpperCase() === wanted);
                pick = exact || null;
              } else if (t.mode === "verify" && t.fl.flight_number && iata) {
                // verify-mode: model emitted a complete flight. First
                // try the EXACT number match (confirmation case) so
                // the merge can write _scheduleVerified without setting
                // _autoResolvedFlightNumber. If the API doesn't have
                // that exact number, fall back to a carrier-matched
                // time-proximity pick (substitution case) so the
                // schedule's number replaces the model's fabricated one.
                // pre-filter by carrier IATA to guarantee no cross-carrier
                // pick can sneak through (same rule PR #108 enforced).
                const wanted = String(t.fl.flight_number).trim().toUpperCase();
                const exact = j.flights.find(x => typeof x.flightNumber === "string" && x.flightNumber.toUpperCase() === wanted);
                if (exact) {
                  pick = exact;
                } else {
                  const filtered = j.flights.filter(x => typeof x.flightNumber === "string" && x.flightNumber.toUpperCase().startsWith(iata.toUpperCase()));
                  if (filtered.length > 0) {
                    pick = pickFromPool({ flights: filtered, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
                  }
                }
              } else if (t.mode === "number" && iata) {
                // number-mode: pre-filter the pool to carrier-matching
                // rows before picking. pickFromPool's internal fallback
                // (filtered empty → use full pool) would otherwise let a
                // cross-carrier candidate through; buildMergePayload's
                // downgrade would then lift its times onto the wrong-
                // carrier flight. Filter here so the downgrade never has
                // cross-carrier material to work with.
                const filtered = j.flights.filter(x => typeof x.flightNumber === "string" && x.flightNumber.toUpperCase().startsWith(iata.toUpperCase()));
                if (filtered.length > 0) {
                  pick = pickFromPool({ flights: filtered, airlineIata: iata, approxMinutes: approx, pickScheduledFlight });
                }
              } else {
                // No carrier known (mode === "number" with no IATA, or
                // any other path) → existing behavior. buildMergePayload
                // still gates number-lifts on prefix match.
                pick = pickFromPool({ flights: j.flights, airlineIata: null, approxMinutes: approx, pickScheduledFlight });
              }
              if (pick) source = "route-only";
            }
          } catch {
            // Silent — falls through to the _timesUnconfirmed fallback.
          }
        }

        if (pick) {
          const merge = buildMergePayload({ mode: t.mode, pick, currentFlight: t.fl, source, airlineIata: iata });
          if (merge) {
            resolved.push({ di: t.di, ii: t.ii, merge });
            continue;
          }
        }

        // Verify-mode total miss: model emitted a complete flight but
        // the schedule API couldn't confirm or substitute. We CANNOT
        // call buildUnconfirmedTimesPayload here because the flight
        // already has both times — that helper would return null, the
        // resolver would push nothing, and applyQualityLayer's strip
        // would null the model's number leaving the user with a blank.
        // This is the exact recurrence we are closing. Instead, write
        // a verify-trusted payload: keep the model's number and times,
        // mark _scheduleVerified so applyQualityLayer's exemption
        // protects the number, and tag _verifyTrusted so downstream
        // tooling (PDF qualifier, future audits) can distinguish a
        // truly schedule-confirmed flight from a fallback-trusted one.
        if (t.mode === "verify" && t.fl.flight_number) {
          resolved.push({
            di: t.di,
            ii: t.ii,
            merge: {
              _scheduleVerified: true,
              _verifyTrusted: true,
              _resolveSource: "verify-fallback",
            },
          });
          continue;
        }

        // Total miss path for number/times modes: when even the route-only
        // retry came up empty AND the flight has no times to begin with,
        // persist _timesUnconfirmed so the PDF can render an honest line
        // ("Times not yet confirmed — check with airline at booking")
        // instead of a blank.
        const fallback = buildUnconfirmedTimesPayload(t.fl);
        if (fallback) resolved.push({ di: t.di, ii: t.ii, merge: fallback });
      }

      if (cancelled || resolved.length === 0) return;

      // Build an immutable next plan with the resolved fields merged
      // into the canonical plan via onPlanRevised. applyQualityLayer
      // exempts _scheduleVerified numbers from the strip; PDF reads
      // both _autoResolvedFlightNumber (for the "verify at booking"
      // qualifier) and _timesUnconfirmed (for the honest-fallback line).
      const nextDays = plan.days.map((d, di) => {
        const hits = resolved.filter(r => r.di === di);
        if (hits.length === 0) return d;
        const items = d.items.map((it, ii) => {
          const hit = hits.find(h => h.ii === ii);
          if (!hit) return it;
          return { ...it, flight: { ...it.flight, ...hit.merge } };
        });
        return { ...d, items };
      });
      onPlanRevised({ ...plan, days: nextDays });
    })();

    return () => { cancelled = true; attemptedRef.current = ""; };
  }, [plan, onPlanRevised]);
  return null;
}

function IntroductionAutoGenerator({ plan, inputs, onPlanRevised, onGeneratingChange }) {
  // Tracks the plan signature we've already auto-attempted so the effect fires
  // once per build and never auto-retries a failure.
  const autoAttemptedRef = useRef("");

  // Lift the in-flight state out to the parent (ItineraryView) so the PDF
  // download button can gate on it. We KEEP a local mirror so this component
  // stays self-contained when no callback is provided (existing tests / any
  // other mount site keep working). The parent reads it via onGeneratingChange.
  // Failure flips it back to false the same as success — a silent server
  // error must never leave the gate permanently closed.
  const [isGenerating, setIsGenerating] = useState(false);
  const reportGeneratingChange = useCallback((value) => {
    setIsGenerating(value);
    if (typeof onGeneratingChange === "function") onGeneratingChange(value);
  }, [onGeneratingChange]);

  // Generate the introduction via the lightweight /api/introduction endpoint
  // and persist it through onPlanRevised, only when the plan carries no
  // introduction yet. Runs once per distinct build. Resilient by design — a
  // failure here is silent and never touches the itinerary; the PDF simply
  // renders without an intro.
  useEffect(() => {
    if (!shouldAutoGenerateIntroduction(plan)) return;
    const sig = introPlanSignature(plan);
    if (autoAttemptedRef.current === sig) return;
    autoAttemptedRef.current = sig;
    let cancelled = false;
    reportGeneratingChange(true);
    (async () => {
      try {
        const payload = shapeIntroRequest(plan, inputs);
        const res = await fetch("/api/introduction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        // force:false — never clobber an existing (e.g. recovered) intro.
        const next = applyGeneratedIntroduction(plan, data, { force: false });
        if (!cancelled && next !== plan) onPlanRevised(next);
      } catch {
        // Swallow — a failed intro must never break the itinerary view.
      } finally {
        // ALWAYS release the gate — success, failure, AND cancellation. An
        // earlier version skipped this on `cancelled` and that produced the
        // PR #70 regression: if a ReviewPanel or ChangeRequestCard revision
        // landed while /api/introduction was in flight, React's dep-change
        // cleanup set cancelled=true, the gate-release was skipped, and the
        // signature-deduped new run never flipped it either — leaving the
        // parent's introIsGenerating permanently true and Save as PDF
        // permanently disabled with "Preparing introduction…". setState on
        // an unmounted child is a React 18 no-op; the parent setter is safe
        // to call as long as the parent itself is still mounted (it is —
        // only this child's effect re-ran).
        reportGeneratingChange(false);
      }
    })();
    return () => {
      cancelled = true;
      // Clear the signature attempt-ref so a cancelled run can be retried
      // against the revised plan. Without this, when a ReviewPanel /
      // ChangeRequestCard revision lands mid-flight, the new plan's effect
      // run early-returns on the still-matching signature (revisions rarely
      // change destination / day count / first / last label) and the
      // revised itinerary ships with no introduction at all. Pair with the
      // always-release-gate fix above so a cancelled run leaves the
      // generator in a clean state, ready to re-attempt.
      autoAttemptedRef.current = "";
    };
  }, [plan, inputs, onPlanRevised, reportGeneratingChange]);

  // Suppress unused-var warning — isGenerating is exposed via callback above
  // and kept locally so consumers without a callback still get correct state.
  void isGenerating;

  return null;
}

function ItineraryView({ data: rawData, inputs, onBack, onEditTrip, onReset, onSaved, savedTripId: _savedTripId, onPlanRevised, onReviewChange, initialReview, reviewerSourceIds, onReviewerSourcesChange }) {
  // Whether IntroductionAutoGenerator's headless POST /api/introduction call
  // is in flight. Lifted here so PrintButton can disable Save as PDF until
  // the intro is either populated on the plan or the generator finishes/fails
  // — closes the PR #69 race where a fast user gets a PDF with no intro page.
  // The generator flips this back to false on both success and failure paths,
  // so a silent /api/introduction error never permanently blocks the button.
  const [introIsGenerating, setIntroIsGenerating] = useState(false);

  // #8 Auto-run the expert review when a FRESH build lands. Per the chosen flow
  // ("pre-build picker, then full auto"), a brand-new plan kicks off the review
  // automatically; a RESTORED saved trip (initialReview present) does not — its
  // review already ran and the user is just viewing it. ReviewPanel guards the
  // actual fire once-per-build, so this is just the on/off intent.
  const autoReview = !initialReview;

  // --- Menu modal state (lazy-fetch via /api/menu) ---
  // For large multi-city trips the build prompt now OMITS per-restaurant
  // menu data to keep the streaming response small (was 10-15k tokens of
  // pure menu boilerplate). When the user taps 'View Menu' we fall back to
  // /api/menu, which already powers FindView. Restaurants with model-
  // supplied menus (older saved trips or small trips that still get them)
  // skip the fetch and render immediately.
  const [menuRestaurant, setMenuRestaurant] = useState(null);
  const [menuData, setMenuData] = useState(null);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuError, setMenuError] = useState("");
  const menuCacheRef = useRef(new Map());
  // Request-id guard for openMenu — a fast user tapping View Menu on
  // restaurant A then restaurant B before A's /api/menu resolves would
  // otherwise see A's late payload land on B's modal (last-write-wins).
  // Every openMenu / closeMenu call increments this; every async state
  // write checks the captured id matches before mutating. Same pattern
  // useLocalProviders already uses (reqRef on line 4631).
  const menuReqRef = useRef(0);
  const destinationForMenu =
    inputs?.basics?.destination ||
    (Array.isArray(inputs?.basics?.cities) ? inputs.basics.cities.map(c => c?.name).filter(Boolean).join(" ") : "") ||
    rawData?.destination ||
    "";
  const openMenu = async (restaurant) => {
    if (!restaurant) return;
    // Bump the request-id BEFORE any state writes so prior in-flight fetches
    // (and any cached / model-supplied early returns from an earlier tap) can
    // no longer mutate the current modal state.
    const reqId = ++menuReqRef.current;
    setMenuRestaurant(restaurant);
    setMenuError("");
    // If the model already shipped a menu, no fetch needed.
    if (restaurant.menu && (
      (Array.isArray(restaurant.menu.signature_dishes) && restaurant.menu.signature_dishes.length > 0) ||
      (Array.isArray(restaurant.menu.mains) && restaurant.menu.mains.length > 0)
    )) {
      setMenuData(null);
      setMenuLoading(false);
      return;
    }
    const cacheKey = `${restaurant.name}|${destinationForMenu}`;
    const cached = menuCacheRef.current.get(cacheKey);
    if (cached) {
      setMenuData(cached);
      setMenuLoading(false);
      return;
    }
    setMenuData(null);
    setMenuLoading(true);
    try {
      const res = await fetch("/api/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: restaurant.name, location: destinationForMenu, cuisine: restaurant.cuisine || "" }),
      });
      const json = await res.json().catch(() => ({}));
      // Always cache a successful response (even if a newer request has
      // superseded this one) so future taps for the same restaurant hit the
      // cache. But ONLY mutate the visible modal state when this fetch is
      // still the current request.
      if (res.ok && json?.menu) {
        menuCacheRef.current.set(cacheKey, { menu: json.menu });
      }
      if (menuReqRef.current !== reqId) return;
      if (!res.ok) setMenuError(json?.error?.message || `Couldn't load the menu (${res.status}).`);
      else if (json?.menu) setMenuData({ menu: json.menu });
      else setMenuError("Couldn't load the menu.");
    } catch (err) {
      if (menuReqRef.current !== reqId) return;
      setMenuError(`Couldn't reach the menu service. ${String(err?.message || err).slice(0, 80)}`);
    } finally {
      // Only clear the loading spinner if this is still the active request —
      // a superseded fetch resolving must not flip a newer request's spinner.
      if (menuReqRef.current === reqId) setMenuLoading(false);
    }
  };
  const closeMenu = () => {
    // Bump the request-id so any in-flight /api/menu can no longer write
    // back into the (now-dismissed) modal state.
    menuReqRef.current++;
    setMenuRestaurant(null);
    setMenuData(null);
    setMenuError("");
    setMenuLoading(false);
  };
  // Section tab state — default "overview" keeps the existing day-by-day
  // timeline as the landing view. The other tabs (flights/lodging/dining/etc)
  // flatten plan content into category cards. Switching tabs scrolls back to
  // the top so the new view starts clean.
  // QA harness: if URL has ?qa=... or hash=#dining, land on the dining tab
  // directly. No-op in normal use. Removed before merge if needed.
  const initialTab = (() => {
    if (typeof window === "undefined") return "overview";
    try {
      const sp = new window.URLSearchParams(window.location.search);
      if (sp.has("qa") || window.location.hash === "#dining") return "dining";
    } catch {}
    return "overview";
  })();
  const [tab, setTab] = useState(initialTab);
  // Day filter for Overview tab. -1 = "All days" (default). 0..N = focus that day.
  const [dayFilter, setDayFilter] = useState(-1);
  const handleTabChange = (next) => {
    setTab(next);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };
  const handleDayFilterChange = (idx) => {
    setDayFilter(idx);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };
  // Apply the pass-three quality layer once before render. This dedupes
  // restaurants, fills verify microcopy, and computes a QC summary.
  const { data, qc } = useMemo(() => applyQualityLayer(rawData, inputs), [rawData, inputs]);
  // Multi-city: track which day starts a new leg so we can render a divider.
  const cityByDay = (data.days || []).map(d => d.city || null);
  const isMultiCityPlan = Array.isArray(data.cities) && data.cities.length > 1;
  const legCities = useMemo(() => collectPlanLegCities(rawData), [rawData]);

  // Warm the PDF module cache as soon as ItineraryView mounts so the dynamic
  // import resolves instantly when the user clicks Export (jsPDF is ~500KB;
  // pre-fetching it hides the cold-load latency behind normal reading time).
  useEffect(() => { import("./pdf/itineraryPdf.js").catch(() => {}); }, []);

  // Local providers (private drivers/guides/tours/tastings). Lifted here so
  // both the "Local providers" tab and the PDF export read the same verified
  // results. Fetches lazily off relevance; empty when no category applies.
  const providers = useLocalProviders(rawData, inputs, legCities, tab === "providers");

  // "Find another restaurant / activity" swap. Alternatives come from the live
  // /api/find engine (real, currently-operating only). We locate the item in
  // the RAW plan (the rendered plan is quality-layered and may have items
  // dropped/reordered), build a same-shape replacement that carries the
  // alternative's verify_status/verify_url through untouched, then reuse the
  // existing replace_item patch path and lift the revised plan so it persists.
  // Returns true on a successful swap, false if the item couldn't be located
  // or the patch didn't apply, so the picker can surface an honest error
  // instead of closing on a silent no-op.
  const handleSwapItem = (dayIndex, item, kind, chosen) => {
    if (!chosen || typeof onPlanRevised !== "function") return false;
    const itemIndex = findRawItemIndex(rawData, dayIndex, item, kind);
    if (itemIndex < 0) return false;
    const newItem = buildSwapItem(rawData.days[dayIndex].items[itemIndex], chosen, kind);
    const { plan: nextPlan, appliedCount } = applyPatchesToPlan(rawData, [
      { op: "replace_item", day_index: dayIndex, item_index: itemIndex, new_item: newItem },
    ]);
    if (appliedCount > 0) {
      onPlanRevised(nextPlan);
      return true;
    }
    return false;
  };

  // Collect every vendor URL in the plan (activities / transport / etc.) so we
  // can ask the server to verify they're reachable. Memoized so we only POST
  // when the underlying plan actually changes.
  const urlsToVerify = useMemo(() => collectVendorURLs(data), [data]);
  const urlVerify = useURLVerification(urlsToVerify);
  const verifyContextValue = useMemo(() => ({
    status: urlVerify.status,
    isReady: urlVerify.isReady,
    destination: inputs?.basics?.destination || (Array.isArray(inputs?.basics?.cities) ? inputs.basics.cities.map(c => c.name).filter(Boolean).join(" ") : ""),
  }), [urlVerify.status, urlVerify.isReady, inputs]);

  return (
    <URLVerifyContext.Provider value={verifyContextValue}>
    <div id="trip-print-root">
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
        <button
          type="button"
          onClick={() => {
            if (typeof onBack === "function") onBack();
          }}
          aria-label="Return to home"
          title="Return to home (your trip plan stays saved)"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            background: "transparent",
            color: GOLD,
            border: `0.5px solid ${GOLD}`,
            borderRadius: "var(--border-radius-md)",
            padding: "7px 12px",
            fontSize: "11px",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
            fontWeight: 500,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h14V9.5" />
          </svg>
          <span>Home</span>
        </button>
      </div>
      <InputSummary inputs={inputs} />
      {/* Menu modal renders MenuModal once data is available (either model-
          supplied at build time or lazy-fetched via /api/menu). While the
          lazy fetch is in flight we show a small loading sheet — same
          treatment as FindView for visual consistency. */}
      {menuRestaurant && (() => {
        const effectiveMenu = (menuRestaurant.menu && ((Array.isArray(menuRestaurant.menu.signature_dishes) && menuRestaurant.menu.signature_dishes.length > 0) || (Array.isArray(menuRestaurant.menu.mains) && menuRestaurant.menu.mains.length > 0)))
          ? menuRestaurant.menu
          : menuData?.menu;
        if (effectiveMenu) {
          return <MenuModal restaurant={{ ...menuRestaurant, menu: effectiveMenu }} onClose={closeMenu} />;
        }
        return (
          <div onClick={closeMenu} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1000, padding: 0 }}>
            <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Menu" style={{ background: "var(--color-background-primary)", maxWidth: "640px", width: "100%", maxHeight: "90vh", overflowY: "auto", borderRadius: "16px 16px 0 0", padding: "22px 22px 32px", boxShadow: "0 -8px 32px rgba(0,0,0,0.25)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, margin: 0 }}>Menu</p>
                <button onClick={closeMenu} aria-label="Close menu" style={{ background: "transparent", border: "none", fontSize: "22px", color: "var(--color-text-secondary)", cursor: "pointer", padding: "4px 8px", lineHeight: 1 }}>×</button>
              </div>
              <p style={{ fontSize: "20px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 14px", color: "var(--color-text-primary)" }}>{menuRestaurant.name}</p>
              {menuLoading && <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", fontStyle: "italic" }}>Loading menu…</p>}
              {menuError && <p role="alert" style={{ fontSize: "13px", color: "var(--color-danger-hover)", background: "var(--color-danger-tint)", border: "0.5px solid var(--color-text-danger)", borderRadius: "var(--border-radius-md)", padding: "8px 12px" }}>{menuError}</p>}
              {!menuLoading && !menuError && <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", fontStyle: "italic" }}>No menu available.</p>}
            </div>
          </div>
        );
      })()}

      {/* Sticky two-row tab nav lives ABOVE the hero so the hero stays compact and every
         tab is reachable at a glance — modeled after zurich-weekend.com / maritimesgrandloop.com. */}
      {data.days && data.days.length > 0 && (
        <TripTabs data={data} tab={tab} onTabChange={handleTabChange} dayFilter={dayFilter} onDayFilterChange={handleDayFilterChange} showProviders={providers.relevantIds.length > 0} onOpenMenu={openMenu} />
      )}

      <TripHero data={data} />
      <QualityBadge qc={qc} />

      {/* Headless introduction generator — auto-generates the intro after build
          via the separate lightweight /api/introduction call and persists it to
          data.introduction so it renders at the top of the PDF (see
          renderIntroduction). Renders nothing on screen by design: the intro is
          a PDF-only artifact. inputs are passed so generation can include trip
          facts. */}
      <IntroductionAutoGenerator
        plan={rawData}
        inputs={inputs}
        onPlanRevised={onPlanRevised}
        onGeneratingChange={setIntroIsGenerating}
      />
      {/* #12 Resolve missing flight numbers from the live schedule and persist
          them to the canonical plan so the PDF shows the same number as screen. */}
      <FlightNumberAutoResolver plan={rawData} onPlanRevised={onPlanRevised} />

      {/* Professional review surface — user-initiated, sits between hero and the day-by-day content. */}
      <ReviewPanel
        plan={rawData}
        inputs={inputs}
        onPlanRevised={onPlanRevised}
        onReviewChange={onReviewChange}
        initialReview={initialReview}
        autoRun={autoReview}
        externalSourceIds={reviewerSourceIds}
        onSourcesChange={onReviewerSourcesChange}
      />

      {/* Always-visible traveler change request — same revision pipeline as
          the review panel, but doesn't require running a review first.

          GATED: when the user has already run a review, the ReviewPanel
          renders its OWN embedded ChangeRequestCard (variant="review")
          inside its findings footer. Showing both at the same time
          produced a confusing duplicate "Suggest a change" pair stacked
          on top of each other (user-reported screenshot 2026-06-08).
          Hide this toplevel one whenever a review is present so only
          ONE change-request affordance is visible at a time. */}
      {!initialReview && (
        <ChangeRequestCard
          plan={rawData}
          inputs={inputs}
          onPlanRevised={onPlanRevised}
          variant="toplevel"
        />
      )}

      {data.days && data.days.length > 0 && tab !== "overview" && (
        <Section title={({ flights: "Flights", lodging: "Lodging", transport: "Ground transport", dining: "Dining", activities: "Activities", category: "By category", providers: "Local providers", essentials: "Essentials" }[tab] || "")}>
          <TripSectionView tab={tab} data={data} inputs={inputs} onOpenMenu={openMenu} providers={providers} />
        </Section>
      )}

      {data.days && data.days.length > 0 && tab === "overview" && (
        <Section title={dayFilter >= 0 && data.days[dayFilter] ? `Day ${dayFilter + 1} · ${dayShort(data.days[dayFilter], dayFilter)}` : "Day-by-day"}>
          {data.days.map((d, i) => {
            // Day filter: if dayFilter >= 0, only render that one day.
            if (dayFilter >= 0 && i !== dayFilter) return null;
            const prevCity = i > 0 ? cityByDay[i - 1] : null;
            // When focused on one day, always show the leg header for that day if multi-city.
            const showLegHeader = isMultiCityPlan && d.city && (dayFilter >= 0 ? true : d.city !== prevCity);
            const legIndex = showLegHeader ? (cityByDay.slice(0, i + 1).filter((c, k, arr) => c && c !== arr[k - 1]).length) : null;
            return (
              <div key={i}>
                {showLegHeader && (
                  <div style={{ margin: "0 0 14px", padding: "10px 12px", background: "var(--color-text-primary)", color: "var(--color-background-primary)", borderRadius: "var(--border-radius-md)", display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "9.5px", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, color: GOLD }}>Leg {legIndex}</span>
                    <span style={{ fontSize: "15px", fontFamily: "var(--font-serif)", fontStyle: "italic", letterSpacing: "-0.2px" }}>{d.city}</span>
                  </div>
                )}
                <DayBlock day={d} dayIndex={i} onOpenMenu={openMenu} legCity={resolveLegCity(rawData, i, legCities)} onSwapItem={handleSwapItem} />
              </div>
            );
          })}
        </Section>
      )}

      {/* Trip reference footer — surfaces the non-itinerary blocks (Tonight,
          Weather & pack, Heads up, Plan B, Snob's guide) inline on Overview so
          they're visible right after the day-by-day instead of being hidden
          behind the secondary Essentials tab. Reuses EssentialsView verbatim
          (same content as the tab and the PDF's reference sections). Only shown
          on Overview, and only when such content actually exists in the plan —
          dayFilter focuses a single day, so suppress it then to keep that view
          scoped to one day. */}
      {data.days && data.days.length > 0 && tab === "overview" && dayFilter < 0 && hasEssentialsContent(data) && (
        <Section title="Trip reference">
          <EssentialsView data={data} />
        </Section>
      )}

      <div className="no-print" style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "0.5rem" }}>
        {onEditTrip && (
          <button
            onClick={onEditTrip}
            style={{ background: "transparent", border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", color: GOLD, fontWeight: 500 }}
            title="Go back to the input form with this trip's details still filled in — tweak dates, cities, or anything else and rebuild."
          >✎ Edit trip details</button>
        )}
        <button
          onClick={onBack}
          style={{ background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", color: "var(--color-text-secondary)" }}
          title="Go back to the input form. Your trip details stay filled in."
        >← Back to inputs</button>
        <SaveTripButton inputs={inputs} result={rawData} onSaved={onSaved} />
        <PrintButton data={data} inputs={inputs} providers={providers} plan={rawData} introIsGenerating={introIsGenerating} />
        <PrintRidesButton data={data} inputs={inputs} />
        {/* Reset — surfaced here on Step 3 (results) so users don't have to
            navigate Home + scroll Step 1 to find it. Styled as a clear but
            secondary action: muted text, no border highlight, confirms
            before wiping because Reset is destructive (form + plan + review
            state all cleared). Sits at the END of the action row so it's
            never the first thing tapped by mistake. */}
        {onReset && (
          <button
            onClick={() => {
              if (window.confirm("Start over? This clears the current trip details and the built itinerary.")) {
                onReset();
              }
            }}
            title="Clear the current trip and start with a blank form"
            aria-label="Reset and start over"
            style={{
              background: "transparent",
              border: "0.5px solid var(--color-border-secondary)",
              borderRadius: "var(--border-radius-md)",
              padding: "10px 16px",
              fontSize: "11px",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
              fontFamily: "inherit",
              color: "var(--color-text-tertiary)",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              marginLeft: "auto",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 3v5h5" />
            </svg>
            <span>Start over</span>
          </button>
        )}
      </div>
    </div>
    </URLVerifyContext.Provider>
  );
}

// Collects every vendor URL embedded in the plan that we should verify before
// shipping. Restaurant reservation URLs are skipped because OpenTable/Resy/Tock
// search-pattern URLs almost never 404 — the bigger win is the long tail of
// small/local vendor sites that go dead (private drivers, boutique tours,
// regional ground services). Returns a deduped array of http(s) URLs.
function collectVendorURLs(data) {
  const out = new Set();
  const push = (u) => {
    if (typeof u !== "string") return;
    const v = u.trim();
    if (/^https?:\/\//i.test(v)) out.add(v);
  };
  const days = Array.isArray(data?.days) ? data.days : [];
  for (const day of days) {
    const items = Array.isArray(day?.items) ? day.items : [];
    for (const it of items) {
      const c = it?.contact;
      if (c) {
        push(c.website);
        push(c.booking_url);
      }
      if (it?.flight?.booking_url) push(it.flight.booking_url);
      if (it?.hotel?.website) push(it.hotel.website); // #21 verify hotel sites too
    }
  }
  return Array.from(out);
}

// Verify a list of vendor URLs by POSTing them to /api/verify-url. Returns
// { status: Map<url, "ok"|"dead">, isReady: boolean }. While the request is
// in flight, status is empty and isReady is false. The renderer should treat
// unknown URLs as ok (link still renders) so the user can interact with the
// itinerary immediately — the swap-to-search only happens once we get a
// definitive "dead" verdict.
function useURLVerification(urls) {
  const [status, setStatus] = useState(() => new Map());
  const [isReady, setIsReady] = useState(false);
  // Stable key for memoization — a sorted-and-joined list of urls.
  const key = useMemo(() => (Array.isArray(urls) ? urls.slice().sort().join("|") : ""), [urls]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local verify-status cache with url-set prop
    if (!key) { setStatus(new Map()); setIsReady(true); return; }
    let cancelled = false;
    setStatus(new Map());
    setIsReady(false);
    (async () => {
      try {
        const res = await fetch("/api/verify-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: key.split("|") }),
        });
        if (!res.ok) throw new Error(`verify-url ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        const next = new Map();
        for (const r of (json?.results || [])) {
          if (!r || !r.url) continue;
          next.set(r.url, r.ok ? "ok" : "dead");
        }
        setStatus(next);
        setIsReady(true);
      } catch {
        if (cancelled) return;
        // If verify endpoint fails, fall back to treating every URL as ok
        // (no swap). This keeps the existing behavior — we'd rather render a
        // model-supplied link than nothing.
        setStatus(new Map());
        setIsReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [key]);
  return { status, isReady };
}

function Field({ label, children, hint }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
      <label style={{ fontSize: "11px", color: "var(--color-text-secondary)", letterSpacing: "0.05em", fontWeight: "500", textTransform: "uppercase" }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: 0, fontStyle: "italic", lineHeight: "1.5" }}>{hint}</p>}
    </div>
  );
}

function Inp({ value, onChange, placeholder, type = "text" }) {
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder} style={{ fontSize: "14px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", lineHeight: "1.4" }} />;
}

// Free-form "tell me about the trip" narrative box with built-in dictation.
//
// Why a dedicated component:
//   1. It's a textarea, not an input — the rest of the form uses single-line
//      Inp / Sel, so this is a layout outlier worth isolating.
//   2. The mic button uses the Web Speech API, which is browser-specific
//      (webkitSpeechRecognition on Chrome/Safari, no Firefox support). The
//      detection + lifecycle (start/stop/error/onresult/onend) is fiddly
//      enough that keeping it inside one component is much cleaner.
//   3. Append-on-dictate semantics: each speech burst appends to whatever
//      the user has already typed/dictated, separated by a space. This is
//      what makes "dictate → read it back → dictate more" feel natural.
// Props:
//   value, onChange   controlled string state (parent supplies setNarrative)
//   placeholder       textarea placeholder text
//   hint              optional helper text below the box
//   size              "large" (default — 8 rows, 40000 chars, counter visible)
//                     | "compact" (3 rows, 2000 chars, no counter — used in
//                     inline change-request flows where space is tight)
//   minHeight         optional CSS override for the textarea floor
//   maxChars          optional cap override
function NarrativeBox({ value, onChange, placeholder, hint, size = "large", minHeight, maxChars }) {
  const [listening, setListening] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const recRef = useRef(null);
  const baseRef = useRef(""); // value at the moment we started this speech burst

  // File-upload state. The traveler can drop a PDF / Word / image / text
  // file into the box (or click the paperclip) and the server extracts trip
  // facts as a clean condensed paragraph that gets APPENDED to whatever
  // they've already typed. Never replaces — the user owns the text.
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadWarnings, setUploadWarnings] = useState([]);
  const [isDragging, setIsDragging] = useState(false);

  // Build the request, ship the file, and append the result.
  const ingestFile = async (file) => {
    if (!file) return;
    setUploadError("");
    setUploadWarnings([]);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name || "upload");
      const resp = await fetch("/api/extract-from-file", { method: "POST", body: form });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = payload?.error?.message || `Upload failed (HTTP ${resp.status}).`;
        setUploadError(msg);
        return;
      }
      const extracted = String(payload?.extracted_text || "").trim();
      if (!extracted) {
        setUploadError("The file didn't return any extracted text. Try a clearer image.");
        return;
      }
      // Append with a separating blank line if the box already has content.
      const prior = (value || "").trim();
      const next = prior
        ? `${prior}\n\n${extracted}`
        : extracted;
      // Respect MAX cap on the textarea — onChange below will clip anyway,
      // but we trim here too so the user sees the right char count immediately.
      onChange({ target: { value: next.slice(0, maxChars || 40000) } });
      if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) {
        setUploadWarnings(payload.warnings);
      }
    } catch (err) {
      setUploadError(`Upload failed: ${String(err?.message || err)}`);
    } finally {
      setUploading(false);
    }
  };

  const onFilePicked = (e) => {
    const f = e?.target?.files?.[0];
    // Reset the input value so picking the SAME file twice in a row still fires onChange.
    if (e?.target) e.target.value = "";
    if (f) ingestFile(f);
  };

  // Drag-and-drop handlers for the textarea wrapper.
  const onDragOver = (e) => { e.preventDefault(); e.stopPropagation(); if (!isDragging) setIsDragging(true); };
  const onDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); };
  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragging(false);
    const f = e?.dataTransfer?.files?.[0];
    if (f) ingestFile(f);
  };

  // Browser-feature detection — derived at render, not via useEffect. The Web
  // Speech API is read-only and synchronous to test, so there's no reason to
  // burn an effect cycle (which also triggered the cascading-render lint).
  const supported = useMemo(
    () => typeof window !== "undefined"
      && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    [],
  );

  const start = () => {
    setPermissionError("");
    const SR =
      (typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition)) ||
      null;
    if (!SR) {
      setPermissionError("Dictation isn't supported in this browser. Try Chrome or Safari.");
      return;
    }
    try {
      const rec = new SR();
      rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      rec.continuous = true;       // keep listening through pauses
      rec.interimResults = true;   // show partial text as it comes

      baseRef.current = value || "";
      let lastInterim = "";

      rec.onresult = (e) => {
        // Concatenate every result in this session. results[i] may be final
        // or interim; we treat the whole session as one append-to-base buffer
        // so the textarea updates smoothly as the user speaks.
        let finalChunk = "";
        let interimChunk = "";
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          const txt = r[0]?.transcript || "";
          if (r.isFinal) finalChunk += txt;
          else interimChunk += txt;
        }
        lastInterim = interimChunk;
        const base = baseRef.current ? baseRef.current.replace(/\s+$/, "") + " " : "";
        const composed = (base + finalChunk + (interimChunk ? " " + interimChunk : "")).trim();
        // Synthesize a synthetic onChange-like event the parent already knows.
        onChange({ target: { value: composed } });
      };
      rec.onerror = (e) => {
        // "no-speech" / "aborted" are normal end-states; only surface the rest.
        if (e?.error && !/no-speech|aborted|audio-capture/.test(String(e.error))) {
          setPermissionError(`Mic error: ${e.error}. Check microphone permissions.`);
        }
      };
      rec.onend = () => {
        // If we ended mid-sentence, lock in the last interim chunk so the user
        // doesn't lose what they were saying when the API auto-times-out.
        if (lastInterim) {
          const base = baseRef.current ? baseRef.current.replace(/\s+$/, "") + " " : "";
          onChange({ target: { value: (base + lastInterim).trim() } });
        }
        setListening(false);
      };

      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch (err) {
      setPermissionError(`Dictation failed to start: ${err?.message || err}`);
      setListening(false);
    }
  };

  const stop = () => {
    try { recRef.current?.stop(); } catch {}
    setListening(false);
  };

  const isCompact = size === "compact";
  const charCount = (value || "").length;
  // 40,000 chars covers even very long pasted itineraries / Word docs;
  // 2000 is plenty for an inline change request. Both still leave headroom
  // in the prompt budget.
  const MAX = maxChars || (isCompact ? 2000 : 40000);

  // Padding-right needs an extra slot when both the mic and the paperclip
  // buttons are present. Compact mode keeps one button height of clearance;
  // large mode reserves enough room for two stacked icons on the right edge.
  const rightPadding = isCompact ? "38px" : "44px";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div
        style={{
          position: "relative",
          // Visible drop-target outline only when the browser reports a
          // drag actually entered. Avoids the box jumping when the user
          // is just hovering with the mouse without a payload.
          outline: isDragging ? `2px dashed ${GOLD}` : "none",
          outlineOffset: "2px",
          borderRadius: isCompact ? "4px" : "8px",
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <textarea
          value={value}
          onChange={(e) => onChange({ target: { value: e.target.value.slice(0, MAX) } })}
          placeholder={placeholder}
          rows={isCompact ? 3 : 8}
          style={{
            fontSize: isCompact ? "13px" : "14px",
            padding: isCompact ? `9px ${rightPadding} 9px 11px` : `12px ${rightPadding} 12px 12px`,
            border: isCompact ? "0.5px solid var(--color-border-secondary)" : "0.5px solid var(--color-border-primary)",
            borderRadius: isCompact ? "var(--border-radius-sm, 4px)" : "8px",
            background: isCompact ? "var(--color-background-primary)" : "transparent",
            color: "var(--color-text-primary)",
            width: "100%",
            boxSizing: "border-box",
            outline: "none",
            fontFamily: "inherit",
            lineHeight: "1.55",
            resize: "vertical",
            minHeight: minHeight || (isCompact ? "60px" : "140px"),
          }}
        />
        {/* Hidden native file input — triggered by the paperclip button. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.heic,.heif,.txt,.eml,.ics,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*,text/plain,message/rfc822,text/calendar"
          onChange={onFilePicked}
          style={{ display: "none" }}
          aria-hidden="true"
        />
        {/* Paperclip / upload button. Sits ABOVE the mic when both exist.
            Uses a unicode paperclip glyph to avoid pulling in an icon lib.
            Disabled while a previous upload is in flight. */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label={uploading ? "Reading file…" : "Upload a flight confirmation, hotel booking, or itinerary file"}
          title={uploading ? "Reading file…" : "Upload PDF, Word, image, or text — we'll extract the trip facts"}
          style={{
            position: "absolute",
            // Stack above the mic when supported, else align with where the
            // mic would have been so the column doesn't look off-balance.
            top: supported
              ? (isCompact ? "6px" : "8px")
              : (isCompact ? "6px" : "8px"),
            right: isCompact ? "6px" : "8px",
            // When mic is also present, shift the paperclip DOWN below it so
            // they stack vertically. When mic isn't supported, paperclip takes
            // the top slot.
            transform: supported ? `translateY(${isCompact ? "30px" : "38px"})` : "none",
            width: isCompact ? "26px" : "32px",
            height: isCompact ? "26px" : "32px",
            border: "none",
            borderRadius: "50%",
            // #16/contrast: navy glyph on navy (uploading) or mid-slate fill was
            // invisible / 2.5:1. Use a LIGHT glyph on the dark circle in both states.
            background: uploading ? GOLD : "var(--color-border-primary)",
            color: "var(--color-background-primary)",
            cursor: uploading ? "wait" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: isCompact ? "13px" : "16px",
            lineHeight: 1,
            opacity: uploading ? 0.85 : 1,
          }}
        >
          {uploading ? "…" : "📎"}
        </button>
        {supported && (
          <button
            type="button"
            onClick={listening ? stop : start}
            aria-label={listening ? "Stop dictation" : "Start dictation"}
            title={listening ? "Stop dictation" : "Dictate — click and speak"}
            style={{
              position: "absolute",
              top: isCompact ? "6px" : "8px",
              right: isCompact ? "6px" : "8px",
              width: isCompact ? "26px" : "32px",
              height: isCompact ? "26px" : "32px",
              border: "none",
              borderRadius: "50%",
              // #16/contrast: navy glyph on the mid-slate border-primary fill was
              // only 2.5:1. Keep the slate circle but use a LIGHT glyph (~4.7:1).
              background: listening ? "var(--color-text-danger)" : "var(--color-border-primary)",
              color: "var(--color-background-primary)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: isCompact ? "12px" : "15px",
              lineHeight: 1,
              transition: "background 0.15s",
              boxShadow: listening ? "0 0 0 4px rgba(221,17,17,0.18)" : "none",
            }}
          >
            {listening ? "■" : "🎙"}
          </button>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
        <p style={{ fontSize: isCompact ? "10.5px" : "11px", color: "var(--color-text-tertiary)", margin: 0, fontStyle: "italic", lineHeight: "1.5", flex: 1 }}>
          {uploading
            ? "Reading your file… extracting trip facts."
            : uploadError
              ? ""
              : permissionError
                ? permissionError
                : listening
                  ? "Listening… speak naturally. Click ■ when done."
                  : (hint || "")}
        </p>
        {!isCompact && (
          <span style={{ fontSize: "11px", color: charCount > MAX - 200 ? "var(--color-text-danger)" : "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
            {charCount} / {MAX}
          </span>
        )}
      </div>
      {/* Upload error — separate row so it doesn't get squeezed by the char
          count. Red border to distinguish from the italic gray hint. */}
      {uploadError && (
        <p role="alert" style={{ fontSize: "11.5px", color: "var(--color-text-danger)", margin: 0, padding: "6px 10px", border: "0.5px solid var(--color-danger-tint)", borderRadius: "4px", background: "var(--color-danger-tint)", lineHeight: 1.5 }}>
          {uploadError}
        </p>
      )}
      {/* Upload warnings — "Could not read: X" lines from the model. These
          are not blockers; the rest of the text was extracted fine. Show as
          a soft amber note so the user knows to verify those bits. */}
      {!uploadError && uploadWarnings.length > 0 && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-primary)", margin: 0, padding: "6px 10px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "4px", background: "var(--color-surface-2)", lineHeight: 1.5 }}>
          Heads up: {uploadWarnings.join(" · ")}
        </p>
      )}
    </div>
  );
}


// Pick BOTH start + return on a single calendar. First click sets start,
// second click sets end. Clicking a date earlier than the current start
// resets the selection to that new start.
function DateRangeInput({ startDate, endDate, onRangeChange }) {
  const [open, setOpen] = useState(false);
  // Two-month view: visibleMonth is the LEFT month. Right is +1.
  const initialMonth = (() => {
    const seed = startDate || new Date().toISOString().slice(0, 10);
    const d = new Date(seed + "T12:00:00");
    if (isNaN(d)) return new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  })();
  const [visibleMonth, setVisibleMonth] = useState(initialMonth);
  // Hover preview while choosing the end date.
  const [hoverISO, setHoverISO] = useState("");
  const popRef = useRef(null);
  const wrapRef = useRef(null);
  // Horizontal nudge (px) applied when the popover would overflow the viewport's
  // right edge. 0 on desktop when there's room → popover stays anchored as today.
  const [shiftX, setShiftX] = useState(0);

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // When opening, jump the calendar to the user's chosen start (or today).
  useEffect(() => {
    if (!open) return;
    const seed = startDate || new Date().toISOString().slice(0, 10);
    const d = new Date(seed + "T12:00:00");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial visible month when datepicker opens
    if (!isNaN(d)) setVisibleMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Right-edge guard: after the popover lays out, check whether it spills past
  // the viewport's right edge and, if so, pull it left by exactly the overflow
  // (plus an 8px gutter). Runs before paint so there's no visible jump. When the
  // popover already fits (e.g. desktop with room), overflow <= 0 → shiftX stays 0
  // and the popover renders exactly where it does today.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: measure layout, then set the horizontal shift before paint
    if (!open) { setShiftX(0); return; }
    const el = popRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const GUTTER = 8;
    const overflowRight = rect.right - (window.innerWidth - GUTTER);
    setShiftX(overflowRight > 0 ? -overflowRight : 0);
  }, [open, startDate, endDate]);

  const toISO = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const fromISO = (iso) => {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const d = new Date(iso + "T12:00:00");
    return isNaN(d) ? null : d;
  };
  const sameDay = (a, b) => a && b && a.toDateString() === b.toDateString();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const fmtRange = () => {
    if (!startDate && !endDate) return "";
    const s = fromISO(startDate);
    const e = fromISO(endDate);
    if (s && e) {
      const sameYear = s.getFullYear() === e.getFullYear();
      const sOpts = { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" };
      const eOpts = { month: "short", day: "numeric", year: "numeric" };
      return `${s.toLocaleDateString("en-US", sOpts)} \u2013 ${e.toLocaleDateString("en-US", eOpts)}`;
    }
    if (s) return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} \u2013 \u2026`;
    return "";
  };

  const handleDayClick = (iso) => {
    const d = fromISO(iso);
    if (!d) return;
    const s = fromISO(startDate);
    // Case 1: no selection yet OR clicking before current start → set start, clear end.
    if (!startDate || !s || d < s) {
      onRangeChange({ startDate: iso, endDate: "" });
      return;
    }
    // Case 2: clicking exactly on start → ignore (keep the picker open).
    if (sameDay(d, s)) return;
    // Case 3: start exists, end empty → set end.
    if (!endDate) {
      onRangeChange({ startDate, endDate: iso });
      // Auto-close after picking the end, with a tiny delay so the user
      // sees the completed range highlight before the popover dismisses.
      setTimeout(() => setOpen(false), 220);
      return;
    }
    // Case 4: both exist → start a fresh range with this click.
    onRangeChange({ startDate: iso, endDate: "" });
  };

  // Build the day grid for a given month (Sun-first weeks).
  const buildMonth = (monthDate) => {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay(); // 0 = Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  };

  const s = fromISO(startDate);
  const e = fromISO(endDate);
  const hov = fromISO(hoverISO);
  // Preview-end is hover when picking the end, otherwise the real end.
  const previewEnd = (s && !e && hov && hov > s) ? hov : e;

  const inRange = (d) => {
    if (!d || !s) return false;
    const end = previewEnd;
    if (!end) return false;
    return d > s && d < end;
  };

  const monthLabel = (d) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const nextMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
  const shiftMonth = (delta) => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + delta, 1));

  const displayValue = fmtRange();

  const dayCell = (date, monthDate) => {
    if (!date) return <div style={{ height: "34px" }} />;
    const iso = toISO(date);
    const isStart = sameDay(date, s);
    const isEnd = sameDay(date, e) || (sameDay(date, previewEnd) && !sameDay(previewEnd, s));
    const within = inRange(date);
    const isToday = sameDay(date, today);
    const isPast = date < today && !isStart && !isEnd && !within;
    const isOtherMonth = date.getMonth() !== monthDate.getMonth();
    if (isOtherMonth) return <div style={{ height: "34px" }} />;
    let bg = "transparent";
    let color = "var(--color-text-primary)";
    let weight = 400;
    if (within) { bg = "rgba(91, 101, 119, 0.18)"; color = "var(--color-text-primary)"; }
    if (isStart || isEnd) { bg = GOLD; color = "var(--color-background-primary)"; weight = 600; }
    if (isPast) color = "var(--color-text-tertiary)";
    const borderRadius = isStart && isEnd ? "50%"
      : isStart ? "50% 0 0 50%"
      : isEnd ? "0 50% 50% 0"
      : within ? "0"
      : "50%";
    return (
      <button
        key={iso}
        type="button"
        onClick={() => handleDayClick(iso)}
        onMouseEnter={() => s && !e && setHoverISO(iso)}
        onMouseLeave={() => setHoverISO("")}
        aria-label={date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        style={{
          height: "34px",
          width: "100%",
          background: bg,
          color,
          border: isToday && !isStart && !isEnd && !within ? `1px solid ${GOLD}` : "none",
          borderRadius,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: "13px",
          fontWeight: weight,
          padding: 0,
          outline: "none",
        }}
      >
        {date.getDate()}
      </button>
    );
  };

  const renderMonth = (monthDate) => {
    const cells = buildMonth(monthDate);
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ textAlign: "center", fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "8px", letterSpacing: "0.02em" }}>
          {monthLabel(monthDate)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px", marginBottom: "4px" }}>
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={`${monthDate.getMonth()}-h-${i}`} style={{ textAlign: "center", fontSize: "10px", color: "var(--color-text-tertiary)", padding: "4px 0", textTransform: "uppercase", letterSpacing: "0.06em" }}>{d}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px" }}>
          {cells.map((c, i) => (
            <div key={`${monthDate.getMonth()}-${i}`}>{dayCell(c, monthDate)}</div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          fontSize: "14px",
          padding: "9px 0",
          border: "none",
          borderBottom: "0.5px solid var(--color-border-primary)",
          background: "transparent",
          color: displayValue ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
          fontFamily: "inherit",
          cursor: "pointer",
          outline: "none",
          lineHeight: "1.4",
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {displayValue || "Pick start \u2192 return"}
      </button>
      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Pick trip dates"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            transform: shiftX ? `translateX(${shiftX}px)` : undefined,
            zIndex: 50,
            background: "var(--color-background-primary)",
            border: "1px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-lg)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.14)",
            padding: "14px",
            width: "min(640px, 92vw)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month"
              style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "18px", color: "var(--color-text-secondary)", padding: "4px 10px", fontFamily: "inherit" }}>‹</button>
            <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              {!startDate ? "Pick start date" : !endDate ? "Pick return date" : "Trip dates"}
            </div>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month"
              style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "18px", color: "var(--color-text-secondary)", padding: "4px 10px", fontFamily: "inherit" }}>›</button>
          </div>
          <div style={{ display: "flex", gap: "18px" }}>
            {renderMonth(visibleMonth)}
            <div className="date-range-second-month" style={{ display: "flex", flex: 1, minWidth: 0 }}>
              {renderMonth(nextMonth)}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "10px", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <button type="button" onClick={() => onRangeChange({ startDate: "", endDate: "" })}
              style={{ background: "transparent", border: "none", color: "var(--color-text-secondary)", fontSize: "11px", cursor: "pointer", padding: "4px 0", textDecoration: "underline", fontFamily: "inherit" }}>Clear</button>
            <button type="button" onClick={() => setOpen(false)}
              style={{ background: "var(--color-text-primary)", color: "var(--color-background-primary)", border: "none", borderRadius: "var(--border-radius-md)", padding: "8px 18px", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>Done</button>
          </div>
        </div>
      )}
      {/* On narrow screens, hide the second month to keep the popover compact. */}
      <style>{`@media (max-width: 520px) { .date-range-second-month { display: none !important; } }`}</style>
    </div>
  );
}

// Generic autocomplete: free-text input + filtered dropdown.
// `getSuggestions(q)` returns an array of items; `renderItem(item)` renders each row;
// `itemToValue(item)` converts a picked item to the string written into the input.
function Autocomplete({ value, onChange, placeholder, getSuggestions, renderItem, itemToValue, itemKey, openOnFocusEmpty = false, minChars = 1, loading = false, emptyHint = null }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapRef = useRef(null);

  const q = (value ?? "").toString().trim().toLowerCase();
  const showList = (q.length >= minChars || (openOnFocusEmpty && q.length === 0));
  const suggestions = showList ? getSuggestions(q).slice(0, 8) : [];
  const showPanel = open && (suggestions.length > 0 || (showList && (loading || emptyHint)));

  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const pick = (item) => {
    onChange({ target: { value: itemToValue(item) } });
    setOpen(false);
    setActiveIdx(-1);
  };

  const onKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      pick(suggestions[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => { onChange(e); setOpen(true); setActiveIdx(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        style={{ fontSize: "14px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", lineHeight: "1.4" }}
      />
      {showPanel && (
        <div className="city-suggestions" role="listbox">
          {suggestions.map((item, i) => (
            <div
              key={itemKey(item)}
              role="option"
              aria-selected={i === activeIdx}
              className={`city-suggestion${i === activeIdx ? " active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            >
              {renderItem(item)}
            </div>
          ))}
          {loading && (
            <div className="city-suggestion" style={{ opacity: 0.65, fontStyle: "italic", cursor: "default", pointerEvents: "none" }}>
              Searching worldwide…
            </div>
          )}
          {!loading && suggestions.length === 0 && emptyHint && (
            <div className="city-suggestion" style={{ opacity: 0.65, fontStyle: "italic", cursor: "default", pointerEvents: "none" }}>
              {emptyHint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// US state name -> USPS code, for compact display of Nominatim results.
const US_STATE_ABBR = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
  "colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
  "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL",
  "indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
  "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR",
  "pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
  "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY",
  "puerto rico":"PR"
};

// In-memory cache of Nominatim queries (per page load).
const NOMINATIM_CACHE = new Map();

// Acceptable place types. Includes country/island/state so small destinations
// like "Aruba", "Bermuda", "Maui", "Bali" surface when typed by name. Skips
// roads, POIs, businesses, postcodes.
const CITY_TYPES = new Set([
  "city","town","village","hamlet","municipality","suburb","borough","neighbourhood","locality",
  "country","island","archipelago","state","region","county","administrative","isolated_dwelling"
]);

function formatNominatim(r) {
  const a = r.address || {};
  // Prefer city-level address fields; fall back to island/country/state names,
  // then to the place's own name. This is what makes "Aruba", "Bermuda",
  // "Maui", etc. surface — Nominatim returns them with no city in the address.
  const place =
    a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.borough || a.locality ||
    a.island || a.archipelago || a.county || a.state || a.country ||
    (r.name || "").split(",")[0].trim();
  if (!place) return null;
  const cc = (a.country_code || "").toLowerCase();
  if (cc === "us") {
    const stateName = (a.state || "").toLowerCase();
    const abbr = US_STATE_ABBR[stateName] || (a.state || "");
    // For US results with no state (e.g. someone types "USA"), skip.
    if (!abbr) return null;
    return { name: `${place}, ${abbr}`, country: "USA", _src: "world" };
  }
  const country = a.country || "";
  // If the place name equals the country (Aruba, Bermuda, Monaco, etc.), show
  // it once instead of "Aruba · Aruba".
  const displayCountry = (place && country && place.toLowerCase() === country.toLowerCase()) ? "" : country;
  return { name: place, country: displayCountry, _src: "world" };
}

async function geocodeNominatim(q, signal) {
  const key = q.trim().toLowerCase();
  if (!key) return [];
  if (NOMINATIM_CACHE.has(key)) return NOMINATIM_CACHE.get(key);
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1&accept-language=en`;
  const res = await fetch(url, { signal, headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const raw = await res.json();
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const at = (r.addresstype || r.type || "").toLowerCase();
    if (!CITY_TYPES.has(at)) continue;
    const fmt = formatNominatim(r);
    if (!fmt) continue;
    const k = `${fmt.name}|${fmt.country}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(fmt);
  }
  NOMINATIM_CACHE.set(key, out);
  return out;
}

function CityAutocomplete({ value, onChange, placeholder }) {
  const [remote, setRemote] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  const safeValue = (value ?? "").toString();
  const q = safeValue.trim();
  useEffect(() => {
    // Cancel any pending request/debounce.
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced typeahead reset
    setErrored(false);
    if (q.length < 2) { setRemote([]); setLoading(false); return; }
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      const ctl = new AbortController();
      abortRef.current = ctl;
      try {
        const results = await geocodeNominatim(q, ctl.signal);
        if (!ctl.signal.aborted) { setRemote(results); setLoading(false); }
      } catch (err) {
        if (err && err.name === "AbortError") return;
        setErrored(true);
        setRemote([]);
        setLoading(false);
      }
    }, 350);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [q]);

  return (
    <Autocomplete
      value={safeValue}
      onChange={onChange}
      placeholder={placeholder}
      loading={loading}
      emptyHint={errored ? "Couldn’t reach world search — type a known city." : "No matches yet — keep typing…"}
      getSuggestions={(qLower) => {
        const curated = CITIES.filter(c =>
          c.name.toLowerCase().includes(qLower) || c.country.toLowerCase().includes(qLower)
        );
        const seen = new Set(curated.map(c => `${c.name}|${c.country}`.toLowerCase()));
        const extras = remote.filter(r => !seen.has(`${r.name}|${r.country}`.toLowerCase()));
        return [...curated, ...extras];
      }}
      renderItem={(c) => <>{c.name}<span className="country">{c.country}{c._src === "world" ? " · world" : ""}</span></>}
      itemToValue={(c) => `${c.name}, ${c.country}`}
      itemKey={(c) => `${c.name}-${c.country}-${c._src || "curated"}`}
    />
  );
}

// Attempt to recover a parseable JSON object from a truncated stream. Strategy:
// walk forward tracking brace depth (while ignoring braces inside strings),
// remember the position right after the last completed top-level child of the
// outer object, then close the outer braces.
function salvageTruncatedJSON(str) {
  if (!str) return null;
  let i = 0;
  const len = str.length;
  while (i < len && str[i] !== "{") i++;
  if (i >= len) return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  let escape = false;
  let lastSafeClose = -1; // index of a '}' or ']' at depth 1 (top-level child boundary)
  for (; i < len; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 1) lastSafeClose = i; // just closed a top-level child
      if (depth === 0) {
        // Already balanced — nothing to salvage; caller's normal parse would have worked.
        return null;
      }
    }
  }
  if (lastSafeClose < 0) return null;
  // Truncate after the last safe close and append closers for whatever remains open.
  let head = str.slice(start, lastSafeClose + 1);
  // Walk head to figure out what's still open.
  let s = false; let esc = false;
  const stack = [];
  for (let k = 0; k < head.length; k++) {
    const c = head[k];
    if (esc) { esc = false; continue; }
    if (s) { if (c === "\\") { esc = true; continue; } if (c === '"') s = false; continue; }
    if (c === '"') { s = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); }
    else if (c === "}" || c === "]") { stack.pop(); }
  }
  // Remove a trailing comma if present, then close remaining open structures.
  head = head.replace(/,\s*$/, "");
  while (stack.length) {
    const open = stack.pop();
    head += open === "{" ? "}" : "]";
  }
  return head;
}

// Run a /api/build job end-to-end against the current NDJSON streaming server.
// Keeps the POST connection open and reads {type:"job"}, {type:"delta"},
// {type:"done"}, {type:"error"} events. Returns the accumulated tool/text
// buffer when the server emits `done`. Falls back to KV polling if the stream
// ends without a `done` event (e.g. transient disconnect mid-build).
//
// Used by the Professional Review and Apply Changes flows. The fresh-build
// path has its own inline reader (streamBuildResponse) with extra UI hooks.
// Streams an Anthropic build via /api/build, with KV polling fallback when
// the SSE stream drops mid-build.
//
// maxPollMs: optional override for the absolute polling ceiling. Default 15
//   minutes for general callers; the wizard build path passes a value
//   scaled to the trip's expected duration (targetSec * 2.5) so multi-city
//   trips that legitimately need 12-15 minutes of model output don't get
//   guillotined by a 10-min ceiling.
async function streamBuildJob(body, { signal, onJob, onDelta, onStallNotice, maxPollMs } = {}) {
  const resp = await fetch("/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    let msg = `Could not start job (HTTP ${resp.status}).`;
    // Defensive parse: if the upstream returned a Cloudflare error page or
    // any other HTML shell, JSON.parse will fail and we previously dumped
    // the raw HTML (doctype + IE conditional comments) into the UI. Now we
    // detect HTML and replace it with a clean user-facing message.
    try {
      const j = JSON.parse(txt);
      msg = j?.error?.message || msg;
    } catch {
      if (txt) {
        const looksLikeHtml = /<!doctype|<html|<body|<head|<script|<style/i.test(txt);
        if (looksLikeHtml) {
          msg = `Server returned an error page (HTTP ${resp.status}). Please retry in a moment.`;
        } else {
          msg = txt.slice(0, 200).replace(/\s+/g, " ").trim();
        }
      }
    }
    throw new Error(msg);
  }
  if (!resp.body) throw new Error("Server did not return a stream body.");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let toolJson = "";
  let jobId = null;
  let doneSeen = false;
  let stopReason = null;

  // #24 — Live-stream stall watchdog. The server emits {type:"ping"} every
  // ~15 s so a healthy idle stream still resets the timer on every loop. If
  // the stream goes truly silent (no deltas AND no pings) for more than
  // LIVE_STALL_MS, we synthesize a StallError so the existing recoverable-
  // drop path (shouldResumeViaPoll) breaks out of the read loop and the
  // KV-poll fallback resumes the job. Without this, a half-closed TCP
  // connection or a true upstream wedge blocked reader.read() indefinitely
  // (the Sedona stall report) because no transport error ever surfaced.
  //
  // Threshold: 90 s. Server's HEARTBEAT_INTERVAL_MS is 15 s, so a quiet
  // healthy stream emits a ping every ~15 s. 90 s = six missed heartbeats —
  // well past anything transient and well below the KV-poll's 180 s budget,
  // so we trip, resume via poll, and the user keeps moving.
  const LIVE_STALL_MS = 90 * 1000;
  let stallTimer = null;
  function clearStallTimer() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  }
  function readWithStallWatchdog() {
    return new Promise((resolve, reject) => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        stallTimer = null;
        reject(new StallError("Live stream stalled — no events for 90s."));
      }, LIVE_STALL_MS);
      reader.read().then(
        (res) => { clearStallTimer(); resolve(res); },
        (err) => { clearStallTimer(); reject(err); },
      );
    });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch {}
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      let value, done;
      try {
        ({ value, done } = await readWithStallWatchdog());
      } catch (readErr) {
        // The live POST stream dropped mid-flight OR our stall watchdog tripped
        // (#24). Without this catch the reject propagated straight out of
        // streamBuildJob, past the KV-poll fallback below (which only ran on a
        // clean `done` break) — so a dropped surgical-revision stream was a
        // hard failure even though the server job kept running and mirroring
        // to KV. If we already have a jobId and the error is a recognized
        // transport drop OR a StallError, fall through to resume via polling
        // instead of failing. See shouldResumeViaPoll.
        if (readErr?.name === "AbortError") throw readErr;
        if (shouldResumeViaPoll(readErr, { jobId, doneSeen })) {
          // Cancel the reader so its underlying connection is freed before we
          // move to KV-poll mode — otherwise a stalled live stream can keep
          // the fetch alive in the background until TCP eventually times out.
          try { await reader.cancel(); } catch {}
          break;
        }
        throw readErr;
      }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === "job" && evt.jobId) {
          jobId = evt.jobId;
          if (typeof onJob === "function") onJob(jobId);
        } else if (evt.type === "delta" && evt.text) {
          toolJson += evt.text;
          if (typeof onDelta === "function") onDelta(evt.text, toolJson.length);
        } else if (evt.type === "stop_reason" && evt.reason) {
          // Forwarded from Anthropic's message_delta event. Captured here
          // so the caller can distinguish a clean end_turn (the JSON is
          // genuinely complete) from a max_tokens hit (the JSON is
          // truncated regardless of how well it parses).
          stopReason = evt.reason;
        } else if (evt.type === "ping") {
          // Server heartbeat — keeps NDJSON alive through long model pauses,
          // and (since #24) the surrounding readWithStallWatchdog already
          // reset the live-stream stall timer when this event arrived, so a
          // quiet-but-healthy stream isn't treated as wedged.
          continue;
        } else if (evt.type === "done") {
          doneSeen = true;
          return { jobId, toolJson, stopReason };
        } else if (evt.type === "error") {
          throw new Error(evt.error || "Build failed on server.");
        }
      }
    }
  } finally {
    clearStallTimer();
    try { reader.releaseLock(); } catch {}
  }

  // #24: if we broke out of the read loop via shouldResumeViaPoll (transport
  // drop or stall watchdog) and we have a jobId to poll, surface a microcopy
  // so the UI doesn't look dead during the transition to polling. Runs at
  // most once per streamBuildJob invocation (this is the only call site).
  if (!doneSeen && jobId && typeof onStallNotice === "function") {
    try { onStallNotice("Live stream paused — polling for the result…"); } catch {}
  }

  // Stream ended without `done` — either a clean EOF or a mid-stream transport
  // drop that broke out of the read loop above (see shouldResumeViaPoll). If we
  // know the jobId, fall back to KV polling so we can still finish reading
  // whatever the server produced and resume the job to completion.
  //
  // Bounded by two signals so the UI never spins forever:
  //   - MAX_POLL_MS:    absolute ceiling on total polling time (10 minutes)
  //   - MAX_STALL_MS:   bail if we go this long without any new bytes
  //                     (the server is alive but the generation has stopped)
  if (!doneSeen && jobId) {
    let cursor = toolJson.length;
    const POLL_MS = 1500;
    // Default ceiling raised from 10 to 15 min because pre-2026 the only
    // builds that hit it were genuinely runaway; post-2026 (after the
    // verify/menu/contact additions) heavy multi-city trips need 12-15 min
    // of legitimate streaming. Callers can override via maxPollMs.
    const MAX_POLL_MS = typeof maxPollMs === "number" && maxPollMs > 0 ? maxPollMs : 15 * 60 * 1000;
    // Stall threshold. The model can legitimately spend 90–150s emitting a
    // single large structure (a full menu object with appetizers + mains +
    // desserts + wine notes is one such block). 90s was tripping on healthy
    // builds; 180s gives real model pauses room while still catching truly
    // dead jobs.
    //
    // #24: made adaptive. If the most recent KV status payload reports the
    // job is still `running` server-side, extend to 300s so a genuinely heavy
    // multi-city build that's slow but alive doesn't get killed by the
    // client. Falls back to 180s when status is missing or anything other
    // than `running`.
    const MAX_STALL_MS_BASE = 180 * 1000;
    const MAX_STALL_MS_ALIVE = 300 * 1000;
    let lastServerStatus = null;
    const pollStart = Date.now();
    let lastProgressAt = Date.now();
    while (true) {
      if (signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error("Build is taking longer than expected. Tap Build again to retry.");
      }
      const stallBudget = lastServerStatus === "running" ? MAX_STALL_MS_ALIVE : MAX_STALL_MS_BASE;
      if (Date.now() - lastProgressAt > stallBudget) {
        throw new Error("Build stalled — no new content from the server. Tap Build again to retry.");
      }
      let r;
      try {
        r = await fetch(`/api/build/${encodeURIComponent(jobId)}?cursor=${cursor}`, {
          signal,
          headers: { "Cache-Control": "no-cache" },
        });
      } catch (netErr) {
        if (netErr?.name === "AbortError") throw netErr;
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      if (r.status === 404) {
        const err = new Error("Job not found or expired.");
        err.notFound = true;
        throw err;
      }
      if (!r.ok) {
        // Surface a missing-JOBS-KV-binding error immediately rather than
        // burning 3 minutes of silent retries. See pollJob for context.
        try {
          const errBody = await r.json();
          const errMsg = errBody?.error?.message || "";
          if (/JOBS\s*KV/i.test(errMsg) || /missing\s+JOBS/i.test(errMsg)) {
            throw new Error(
              "Server is missing the JOBS KV binding on Cloudflare Pages. " +
              "Cloudflare dashboard \u2192 Pages \u2192 trip-optimizer \u2192 " +
              "Settings \u2192 Functions \u2192 KV namespace bindings: add " +
              "variable name JOBS pointing to a KV namespace. Then redeploy."
            );
          }
        } catch (jsonErr) {
          if (jsonErr instanceof Error && /JOBS\s+KV/i.test(jsonErr.message)) throw jsonErr;
        }
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      const data = await r.json();
      if (data?.error?.message) throw new Error(data.error.message);
      if (data.delta) {
        toolJson += data.delta;
        cursor = data.cursor;
        lastProgressAt = Date.now();
        if (typeof onDelta === "function") onDelta(data.delta, toolJson.length);
      }
      // The status payload mirrors the worker's stopReason once the model
      // sends message_delta. Read it on the final poll so resume-via-poll
      // clients get the same stop_reason signal as SSE-stream clients.
      if (data.stopReason && !stopReason) stopReason = data.stopReason;
      // #24: track server-reported status so the adaptive stall budget above
      // can extend when the job is provably still alive.
      if (typeof data.status === "string") lastServerStatus = data.status;
      if (data.status === "done") return { jobId, toolJson, stopReason };
      if (data.status === "error") throw new Error(data.error || "Build failed on server.");
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  }

  return { jobId, toolJson, stopReason };
}

// Clean an error message before it hits the UI. Strips HTML tags, collapses
// whitespace, trims length. The catch-all for any setError(err?.message) site
// where err.message might be raw HTML from an upstream error page or a long
// stack-like blob. React already escapes the text, but escaped HTML markup in
// the UI still looks broken — this normalizes it to plain prose.
function cleanErrorMessage(raw, fallback = "Something went wrong.") {
  if (!raw) return fallback;
  const s = String(raw);
  // If the string contains markup, replace with a clean message rather than
  // letting escaped tags clutter the UI.
  if (/<!doctype|<html|<body|<head|<script|<style|<\/\w+>/i.test(s)) {
    return "The server returned an unexpected response. Please retry.";
  }
  // Strip any stray tags, collapse whitespace, cap at 200 chars.
  const stripped = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!stripped) return fallback;
  return stripped.length > 200 ? stripped.slice(0, 197) + "…" : stripped;
}

// Parse a tool-input JSON buffer with salvage fallback. Returns { parsed, truncated }.
function parseToolJson(toolJson) {
  if (!toolJson) throw new Error("Empty response.");
  try {
    return { parsed: JSON.parse(toolJson), truncated: false };
  } catch (parseErr) {
    const salvaged = salvageTruncatedJSON(toolJson);
    if (!salvaged) throw new Error("The response was cut off before it finished.", { cause: parseErr });
    try {
      return { parsed: JSON.parse(salvaged), truncated: true };
    } catch (salvageErr) {
      throw new Error("The response was cut off before it finished.", { cause: salvageErr });
    }
  }
}

// Extract the IATA code from a home-airport string. The Home Airport field
// now stores the picked airport as "EWR — Newark Liberty Intl" so the user
// sees the full name after selection, but downstream logic still needs just
// the 3-letter code. This helper handles both raw codes and the rich format.
function extractAirportCode(value) {
  if (!value) return "";
  const m = String(value).trim().match(/^([A-Za-z]{3})\b/);
  return m ? m[1].toUpperCase() : "";
}

// Look up an airport record by IATA code, city, or name fragment.
// Also handles the rich "EWR — Newark Liberty Intl" format produced by
// AirportAutocomplete by first attempting an exact code-prefix extraction.
function lookupAirport(value) {
  if (!value) return null;
  const code = extractAirportCode(value);
  if (code) {
    const byCode = AIRPORTS.find(a => a.code.toUpperCase() === code);
    if (byCode) return byCode;
  }
  const v = String(value).trim().toLowerCase();
  return (
    AIRPORTS.find(a => a.code.toLowerCase() === v) ||
    AIRPORTS.find(a => a.city.toLowerCase() === v) ||
    AIRPORTS.find(a => a.code.toLowerCase().startsWith(v) || a.city.toLowerCase().startsWith(v)) ||
    null
  );
}

function AirportAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      getSuggestions={(q) => {
        // Match against code, city, name, AND the rich display string itself
        // so re-opening the dropdown after selection still surfaces matches.
        const query = q.toLowerCase();
        return AIRPORTS.filter(a =>
          a.code.toLowerCase().includes(query) ||
          a.city.toLowerCase().includes(query) ||
          a.name.toLowerCase().includes(query)
        );
      }}
      renderItem={(a) => <>{a.code}<span className="country">{a.city} · {a.name}</span></>}
      // Store the rich display string so the input field shows the full
      // airport name after the user picks one. Downstream code extracts
      // the IATA code via extractAirportCode() / lookupAirport().
      itemToValue={(a) => `${a.code} — ${a.name}`}
      itemKey={(a) => a.code}
    />
  );
}

// Pop the airline list open on click and — if we know the home airport —
// surface carriers that actually fly the user's route at the top of the list.
// We pull route hints from KNOWN_NONSTOPS keyed by home-airport IATA against
// every destination airport we have for the trip's primary city. Anything
// not in those route hints sorts to the bottom in the global AIRLINES order.
function getRouteHintAirlines(homeAirportRaw, destinationName) {
  const home = extractAirportCode(homeAirportRaw);
  if (!home || !destinationName) return [];
  const key = String(destinationName).trim().toLowerCase();
  const destEntries = DEST_AIRPORTS[key];
  if (!Array.isArray(destEntries) || destEntries.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const d of destEntries) {
    const dCode = (d.iata || "").toUpperCase();
    if (!dCode) continue;
    // KNOWN_NONSTOPS keys are stored as HOME-DEST or DEST-HOME (the table
    // mixes both directions — e.g. "CPH-EWR" and "EWR-FRA"). Try both.
    const variants = [`${home}-${dCode}`, `${dCode}-${home}`];
    for (const v of variants) {
      const list = KNOWN_NONSTOPS[v];
      if (Array.isArray(list)) {
        for (const a of list) {
          if (!seen.has(a)) { seen.add(a); out.push(a); }
        }
      }
    }
  }
  return out;
}

function AirlineAutocomplete({ value, onChange, placeholder, homeAirport, destination }) {
  // Build the suggestion list: route-relevant carriers first (when known),
  // then the rest of AIRLINES in the canonical order. When the user starts
  // typing, normal substring filtering kicks in across the merged list.
  const buildList = () => {
    const route = getRouteHintAirlines(homeAirport, destination);
    if (route.length === 0) return AIRLINES;
    const routeSet = new Set(route.map(a => a.toLowerCase()));
    const rest = AIRLINES.filter(a => !routeSet.has(a.toLowerCase()));
    // Filter route hints down to ones we actually have in AIRLINES (drop
    // aliases like "Swiss International" so users see a single entry).
    const known = route.filter(a => AIRLINES.some(b => b.toLowerCase() === a.toLowerCase()));
    return [...known, ...rest];
  };
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => {
        const list = buildList();
        if (!q) return list;
        return list.filter(a => a.toLowerCase().includes(q));
      }}
      renderItem={(a) => <>{a}</>}
      itemToValue={(a) => a}
      itemKey={(a) => a}
    />
  );
}

function HotelTierAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? HOTEL_TIERS.filter(h => h.toLowerCase().includes(q)) : HOTEL_TIERS}
      renderItem={(h) => <>{h}</>}
      itemToValue={(h) => h}
      itemKey={(h) => h}
    />
  );
}

function VehicleAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? VEHICLE_TYPES.filter(v => v.toLowerCase().includes(q)) : VEHICLE_TYPES}
      renderItem={(v) => <>{v}</>}
      itemToValue={(v) => v}
      itemKey={(v) => v}
    />
  );
}

// Rental company — filters by region of the chosen home airport.
function RentalCompanyAutocomplete({ value, onChange, placeholder, airport }) {
  const list = getRentalCompanies(airport);
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? list.filter(c => c.name.toLowerCase().includes(q)) : list}
      renderItem={(c) => <>{c.name}{c.note && <span className="country">{c.note}</span>}</>}
      itemToValue={(c) => c.name}
      itemKey={(c) => c.name}
    />
  );
}

// Simple wrappers for plain string lists.
function makeSimpleAutocomplete(getList) {
  return function SimpleAutocomplete({ value, onChange, placeholder }) {
    return (
      <Autocomplete
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        openOnFocusEmpty={true}
        minChars={0}
        getSuggestions={(q) => {
          const list = typeof getList === "function" ? getList() : getList;
          return q ? list.filter(s => s.toLowerCase().includes(q)) : list;
        }}
        renderItem={(s) => <>{s}</>}
        itemToValue={(s) => s}
        itemKey={(s) => s}
      />
    );
  };
}

const TravelersAutocomplete = makeSimpleAutocomplete(TRAVELER_PRESETS);
const CuisineAutocomplete = makeSimpleAutocomplete(CUISINE_SUGGESTIONS);
const HotelMustHaveAutocomplete = makeSimpleAutocomplete(HOTEL_MUSTHAVE_SUGGESTIONS);
const InterestsAutocomplete = makeSimpleAutocomplete(INTEREST_SUGGESTIONS);

// Suggests neighborhoods/base areas for the chosen destination from the existing areaHints list.
function BaseAreaAutocomplete({ value, onChange, placeholder, destination }) {
  // Parse the hint string for the destination into an array of area names.
  const hint = getAreaHint(destination || "");
  // Strip the leading "e.g. " and split on commas.
  const areas = hint.replace(/^e\.g\.\s*/i, "").split(/,\s*/).map(s => s.trim()).filter(Boolean);
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? areas.filter(a => a.toLowerCase().includes(q)) : areas}
      renderItem={(a) => <>{a}</>}
      itemToValue={(a) => a}
      itemKey={(a) => a}
    />
  );
}

// Sel supports two modes:
//  - single (default): controlled by a string `value` + onChange({target:{value}})
//  - multi: pass `multi` + array `value` (e.g. ["Marriott","Hyatt"]); selection
//    is rendered as toggle-chip list, onChange receives the new array via
//    {target:{value:newArr}}.
// First option is treated as the "no preference" sentinel for the multi flow
// (selecting it clears all other selections; selecting any other unselects it).
function Sel({ value, onChange, opts, multi = false, placeholder = "No preference" }) {
  if (!multi) {
    const safeVal = value || "";
    return (
      <select value={safeVal} onChange={onChange} style={{ fontSize: "13px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: safeVal ? "var(--color-text-primary)" : "var(--color-text-secondary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", appearance: "none", cursor: "pointer" }}>
        <option value="">{placeholder}</option>
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  // Multi: chip toggles. `value` is array (or stringy-legacy; coerce).
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  const isNone = arr.length === 0;
  const toggle = (opt) => {
    let next;
    if (arr.includes(opt)) next = arr.filter(x => x !== opt);
    else next = [...arr, opt];
    onChange({ target: { value: next } });
  };
  const clearAll = () => onChange({ target: { value: [] } });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", padding: "6px 0", borderBottom: "0.5px solid var(--color-border-primary)" }}>
      <button type="button" onClick={clearAll}
        style={{ fontSize: "11px", padding: "5px 9px", borderRadius: "12px", border: `0.5px solid ${isNone ? GOLD : "var(--color-border-secondary)"}`, background: isNone ? "var(--color-surface-2)" : "transparent", color: isNone ? GOLD : "var(--color-text-secondary)", fontWeight: isNone ? 600 : 400, cursor: "pointer", fontFamily: "inherit" }}>
        {placeholder}
      </button>
      {opts.map(o => {
        const on = arr.includes(o);
        return (
          <button key={o} type="button" onClick={() => toggle(o)}
            style={{ fontSize: "11px", padding: "5px 9px", borderRadius: "12px", border: `0.5px solid ${on ? GOLD : "var(--color-border-secondary)"}`, background: on ? "var(--color-surface-2)" : "transparent", color: on ? GOLD : "var(--color-text-primary)", fontWeight: on ? 600 : 400, cursor: "pointer", fontFamily: "inherit" }}>
            {o}
          </button>
        );
      })}
    </div>
  );
}

// Coerce an array-or-string preference field into a human-readable phrase
// for the system prompt. Returns "No preference" when empty.
function prefToText(v) {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "No preference";
  return v || "No preference";
}

// #5 Dynamic build-time estimate. The old copy hard-coded "3 to 15 minutes".
// Builds scale with trip length (more days = more items to verify), multi-city
// (each leg adds geocoding + per-city searches), and the number of optional
// output sections selected (each is extra generation + verification). We return
// a coarse minute RANGE string. Until the user has entered enough to estimate,
// callers fall back to a generic "can take more than 5 minutes" message.
function estimateBuildMinutes({ nights, citiesCount = 1, outputsCount = 0 } = {}) {
  const days = Math.max(1, Number(nights) || 0);
  const cityN = Math.max(1, Number(citiesCount) || 1);
  const addons = Math.max(0, Number(outputsCount) || 0);
  // Base ~2 min, +~0.5 min/day, +~1 min per extra city, +~0.4 min per add-on.
  const low = 2 + days * 0.5 + (cityN - 1) * 1 + addons * 0.4;
  const high = low * 1.7 + 2;
  const lo = Math.max(2, Math.round(low));
  const hi = Math.max(lo + 2, Math.round(high));
  return { lo, hi, text: `about ${lo}\u2013${hi} minutes` };
}

// True once the user has entered enough for a meaningful estimate.
function canEstimateBuild(basics) {
  return !!(basics && (Number(basics.nights) > 0 || (Array.isArray(basics.cities) && basics.cities.some(c => c && c.name))));
}

function TagInput({ placeholder, tags, setTags, suggestions = [] }) {
  const [val, setVal] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const q = val.trim().toLowerCase();
  const filtered = (suggestions || [])
    .filter(s => !tags.includes(s))
    .filter(s => q ? s.toLowerCase().includes(q) : true)
    .slice(0, 8);

  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const add = (v) => {
    const trimmed = (v || val).trim();
    if (!trimmed) {
      // Empty + Add click: focus the input and open suggestions so the user
      // sees a path forward instead of a silent no-op. Previously this
      // returned nothing and made the button feel broken.
      try { inputRef.current?.focus(); } catch {}
      setOpen(true);
      setActiveIdx(-1);
      return;
    }
    if (!tags.includes(trimmed)) setTags([...tags, trimmed]);
    setVal("");
    setOpen(false);
    setActiveIdx(-1);
  };

  const onKeyDown = (e) => {
    if (open && filtered.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); add(filtered[activeIdx]); return; }
      if (e.key === "Escape")    { setOpen(false); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); add(); }
  };

  return (
    <div>
      <div ref={wrapRef} style={{ display: "flex", gap: "8px", marginBottom: "8px", position: "relative" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            ref={inputRef}
            value={val}
            onChange={e => { setVal(e.target.value); setOpen(true); setActiveIdx(-1); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            autoComplete="off"
            style={{ width: "100%", fontSize: "13px", padding: "8px 0", border: "none", borderBottom: `0.5px solid var(--color-border-primary)`, background: "transparent", color: "var(--color-text-primary)", outline: "none", fontFamily: "inherit" }}
          />
          {open && filtered.length > 0 && (
            <div className="city-suggestions" role="listbox">
              {filtered.map((s, i) => (
                <div
                  key={s}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`city-suggestion${i === activeIdx ? " active" : ""}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseDown={(e) => { e.preventDefault(); add(s); }}
                >{s}</div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => add()} style={{ background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "6px 12px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>+ Add</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
        {tags.map(t => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: "5px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "4px 10px", fontSize: "12px", color: "var(--color-text-primary)" }}>
            {t}
            <button onClick={() => setTags(tags.filter(x => x !== t))} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: "15px", padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, desc, checked, onChange, disabled }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "0.5px solid var(--color-border-tertiary)", gap: "12px" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>{label}{disabled && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginLeft: "8px", fontStyle: "italic" }}>always included</span>}</div>
        {desc && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{desc}</div>}
      </div>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} style={{ accentColor: GOLD, width: "15px", height: "15px", cursor: disabled ? "not-allowed" : "pointer", flexShrink: 0 }} />
    </div>
  );
}

const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)", padding: "1.25rem 1.5rem", marginBottom: "1rem" };
const ctStyle = { fontSize: "11px", fontWeight: "500", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 1.1rem", paddingBottom: "10px", borderBottom: "0.5px solid var(--color-border-tertiary)" };
const g2 = { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "20px", marginBottom: "16px" };
const g3 = { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)", gap: "14px", marginBottom: "16px" };

// ----------------------------------------------------------------------------
// Anthropic tool_use schema. Forces the model to produce structured JSON that
// matches this shape — no more truncation, no more empty days[], no more
// "summary in logistics" failures. The API validates before responding.
// ----------------------------------------------------------------------------
const MENU_DISH_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    price: { type: "string" },
  },
  required: ["name"],
};

const MENU_SCHEMA = {
  type: "object",
  description: "Representative menu reconstructed from typical offerings.",
  properties: {
    style_note: { type: "string" },
    signature_dishes: { type: "array", items: MENU_DISH_SCHEMA },
    appetizers: { type: "array", items: MENU_DISH_SCHEMA },
    mains: { type: "array", items: MENU_DISH_SCHEMA },
    desserts: { type: "array", items: MENU_DISH_SCHEMA },
    wine_and_drinks: { type: "array", items: MENU_DISH_SCHEMA },
    source_note: { type: "string", description: "Disclaimer that menus change." },
  },
};

const RESTAURANT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    neighborhood: { type: "string" },
    cuisine: { type: "string" },
    price_range: { type: "string", description: "$, $$, $$$, or $$$$" },
    why: { type: "string", description: "Insider, opinionated 1–2 sentence reason." },
    closure_note: { type: "string", description: "Confirm closure-day awareness given the weekday of the meal." },
    // Day-of-week open days. Mirrors the Santa Fe June dataset format. When
    // present, the renderer cross-checks the assigned meal day and surfaces
    // a red 'Closed [Day]' chip if the restaurant is not open that weekday.
    // Omit entirely when truly unknown — downstream code treats missing as
    // 'assume open' rather than 'closed every day'.
    open_days: {
      type: "array",
      description: "Lowercase 3-letter weekday codes the restaurant serves DINNER (or the relevant meal). Use only what you genuinely know. Omit if uncertain. Examples: ['mon','tue','wed','thu','fri','sat'] for a typical 'closed Sundays' spot; ['tue','wed','thu','fri','sat','sun'] for 'closed Mondays'.",
      items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
    },
    hours_note: {
      type: "string",
      description: "Short human-readable hours summary if known. Examples: 'Mon–Sat 5–9pm', 'Daily 5–9:30pm, last seating 8pm', 'Closed Sun-Mon'. Omit if uncertain.",
    },
    reservation: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["opentable", "resy", "tock", "yelp", "phone", "walkin"] },
        url: { type: "string" },
        phone: { type: "string" },
      },
      required: ["platform"],
    },
    contact: {
      type: "object",
      description: "Restaurant contact info. The website field powers the 'Website ↗' button on the card.",
      properties: {
        phone: { type: "string" },
        address: { type: "string" },
        website: { type: "string", description: "Official restaurant website (e.g. https://thecompoundrestaurant.com). Omit if you don't know it — a confirmation pass fills missing websites." },
        hours: { type: "string" },
      },
    },
    menu: MENU_SCHEMA,
  },
  required: ["name", "cuisine", "why"],
};

// Backup is the same shape but allowed to be slimmer.
const BACKUP_SCHEMA = { ...RESTAURANT_SCHEMA, description: "Same-tier fallback in the same neighborhood / cuisine family." };

// ============================================================================
// DESTINATION FACTS — hard-corrected facts injected into the planner prompt.
// Each entry: triggers (lowercase substrings tested against the destination)
// + facts (an array of bullet strings). The planner sees these as authoritative
// corrections to its training data — things it has gotten wrong before.
//
// Append to this list whenever the user catches a factual error the model
// keeps re-emitting (wrong neighborhood, closed venue, mis-located restaurant).
// Keep facts SHORT, SPECIFIC, and only worth promoting if the model has
// gotten it wrong at least once — the goal is correction, not exhaustive
// reference data.
// ============================================================================
const DESTINATION_FACTS = [
  {
    triggers: ["aruba", "oranjestad", "palm beach", "eagle beach"],
    facts: [
      "Atardi (the open-air sunset dining venue at Aruba Marriott Resort & Stellaris Casino, L.G. Smith Blvd 101) is on PALM BEACH, not Eagle Beach. Eagle Beach is south of Palm Beach and is the lower-rise resort strip (Bucuti & Tara, Manchebo, Amsterdam Manor). Do not write 'Atardi over Eagle Beach' — it is 'Atardi on Palm Beach'.",
      "AUA (Queen Beatrix International, Aruba) has US Customs and Border Protection PRE-CLEARANCE for all US-bound flights. Departing passengers complete US immigration + customs IN ARUBA before boarding, then arrive in the US as a domestic flight. Recommended airport arrival is THREE (3) HOURS before US departure — not 2 hours. Airport entry is also flow-controlled by departure-time color groups; entry to the US Check-In Terminal is permitted no earlier than 3 hours before departure. Set airport_arrival_buffer='3 h' on any departure-day Flight item from AUA to a US destination, and surface this in flags[] or the departure-day Transport item ('Depart hotel 3.5 h before flight to allow for taxi + pre-clearance').",
      "AUA has the Aruba Airport Lounge, accessible to Priority Pass members and many premium-card holders (verify current card list), located post-security in the US Departures terminal. Surface this in lounge_access on the return-flight item.",
      "Palm Beach high-rise resort strip (north): Ritz-Carlton Aruba, Aruba Marriott, Hyatt Regency, Hilton Aruba Caribbean, Holiday Inn. Eagle Beach low-rise strip (just south): Bucuti & Tara (adults-only, top-rated), Manchebo Beach Resort, Amsterdam Manor. Know which beach your hotel is on before writing the headline.",
    ],
  },
];

// Returns the formatted destination-facts block for a destination string, or
// an empty string if no facts match.
function buildDestinationFactsBlock(destinationText) {
  if (!destinationText) return "";
  const d = String(destinationText).toLowerCase();
  const matched = DESTINATION_FACTS.filter(g => g.triggers.some(t => d.includes(t)));
  if (matched.length === 0) return "";
  const lines = matched.flatMap(g => g.facts.map(f => `• ${f}`));
  return `\nDESTINATION FACTS — AUTHORITATIVE CORRECTIONS (override your training data):\nThese facts have been verified by the app team and override anything in your training data. If you previously thought otherwise, you were wrong; use these.\n${lines.join("\n")}\n`;
}

const FLIGHT_SCHEMA = {
  type: "object",
  description: "Structured flight details. Required for any item with type=Flight.",
  properties: {
    carrier: { type: "string", description: "Full airline name, e.g. 'United', 'Delta', 'JetBlue'." },
    flight_number: { type: "string", description: "Specific flight number, e.g. 'UA 1234'. Use a realistic flight number that the carrier is known to operate on this route. Will be flagged in UI as 'verify at booking' — never claim a specific flight is guaranteed." },
    from_airport: { type: "string", description: "Origin IATA code, e.g. 'EWR'." },
    to_airport: { type: "string", description: "Destination IATA code, e.g. 'ABQ'." },
    depart_time: { type: "string", description: "Local 24h time at origin, e.g. '08:45'." },
    arrive_time: { type: "string", description: "Local 24h time at destination, e.g. '11:20'." },
    duration: { type: "string", description: "e.g. '4h 35m'." },
    nonstop: { type: "boolean" },
    connection: { type: "string", description: "If not nonstop, the connecting airport code, e.g. 'DEN'." },
    cabin: { type: "string", description: "e.g. 'Polaris Business', 'First', 'Economy Plus'." },
    aircraft: { type: "string", description: "e.g. 'Boeing 737-900', 'Airbus A321neo'." },
    confirmation_note: { type: "string", description: "Booking guidance, e.g. 'Book directly on united.com for Polaris lounge access'." },
    airport_arrival_buffer: { type: "string", description: "Recommended airport-arrival lead time before departure, e.g. '3 h' for US pre-clearance airports (Aruba AUA, Bahamas NAS, Bermuda BDA, Dublin DUB, Shannon SNN, Abu Dhabi AUH) or '2.5 h' for international, '1.5 h' for domestic. Required for departure-day Flight items." },
    lounge_access: {
      type: "array",
      description: "Airport lounges the traveler can access on this flight — by cabin (Polaris, Flagship, Delta One, etc.), elite status (United 1K, Star Alliance Gold), or membership (Priority Pass, Amex Centurion / Plat, Capital One). Include even when uncertain so the traveler can verify access.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. 'United Polaris Lounge', 'Aruba Airport Lounge', 'Centurion Lounge'." },
          terminal: { type: "string", description: "Terminal / concourse / gate range, e.g. 'Terminal C, post-security, near gates C70-C90'. Be specific about WHERE in the terminal so the traveler knows whether to detour for it." },
          access: { type: "string", description: "How to enter: 'Polaris business cabin', 'Priority Pass', 'Amex Centurion / Plat (with same-day boarding pass)', 'United Club one-time pass', 'Star Alliance Gold + intl business'." },
          gate_proximity: { type: "string", description: "How close this lounge is to the traveler's likely gate, e.g. 'Closest to UA gates C70-C90', 'Same concourse as the gate', '~5 min walk from gate', 'Different terminal — only worth it with 2+ hours'. Helps the traveler pick when multiple lounges are accessible." },
          notes: { type: "string", description: "Hours, food highlights, showers, must-arrive-by note. Keep short." },
        },
        required: ["name", "access"],
      },
    },
  },
  required: ["carrier", "flight_number", "from_airport", "to_airport", "depart_time", "arrive_time", "nonstop"],
};

const HOTEL_ITEM_SCHEMA = {
  type: "object",
  description: "Structured hotel check-in/check-out details. Use for any Hotel-type item.",
  properties: {
    name: { type: "string" },
    address: { type: "string" },
    phone: { type: "string", description: "Direct line, formatted +1-505-988-3030. Tappable in-app." },
    check_in_time: { type: "string", description: "e.g. '15:00'." },
    check_out_time: { type: "string", description: "e.g. '11:00'." },
    room_type: { type: "string" },
    website: { type: "string", description: "Official hotel website URL — the property's actual homepage (e.g. https://www.ritzcarlton.com/...). URLs are HEAD-checked after generation; broken links auto-swap to a Google fallback. OMIT this field if you are not highly confident the URL is live. Do NOT fabricate URLs or guess a domain." },
    confirmation_note: { type: "string" },
  },
};

// Unified contact block. Attached to Activity/Transport/Note items so we can
// render an "About" modal with tap-to-call, directions, hours, and a booking
// link. Restaurants use the existing RESTAURANT_SCHEMA.reservation block;
// Hotels use HOTEL_ITEM_SCHEMA.phone/address. This is for everything else.
const CONTACT_SCHEMA = {
  type: "object",
  description: "Contact info for activities, tours, museums, transport providers — anything the traveler may need to call, book, or get directions to. REQUIRED for every Activity and every Transport item: BOTH phone AND website. The website is verified server-side after generation; if you don't know a real working URL, OMIT the website field entirely — do NOT invent a plausible-looking URL, do NOT guess a domain, do NOT use generic placeholders. A missing URL is far better than a broken one (the user gets a Google search fallback). Phone numbers must be in the destination's local format with country code (+1-NYC, +41 for Switzerland, +39 for Italy, etc.). If you cannot supply a phone number either, write the contact via the hotel concierge instead (set booking_note to 'Booked via hotel concierge — ask front desk').",
  properties: {
    phone: { type: "string", description: "REQUIRED for Transport and Activity items. Main reservation/info line in tappable format, e.g. '+1-505-988-3236' or '+41 44 422 25 20'. If unknown, use the hotel concierge line instead and note that in booking_note." },
    website: { type: "string", description: "Official site URL — the operator's actual homepage you would link a luxury traveler to. URLs are HEAD-checked after generation; broken links get auto-swapped to a Google fallback. Therefore: OMIT this field if you are not highly confident the URL is live. Do NOT fabricate URLs." },
    booking_url: { type: "string", description: "Direct booking/reservation page. Used by 'Book ↗' button. Examples: Viator/GetYourGuide/Tock/Eventbrite URLs. Subject to the same verification — omit if unsure." },
    address: { type: "string", description: "Full street address including city. Used for 'Directions' button (Google Maps link)." },
    hours: { type: "string", description: "Operating hours relevant to the visit, e.g. 'Tue–Sun 10–5, closed Mondays' or 'Sat 7:30am–6:30pm'." },
    price: { type: "string", description: "Per-person cost or price range, e.g. '$45/adult', 'CHF 32', 'Free', '$200/person private tour'." },
    booking_note: { type: "string", description: "Booking nuance: 'Book 7+ days ahead', 'Members-only — bring NMA card', 'Pay at door', 'Cash only', etc." },
  },
};

const DAY_ITEM_SCHEMA = {
  type: "object",
  properties: {
    time: { type: "string", description: "REQUIRED. Local 24h start time for this item, e.g. '08:30', '12:00', '19:30'. Must be present on EVERY item so the day reads chronologically." },
    end_time: { type: "string", description: "Optional local 24h end time, e.g. '10:00'. Use for activities and meals with a known duration." },
    type: { type: "string", enum: ["Flight", "Hotel", "Activity", "Breakfast", "Brunch", "Lunch", "Dinner", "Transport", "Note"] },
    text: { type: "string", description: "Short headline of the item — what it is and where, no times (times go in the time field)." },
    location: { type: "string", description: "Specific venue or address when applicable." },
    duration: { type: "string", description: "Human-readable duration if useful, e.g. '2 hours', '90 min'." },
    why: { type: "string", description: "For Activity items: 1–2 sentence insider/opinionated reason this is on the trip. Skip for Flight/Hotel/Note." },
    contact: CONTACT_SCHEMA,
    flight: FLIGHT_SCHEMA,
    hotel: HOTEL_ITEM_SCHEMA,
    restaurant: { ...RESTAURANT_SCHEMA, properties: { ...RESTAURANT_SCHEMA.properties, backup: BACKUP_SCHEMA } },
  },
  required: ["time", "type", "text"],
};

const DAY_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", description: "Day label using the EXACT stamp from the COMPUTED DATE TABLE, followed by the day's purpose. Format: 'Day N · <stamp from table> · <purpose>'. Example: 'Day 1 · Wed Aug 25 · Arrive Santa Fe'. Never compute the weekday yourself — always copy it from the table." },
    city: { type: "string", description: "Which city this day belongs to on multi-city trips (e.g. 'Santa Fe, NM'). Match the spelling in the cities[] array. Transit days that span two cities use 'From→To' format (e.g. 'Santa Fe → Taos')." },
    headline: { type: "string", description: "REQUIRED. The one signature moment of the day, written as a vivid 6–10 word phrase. Examples: 'Sunset margaritas on the Anasazi rooftop' · 'Walk Canyon Road slowly before the galleries close' · 'Drive to Abiquiú for the Pedernal light'. Never leave blank." },
    weather: { type: "string", description: "REQUIRED. Seasonal expectation for this destination/date: high/low + sky + any caveat. e.g. 'High 82°F / low 52°F · sun w/ 30% PM thunderstorm risk'. Use seasonal norms; never fabricate live forecasts." },
    pace_note: { type: "string", description: "Optional 1-line pacing call: 'easy arrival', 'big driving day', 'spa & slow', etc." },
    items: { type: "array", items: DAY_ITEM_SCHEMA, minItems: 3 },
  },
  required: ["label", "headline", "weather", "items"],
};

// IMPORTANT: property declaration order matters here. Anthropic models tend to
// emit fields in the order they appear in the schema. days[] MUST be declared
// before the smaller string-array fields (logistics/flags/planb) so the model
// commits the expensive content first — if anything gets truncated, we lose
// the tail (insider notes, plan B) instead of the entire itinerary.
const TRIP_PLAN_TOOL = {
  name: "submit_trip_plan",
  description: "Submit the finalized luxury trip plan to the user. You MUST call this tool with a complete plan. CRITICAL: emit fields in this exact order: destination, meta, days, then everything else. days[] is the main deliverable — write it BEFORE logistics, flags, planb, snobs, or tonight.",
  input_schema: {
    type: "object",
    properties: {
      destination: { type: "string", description: "WRITE FIRST. For multi-city trips, join cities with arrows: 'Santa Fe → Taos → Albuquerque'." },
      meta: { type: "string", description: "WRITE SECOND. One-line summary: Dates · N nights · N travelers · Style. For multi-city, indicate the leg structure too (e.g. 'Sat–Sat · 3+2+2 nights')." },
      cities: {
        type: "array",
        description: "REQUIRED for multi-city trips, omit for single-city. One entry per leg in travel order. Inter-city transport (drive/fly time + distance) is captured in each city's transport_in field. Day count per city should match the user-requested nights for that city.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "City name as the user entered it (e.g. 'Santa Fe, NM')." },
            nights: { type: "integer", description: "Nights at this city." },
            days_range: { type: "string", description: "e.g. 'Day 1–Day 3' or 'Day 4–Day 5'." },
            focus: { type: "string", description: "What this leg is FOR — the why. e.g. 'Galleries + food on Canyon Road', 'Skiing & mountain lunches', 'Day trips to Bandelier'." },
            transport_in: { type: "string", description: "How the traveler ARRIVES at this city. For Leg 1: 'Fly EWR→ABQ · 4h 30m nonstop · then 1h drive to Santa Fe'. For later legs: 'Drive Santa Fe→Taos · 1h 15m · 70 miles via US-285' or 'Fly SFO→LAX · 1h 25m'. Include time AND distance for drives, time only for flights." },
            stay: { type: "string", description: "The recommended hotel/lodging name for this leg." },
          },
          required: ["name", "nights", "days_range"],
        },
        maxItems: 3,
      },
      days: {
        type: "array",
        description: "WRITE THIRD — THIS IS THE MAIN DELIVERABLE. Day-by-day plan. Must have exactly nights+1 entries. Never empty. Write this BEFORE logistics/flags/planb/snobs/tonight.",
        items: DAY_SCHEMA,
        minItems: 1,
      },
      logistics: {
        type: "array",
        description: "WRITE AFTER DAYS. Short chips only (≤6 chips, ≤40 chars each). Top-line facts. NO long sentences.",
        items: { type: "string" },
        maxItems: 6,
      },
      weather_window: { type: "string", description: "WRITE AFTER DAYS. 1–2 sentence seasonal weather expectation for the trip dates + any pattern the traveler should plan around (e.g. afternoon monsoons, midday heat). Never fabricate a live forecast." },
      pack: {
        type: "array",
        description: "WRITE AFTER DAYS. 4–8 destination-specific packing or prep essentials that are NOT obvious (e.g. 'Aspirin for altitude headache', 'Layers — evenings drop 30°F', 'Cash for Canyon Road galleries'). Skip the obvious (passport, phone charger).",
        items: { type: "string" },
        minItems: 3,
        maxItems: 8,
      },
      flags: { type: "array", items: { type: "string" }, description: "WRITE AFTER DAYS. Constraint flags: closures, booking lead times." },
      planb: {
        type: "array",
        items: { type: "string" },
        description: "WRITE AFTER DAYS. AT LEAST 5 disruption alternatives. Cover at minimum: weather/rain, a sold-out marquee restaurant, a closed-day activity, a transport disruption (canceled flight / car issue), and a health/altitude/illness day. Each entry: brief scenario → concrete substitute.",
        minItems: 5,
      },
      snobs: { type: "array", items: { type: "string" }, description: "WRITE LAST. Insider tone notes." },
      tonight: { type: "array", items: { type: "string" }, description: "WRITE LAST. Action items to do tonight — each prefixed with priority: '⚠︎ Must today:', '· This week:', or 'Anytime:'. Most urgent first." },
      // NOTE: introduction is intentionally NOT in this schema. It is
      // generated by an external AI tool and pasted into the rendered plan
      // via the Introduction paste box on the result page. Keeping it out
      // of the planner's responsibility saves ~600 output tokens per build
      // and removes one source of max_tokens truncation pressure.
    },
    required: ["destination", "meta", "days"],
  },
};

// ============================================================================
// PROFESSIONAL REVIEW SYSTEM
// ----------------------------------------------------------------------------
// After a plan is generated, the user can request a professional review from
// a curated set of editorial / hotel / restaurant / local-voice sources. The
// reviewer produces a structured set of findings (no free-form prose) which
// the user can selectively apply. Surgical-mode card swaps re-run the same
// /api/build pipeline with REVISION_TOOL in patches mode; broader changes
// (pacing, neighborhood, day restructure) trigger a full re-plan with the
// reviewer's findings injected into the system prompt.
// ============================================================================

// 12 reviewer sources organized into 4 lens groups. Default = the 4 marked
// `dflt: true` (Condé Nast, Michelin Guide, NYT 36 Hours, Reddit + locals)
// which together cover editorial / restaurants / itinerary pacing / local truth.
const REVIEWER_SOURCES = [
  // Editorial lens — overall trip shape, taste level, neighborhood selection.
  { id: "cnt",        name: "Condé Nast Traveler",           lens: "editorial",   dflt: true,  blurb: "Hot Lists, Reader's Choice" },
  { id: "tl",         name: "Travel + Leisure",              lens: "editorial",   dflt: false, blurb: "World's Best, A-List advisors" },
  { id: "departures", name: "Departures",                    lens: "editorial",   dflt: false, blurb: "Amex Platinum — high-end taste" },
  // Hotels lens — property quality, service, room hierarchy.
  { id: "forbes",     name: "Forbes Travel Guide",           lens: "hotels",      dflt: false, blurb: "5-star service standards" },
  { id: "michelinK",  name: "Michelin Keys",                 lens: "hotels",      dflt: false, blurb: "New 1–3 Key hotel rating" },
  { id: "lqa",        name: "LQA / Leading Hotels",          lens: "hotels",      dflt: false, blurb: "Mystery-shop service audits" },
  // Restaurants lens — culinary quality, reservation logic, scene fit.
  { id: "michelinG",  name: "Michelin Guide",                lens: "restaurants", dflt: true,  blurb: "Stars, Bib Gourmand, Plates" },
  { id: "w50b",       name: "World's 50 Best",               lens: "restaurants", dflt: false, blurb: "Global voting body" },
  { id: "eater",      name: "Eater",                         lens: "restaurants", dflt: false, blurb: "City-level Heatmaps & Essential 38" },
  // Local voice lens — pacing, walkability, when-to-go, what locals actually do.
  { id: "nyt36",      name: "NYT 36 Hours",                  lens: "local",       dflt: true,  blurb: "Tight, pacing-aware day plans" },
  { id: "ftHTSI",     name: "FT How to Spend It",            lens: "local",       dflt: false, blurb: "Bloomberg Pursuits–style insider picks" },
  { id: "reddit",     name: "Reddit + locals",               lens: "local",       dflt: true,  blurb: "r/travel, r/[city] real talk" },
  // Off-the-beaten-path lens — finds the experiences mainstream travel
  // press misses. Atlas Obscura is the canonical hidden-gems catalog;
  // Substack travel newsletters are where editors who left Condé Nast /
  // T+L publish their real picks. Both default-on so every reviewer run
  // surfaces at least a couple of off-beat options the model can weave in.
  { id: "atlasObscura", name: "Atlas Obscura",               lens: "local",       dflt: true,  blurb: "Hidden gems, oddities, obscure landmarks" },
  { id: "substack",   name: "Substack travel",               lens: "local",       dflt: true,  blurb: "Indie editors' fresh picks, newly opened" },

  // Hyperlocal lens — destination-specific authoritative sources. NOT default-on
  // for every trip; they auto-attach (dflt becomes true via HYPERLOCAL_REGIONS
  // matching) when the destination is one we have curated coverage for. Today
  // that's Lake George / Bolton Landing, NY. The match runs on the resolved
  // destination string and adds these IDs to the default-selected set on top
  // of the 6 generic defaults.
  { id: "poststar",   name: "The Post-Star",                 lens: "hyperlocal",  dflt: false, region: "lake_george", blurb: "Daily paper, Glens Falls / Lake George area" },
  { id: "lgexaminer", name: "Lake George Examiner",          lens: "hyperlocal",  dflt: false, region: "lake_george", blurb: "Weekly local coverage" },
  { id: "adklife",    name: "Adirondack Life",               lens: "hyperlocal",  dflt: false, region: "lake_george", blurb: "Regional magazine of record" },
  { id: "adkreddit",  name: "r/adirondacks",                 lens: "hyperlocal",  dflt: false, region: "lake_george", blurb: "Current local-resident voice" },
  { id: "visitlg",    name: "Visit Lake George",             lens: "hyperlocal",  dflt: false, region: "lake_george", blurb: "Tourism board" },
  { id: "lgmirror",   name: "Lake George Mirror",            lens: "hyperlocal",  dflt: false, region: "lake_george", blurb: "Weekly summer paper" },
];

// HYPERLOCAL_REGIONS — destination-matching table that decides which hyperlocal
// sources to auto-attach to the default reviewer selection. Mirror of the
// server's LOCAL_SOURCE_OVERRIDES (functions/api/find.js) but kept lean: we
// only need the match predicate and the source IDs here. Source domains and
// query templates live server-side in review-retrieve.js's SOURCE_CONFIG.
//
// Adding a new region means adding entries in THREE places:
//   1. New rows here with the match() + sourceIds
//   2. REVIEWER_SOURCES entries above with region: <key>
//   3. SOURCE_CONFIG entries in functions/api/review-retrieve.js so the
//      server knows the domains and query template
// The duplication is intentional: server fan-out and client picker have
// different shape requirements, but the matching logic stays in sync via
// shared region keys.
const HYPERLOCAL_REGIONS = [
  {
    key: "lake_george",
    label: "Lake George / Bolton Landing, NY",
    // Same predicate the server uses in find.js's LOCAL_SOURCE_OVERRIDES.
    // Lower-cases destination first; rejects matches that mention a
    // disambiguating state OTHER than NY (Lake George, MI exists).
    match: (rawDest) => {
      const loc = String(rawDest || "").toLowerCase();
      if (!loc) return false;
      const hasLakeGeorge = /\blake george\b/.test(loc);
      const hasBoltonLanding = /\bbolton landing\b/.test(loc);
      const hasBoltonNY = /\bbolton, ?ny\b/.test(loc);
      const mentionsOtherState = /\b(mi|michigan|fl|florida|mn|minnesota|co|colorado|wa|washington)\b/.test(loc);
      if (mentionsOtherState && !/(ny|new york)/.test(loc)) return false;
      return hasLakeGeorge || hasBoltonLanding || hasBoltonNY;
    },
    sourceIds: ["poststar", "lgexaminer", "adklife", "adkreddit", "visitlg", "lgmirror"],
  },
];

// Resolve which hyperlocal region (if any) a given destination string maps to.
// Returns the matched region or null. Pure function; safe to call in render.
function matchHyperlocalRegion(destination) {
  for (const region of HYPERLOCAL_REGIONS) {
    if (region.match(destination)) return region;
  }
  return null;
}

const REVIEWER_LENSES = [
  { id: "editorial",   label: "Editorial",       why: "Overall trip taste, shape, and neighborhood logic — do the days hold together as a coherent stay." },
  { id: "hotels",      label: "Hotels",          why: "Property tier, service, and room hierarchy — is this the right hotel for the trip's price and purpose." },
  { id: "restaurants", label: "Restaurants",     why: "Culinary quality, reservation feasibility, scene fit — would a serious diner make these picks." },
  { id: "local",       label: "Local voice",     why: "Pacing, walkability, what locals actually do — does the plan move like a local would, or a tourist." },
  { id: "hyperlocal",  label: "Hyperlocal",      why: "Destination-specific authoritative sources — the local paper, the tourism board, the regional magazine. Only appears when the destination matches a curated region." },
];

// findings[].mode_hint controls the surgical-vs-full router. Card-targeted
// hints can be applied as a JSON patch; structural hints require a re-plan.
const CARD_TARGETED_HINTS = new Set([
  "swap_restaurant",
  "swap_hotel",
  "swap_planb",
  "swap_activity",
  "adjust_logistics",
  "add_flag",
  "add_tonight",
]);

// Format a finding.target ({day, time, item} | string) into a short chip label.
function formatFindingTarget(t) {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (typeof t !== "object") return String(t);
  const parts = [];
  if (t.day != null) parts.push(`Day ${t.day}`);
  if (t.time) parts.push(String(t.time));
  if (t.label) parts.push(String(t.label));
  if (t.item) parts.push(String(t.item));
  if (t.section) parts.push(String(t.section));
  if (parts.length === 0) {
    try { return JSON.stringify(t); } catch { return ""; }
  }
  return parts.join(" · ");
}

// Decide which revision path to use given the set of findings the user marked
// for Apply. Returns 'surgical' if every selected finding has a card-targeted
// mode_hint AND there are at most 3 findings. Returns 'full' otherwise.
function routeRevisionMode(selectedFindings) {
  if (!Array.isArray(selectedFindings) || selectedFindings.length === 0) return null;
  if (selectedFindings.length > 3) return "full";
  for (const f of selectedFindings) {
    if (!f?.mode_hint || !CARD_TARGETED_HINTS.has(f.mode_hint)) return "full";
  }
  return "surgical";
}

const REVIEW_TOOL = {
  name: "submit_review",
  description: "Submit a structured professional review of an existing trip plan. NO free-form prose — only call this tool with a verdict + findings[] array. Each finding is a single, actionable observation a luxury concierge would flag. Critical findings = real problems that hurt the trip. Suggested = clear upgrades. Nice-to-have = polish.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        description: "One-line overall verdict in the format 'A | B+ | B | C+ | C — short rationale (≤14 words)'. Examples: 'B+ — strong hotels, but Day 2 pacing is too aggressive', 'A — tight, well-balanced, no notes'.",
      },
      findings: {
        type: "array",
        description: "Each finding is ONE actionable observation. Order by severity (critical first), then by day order. AT LEAST 1 finding unless verdict is A with no notes. Cap at 8 findings — pick the highest-impact issues only.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id: 'f1', 'f2', 'f3', etc. — used to track Apply selections." },
            severity: { type: "string", enum: ["critical", "suggested", "nice"], description: "critical = real problem that hurts the trip (e.g. closed restaurant, impossible drive time, hotel mismatch). suggested = clear upgrade (better-fitting hotel, more interesting restaurant). nice = polish (timing tweak, micro-substitution)." },
            lens: { type: "string", enum: ["editorial", "hotels", "restaurants", "local"], description: "Which lens flagged this. Must match the lens of the source(s) supporting it." },
            source: { type: "string", description: "Which reviewer source(s) flag this, comma-separated. Use the source names exactly: 'Condé Nast Traveler', 'Michelin Guide', 'NYT 36 Hours', 'Reddit + locals', etc." },
            target: { type: "string", description: "What this finding is ABOUT, in the user's language. Format: 'Day N · context' or 'Hotel' or 'Pacing' or 'Plan B'. Examples: 'Day 2 · lunch', 'Day 3 · hotel', 'Pacing — Days 4–5', 'Plan B'." },
            summary: { type: "string", description: "One sentence (≤22 words) stating the issue. Plain, specific, no hedging. Example: 'Dinner at Geranium on Day 3 needs a 2–3 month reservation; the plan assumes walk-in.'" },
            action: { type: "string", description: "One sentence (≤22 words) stating the concrete change to make. Example: 'Swap to Alchemist (similar tier, easier reservation) or move Geranium to Day 1 and book now.'" },
            mode_hint: { type: "string", enum: ["swap_restaurant", "swap_hotel", "swap_planb", "swap_activity", "adjust_logistics", "add_flag", "add_tonight", "adjust_pacing", "change_neighborhood", "restructure_day", "rebalance_legs", "change_hotel_brand_tier"], description: "Categorizes the kind of change. Swap_* hints can be applied as a card-level patch. Structural hints (adjust_pacing, change_neighborhood, restructure_day, rebalance_legs, change_hotel_brand_tier) require a full re-plan." },
            default_apply: { type: "boolean", description: "Whether the Apply toggle should default ON. Set true for critical findings, false for nice findings; for suggested findings use your judgment based on impact." },
          },
          required: ["id", "severity", "lens", "source", "target", "summary", "action", "mode_hint", "default_apply"],
        },
        maxItems: 8,
      },
    },
    required: ["verdict", "findings"],
  },
};

const REVISION_TOOL_SURGICAL = {
  name: "submit_revision_patches",
  description: "Apply a small set of surgical patches to an existing trip plan. Each patch describes ONE replacement: a new item to put in place of an existing item identified by day index + item index. The client merges these patches into the plan locally. Use this ONLY when the changes are card-level swaps (restaurant, hotel, plan B, activity). Do NOT use for pacing or neighborhood changes.",
  input_schema: {
    type: "object",
    properties: {
      patches: {
        type: "array",
        description: "At most 5 patches. Each patch targets one specific card.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["replace_item", "replace_hotel", "replace_planb_entry", "add_flag", "add_tonight"], description: "What kind of patch. replace_item swaps one day's item (restaurant/activity/transport). replace_hotel swaps the hotel item for a day. replace_planb_entry replaces one Plan B entry by index. add_flag / add_tonight append a new string." },
            finding_id: { type: "string", description: "The bracketed [id] of the finding this patch addresses (e.g. 'f2'), copied verbatim from FINDINGS TO ADDRESS. Lets the client confirm exactly which findings were applied." },
            day_index: { type: "integer", description: "0-based day index. Required for replace_item and replace_hotel." },
            item_index: { type: "integer", description: "0-based item index within day.items[]. Required for replace_item." },
            planb_index: { type: "integer", description: "0-based index into planb[]. Required for replace_planb_entry." },
            new_item: { type: "object", description: "The replacement item, matching the DAY_SCHEMA items shape (type, name, time, location, etc.). Required for replace_item / replace_hotel.", additionalProperties: true },
            new_text: { type: "string", description: "The replacement text. Required for replace_planb_entry / add_flag / add_tonight." },
            rationale: { type: "string", description: "One short sentence (≤18 words) explaining why this patch addresses the finding." },
          },
          required: ["op", "finding_id", "rationale"],
        },
        maxItems: 5,
      },
    },
    required: ["patches"],
  },
};

// For full re-plans the revised plan must match TRIP_PLAN_TOOL exactly — we
// reuse the same schema so the existing parser/renderer paths work unchanged.
const REVISION_TOOL_FULL = TRIP_PLAN_TOOL;

// Build the system prompt that runs the review. We pass in the plan JSON (the
// Extract the primary hotel name from a plan. The first Hotel-type item we
// find wins — multi-city plans will use whichever leg comes first, which is
// fine for retrieval scoping.
function extractPrimaryHotel(plan) {
  if (!plan?.days) return null;
  for (const day of plan.days) {
    if (!Array.isArray(day?.items)) continue;
    for (const item of day.items) {
      if (item?.type === "Hotel" && item.name) return String(item.name);
    }
  }
  return null;
}

// Top N unique restaurant names across the plan (in order of appearance).
function extractRestaurantNames(plan, limit = 6) {
  if (!plan?.days) return [];
  const out = [];
  const seen = new Set();
  const restaurantTypes = new Set(["Restaurant", "Breakfast", "Lunch", "Dinner", "Brunch"]);
  for (const day of plan.days) {
    if (!Array.isArray(day?.items)) continue;
    for (const item of day.items) {
      if (!restaurantTypes.has(item?.type)) continue;
      const name = String(item?.name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Top N unique activity names across the plan.
function extractActivityNames(plan, limit = 4) {
  if (!plan?.days) return [];
  const out = [];
  const seen = new Set();
  for (const day of plan.days) {
    if (!Array.isArray(day?.items)) continue;
    for (const item of day.items) {
      if (item?.type !== "Activity") continue;
      const name = String(item?.name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Render the live-retrieval snippets into a compact prompt block. Empty input
// → empty string (the review prompt simply omits the block).
function renderLiveSourceBlock(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) return "";
  const lines = [];
  for (const s of snippets) {
    if (!Array.isArray(s?.results) || s.results.length === 0) continue;
    lines.push(`[${s.source_name}]`);
    for (const r of s.results) {
      const datePart = r.date ? ` (${r.date})` : "";
      const snip = (r.snippet || "").replace(/\s+/g, " ").trim().slice(0, 220);
      lines.push(`  • ${r.title}${datePart} — ${r.url}`);
      if (snip) lines.push(`    "${snip}"`);
    }
  }
  if (lines.length === 0) return "";
  return `\nLIVE SOURCE SIGNAL — real published results pulled just now from your reviewer panel. Use these as grounded evidence:\n${lines.join("\n")}\n\nWhen a finding is supported by one of these results, you MAY put the URL in the finding's source field alongside the source name (e.g. "Michelin Guide — https://guide.michelin.com/…"). Prefer findings supported by these live sources over speculative ones.\n`;
}

// --------------------------------------------------------------------------
// planForPrompt(plan)
//
// Returns a compact JSON string of the plan with internal/app-only metadata
// stripped, suitable for embedding in an LLM system prompt.
//
// Two wins vs the previous JSON.stringify(plan, null, 2):
//
//   1. Drops indentation. The pretty-printed form is ~30–40% larger than
//      compact JSON for no model-side benefit — Claude reads both equally
//      well. On a typical 18k-char plan, compact form is ~12k chars
//      (~1500 fewer input tokens).
//
//   2. Strips fields starting with '_' (\_review, \_qc, \_verifiedAt, etc.).
//      These are app-internal: the review state, quality-check overlays,
//      URL-verification status, and assorted timestamps the app attaches
//      after the model returned. The model never patches them in surgical
//      mode and re-emits them fresh in full mode via the tool schema.
//      Saves another 1–3k chars depending on review history.
//
// Used by buildReviewSystemPrompt, buildRevisionSystemPromptSurgical, and
// buildRevisionSystemPromptFull — the three places that embed the full
// plan JSON in their system prompt.
//
// Conservative: this is a NEW helper, not a replacement of plan structure.
// The plan object in state is unchanged.
// --------------------------------------------------------------------------
function planForPrompt(plan) {
  if (!plan || typeof plan !== "object") return JSON.stringify(plan);
  // Shallow-copy then drop top-level keys starting with '_'. The model never
  // needs these; they're set after the model returns and are noise in the
  // prompt. Days[] items currently don't carry underscore-prefixed keys, so
  // we don't need to recurse.
  const cleaned = {};
  for (const k of Object.keys(plan)) {
    if (k.startsWith("_")) continue;
    cleaned[k] = plan[k];
  }
  // Compact JSON — no indentation, no extra whitespace. Same semantics, fewer tokens.
  return JSON.stringify(cleaned);
}

// full result object) plus the list of selected reviewer source objects so the
// model knows which lenses to weight.
function buildReviewSystemPrompt(plan, sources, inputs, liveSnippets = []) {
  const lensesActive = Array.from(new Set(sources.map(s => s.lens)));
  const sourceList = sources.map(s => `• ${s.name} (${s.lens}) — ${s.blurb}`).join("\n");
  const lensRules = REVIEWER_LENSES
    .filter(l => lensesActive.includes(l.id))
    .map(l => `• ${l.label}: ${l.why}`)
    .join("\n");
  const tripContext = [
    inputs?.basics?.destination && `Destination: ${inputs.basics.destination}`,
    inputs?.basics?.nights && `${inputs.basics.nights} nights`,
    inputs?.basics?.travelers && `${inputs.basics.travelers}`,
    (Array.isArray(inputs?.basics?.budget) ? inputs.basics.budget.length : inputs?.basics?.budget) && `Budget: ${prefToText(inputs.basics.budget)}`,
    inputs?.basics?.style?.length ? `Style: ${inputs.basics.style.join(", ")}` : null,
    inputs?.basics?.pace && `Pace: ${inputs.basics.pace}`,
  ].filter(Boolean).join(" · ");

  // Surface the user's free-form guidelines + narrative so the reviewer
  // doesn't push more luxury than the user asked for. "Moderate excursions",
  // "family-friendly", "avoid Michelin", etc. live in these fields and they
  // are the user's explicit constraints, not the sources' defaults.
  const userGuidelinesBlock = ((inputs?.guidelines || "").trim() || (inputs?.narrative || "").trim())
    ? `\nUSER'S EXPLICIT GUIDELINES (these override the sources' default taste):\n${(inputs?.guidelines || inputs?.narrative || "").trim().slice(0, 3000)}\n`
    : "";

  return `You are a panel of travel experts conducting a professional review of a finalized trip plan. Your job is to evaluate the plan AGAINST THE USER'S STATED BUDGET, STYLE, AND GUIDELINES — not against your sources' default tier. You will call the submit_review tool exactly once. Do NOT emit any prose — only the tool call.

REVIEWER PANEL — you have access to the taste and editorial voice of these sources, but you adapt their standards to fit the user's stated trip tier:
${sourceList}

ACTIVE LENSES (only flag findings that fall under one of these):
${lensRules}

TRIP CONTEXT: ${tripContext || "unspecified"}
${userGuidelinesBlock}${renderLiveSourceBlock(liveSnippets)}
REVIEW DISCIPLINE — STRICT:
• Findings only. No general praise, no recap, no "overall this is a strong plan" prose.
• Each finding is a real, actionable issue. If the plan is genuinely strong with no notes, emit verdict 'A — no notes' and findings: [] (empty array allowed).
• Critical = the trip is materially worse if this is not fixed (closed restaurant, impossible drive time, dangerous pacing on transit days, marquee booking that needs 2-month lead time, factual errors, etc.).
• Suggested = clear upgrade WITHIN the stated tier (better-fitting hotel at the SAME price level, more interesting restaurant at the SAME price level, more locally-authentic activity at the SAME intensity/budget).
• Nice-to-have = polish (timing nudge, micro-substitution, small flag worth adding).
• Cap critical at 3. Cap total at 8. Pick the highest-impact issues only — quality over quantity.
• Set default_apply = true for ALL critical findings, false for ALL nice findings, and use your judgment for suggested.
• TIME FORMAT: Write every clock time in your findings (summary, action, any recommended/arrival time) in 12-hour AM/PM format (e.g. "7:00 PM", never "19:00"). Never use 24-hour/military time.

BUDGET DISCIPLINE — CRITICAL:
• The user's stated budget, style, pace, AND guidelines are HARD CONSTRAINTS. You do NOT push the trip up-market.
• If the budget says "$$", evaluate against $$ expectations — NOT Michelin-Key, NOT Forbes 5-Star, NOT Relais & Châteaux defaults.
• If the guidelines say "moderate-price excursions" or "family-friendly hotel" or "casual dining", DO NOT flag a hotel/restaurant/activity for being "not luxe enough." That is the point.
• NEVER emit a finding whose substance is "upgrade to a more expensive option" unless the existing pick is actually broken (closed, double-booked, geographically wrong) AND the upgrade stays within the user's stated price tier.
• A correctly-tiered moderate hotel is a CORRECT pick, not a finding. A 4-star instead of 5-star when the user said $$$ is NOT a critical issue.
• You CAN flag overpriced picks that exceed the user's stated tier ("this Michelin restaurant blows the $$ budget for one dinner"). Going DOWN-market when the user asked for it is never a finding.
• Each source name in the source field must come from the panel list above, exactly as written.
• Pick the right mode_hint per finding — this drives whether the apply is a quick patch or a full re-plan.

MODE_HINT GUIDE:
• swap_restaurant — replacing one specific dinner/lunch/breakfast item with a different restaurant.
• swap_hotel — replacing the hotel item for one leg with a different property (same city).
• swap_planb — replacing or improving a Plan B entry.
• swap_activity — replacing one Activity item with a different one same day.
• adjust_logistics — fixing a Transport item (drive time, route, mode).
• add_flag / add_tonight — appending a missing warning or todo.
• adjust_pacing — the day has too much / too little. REQUIRES full re-plan.
• change_neighborhood — base area is wrong for the trip's style. REQUIRES full re-plan.
• restructure_day — the day's shape is broken (transit + dinner in wrong order, etc.). REQUIRES full re-plan.
• rebalance_legs — multi-city night allocation is off. REQUIRES full re-plan.
• change_hotel_brand_tier — hotel brand or tier is wrong for budget. REQUIRES full re-plan.

PLAN TO REVIEW (JSON):
${planForPrompt(plan)}`;
}

function buildReviewUserPrompt() {
  return "Review the plan above. Call submit_review exactly once with verdict + findings[].";
}

function buildRevisionSystemPromptSurgical(plan, findings, inputs) {
  const findingsBlock = findings.map(f =>
    `[${f.id}] (${f.severity}, ${f.mode_hint}, ${formatFindingTarget(f.target)}) ${f.summary} → ${f.action}`
  ).join("\n");
  const tripContext = [
    inputs?.basics?.destination && `Destination: ${inputs.basics.destination}`,
    inputs?.basics?.nights && `${inputs.basics.nights} nights`,
    (Array.isArray(inputs?.basics?.budget) ? inputs.basics.budget.length : inputs?.basics?.budget) && `Budget: ${prefToText(inputs.basics.budget)}`,
    inputs?.basics?.style?.length ? `Style: ${inputs.basics.style.join(", ")}` : null,
    inputs?.basics?.pace && `Pace: ${inputs.basics.pace}`,
  ].filter(Boolean).join(" · ");
  const userGuidelinesBlock = ((inputs?.guidelines || "").trim() || (inputs?.narrative || "").trim())
    ? `\nUSER'S EXPLICIT GUIDELINES (hard constraints — do not violate):\n${(inputs?.guidelines || inputs?.narrative || "").trim().slice(0, 2000)}\n`
    : "";

  return `You are applying surgical card-level patches to an existing trip plan. Call submit_revision_patches exactly once with a small patches[] array — one patch per finding. No prose.

TRIP CONTEXT: ${tripContext}
${userGuidelinesBlock}
FINDINGS TO ADDRESS:
${findingsBlock}

PATCH RULES:
• Emit ONE patch per finding above (in the same order). Skip a finding only if it genuinely cannot be card-patched.
• On every patch, set finding_id to the bracketed [id] of the finding it addresses (copy it verbatim, e.g. 'f2'). This lets the client confirm which findings actually landed.
• Identify the right day_index and item_index by reading the plan JSON below. Days are 0-indexed; items[] within a day are 0-indexed.
• IMPORTANT: The day hint in the finding target (e.g. "day: 2") is a STARTING POINT, not authoritative. The user may have picked the wrong day, or the item they want to change (e.g. "remove the Dry Tortugas trip") may actually live on a different day in the plan. ALWAYS search the entire plan JSON below to find the item the user is describing. Use name, description, location, and item type to locate it — then patch the day/item index where it actually exists. If the request describes a multi-item excursion that spans more than one card or day, skip surgical patching for that finding (the system will retry as a full re-plan).
• If after a thorough search you cannot identify a clear single card to swap, emit zero patches for that finding. The system will detect the empty result and auto-fall-through to a full re-plan.
• For replace_item: new_item must have type ('Restaurant' | 'Activity' | 'Transport' | 'Breakfast' | 'Lunch' | 'Dinner' | 'Hotel' | 'Flight'), name, time (24h), and any other relevant fields the original item had (location, reservation, notes, end_time). Match the structure of the existing item shape.
• For replace_hotel: same as replace_item but the new_item.type must be 'Hotel'.
• For replace_planb_entry: provide planb_index (0-based) and new_text.
• For add_flag / add_tonight: provide new_text only.
• Keep replacement choices consistent with the original budget, style, and the user's guidelines above. The user's stated price tier and guidelines are hard constraints — do not push the trip up-market beyond what they asked for. If the user said "moderate" excursions or "family-friendly" or any other tier-specific instruction, the replacement must respect that.
• Rationale: one short sentence per patch, plain language.
• TIME FORMAT IN PROSE: The structured "time" field stays 24h as noted above. But in any prose you write (rationale, new_item text/notes), write clock times in 12-hour AM/PM format (e.g. "7:00 PM", never "19:00"). Never use 24-hour/military time in prose.

PLAN TO PATCH (JSON):
${planForPrompt(plan)}`;
}

function buildRevisionUserPromptSurgical() {
  return "Apply the findings above as surgical patches. Call submit_revision_patches exactly once.";
}

function buildRevisionSystemPromptFull(plan, findings, inputs) {
  const findingsBlock = findings.map(f =>
    `• [${f.severity}/${f.mode_hint}] ${formatFindingTarget(f.target)} — ${f.summary} → ${f.action}`
  ).join("\n");
  // External-LLM-review pass-through. If the user pasted an evaluation from
  // another model into the change-request box, surface the full text as a
  // separate, prominent block so the planner treats every issue in it as a
  // critical finding to address — not just the one-line summary above.
  const externalReviewSource = findings.find(f => f.external_review_text && String(f.external_review_text).trim());
  const externalReviewBlock = externalReviewSource
    ? `\nEXTERNAL LLM REVIEW — TREAT EVERY ISSUE BELOW AS A CRITICAL FINDING TO ADDRESS IN THIS REVISION:\nThe traveler had another AI (Claude, GPT, Gemini, etc.) evaluate the current plan. The full evaluation is pasted below. You MUST work through it issue-by-issue and fix every concrete problem it raises — swapped hotels, replaced restaurants, retimed days, pacing fixes, missing reservations, factual corrections. Do not cherry-pick. If the external review and the user's existing guidelines conflict, the user's guidelines win.\n\n---BEGIN EXTERNAL REVIEW---\n${String(externalReviewSource.external_review_text).slice(0, 8000)}\n---END EXTERNAL REVIEW---\n`
    : "";
  const tripContext = [
    inputs?.basics?.destination && `Destination: ${inputs.basics.destination}`,
    inputs?.basics?.nights && `${inputs.basics.nights} nights`,
    inputs?.basics?.travelers && `${inputs.basics.travelers}`,
    (Array.isArray(inputs?.basics?.budget) ? inputs.basics.budget.length : inputs?.basics?.budget) && `Budget: ${prefToText(inputs.basics.budget)}`,
    inputs?.basics?.style?.length ? `Style: ${inputs.basics.style.join(", ")}` : null,
    inputs?.basics?.pace && `Pace: ${inputs.basics.pace}`,
  ].filter(Boolean).join(" · ");
  const userGuidelinesBlock = ((inputs?.guidelines || "").trim() || (inputs?.narrative || "").trim())
    ? `\nUSER'S EXPLICIT GUIDELINES (hard constraints — do not violate):\n${(inputs?.guidelines || inputs?.narrative || "").trim().slice(0, 3000)}\n`
    : "";
  const nightsNum = parseInt(inputs?.basics?.nights, 10) || (Array.isArray(plan?.days) ? Math.max(1, plan.days.length - 1) : 3);
  const totalDays = nightsNum + 1;

  return `You are revising a trip plan based on a professional review. Call the submit_trip_plan tool exactly once with the FULL revised plan — same schema as the original. Do not emit any prose.

TRIP CONTEXT: ${tripContext}
Target: ${totalDays} days (${nightsNum} nights).
${userGuidelinesBlock}
REVIEWER FINDINGS TO ADDRESS:
${findingsBlock}
${externalReviewBlock}

REVISION RULES:
• Re-emit the COMPLETE plan with every field (destination, meta, days, logistics, weather_window, pack, flags, planb, snobs, tonight). Do not return a partial plan.
• Address every finding above. Where a finding calls for pacing or neighborhood changes, restructure the affected days fully — don't just relabel.
• Preserve what was working: keep restaurants, hotels, and activities that the review did NOT flag, unless adjusting them is necessary to fix a flagged issue.
• Respect the user's stated budget, style, pace, AND guidelines above as hard constraints. If the user asked for moderate-tier excursions or a family-friendly tone, the revised plan must keep that. Do not push the trip up-market past what the user requested.
• Same field emission order rule applies: destination, meta, ${Array.isArray(plan?.cities) && plan.cities.length > 1 ? "cities, " : ""}days, then logistics/flags/planb/snobs/tonight last.
• days[] must contain exactly ${totalDays} entries.
• VARIETY: no restaurant repeats across days. Each unique name appears at most once across the whole plan.
• EVERY item in items[] MUST have a "time" field (24h local time).
• TIME FORMAT IN PROSE: The structured "time" field stays 24h. But in all human-readable prose (headlines, why-blurbs, notes, confirmation_notes, flags, tonight), write clock times in 12-hour AM/PM format (e.g. "7:00 PM", never "19:00"). Never use 24-hour/military time in prose.
• If a finding's mode_hint is 'change_hotel_brand_tier', change the hotel item AND update any related fields (transport_in if hotel moved across town, neighborhood references in headlines, etc.) — keep the plan internally consistent.

ORIGINAL PLAN (use as starting point — change only what the findings require):
${planForPrompt(plan)}`;
}

function buildRevisionUserPromptFull() {
  return "Revise the plan above to address every finding. Call submit_trip_plan exactly once with the complete revised plan.";
}

// Apply surgical patches client-side. Returns a new plan object (does not mutate).
// Each patch op:
//   replace_item       — plan.days[day_index].items[item_index] = new_item
//   replace_hotel      — same, but asserts new_item.type === 'Hotel'
//   replace_planb_entry— plan.planb[planb_index] = new_text
//   add_flag           — push new_text into plan.flags
//   add_tonight        — push new_text into plan.tonight
// Applies a list of surgical patches to a plan. Returns BOTH the patched
// plan AND counters so the caller can detect the "model returned patches
// but none actually applied" case (out-of-range indices, missing new_item,
// unrecognised op) and decide whether to fall through to a full re-plan
// instead of silently doing nothing.
function applyPatchesToPlan(plan, patches) {
  if (!plan || !Array.isArray(patches)) return { plan, appliedCount: 0, skipped: [] };
  // Deep-clone the parts we'll mutate so React notices the change.
  const next = { ...plan };
  next.days = Array.isArray(plan.days) ? plan.days.map(d => ({ ...d, items: Array.isArray(d.items) ? [...d.items] : [] })) : [];
  next.planb = Array.isArray(plan.planb) ? [...plan.planb] : [];
  next.flags = Array.isArray(plan.flags) ? [...plan.flags] : [];
  next.tonight = Array.isArray(plan.tonight) ? [...plan.tonight] : [];

  let appliedCount = 0;
  const skipped = [];
  // Track WHICH findings genuinely landed, keyed by the finding_id the model
  // copies onto each patch. The caller uses this to mark only truly-applied
  // findings as done — never the full selected set when some were skipped.
  const appliedFindingIds = new Set();
  for (const p of patches) {
    if (!p || !p.op) { skipped.push("missing-op"); continue; }
    const before = appliedCount;
    try {
      if (p.op === "replace_item" && typeof p.day_index === "number" && typeof p.item_index === "number" && p.new_item) {
        const day = next.days[p.day_index];
        if (day && Array.isArray(day.items) && p.item_index >= 0 && p.item_index < day.items.length) {
          day.items[p.item_index] = p.new_item;
          appliedCount += 1;
        } else {
          skipped.push(`replace_item out-of-range (day=${p.day_index}, item=${p.item_index})`);
        }
      } else if (p.op === "replace_hotel" && typeof p.day_index === "number" && p.new_item) {
        const day = next.days[p.day_index];
        if (day && Array.isArray(day.items)) {
          // Replace the FIRST hotel-typed item on that day. If none, append.
          const hotelIdx = day.items.findIndex(it => it && typeof it.type === "string" && it.type.toLowerCase() === "hotel");
          if (hotelIdx >= 0) day.items[hotelIdx] = { ...p.new_item, type: "Hotel" };
          else day.items.push({ ...p.new_item, type: "Hotel" });
          appliedCount += 1;
        } else {
          skipped.push(`replace_hotel bad day (day=${p.day_index})`);
        }
      } else if (p.op === "replace_planb_entry" && typeof p.planb_index === "number" && typeof p.new_text === "string") {
        if (p.planb_index >= 0 && p.planb_index < next.planb.length) {
          next.planb[p.planb_index] = p.new_text;
          appliedCount += 1;
        } else {
          skipped.push(`replace_planb_entry out-of-range (idx=${p.planb_index})`);
        }
      } else if (p.op === "add_flag" && typeof p.new_text === "string") {
        next.flags.push(p.new_text);
        appliedCount += 1;
      } else if (p.op === "add_tonight" && typeof p.new_text === "string") {
        next.tonight.push(p.new_text);
        appliedCount += 1;
      } else {
        skipped.push(`unrecognised-or-incomplete (op=${p.op})`);
      }
    } catch (err) {
      skipped.push(`exception (op=${p.op}): ${String(err?.message || err).slice(0, 80)}`);
      // Continue — we'd rather apply 4-of-5 patches than abort.
    }
    if (appliedCount > before && typeof p.finding_id === "string" && p.finding_id) {
      appliedFindingIds.add(p.finding_id);
    }
  }
  return { plan: next, appliedCount, skipped, appliedFindingIds: Array.from(appliedFindingIds) };
}


// ===========================================================================
// /find — standalone restaurants + activities search.
//
// Path-mounted as a sibling to the wizard (see TripOptimizer below). When the
// URL pathname starts with /find, this component renders instead of the
// 3-step wizard. Completely separate state, completely separate localStorage
// key, no shared form context — so it cannot regress anything in the build
// flow.
//
// Reuses RestaurantCard and ActivityCard from the wizard's itinerary view to
// keep visual treatment identical. Sets up its own URLVerifyContext provider
// so the cards' dead-link defense (/api/verify-url) works here too.
//
// Hotel exclusion: server-side at /api/find (tool schema + system prompt +
// defensive filter), plus a final client-side regex sweep here as the third
// line of defense.
// ===========================================================================

const FIND_LS_KEY = "trip-optimizer-find-v1";
const FIND_GUIDELINES_MAX = 1000;

// Defensive client-side lodging filter — mirrors functions/api/find.js
// isNotLodging(). Belt and braces: even if /api/find ever changes and lets
// something through, the UI will not render a hotel on the /find page.
//
// Trade-off acknowledged: this WILL drop a legitimate restaurant whose name
// includes a lodging word (e.g. "Inn at Little Washington" — a real,
// 3-Michelin-star restaurant). We accept that false-positive risk because:
//   1. The server-side schema + system prompt are the primary defense —
//      this is the safety net, not the primary filter.
//   2. The cost of dropping one famous edge-case restaurant is much lower
//      than the cost of accidentally rendering an actual hotel as a search
//      result, which violates the core product promise of /find.
//   3. Only item.name, item.text, item.type, and item.cuisine are checked.
//      item.why can legitimately mention "near the hotel" or "walking from
//      your hotel" without making the place itself lodging.
const LODGING_RX = /\b(hotel|resort|inn|lodge|hostel|b&b|bed[\s-]?and[\s-]?breakfast|guesthouse|airbnb|vacation rental|accommodation)\b/i;
function findIsNotLodging(item) {
  if (!item || typeof item !== "object") return false;
  const typeName = [item.name, item.text, item.type, item.cuisine]
    .filter((s) => typeof s === "string")
    .join(" | ");
  return !LODGING_RX.test(typeName);
}

// Read /find query params. Returns { q, c, g } where any value may be "".
function readFindParams() {
  if (typeof window === "undefined") return { q: "", c: "both", g: "" };
  try {
    const p = new window.URLSearchParams(window.location.search);
    const c = (p.get("c") || "both").toLowerCase();
    return {
      q: (p.get("q") || "").trim(),
      c: c === "restaurants" || c === "activities" ? c : "both",
      g: (p.get("g") || "").slice(0, FIND_GUIDELINES_MAX),
    };
  } catch {
    return { q: "", c: "both", g: "" };
  }
}

function writeFindParams({ q, c, g }) {
  if (typeof window === "undefined") return;
  try {
    const p = new window.URLSearchParams();
    if (q) p.set("q", q);
    if (c && c !== "both") p.set("c", c);
    if (g) p.set("g", g);
    const qs = p.toString();
    const newUrl = "/find" + (qs ? "?" + qs : "");
    window.history.replaceState({}, "", newUrl);
  } catch { /* non-fatal */ }
}

// Collect every verifiable URL from the find results so useURLVerification
// (the same hook the wizard uses) can probe them. Restaurants supply
// contact.website + contact.booking_url + reservation.url; activities supply
// contact.website + contact.booking_url.
function collectFindURLs(results) {
  const out = new Set();
  const push = (u) => { if (typeof u === "string" && /^https?:\/\//i.test(u)) out.add(u); };
  for (const r of (results?.restaurants || [])) {
    push(r?.contact?.website);
    push(r?.contact?.booking_url);
    push(r?.reservation?.url);
  }
  for (const a of (results?.activities || [])) {
    push(a?.contact?.website);
    push(a?.contact?.booking_url);
  }
  return Array.from(out);
}

// FindRestaurantCard — a search-result-shaped restaurant card.
//
// Why this duplicates a chunk of RestaurantCard rather than wrapping it:
//   RestaurantCard is built for the itinerary context where contact info
//   (website/phone/directions) is shown on a separate day-view row, not
//   inside the card. Wrapping RestaurantCard to append a ContactBlock
//   produces an awkward double-border seam because the inner card paints
//   its own outline. Negative-margin compositions didn't cleanly hide
//   the seam. The least-surprising fix is to render an integrated card
//   that keeps RestaurantCard's typography, badge, and Reserve button
//   styling exactly, then includes ContactBlock inside the same border.
//
// What we deliberately leave OUT compared to RestaurantCard:
//   - Itinerary-specific chips: weekday-mismatch, missing-backup, return-visit
//   - Closure banner (the find prompt forbids closed places)
//   - Backup-restaurant sub-block (only meaningful with a known reservation slot)
//
// What we keep IDENTICAL by reusing shared primitives:
//   - Badge component (top-left type chip)
//   - reservationLink() helper (OpenTable / Resy / Tock / Yelp / phone)
//   - ContactBlock component (the dead-link-aware website/phone/directions row)
//   - MenuModal trigger via onOpenMenu prop
//
// If RestaurantCard's typography or padding changes, this card should be
// updated to match — they're meant to look like the same surface.
function FindRestaurantCard({ restaurant, onOpenMenu }) {
  // Hook MUST be called unconditionally — keep above the early return.
  // See RestaurantCard for why we thread destination through.
  const { destination: tripCity } = useURLVerify();
  if (!restaurant) return null;
  const r = restaurant;
  const resv = reservationLink(r, tripCity);
  const platformLabel = resv ? ({
    opentable: "OpenTable", resy: "Resy", tock: "Tock", yelp: "Yelp", phone: "Call",
  }[resv.platform] || "Reserve") : null;
  const hasContact = r.contact &&
    (r.contact.address || r.contact.phone || r.contact.website ||
     r.contact.booking_url || r.contact.hours);
  return (
    <div style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        <Badge type={r.type || "Restaurant"} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1 }}>{r.name}</p>
      </div>
      {(r.neighborhood || r.cuisine || r.price_range) && (
        <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 6px", letterSpacing: "0.02em" }}>
          {[r.neighborhood, r.cuisine, r.price_range].filter(Boolean).join("  ·  ")}
        </p>
      )}
      {r.why && (
        <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>{r.why}</p>
      )}
      {/* Always show View Menu — lazy-fetches via /api/menu. Reserve button conditional on platform. */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "6px", marginBottom: hasContact ? "4px" : 0 }}>
        <button
          onClick={() => onOpenMenu(r)}
          style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: `0.5px solid ${GOLD}`, background: "transparent", color: GOLD, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}
        >View Menu</button>
        {resv && (
          <a
            href={resv.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: "none", background: "var(--color-text-primary)", color: "var(--color-background-primary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, textDecoration: "none", display: "inline-block" }}
          >Reserve · {platformLabel}</a>
        )}
      </div>
      {hasContact && (
        <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
          <ContactBlock contact={r.contact} name={r.name} />
        </div>
      )}
    </div>
  );
}

// Compute the initial input state once, outside React, so it runs exactly
// once per FindView mount (not on every render and not memoized weirdly).
// Source-of-truth order: URL ?q= wins (shareable links), then localStorage
// (last session), then defaults.
function computeInitialFindState() {
  const fromUrl = readFindParams();
  if (fromUrl.q) return fromUrl;
  try {
    const raw = window.localStorage.getItem(FIND_LS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      return {
        q: typeof j?.q === "string" ? j.q : "",
        c: ["both", "restaurants", "activities"].includes(j?.c) ? j.c : "both",
        g: typeof j?.g === "string" ? j.g.slice(0, FIND_GUIDELINES_MAX) : "",
      };
    }
  } catch { /* ignore */ }
  return { q: "", c: "both", g: "" };
}

// ActivityDetailsModal — bottom-sheet modal showing expanded details for
// a single activity, lazy-fetched from /api/activity-details. Mirrors the
// visual treatment of MenuModal (bottom-sheet on mobile, max 640px wide,
// scrollable) so the two feel like the same surface.
function ActivityDetailsModal({ activity, details, loading, error, onClose }) {
  if (!activity) return null;
  const sections = details ? [
    ["Best time", details.best_time],
    ["Typical duration", details.typical_duration],
    ["What to bring", details.what_to_bring],
    ["Booking tips", details.booking_tips],
    ["Crowd tips", details.crowd_tips],
    ["What locals know", details.locals_tips],
    ["Cost breakdown", details.cost_breakdown],
    ["Accessibility", details.accessibility],
  ] : [];
  const dashIdx = (activity.text || "").indexOf(" — ");
  const head = dashIdx > 0 ? (activity.text || "").slice(0, dashIdx) : (activity.text || "");
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1000, padding: 0 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${head}`}
        style={{ background: "var(--color-background-primary)", maxWidth: "640px", width: "100%", maxHeight: "90vh", overflowY: "auto", borderRadius: "16px 16px 0 0", padding: "22px 22px 32px", boxShadow: "0 -8px 32px rgba(0,0,0,0.25)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
          <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, margin: 0 }}>Details</p>
          <button
            onClick={onClose}
            aria-label="Close details"
            style={{ background: "transparent", border: "none", fontSize: "22px", color: "var(--color-text-secondary)", cursor: "pointer", padding: "4px 8px", lineHeight: 1 }}
          >×</button>
        </div>
        <p style={{ fontSize: "20px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 14px", color: "var(--color-text-primary)" }}>{head}</p>
        {loading && (
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", fontStyle: "italic" }}>Loading details…</p>
        )}
        {error && (
          <p role="alert" style={{ fontSize: "13px", color: "var(--color-danger-hover)", background: "var(--color-danger-tint)", border: "0.5px solid var(--color-text-danger)", borderRadius: "var(--border-radius-md)", padding: "8px 12px" }}>{error}</p>
        )}
        {details && sections.map(([title, body]) => body && (
          <div key={title} style={{ marginBottom: "14px" }}>
            <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px", paddingBottom: "4px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{title}</p>
            <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: 0, lineHeight: 1.55 }}>{body}</p>
          </div>
        ))}
        {details && Array.isArray(details.nearby_pairings) && details.nearby_pairings.length > 0 && (
          <div style={{ marginBottom: "14px" }}>
            <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 6px", paddingBottom: "4px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Pair it with</p>
            <ul style={{ margin: 0, paddingLeft: "20px" }}>
              {details.nearby_pairings.map((p, i) => (
                <li key={i} style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "4px", lineHeight: 1.5 }}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {details?.source_note && (
          <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", marginTop: "16px", fontStyle: "italic", lineHeight: 1.5 }}>{details.source_note}</p>
        )}
      </div>
    </div>
  );
}

// FindActivityCard — wraps the existing ActivityCard with a "More details"
// button that triggers a lazy /api/activity-details fetch. We compose
// rather than modify ActivityCard so the itinerary view is untouched.
function FindActivityCard({ activity, onOpenDetails }) {
  if (!activity) return null;
  return (
    <div style={{ marginBottom: "12px" }}>
      <ActivityCard time={null} end_time={null} item={activity} />
      <div style={{ marginTop: "-6px", marginBottom: 0, display: "flex" }}>
        <button
          type="button"
          onClick={() => onOpenDetails(activity)}
          style={{ fontSize: "11px", padding: "6px 12px", borderRadius: "4px", border: `0.5px solid ${GOLD}`, background: "transparent", color: GOLD, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, marginLeft: "auto" }}
        >More details →</button>
      </div>
    </div>
  );
}

function FindView({ embedded = false } = {}) {
  // `embedded` is set when FindView is rendered inline inside the wizard
  // surface (the landing "Find local info only" toggle) rather than as the
  // standalone /find route. When embedded, the brand/back-link header band is
  // suppressed because the host already renders the brand header + mode
  // toggle above us.
  // Viewport awareness for responsive container widths and search-result grid
  // density. Same rationale as in TripOptimizer.
  const vp = useViewport();

  // -------- input state --------
  // Lazy-init each useState so computeInitialFindState() runs exactly once.
  const [location, setLocation] = useState(() => computeInitialFindState().q);
  const [category, setCategory] = useState(() => computeInitialFindState().c);
  const [guidelines, setGuidelines] = useState(() => computeInitialFindState().g);

  // -------- search state --------
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // results       — standard mode results, never replaced by Ask-the-locals
  // localExpert   — Sonar-grounded results, rendered as its own section below
  const [results, setResults] = useState(null);
  const [localExpertResults, setLocalExpertResults] = useState(null);

  // -------- on-demand menu state (lazy /api/menu fetch) --------
  // menuRestaurant : the restaurant whose menu modal is open (or null)
  // menuData       : { menu } when loaded
  // menuLoading    : while the fetch is in flight
  // menuError      : friendly error string on fetch failure
  const [menuRestaurant, setMenuRestaurant] = useState(null);
  const [menuData, setMenuData] = useState(null);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuError, setMenuError] = useState("");

  // -------- on-demand activity-details state (lazy /api/activity-details) --
  const [detailsActivity, setDetailsActivity] = useState(null);
  const [detailsData, setDetailsData] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");

  // -------- URL verify provider (same pattern as ItineraryView) --------
  // Pull URLs from BOTH the standard and locally-sourced result sets so the
  // dead-link defense covers cards in either section.
  const urlsToVerify = useMemo(() => {
    const a = collectFindURLs(results);
    const b = collectFindURLs(localExpertResults);
    return Array.from(new Set([...a, ...b]));
  }, [results, localExpertResults]);
  const urlVerify = useURLVerification(urlsToVerify);
  const verifyContextValue = useMemo(() => ({
    status: urlVerify.status,
    isReady: urlVerify.isReady,
    destination: results?.queryUsed?.location || location || "",
  }), [urlVerify.status, urlVerify.isReady, results, location]);

  // -------- persist inputs to localStorage on change (debounced 400ms) ---
  // localStorage.setItem is synchronous on the main thread. Without a
  // debounce, typing into guidelines would write on every keystroke. 400ms
  // is imperceptible but reduces writes ~50x during sustained typing.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(
          FIND_LS_KEY,
          JSON.stringify({ q: location, c: category, g: guidelines }),
        );
      } catch { /* quota — non-fatal */ }
    }, 400);
    return () => clearTimeout(t);
  }, [location, category, guidelines]);

  // -------- document title + noindex on mount --------
  // Set on mount and never reverted: FindView never unmounts during a session
  // because main.jsx picks one root component for the lifetime of the page.
  useEffect(() => {
    try {
      document.title = "Find — Trip Optimizer";
      // /find pages can have a user's query in ?q=, which we don't want crawled.
      let m = document.querySelector('meta[name="robots"]');
      if (!m) {
        m = document.createElement("meta");
        m.setAttribute("name", "robots");
        document.head.appendChild(m);
      }
      m.setAttribute("content", "noindex, nofollow");
    } catch { /* non-fatal */ }
  }, []);

  // -------- the search action --------
  // Defined before the auto-search effect so the reference is resolved at
  // effect-creation time, not via legacy block-scoped function hoisting.
  //
  // Race-condition defense: each call gets a monotonically-increasing
  // requestId. Only the LATEST in-flight request's response is allowed to
  // update state. If the user starts search A (slow) then B (fast), B's
  // response can land first; when A finally returns, its requestId no
  // longer matches and we discard it. Without this, the user could see
  // results for an older query overwrite results for the newer one.
  //
  // Timeout: standard mode 60s, local-expert mode 60s. Real-world Anthropic
  // latency for a both-category search with rich guidelines + the full
  // restaurant/activity tool schema is consistently 28–35s end-to-end
  // (Anthropic call + Cloudflare cold-start overhead). The original 30s
  // ceiling was too tight — users were seeing the "taking too long" error
  // while the server was still completing the call. 60s gives generous
  // headroom while still surfacing a real failure for a truly stuck call.
  // Loading flag specifically for the "Ask the locals" follow-up. Tracked
  // separately so the rest of the page (form, baseline results) doesn't
  // reset while the local-expert pass is running.
  const [askingLocals, setAskingLocals] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);

  const requestIdRef = useRef(0);
  const runSearch = async (q, c, g, mode = "standard") => {
    const loc = String(q || "").trim();
    if (!loc) {
      setError("Enter a location to search.");
      return;
    }
    const isLocalExpert = mode === "local_expert";
    const myId = ++requestIdRef.current;
    if (isLocalExpert) {
      setAskingLocals(true);
      // Do NOT touch `results` — standard results stay visible above the
      // soon-to-be-rendered "Locally sourced" section.
    } else {
      setLoading(true);
      setResults(null);
      // A new standard search wipes any prior locally-sourced section too,
      // since those snippets were grounded for a different query.
      setLocalExpertResults(null);
      setSourcesExpanded(false);
    }
    setError("");
    writeFindParams({ q: loc, c, g });

    // Local-expert calls fan out to Sonar in parallel server-side. Per-source
    // 8s + retrieval overhead can push total latency higher than standard,
    // so we give the timeout extra headroom for that mode.
    const timeoutMs = isLocalExpert ? 60000 : 60000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("/api/find", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: loc,
          category: c,
          guidelines: g || "",
          mode,
        }),
        signal: controller.signal,
      });
      if (myId !== requestIdRef.current) return; // stale
      const json = await res.json().catch(() => ({}));
      if (myId !== requestIdRef.current) return; // stale
      if (!res.ok) {
        setError(json?.error?.message || `Search failed (${res.status}).`);
        if (!isLocalExpert) setResults(null);
      } else {
        // Third line of defense — server schema + server response filter
        // already filtered lodging; this is the client-side belt.
        const restaurants = (json?.results?.restaurants || []).filter(findIsNotLodging);
        const activities = (json?.results?.activities || []).filter(findIsNotLodging);
        if (restaurants.length === 0 && activities.length === 0) {
          setError(
            isLocalExpert
              ? "The locals didn't surface different results this time. Your original list above is unchanged."
              : "No results for that search. Try a different location or relax the guidelines.",
          );
          if (!isLocalExpert) setResults(null);
        } else {
          const payload = {
            restaurants,
            activities,
            note: typeof json?.note === "string" ? json.note : "",
            queryUsed: { location: loc, category: c, guidelines: g, mode },
            localExpert: json?.local_expert || null,
          };
          if (isLocalExpert) {
            // Render BELOW the standard results, as its own section.
            setLocalExpertResults(payload);
            setSourcesExpanded(false);
          } else {
            setResults(payload);
          }
        }
      }
    } catch (err) {
      if (myId !== requestIdRef.current) return; // stale
      const isAbort = err?.name === "AbortError";
      if (isLocalExpert) {
        setError(
          isAbort
            ? "Asking the locals took too long. Your original results above are unchanged — try again later."
            : "Couldn't reach the local sources right now. Your original results above are unchanged.",
        );
      } else {
        setError(
          isAbort
            ? "Search timed out after 60 seconds. The server may be under load — please try again."
            : "Search couldn't reach the server. Try again in a moment.",
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
      if (myId === requestIdRef.current) {
        if (isLocalExpert) setAskingLocals(false);
        else setLoading(false);
      }
    }
  };

  // Re-run the current query with Sonar-grounded local-expert mode. We keep
  // the same query inputs (location/category/guidelines) but ask the server
  // to fan out to local press and forums first. The result is stored in
  // localExpertResults and rendered BELOW the standard results — the
  // standard list is never replaced.
  const onAskLocals = () => {
    if (!results || askingLocals || loading) return;
    runSearch(
      results.queryUsed.location,
      results.queryUsed.category,
      results.queryUsed.guidelines,
      "local_expert",
    );
  };

  // Auto-fire the local-expert pass as soon as standard results land. Users
  // shouldn't have to know about, or click, a second button to get the
  // locals' picks — the value of the feature is invisible until they see
  // both lists side by side. Only auto-fires when:
  //   • standard results just arrived (results truthy)
  //   • we haven't already run the local pass for this query
  //     (localExpertResults nullable)
  //   • we're not already running anything
  // Encoded as a query-signature dependency so re-running the same query
  // (e.g. after a clear/re-submit) re-triggers it but no-ops on incidental
  // re-renders.
  const lastAutoLocalsKeyRef = useRef(null);
  useEffect(() => {
    if (!results || loading || askingLocals) return;
    if (localExpertResults) return;
    const sig = `${results.queryUsed.location}|${results.queryUsed.category}|${results.queryUsed.guidelines}`;
    if (lastAutoLocalsKeyRef.current === sig) return;
    lastAutoLocalsKeyRef.current = sig;
    runSearch(
      results.queryUsed.location,
      results.queryUsed.category,
      results.queryUsed.guidelines,
      "local_expert",
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  // -------- lazy menu fetch --------
  // Opens the menu modal in a loading state, then resolves with menu data
  // or an error. Cached per-restaurant-name in a session ref so re-opening
  // the same restaurant's menu within the session is instant.
  const menuCacheRef = useRef(new Map());
  const onOpenMenu = async (restaurant) => {
    if (!restaurant) return;
    const cacheKey = `${restaurant.name}|${results?.queryUsed?.location || localExpertResults?.queryUsed?.location || ""}`;
    setMenuRestaurant(restaurant);
    setMenuError("");
    const cached = menuCacheRef.current.get(cacheKey);
    if (cached) {
      setMenuData(cached);
      setMenuLoading(false);
      return;
    }
    setMenuData(null);
    setMenuLoading(true);
    try {
      const loc = results?.queryUsed?.location || localExpertResults?.queryUsed?.location || "";
      const res = await fetch("/api/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: restaurant.name, location: loc, cuisine: restaurant.cuisine || "" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMenuError(json?.error?.message || `Couldn't load the menu (${res.status}).`);
      } else if (json?.menu) {
        menuCacheRef.current.set(cacheKey, { menu: json.menu });
        setMenuData({ menu: json.menu });
      } else {
        setMenuError("Couldn't load the menu.");
      }
    } catch (err) {
      setMenuError(`Couldn't reach the menu service. ${String(err?.message || err).slice(0, 80)}`);
    } finally {
      setMenuLoading(false);
    }
  };
  const onCloseMenu = () => {
    setMenuRestaurant(null);
    setMenuData(null);
    setMenuError("");
    setMenuLoading(false);
  };

  // -------- lazy activity-details fetch --------
  const detailsCacheRef = useRef(new Map());
  const onOpenDetails = async (activity) => {
    if (!activity) return;
    const cacheKey = `${activity.text}|${results?.queryUsed?.location || localExpertResults?.queryUsed?.location || ""}`;
    setDetailsActivity(activity);
    setDetailsError("");
    const cached = detailsCacheRef.current.get(cacheKey);
    if (cached) {
      setDetailsData(cached);
      setDetailsLoading(false);
      return;
    }
    setDetailsData(null);
    setDetailsLoading(true);
    try {
      const loc = results?.queryUsed?.location || localExpertResults?.queryUsed?.location || "";
      // The activity's "name" is the part before ' — ' in text.
      const dashIdx = (activity.text || "").indexOf(" — ");
      const justName = dashIdx > 0 ? activity.text.slice(0, dashIdx) : activity.text;
      const res = await fetch("/api/activity-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: justName, location: loc, type: activity.type || "" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDetailsError(json?.error?.message || `Couldn't load details (${res.status}).`);
      } else if (json?.details) {
        detailsCacheRef.current.set(cacheKey, json.details);
        setDetailsData(json.details);
      } else {
        setDetailsError("Couldn't load details for this activity.");
      }
    } catch (err) {
      setDetailsError(`Couldn't reach the details service. ${String(err?.message || err).slice(0, 80)}`);
    } finally {
      setDetailsLoading(false);
    }
  };
  const onCloseDetails = () => {
    setDetailsActivity(null);
    setDetailsData(null);
    setDetailsError("");
    setDetailsLoading(false);
  };

  // -------- if URL had a q on first load, auto-search --------
  // Wrapped in a ref-flag so this only fires once per page load, even if
  // React StrictMode double-invokes effects in dev. We read params fresh
  // from URL here rather than closing over `initial` — simpler reasoning,
  // and avoids the closure-on-mount fragility.
  const autoSearchRef = useRef(false);
  useEffect(() => {
    if (autoSearchRef.current) return;
    autoSearchRef.current = true;
    const params = readFindParams();
    if (params.q) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time URL-param hydration
      runSearch(params.q, params.c, params.g);
    }
  }, []);

  function onSubmit(e) {
    e?.preventDefault?.();
    runSearch(location, category, guidelines);
  }

  function onClear() {
    setLocation("");
    setCategory("both");
    setGuidelines("");
    setResults(null);
    setLocalExpertResults(null);
    setError("");
    setSourcesExpanded(false);
    try { window.localStorage.removeItem(FIND_LS_KEY); } catch {}
    writeFindParams({ q: "", c: "both", g: "" });
  }

  const hasRestaurants = (results?.restaurants?.length || 0) > 0;
  const hasActivities = (results?.activities?.length || 0) > 0;
  const showSectionToggle = !!results && hasRestaurants && hasActivities;

  return (
    <URLVerifyContext.Provider value={verifyContextValue}>
      {/* Find page container. Wider than the wizard's because once results
          land the layout supports a 2-col card grid on desktop+wide. Below
          tablet we use the full viewport width (just gutter padding) so
          inputs stay tappable. */}
      <div style={{
        fontFamily: "var(--font-sans)",
        color: "var(--color-text-primary)",
        padding: vp.isMobile ? "0 0.875rem" : "0 1.25rem",
        paddingTop: embedded ? (vp.isMobile ? "1.5rem" : "1.75rem") : undefined,
        maxWidth: vp.isMobile ? "100%" : vp.isTablet ? "780px" : vp.isDesktop ? "1040px" : "1200px",
        margin: "0 auto",
      }}>
        {/* Header band — only when standalone (/find route). When embedded in
            the wizard surface the host renders the brand header + mode toggle. */}
        {!embedded && (
          <div style={{ paddingTop: "1.25rem", paddingBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div>
              <img src="/rs3-wordmark.svg?v=3" alt="Route Smith" style={{ display: "block", height: vp.isMobile ? "28px" : "38px", width: "auto", margin: 0 }} />
              <p style={{ fontSize: "22px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "2px 0 0", color: "var(--color-text-primary)" }}>Find</p>
            </div>
            <a href="/" style={{ fontSize: "11px", color: GOLD, textDecoration: "none", letterSpacing: "0.06em", textTransform: "uppercase", padding: "10px 14px", border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", display: "inline-flex", alignItems: "center", minHeight: "40px" }}>← Trip Builder</a>
          </div>
        )}

        {/* Headline */}
        <div style={{ marginBottom: "1.25rem" }}>
          <h1 style={{ fontSize: "26px", fontFamily: "var(--font-serif)", fontWeight: 400, margin: "0 0 6px", color: "var(--color-text-primary)", lineHeight: 1.25 }}>Find restaurants and activities</h1>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.55 }}>Tell us where. We&rsquo;ll skip the hotels.</p>
        </div>

        {/* Search form */}
        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "16px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)", background: "var(--color-background-primary)", marginBottom: "1.25rem" }}>
          <Field label="Location" hint="City, neighborhood, or landmark.">
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Santa Fe, NM"
              autoComplete="off"
              autoCapitalize="words"
              spellCheck={false}
              enterKeyHint="search"
              style={{ fontSize: "16px", padding: "10px 12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", fontFamily: "inherit", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box" }}
            />
          </Field>

          <Field label="Show">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{ fontSize: "14px", padding: "10px 12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", fontFamily: "inherit", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box" }}
            >
              <option value="both">Restaurants &amp; activities</option>
              <option value="restaurants">Restaurants only</option>
              <option value="activities">Activities only</option>
            </select>
          </Field>

          <Field label="Guidelines (optional)" hint={`Anything specific. We treat this as preferences, not commands. ${guidelines.length}/${FIND_GUIDELINES_MAX}`}>
            <textarea
              value={guidelines}
              onChange={(e) => setGuidelines(e.target.value.slice(0, FIND_GUIDELINES_MAX))}
              placeholder="Dinner spots good for a celebration, walking distance from the plaza. Morning activities, no strenuous hikes. We're vegetarian."
              rows={3}
              style={{ fontSize: "14px", padding: "10px 12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", fontFamily: "inherit", background: "var(--color-background-primary)", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: "70px", lineHeight: 1.5 }}
            />
          </Field>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="submit"
              disabled={loading || !location.trim()}
              style={{ flex: 1, minWidth: "140px", fontSize: "13px", padding: "12px 18px", borderRadius: "var(--border-radius-md)", border: "none", background: loading || !location.trim() ? "var(--color-border-secondary)" : GOLD, color: loading || !location.trim() ? "var(--color-text-tertiary)" : ON_NAVY, cursor: loading || !location.trim() ? "not-allowed" : "pointer", fontFamily: "inherit", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}
            >{loading ? "Searching…" : "Search"}</button>
            {loading && (
              <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", letterSpacing: "0.04em", fontStyle: "italic" }}>This usually takes 20–40 seconds.</span>
            )}
            {(location || guidelines || results) && (
              <button
                type="button"
                onClick={onClear}
                style={{ fontSize: "11px", padding: "12px 16px", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", minHeight: "44px" }}
              >Clear</button>
            )}
          </div>
        </form>

        {/* Error banner */}
        {error && (
          <div role="alert" style={{ padding: "10px 14px", marginBottom: "1rem", background: "var(--color-danger-tint)", border: "0.5px solid var(--color-text-danger)", borderRadius: "var(--border-radius-md)", color: "var(--color-danger-hover)", fontSize: "13px", lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        {/* Summary line — proves to the user what we heard */}
        {results && (
          <div style={{ marginBottom: "1rem", padding: "10px 14px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.55, display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "flex-start", flexWrap: "wrap" }}>
            <span>
              Showing{" "}
              <strong style={{ color: "var(--color-text-primary)" }}>
                {results.queryUsed.category === "both"
                  ? "restaurants & activities"
                  : results.queryUsed.category === "restaurants"
                  ? "restaurants only"
                  : "activities only"}
              </strong>{" "}
              for{" "}
              <strong style={{ color: "var(--color-text-primary)" }}>{results.queryUsed.location}</strong>
              {results.queryUsed.guidelines && (
                <>
                  {" "}·{" "}
                  <em style={{ fontStyle: "italic" }}>&ldquo;{results.queryUsed.guidelines.length > 120 ? results.queryUsed.guidelines.slice(0, 117) + "…" : results.queryUsed.guidelines}&rdquo;</em>
                </>
              )}
            </span>
            <a
              href="#top"
              onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              style={{ color: GOLD, textDecoration: "none", fontSize: "11px", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}
            >Edit</a>
          </div>
        )}

        {/* Optional note from the model */}
        {results?.note && (
          <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 1rem", fontStyle: "italic", lineHeight: 1.55 }}>{results.note}</p>
        )}

        {/* Ask the locals — opt-in retrieval pass. Hidden while a local-expert
            result is already on the page; user can clear and re-ask if needed. */}
        {results && !localExpertResults && !askingLocals && (
          <div style={{ marginBottom: "1rem", padding: "12px 14px", border: `0.5px dashed ${GOLD}`, borderRadius: "var(--border-radius-md)", background: "var(--color-background-primary)" }}>
            <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: "200px" }}>
                <p style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", margin: "0 0 2px", letterSpacing: "0.02em" }}>Want a hyperlocal second opinion?</p>
                <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}>Pulls in regional press, local forums, and area guides. Adds a second list below — your results above stay put.</p>
              </div>
              <button
                type="button"
                onClick={onAskLocals}
                disabled={askingLocals}
                style={{ fontSize: "12px", padding: "10px 16px", borderRadius: "var(--border-radius-md)", border: `0.5px solid ${GOLD}`, background: "transparent", color: GOLD, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600, minHeight: "44px", whiteSpace: "nowrap" }}
              >Ask the locals →</button>
            </div>
          </div>
        )}

        {/* Asking-the-locals progress */}
        {askingLocals && (
          <div style={{ marginBottom: "1rem", padding: "12px 14px", border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", background: GOLD_LIGHT, display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: GOLD_DARK, letterSpacing: "0.04em" }}>Asking the locals…</span>
            <span style={{ fontSize: "11px", color: GOLD_DARK }}>Querying regional press, local forums, and area guides.</span>
          </div>
        )}

        {/* Section toggle — only when both sections have results */}
        {showSectionToggle && (
          <div style={{ position: "sticky", top: 0, background: "var(--color-background-secondary)", padding: "10px 0", marginBottom: "0.5rem", zIndex: 10, display: "flex", gap: "16px", fontSize: "12px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            <a href="#find-restaurants" style={{ color: "var(--color-text-primary)", textDecoration: "none", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>Restaurants <span style={{ color: GOLD }}>({results.restaurants.length})</span></a>
            <a href="#find-activities" style={{ color: "var(--color-text-primary)", textDecoration: "none", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>Activities <span style={{ color: GOLD }}>({results.activities.length})</span></a>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "1rem" }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ height: "82px", borderRadius: "var(--border-radius-md)", background: "linear-gradient(90deg, var(--color-background-secondary) 0%, var(--color-surface-offset) 50%, var(--color-background-secondary) 100%)", backgroundSize: "200% 100%", animation: "find-shimmer 1.4s linear infinite" }} />
            ))}
            <style>{`@keyframes find-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
          </div>
        )}

        {/* Restaurants section. On desktop+ we render a 2-column card grid
            so 8-12 results don't make the user scroll forever. The grid
            uses auto-fit + minmax so on narrow desktop it stays single
            column rather than cramming. */}
        {hasRestaurants && (
          <section id="find-restaurants" style={{ marginTop: "1.25rem", scrollMarginTop: "60px" }}>
            <h2 style={{ fontSize: "11px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 12px", paddingBottom: "8px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Restaurants in {results.queryUsed.location} ({results.restaurants.length})</h2>
            <div style={{ display: "grid", gridTemplateColumns: vp.isAtLeastDesktop ? "repeat(auto-fit, minmax(360px, 1fr))" : "1fr", gap: "12px" }}>
              {results.restaurants.map((r, i) => (
                <FindRestaurantCard key={`${r.name}-${i}`} restaurant={r} onOpenMenu={onOpenMenu} />
              ))}
            </div>
          </section>
        )}

        {/* Activities section — same grid treatment as restaurants. */}
        {hasActivities && (
          <section id="find-activities" style={{ marginTop: "1.25rem", scrollMarginTop: "60px" }}>
            <h2 style={{ fontSize: "11px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 12px", paddingBottom: "8px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Activities in {results.queryUsed.location} ({results.activities.length})</h2>
            <div style={{ display: "grid", gridTemplateColumns: vp.isAtLeastDesktop ? "repeat(auto-fit, minmax(360px, 1fr))" : "1fr", gap: "12px" }}>
              {results.activities.map((a, i) => (
                <FindActivityCard key={`${a.text}-${i}`} activity={a} onOpenDetails={onOpenDetails} />
              ))}
            </div>
          </section>
        )}

        {/* Locally sourced section — appears BELOW the standard results.
            Independent from the standard section above; its own header,
            its own badge, its own restaurants and activities lists. */}
        {localExpertResults && (
          <section style={{ marginTop: "2rem", paddingTop: "1.25rem", borderTop: `1px solid ${GOLD}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
              <h2 style={{ fontSize: "13px", fontWeight: 700, color: GOLD_DARK, letterSpacing: "0.12em", textTransform: "uppercase", margin: 0 }}>Locally sourced</h2>
              {localExpertResults.localExpert?.source_set === "curated" && localExpertResults.localExpert?.status === "ok" && (
                <span style={{ fontSize: "10.5px", padding: "2px 6px", background: GOLD, color: ON_NAVY, borderRadius: "3px", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>Curated</span>
              )}
              {localExpertResults.localExpert?.status === "ok" && localExpertResults.localExpert.sources?.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSourcesExpanded((v) => !v)}
                  style={{ background: "transparent", border: "none", color: GOLD_DARK, textDecoration: "underline", cursor: "pointer", fontFamily: "inherit", fontSize: "12px", padding: 0 }}
                >{localExpertResults.localExpert.sources.length} source{localExpertResults.localExpert.sources.length === 1 ? "" : "s"} consulted {sourcesExpanded ? "▲" : "▼"}</button>
              )}
              {localExpertResults.localExpert?.status === "no_results" && (
                <span style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", fontStyle: "italic" }}>local sources returned nothing usable — these are the model's best guesses</span>
              )}
              {localExpertResults.localExpert?.status === "skipped_no_key" && (
                <span style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", fontStyle: "italic" }}>local-source retrieval not configured</span>
              )}
            </div>
            {sourcesExpanded && localExpertResults.localExpert?.sources?.length > 0 && (
              <ul style={{ margin: "0 0 12px", padding: "0 0 0 18px", fontSize: "11.5px", color: GOLD_DARK }}>
                {localExpertResults.localExpert.sources.map((s) => (
                  <li key={s.source_id} style={{ marginBottom: "2px" }}>
                    {s.source_name}{" "}
                    <span style={{ opacity: 0.7 }}>({s.result_count} result{s.result_count === 1 ? "" : "s"}){s.cached ? " · cached" : ""}</span>
                  </li>
                ))}
              </ul>
            )}
            {localExpertResults.note && (
              <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 1rem", fontStyle: "italic", lineHeight: 1.55 }}>{localExpertResults.note}</p>
            )}
            {localExpertResults.restaurants?.length > 0 && (
              <div style={{ marginTop: "0.75rem" }}>
                <h3 style={{ fontSize: "11px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 12px", paddingBottom: "8px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Restaurants ({localExpertResults.restaurants.length})</h3>
                <div style={{ display: "grid", gridTemplateColumns: vp.isAtLeastDesktop ? "repeat(auto-fit, minmax(360px, 1fr))" : "1fr", gap: "12px" }}>
                  {localExpertResults.restaurants.map((r, i) => (
                    <FindRestaurantCard key={`le-${r.name}-${i}`} restaurant={r} onOpenMenu={onOpenMenu} />
                  ))}
                </div>
              </div>
            )}
            {localExpertResults.activities?.length > 0 && (
              <div style={{ marginTop: "1.25rem" }}>
                <h3 style={{ fontSize: "11px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 12px", paddingBottom: "8px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Activities ({localExpertResults.activities.length})</h3>
                <div style={{ display: "grid", gridTemplateColumns: vp.isAtLeastDesktop ? "repeat(auto-fit, minmax(360px, 1fr))" : "1fr", gap: "12px" }}>
                  {localExpertResults.activities.map((a, i) => (
                    <FindActivityCard key={`le-${a.text}-${i}`} activity={a} onOpenDetails={onOpenDetails} />
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Menu modal — opens with loading/error states, then renders MenuModal once data lands. */}
        {menuRestaurant && (
          menuData?.menu ? (
            <MenuModal restaurant={{ ...menuRestaurant, menu: menuData.menu }} onClose={onCloseMenu} />
          ) : (
            <div onClick={onCloseMenu} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1000, padding: 0 }}>
              <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Menu" style={{ background: "var(--color-background-primary)", maxWidth: "640px", width: "100%", maxHeight: "90vh", overflowY: "auto", borderRadius: "16px 16px 0 0", padding: "22px 22px 32px", boxShadow: "0 -8px 32px rgba(0,0,0,0.25)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                  <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, margin: 0 }}>Menu</p>
                  <button onClick={onCloseMenu} aria-label="Close menu" style={{ background: "transparent", border: "none", fontSize: "22px", color: "var(--color-text-secondary)", cursor: "pointer", padding: "4px 8px", lineHeight: 1 }}>×</button>
                </div>
                <p style={{ fontSize: "20px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 14px", color: "var(--color-text-primary)" }}>{menuRestaurant.name}</p>
                {menuLoading && <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", fontStyle: "italic" }}>Loading menu…</p>}
                {menuError && <p role="alert" style={{ fontSize: "13px", color: "var(--color-danger-hover)", background: "var(--color-danger-tint)", border: "0.5px solid var(--color-text-danger)", borderRadius: "var(--border-radius-md)", padding: "8px 12px" }}>{menuError}</p>}
              </div>
            </div>
          )
        )}

        {/* Activity details modal — lazy /api/activity-details */}
        {detailsActivity && (
          <ActivityDetailsModal
            activity={detailsActivity}
            details={detailsData}
            loading={detailsLoading}
            error={detailsError}
            onClose={onCloseDetails}
          />
        )}

        {/* Footer */}
        <div style={{ padding: "1.75rem 0 1.5rem", borderTop: "0.5px solid var(--color-border-tertiary)", marginTop: "2rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Powered by</span>
            <img src="/brand-wordmark.png?v=2" alt="Barrier Island Digital, LLC" style={{ display: "block", height: "22px", width: "auto", opacity: 0.9 }} />
          </div>
          <hr style={{ border: "none", borderTop: `1px solid ${GOLD}`, width: "32px", margin: "4px 0 0" }} />
          <span style={{ color: "var(--color-text-tertiary)", fontSize: "10px", letterSpacing: "0.06em", marginTop: "2px" }}>
            build {(typeof __BUILD_ID__ !== "undefined") ? __BUILD_ID__ : "dev"}
          </span>
        </div>
      </div>
    </URLVerifyContext.Provider>
  );
}

// FindView is exported as a named export so main.jsx can mount it as a
// sibling-of-TripOptimizer when the URL pathname starts with /find. We do
// the path branch ABOVE the React tree (in main.jsx) — not inside
// TripOptimizer — because TripOptimizer holds dozens of hooks and the
// rules-of-hooks forbid returning before them.
export { FindView };

// #9 — First-visit App Intro overlay. Explains what RouteSmith is, what it
// isn't, and how to add it to the home screen. Once-only per browser via
// localStorage; suppressed when ?direct=1 is on the URL or the app is
// running as an installed PWA. Pure gate logic lives in src/appIntro.js so
// the dismissal, URL bypass, and platform detection are unit-testable.
function AppIntroOverlay() {
  // Render-stable gate: compute once on mount, never re-show within the
  // same session even if the user opens another tab that dismisses it.
  // useState lazy initializer so SSR / hydration mismatches don't trip.
  const [visible, setVisible] = useState(() => shouldShowWelcome());
  // Which A2HS panel is expanded. "" = none; "ios" / "android" / "desktop".
  // Initialized from the user agent so the user sees their platform's
  // instructions first without an extra tap. Desktop stays collapsed (the
  // install flow is browser-specific and a generic panel is unhelpful).
  const [a2hsOpen, setA2hsOpen] = useState(() => {
    const p = detectPlatform(typeof navigator !== "undefined" ? navigator.userAgent : "");
    return p === "ios" || p === "android" ? p : "";
  });

  const dismiss = useCallback(() => {
    markWelcomeDismissed();
    setVisible(false);
  }, []);

  // Lock body scroll while the overlay is up so background touches on
  // mobile don't drift the wizard underneath. Restored on dismiss / unmount.
  useEffect(() => {
    if (!visible) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [visible]);

  // Escape key dismisses, matching modal conventions.
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (e) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, dismiss]);

  if (!visible) return null;

  const OVERLAY_BG = "var(--color-background-secondary)";
  const cardStyle = {
    background: "var(--color-background-primary)",
    border: "0.5px solid var(--color-border-secondary)",
    borderRadius: "var(--border-radius-md)",
    padding: "14px 16px",
    marginBottom: "10px",
  };
  const cardLabel = {
    fontSize: "10.5px",
    color: "var(--color-text-primary)",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    fontWeight: 700,
    margin: "0 0 6px",
  };
  const cardBody = {
    fontSize: "13px",
    color: "var(--color-text-secondary)",
    margin: 0,
    lineHeight: 1.55,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-intro-title"
      style={{
        position: "fixed",
        inset: 0,
        background: OVERLAY_BG,
        zIndex: 9999,
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Skip the intro and go straight to the planner"
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 14px) + 14px)",
          right: "18px",
          background: "transparent",
          border: "none",
          color: "var(--color-text-tertiary)",
          fontSize: "11px",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          fontWeight: 600,
          cursor: "pointer",
          textDecoration: "underline",
          fontFamily: "inherit",
        }}
      >
        Skip
      </button>

      <div
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 14px) + 14px)",
          left: "22px",
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "9.5px",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--color-text-tertiary)",
          fontWeight: 600,
        }}
      >
        <span>Powered by</span>
        <img
          src="/brand-wordmark.png?v=2"
          alt="Barrier Island Digital, LLC"
          style={{ display: "block", height: "18px", width: "auto", opacity: 0.9 }}
        />
      </div>

      <div
        style={{
          maxWidth: "640px",
          margin: "0 auto",
          padding: "calc(env(safe-area-inset-top, 14px) + 76px) 20px 32px",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <img
            src="/rs3-wordmark.svg?v=3"
            alt="Route Smith"
            style={{ display: "inline-block", height: "56px", width: "auto", margin: "0 0 10px" }}
          />
          <p
            id="app-intro-title"
            style={{
              fontSize: "15px",
              color: "var(--color-text-primary)",
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              lineHeight: 1.4,
            }}
          >
            An LLM-assisted itinerary builder for premium trips.
          </p>
        </div>

        <div style={cardStyle}>
          <p style={cardLabel}>What it is</p>
          <p style={cardBody}>
            Tell us where, when, and how you travel — get a day-by-day plan with flights, hotels, dining, activities, and the operational details you actually need: addresses, phone numbers, confirmation slots, weather windows, packing notes.
          </p>
        </div>

        <div style={cardStyle}>
          <p style={cardLabel}>What it isn&rsquo;t</p>
          <p style={cardBody}>
            Not a booking engine. We don&rsquo;t sell flights or hotels and we don&rsquo;t have live availability. Every recommendation is checked through a panel of expert sources, but you book directly with the operator. Treat dates, prices, and hours as starting points — confirm before you commit.
          </p>
        </div>

        <div style={cardStyle}>
          <p style={cardLabel}>How to use it</p>
          <p style={cardBody}>
            Build a plan, tweak it via the expert review or &ldquo;Suggest a change,&rdquo; save it to your device, and export as PDF for the trip. Nothing&rsquo;s stored on a server. You can come back any time and pick up where you left off.
          </p>
        </div>

        <div style={cardStyle}>
          <p style={cardLabel}>Add to your home screen</p>
          <p style={{ ...cardBody, marginBottom: "10px" }}>
            Travel apps get checked dozens of times per trip. Save Route Smith to your home screen so it&rsquo;s one tap away — it works offline once installed.
          </p>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: a2hsOpen ? "10px" : 0 }}>
            {[
              { id: "ios", label: "iPhone / iPad" },
              { id: "android", label: "Android" },
              { id: "desktop", label: "Desktop" },
            ].map((opt) => {
              const active = a2hsOpen === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-expanded={active}
                  aria-controls={`a2hs-panel-${opt.id}`}
                  onClick={() => setA2hsOpen(active ? "" : opt.id)}
                  style={{
                    fontSize: "10.5px",
                    letterSpacing: "0.04em",
                    fontWeight: active ? 700 : 500,
                    color: active ? "var(--color-background-primary)" : "var(--color-text-secondary)",
                    background: active ? "var(--color-text-primary)" : "transparent",
                    border: `0.5px solid ${active ? "var(--color-text-primary)" : "var(--color-border-secondary)"}`,
                    borderRadius: "999px",
                    padding: "4px 11px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {a2hsOpen === "ios" && (
            <ol
              id="a2hs-panel-ios"
              style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: 0, paddingLeft: "20px", lineHeight: 1.6 }}
            >
              <li>Open this page in <strong>Safari</strong> (other iOS browsers can&rsquo;t install web apps).</li>
              <li>Tap the <strong>Share</strong> icon at the bottom of the screen (the square with the up arrow).</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong> in the top-right.</li>
            </ol>
          )}
          {a2hsOpen === "android" && (
            <ol
              id="a2hs-panel-android"
              style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: 0, paddingLeft: "20px", lineHeight: 1.6 }}
            >
              <li>Open this page in <strong>Chrome</strong>, <strong>Edge</strong>, or <strong>Samsung Internet</strong>.</li>
              <li>Tap the <strong>three-dot menu</strong> in the top-right corner.</li>
              <li>Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong> if you see it).</li>
              <li>Tap <strong>Add</strong> to confirm.</li>
            </ol>
          )}
          {a2hsOpen === "desktop" && (
            <ol
              id="a2hs-panel-desktop"
              style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: 0, paddingLeft: "20px", lineHeight: 1.6 }}
            >
              <li><strong>Chrome / Edge:</strong> look for the install icon in the URL bar (a small monitor with a down arrow) and click <strong>Install</strong>.</li>
              <li><strong>Safari (macOS):</strong> File menu, then <strong>Add to Dock</strong>.</li>
              <li><strong>Firefox:</strong> doesn&rsquo;t support PWA install; bookmark the page instead.</li>
            </ol>
          )}
        </div>

        <button
          type="button"
          onClick={dismiss}
          style={{
            width: "100%",
            border: "none",
            borderRadius: "var(--border-radius-md)",
            padding: "14px 18px",
            fontSize: "12px",
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "inherit",
            background: "var(--color-text-primary)",
            color: "var(--color-background-primary)",
            marginTop: "14px",
          }}
        >
          Start planning
        </button>

        <p
          style={{
            textAlign: "center",
            fontSize: "9.5px",
            color: "var(--color-text-tertiary)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginTop: "18px",
            marginBottom: 0,
            fontWeight: 500,
          }}
        >
          A travel companion crafted by Barrier Island Digital, LLC
        </p>
      </div>
    </div>
  );
}

export default function TripOptimizer() {

  // Viewport awareness drives a few container widths so the wizard form
  // doesn't sit in a 640px column on a 1280px+ screen. Per-component opt-in
  // (most surfaces don't need it).
  const vp = useViewport();

  // Form state is INTENTIONALLY NOT PERSISTED across launches. The user wants
  // a clean slate on every launch and after "Plan another trip". We still
  // write to localStorage during a session for crash recovery within the
  // same tab, but on mount we wipe it. Saved trips (multi-trip library) live
  // under SAVED_TRIPS_KEY and are unaffected.
  const LS_KEY = "trip-optimizer-form-v4";

  // BLANK = truly empty state. Used on every launch and on "Plan another trip".
  const BLANK = {
    basics: { destination: "", cities: [{ name: "", nights: "", focus: "" }], startDate: "", endDate: "", nights: "", travelers: "", baseArea: "", style: [], pace: "", budget: [] },
    flights: { homeAirport: "EWR", airline: "", cabin: "", flex: "", noFlight: false },
    hotel: { brand: ["Marriott / Bonvoy"], tier: "", mustHave: "" },
    transport: { type: [], company: "Hertz", vehicle: "" },
    dining: { cuisine: "", budget: [] },
    restaurants: [],
    activities: [],
    interests: { level: "", text: "" },
    // Hero-level overarching planning guidelines. Sits at the very top of
    // step 1, BEFORE destination/dates. These are the meta-rules — the
    // traveler's high-level direction (anniversary trip, pacing rules,
    // mobility constraints, budget posture, must-have anchors). The build
    // prompt treats this as the highest priority — even above the narrative
    // — because guidelines shape every decision the planner makes.
    guidelines: "",
    // Freeform "tell me everything" box. Anything the dropdowns can't capture
    // — specific hotels with confirmation numbers, flight legs, dates, kids’
    // ages, anniversary surprises, named guides, no-museum-Tuesdays, upgrade
    // status. The build prompt treats this as the highest-priority directive,
    // overriding/augmenting any structured field that conflicts.
    narrative: "",
  };
  // DEFAULTS preserved only as fallback when a saved trip is missing a field on Open.
  const DEFAULTS = BLANK;

  // Wipe any leftover form state from a prior session as early as possible.
  // Runs once at module init — before the first render — so the form starts blank.
  try { localStorage.removeItem(LS_KEY); } catch {}

  // SESSION RECOVERY. Holds the most recent built `result` + inputs + step so
  // an unexpected reload (PWA update, browser crash, our own self-heal) doesn't
  // wipe a working itinerary the user hasn't explicitly saved. Distinct from
  // SAVED_TRIPS_KEY which is the explicit "library". TTL'd to 24h so a stale
  // session doesn't surprise the user on a future visit.
  const SESSION_KEY = "trip-optimizer-session-v1";
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
  const loadSession = () => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object") return null;
      if (!s.savedAt || (Date.now() - s.savedAt) > SESSION_TTL_MS) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch { return null; }
  };
  // recovered must be computed ONCE per component mount, not on every render.
  // Previously called loadSession() directly during render which executed
  // Date.now() + localStorage.getItem on every render (and re-evaluated the
  // TTL check, so a session could be "recovered" on first render and then
  // "missing" on the next render after the TTL expired mid-session).
  // useState with a lazy initializer runs loadSession() exactly once on mount
  // and keeps the snapshot stable across all subsequent renders. The setter
  // is intentionally unused — we just need the lazy-init contract.
  const [recovered] = useState(() => loadSession());

  const [step, setStep] = useState(recovered?.step || 1);
  // Landing-level mode switch. When true, the whole surface flips to the
  // find-only experience (the standalone FindView, rendered inline) instead
  // of the full-trip wizard. Lives outside the wizard module so it can swap
  // the body without navigating to /find. Not persisted — every launch
  // starts in full-trip mode.
  const [findOnly, setFindOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [progress, setProgress] = useState(0);          // 0–1 estimated fraction
  const [progressLabel, setProgressLabel] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState(recovered?.result || null);
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  // Points at the streaming-progress panel (rendered in step 2 while
  // loading/extracting). Used to scroll the panel into view on build start so
  // the user sees that something is happening even when it's below the fold.
  const progressPanelRef = useRef(null);
  // Tracks the previous value of `loading` so the auto-scroll effect fires
  // only on the rising edge (false -> true), i.e. once per build, not on every
  // progress-driven re-render while a build is already running.
  const prevLoadingRef = useRef(false);
  // Tracks which saved-trip entry (if any) the current `result` came from.
  // When a saved trip is opened and then revised, we persist the revised plan
  // and review state back into THAT entry rather than creating a new one.
  const [currentSavedTripId, setCurrentSavedTripId] = useState(recovered?.currentSavedTripId || null);
  // _review state for the currently-displayed plan. Mirrored onto result so
  // it round-trips through saves; also lifted here so ItineraryView re-mounts
  // pick up the latest reviewer findings.
  const [reviewState, setReviewState] = useState(recovered?.reviewState || recovered?.result?._review || null);

  // Normalize basics: ensure cities[] exists even for saved sessions from before multi-city support.
  const normalizeBasics = (b) => {
    const src = b || DEFAULTS.basics;
    if (Array.isArray(src.cities) && src.cities.length > 0) return src;
    return { ...src, cities: [{ name: src.destination || "", nights: src.nights || "", focus: "" }] };
  };
  const _ri = recovered?.inputs;
  const [basics, setB] = useState(normalizeBasics(_ri?.basics || BLANK.basics));
  const [flights, setF] = useState(_ri?.flights || BLANK.flights);
  const [hotel, setH] = useState(_ri?.hotel || BLANK.hotel);
  const [transport, setT] = useState(_ri?.transport || BLANK.transport);
  const [dining, setD] = useState(_ri?.dining || BLANK.dining);
  const [restaurants, setRest] = useState(_ri?.restaurants || BLANK.restaurants);
  const [activities, setActs] = useState(_ri?.activities || BLANK.activities);
  const [interests, setInt] = useState(_ri?.interests || BLANK.interests);
  // narrative is intentionally a top-level string — not nested under interests —
  // so the prompt can address it as its own "trip directive" block. Persists
  // through localStorage + saved-trip serialization like every other field.
  const [narrative, setNarrative] = useState(_ri?.narrative || BLANK.narrative);
  // Hero-level trip guidelines — meta-rules above all other inputs.
  const [guidelines, setGuidelines] = useState(_ri?.guidelines || BLANK.guidelines);
  // Build "output sections" selection. The day-by-day itinerary is ALWAYS on
  // (a plan with no days is meaningless, so its toggle renders locked-on);
  // every add-on section defaults OFF and the user opts in on the Step 2
  // choices panel before building. Restored from the recovered session
  // snapshot so a remount mid-flow (PWA update, mobile tab discard, self-heal
  // reload) keeps the user's picks instead of silently resetting to defaults —
  // the cause of the "sections cleared to flight + hotel only" report.
  // Declared here (with the other input buckets, before the snapshot effect
  // that reads it) so the key set stays identical to outputDefs.
  const [outputs, setOut] = useState(() => resolveOutputs(recovered?.inputs?.outputs));
  // #8 Reviewer source selection, LIFTED to wizard level so the user can pick
  // expert-review sources BEFORE the build (the agreed "pre-build picker, then
  // full auto" flow). Defaults mirror ReviewPanel exactly: the dflt sources +
  // (if the destination matches a curated region) that region's hyperlocal set.
  // Recovered trips reuse their saved review sources when present.
  const [reviewerSourceIds, setReviewerSourceIds] = useState(() => {
    const saved = recovered?.result?.review?.sources;
    if (Array.isArray(saved) && saved.length) return saved;
    const base = REVIEWER_SOURCES.filter(s => s.dflt).map(s => s.id);
    const dest = recovered?.inputs?.basics?.destination
      || (Array.isArray(recovered?.inputs?.basics?.cities) ? recovered.inputs.basics.cities.map(c => c?.name).filter(Boolean).join(" ") : "")
      || "";
    const region = matchHyperlocalRegion(dest);
    return region ? Array.from(new Set([...base, ...region.sourceIds])) : base;
  });
  // Pending state for the "Build from this" shortcut. extractingFromGuidelines
  // shows the spinner on the shortcut button; pendingBuildFromGuidelines fires
  // handleBuild on the NEXT render after setState flushes — we cannot call
  // handleBuild() inline because the prompt builders read state from the
  // closure that's about to be replaced.
  const [extractingFromGuidelines, setExtractingFromGuidelines] = useState(false);
  const [pendingBuildFromGuidelines, setPendingBuildFromGuidelines] = useState(false);
  // Uncertain-name confirmation. When extraction returns name_checks[],
  // pause before arming the build and show the user a small panel asking
  // them to resolve each one (use original / pick a candidate / type a fix).
  // pendingNameChecks holds { checks: [...], resolutions: { idx: { choice, value } } }.
  // resolutions are keyed by the check's index in checks[].
  const [pendingNameChecks, setPendingNameChecks] = useState(null);

  // "Build from this →" shortcut. POSTs the guidelines text to the extraction
  // endpoint, merges whatever structured fields come back into the form state,
  // and arms a flag that handleBuild fires off on the next render. The
  // guidelines text itself still flows through to the build prompt as SOURCE
  // OF TRUTH — extraction is only here to satisfy the form's structural needs
  // (destination is required to resolve weather / geography).
  const buildFromGuidelines = async () => {
    const text = (guidelines || "").trim();
    if (!text || extractingFromGuidelines || loading) return;
    setExtractingFromGuidelines(true);
    setError("");
    // Advance to step 2 immediately so the user sees the progress panel
    // throughout extraction + build. Without this, the user stayed on step 1
    // with only the button changing labels, which looked like a no-op click.
    // The step-2 loading panel watches `extractingFromGuidelines || loading`
    // so it shows the spinner + "Reading your narrative…" right away.
    setLoadingMsg("Reading your narrative…");
    setProgress(0);
    setProgressLabel("");
    // The "Build from this" shortcut commits straight to a build, so it lands
    // on the Outputs screen where the progress panel renders.
    setOutputsStep(true);
    setStep(2);
    try { window.scrollTo({ top: 0, behavior: "instant" }); } catch {}
    try {
      const resp = await fetch("/api/extract-trip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      let data = null;
      try { data = await resp.json(); } catch {}
      if (!resp.ok) {
        const msg = data?.error?.message || `Extraction failed (${resp.status}). Try filling the form manually.`;
        setError(msg);
        setExtractingFromGuidelines(false);
        setLoadingMsg("");
        // Bounce back to step 1 so the inline error under the 'Build from
        // this' button is the thing the user sees.
        setOutputsStep(false);
        setStep(1);
        return;
      }
      const ex = data?.extracted || {};
      // Merge extracted basics into existing state — do NOT wholesale replace,
      // because the user might have already typed something into a form field
      // before clicking the shortcut.
      const exBasics = ex.basics || {};
      const exFlights = ex.flights || {};
      const exHotel = ex.hotel || {};
      const exRestaurants = Array.isArray(ex.restaurants) ? ex.restaurants : [];
      const exActivities = Array.isArray(ex.activities) ? ex.activities : [];

      // Compute nights from dates if extraction didn't provide one.
      let inferredNights = exBasics.nights || "";
      if (!inferredNights && exBasics.startDate && exBasics.endDate) {
        try {
          const d1 = new Date(exBasics.startDate + "T00:00:00");
          const d2 = new Date(exBasics.endDate + "T00:00:00");
          const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
          if (diff > 0 && diff < 60) inferredNights = String(diff);
        } catch {}
      }

      setB((prev) => normalizeBasics({
        ...prev,
        destination: exBasics.destination || prev.destination,
        startDate: exBasics.startDate || prev.startDate,
        endDate: exBasics.endDate || prev.endDate,
        nights: inferredNights || prev.nights,
        travelers: exBasics.travelers || prev.travelers,
        baseArea: exBasics.baseArea || prev.baseArea,
        budget: exBasics.budget != null ? (Array.isArray(exBasics.budget) ? exBasics.budget : [exBasics.budget].filter(Boolean)) : prev.budget,
        style: (Array.isArray(exBasics.style) && exBasics.style.length) ? exBasics.style : prev.style,
        pace: exBasics.pace || prev.pace,
        // Mirror destination into cities[0].name so multi-city machinery
        // and the city autocomplete stay consistent.
        cities: (prev.cities && prev.cities.length)
          ? prev.cities.map((c, i) => i === 0 ? { ...c, name: exBasics.destination || c.name } : c)
          : [{ name: exBasics.destination || "", nights: inferredNights || "", focus: "" }],
      }));
      setF((prev) => ({
        ...prev,
        homeAirport: exFlights.homeAirport || prev.homeAirport,
        airline: exFlights.airline || prev.airline,
        cabin: exFlights.cabin || prev.cabin,
        noFlight: typeof exFlights.noFlight === "boolean" ? exFlights.noFlight : prev.noFlight,
      }));
      setH((prev) => ({
        ...prev,
        mustHave: exHotel.mustHave || prev.mustHave,
        tier: exHotel.tier || prev.tier,
      }));
      if (exRestaurants.length) setRest((prev) => Array.from(new Set([...(prev || []), ...exRestaurants])));
      if (exActivities.length) setActs((prev) => Array.from(new Set([...(prev || []), ...exActivities])));

      // Uncertain-name gate. If the extractor flagged any names it wasn't
      // confident about, pause the build and show a confirm panel. The user
      // resolves each check (use original / pick a candidate / custom), then
      // clicks Continue — only then do we arm the deferred build. This
      // prevents the silent-substitution-of-a-misspelled-hotel-name failure.
      const checks = Array.isArray(ex.name_checks)
        ? ex.name_checks.filter((c) => c && c.original && c.kind)
        : [];
      if (checks.length > 0) {
        setPendingNameChecks({
          checks,
          resolutions: Object.fromEntries(
            checks.map((_, i) => [i, { choice: "original", value: "" }]),
          ),
        });
        setLoadingMsg("");
        // Stay on step 2 — the panel renders below the (now hidden) loading
        // panel and asks the user to confirm before we arm the build.
        return;
      }

      // No uncertain names — arm the deferred build. The effect below will
      // fire handleBuild on the next render, by which point the setters above
      // have flushed and the prompt builders will see the new values.
      setPendingBuildFromGuidelines(true);
    } catch (err) {
      setError(`Couldn't process guidelines: ${String(err?.message || err)}. Try filling the form manually.`);
      setLoadingMsg("");
      setOutputsStep(false);
      setStep(1);
    } finally {
      setExtractingFromGuidelines(false);
    }
  };

  // Reset every form bucket to BLANK. Used for "Plan another trip".
  const resetFormToBlank = () => {
    setB(normalizeBasics(BLANK.basics));
    setF(BLANK.flights);
    setH(BLANK.hotel);
    setT(BLANK.transport);
    setD(BLANK.dining);
    setRest(BLANK.restaurants);
    setActs(BLANK.activities);
    setInt(BLANK.interests);
    setNarrative(BLANK.narrative);
    setGuidelines(BLANK.guidelines);
    setExtractingFromGuidelines(false);
    setPendingBuildFromGuidelines(false);
    setPendingNameChecks(null);
    setResult(null);
    setError("");
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    setLoading(false); setLoadingMsg(""); setProgress(0); setProgressLabel(""); setElapsedSec(0);
    try { localStorage.removeItem(LS_KEY); } catch {}
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  };

  // Apply the user's name-check resolutions to form state and arm the build.
  // For each check, the chosen value either keeps the original text or
  // substitutes a candidate / custom text. We rewrite the relevant slot:
  //   hotel       → hotel.mustHave (string replace of original → chosen)
  //   restaurant  → restaurants[] (replace matching entry)
  //   activity    → activities[] (replace matching entry)
  //   airline     → flights.airline (string replace)
  //   other       → only updates the guidelines text
  // The guidelines text itself also gets the original → chosen rewrite so
  // the build prompt's "SOURCE OF TRUTH" block doesn't still contain the
  // unresolved name.
  const confirmNameChecks = () => {
    if (!pendingNameChecks) return;
    const { checks, resolutions } = pendingNameChecks;
    // Case-insensitive first-occurrence replace; falls back to literal if no
    // match (so we always apply *something* even when the model's original
    // text doesn't appear verbatim in the narrative).
    const replaceFirst = (haystack, needle, replacement) => {
      if (!haystack || !needle) return haystack;
      const i = haystack.toLowerCase().indexOf(String(needle).toLowerCase());
      if (i < 0) return haystack;
      return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
    };
    const pickValue = (i) => {
      const r = resolutions[i] || { choice: "original", value: "" };
      if (r.choice === "original") return checks[i].original;
      if (r.choice === "custom") return (r.value || "").trim() || checks[i].original;
      // Candidate index encoded as "candidate:0", "candidate:1", ...
      if (r.choice && r.choice.startsWith("candidate:")) {
        const idx = parseInt(r.choice.slice("candidate:".length), 10);
        return checks[i].candidates?.[idx] || checks[i].original;
      }
      return checks[i].original;
    };
    // Build a list of (kind, original, chosen) rewrites for non-noop changes.
    const rewrites = checks.map((c, i) => ({ kind: c.kind, original: c.original, chosen: pickValue(i) }));
    const changed = rewrites.filter((r) => r.chosen && r.chosen !== r.original);

    if (changed.length > 0) {
      // Apply slot-specific rewrites.
      changed.forEach((r) => {
        if (r.kind === "hotel") {
          setH((prev) => ({ ...prev, mustHave: replaceFirst(prev.mustHave || "", r.original, r.chosen) }));
        } else if (r.kind === "restaurant") {
          setRest((prev) => (prev || []).map((s) => (s === r.original ? r.chosen : s)));
        } else if (r.kind === "activity") {
          setActs((prev) => (prev || []).map((s) => (s === r.original ? r.chosen : s)));
        } else if (r.kind === "airline") {
          setF((prev) => ({ ...prev, airline: replaceFirst(prev.airline || "", r.original, r.chosen) }));
        }
      });
      // Rewrite guidelines so the build prompt's verbatim block matches.
      setGuidelines((prev) => {
        let next = prev || "";
        changed.forEach((r) => { next = replaceFirst(next, r.original, r.chosen); });
        return next;
      });
    }

    setPendingNameChecks(null);
    setLoadingMsg("Reading your narrative…");
    setPendingBuildFromGuidelines(true);
  };

  // Cancel the name-check panel — go back to step 1 so the user can edit
  // their narrative.
  const cancelNameChecks = () => {
    setPendingNameChecks(null);
    setLoadingMsg("");
    setStep(1);
  };

  // Saved trips list — hydrated from localStorage. Refreshed on save/delete/open.
  const [savedTrips, setSavedTrips] = useState(() => loadSavedTrips());
  const refreshSavedTrips = () => setSavedTrips(loadSavedTrips());
  const handleOpenSavedTrip = (entry) => {
    if (!entry || !entry.inputs || !entry.result) return;
    const i = entry.inputs;
    // CLEAR-BEFORE-OPEN. Reset every piece of form state to a clean baseline
    // first, then layer the saved entry on top. Without this, chips/fields
    // from the prior session bleed through whenever the saved entry doesn't
    // include that key (e.g. saved trip has no restaurants[] -> old chips
    // persist). Also wipes any in-flight error / loading state.
    setB(normalizeBasics(i.basics || DEFAULTS.basics));
    setF(i.flights || DEFAULTS.flights);
    setH(i.hotel || DEFAULTS.hotel);
    setT(i.transport || DEFAULTS.transport);
    setD(i.dining || DEFAULTS.dining);
    setRest(Array.isArray(i.restaurants) ? i.restaurants : []);
    setActs(Array.isArray(i.activities) ? i.activities : []);
    setInt(i.interests || DEFAULTS.interests);
    setNarrative(typeof i.narrative === "string" ? i.narrative : DEFAULTS.narrative);
    setGuidelines(typeof i.guidelines === "string" ? i.guidelines : DEFAULTS.guidelines);
    setOut(resolveOutputs(i.outputs));
    // Cancel any in-flight generation and clear transient UI state.
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    setLoading(false);
    setLoadingMsg("");
    setProgress(0);
    setProgressLabel("");
    setElapsedSec(0);
    setError("");
    setResult(entry.result);
    setCurrentSavedTripId(entry.id || null);
    setReviewState(entry.result?._review || null);
    setStep(3);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const handleDeleteSavedTrip = (id) => {
    const next = loadSavedTrips().filter(t => t.id !== id);
    writeSavedTrips(next);
    setSavedTrips(next);
  };

  // Stale-chip detector. Runs on mount AND on any change to destination/chips.
  // Catches two scenarios:
  //  (a) user switches destination during the session
  //  (b) form loads from localStorage with destination + chips that don't match
  //      (the common real-world failure mode -- the prior fix only handled (a))
  const primaryDest = (basics.cities && basics.cities[0]?.name) || basics.destination || "";
  const [staleSuggestion, setStaleSuggestion] = useState(null);
  const dismissedRef = useRef(""); // remember dismissed signature to not re-pop after user dismissed
  useEffect(() => {
    const currentKey = destinationKey(primaryDest);
    const r = findOrphanedChips(restaurants, currentKey, RESTAURANT_BY_DEST);
    const a = findOrphanedChips(activities, currentKey, ACTIVITY_BY_DEST);
    if (r.staleChips.length === 0 && a.staleChips.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- destination changed, clear stale suggestion
      setStaleSuggestion(null);
      return;
    }
    // Source key: prefer whichever has the most chips; fall back to either.
    const sourceKey = (r.staleChips.length >= a.staleChips.length ? r.sourceKey : a.sourceKey) || r.sourceKey || a.sourceKey;
    const signature = `${currentKey}|${sourceKey}|${r.staleChips.join(",")}|${a.staleChips.join(",")}`;
    if (dismissedRef.current === signature) return; // user already dismissed this exact set
    setStaleSuggestion({
      prevKey: sourceKey,
      newKey: currentKey,
      staleRestaurants: r.staleChips,
      staleActivities: a.staleChips,
      prevLabel: sourceKey ? sourceKey.replace(/\b\w/g, c => c.toUpperCase()) : "a different destination",
      newLabel: primaryDest || "your new destination",
      _sig: signature,
    });
  }, [primaryDest, restaurants, activities]);
  const clearStaleChips = () => {
    if (!staleSuggestion) return;
    if (staleSuggestion.staleRestaurants.length > 0) {
      setRest(restaurants.filter(r => !staleSuggestion.staleRestaurants.includes(r)));
    }
    if (staleSuggestion.staleActivities.length > 0) {
      setActs(activities.filter(a => !staleSuggestion.staleActivities.includes(a)));
    }
    setStaleSuggestion(null);
  };
  const dismissStale = () => {
    if (staleSuggestion?._sig) dismissedRef.current = staleSuggestion._sig;
    setStaleSuggestion(null);
  };

  // --------------------------------------------------------------------
  // AUTO-SAVE — debounced.
  //
  // Both auto-saves used to run SYNCHRONOUSLY on every keystroke. The form
  // payload is small (a few KB) but the session snapshot can include a built
  // `result` (50–100k chars) + reviewState (the plan JSON repeated). Pasting
  // a 15k-character instruction into the narrative box fired the snapshot
  // effect once, but the synchronous JSON.stringify + localStorage.setItem of
  // a ~200k-payload during a paste committed enough work on the main thread
  // to lock up the page — and could trip the localStorage 5MB quota when a
  // big result was already in state.
  //
  // Two-part fix:
  //   1. Debounce both writes by 400ms — a paste or burst of typing fires
  //      ONE write after the user pauses instead of N writes during.
  //   2. Catch QuotaExceededError on the snapshot and degrade gracefully:
  //      first try dropping `result` from the snapshot (form + step is enough
  //      to recover); if that still fails, clear the slot and log to console.
  // --------------------------------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({ basics, flights, hotel, transport, dining, restaurants, activities, interests, guidelines, narrative }),
        );
      } catch (err) {
        // Quota or serialization error — don't crash the app.
        console.warn("[trip-optimizer] form auto-save skipped:", err?.message || err);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [basics, flights, hotel, transport, dining, restaurants, activities, interests, guidelines, narrative]);

  // Persist a session snapshot whenever the built `result` or step changes.
  // This is the safety net against unexpected reloads losing an unsaved trip.
  // Only writes when we have a real result OR have advanced past Step 1.
  useEffect(() => {
    if (!result && step === 1) {
      // Nothing meaningful to preserve. Clear any stale slot from a prior session.
      try { localStorage.removeItem(SESSION_KEY); } catch {}
      return undefined;
    }
    const t = setTimeout(() => {
      const baseSnapshot = {
        savedAt: Date.now(),
        step,
        currentSavedTripId,
        reviewState,
        inputs: { basics, flights, hotel, transport, dining, restaurants, activities, interests, guidelines, narrative, outputs },
      };
      const writeOrDegrade = () => {
        try {
          // First attempt: full snapshot including the built result.
          localStorage.setItem(SESSION_KEY, JSON.stringify({ ...baseSnapshot, result }));
          return;
        } catch (err) {
          if (!(err && /quota|exceed/i.test(String(err.name || err.message || "")))) {
            console.warn("[trip-optimizer] session snapshot skipped:", err?.message || err);
            return;
          }
        }
        // Degrade: drop the heavy `result` so we can still recover form+step on reload.
        try {
          localStorage.setItem(SESSION_KEY, JSON.stringify(baseSnapshot));
          console.warn("[trip-optimizer] session snapshot saved WITHOUT built result (localStorage quota).");
        } catch (err2) {
          try { localStorage.removeItem(SESSION_KEY); } catch {}
          console.warn("[trip-optimizer] session snapshot dropped (quota):", err2?.message || err2);
        }
      };
      writeOrDegrade();
    }, 400);
    return () => clearTimeout(t);
  }, [result, step, currentSavedTripId, reviewState, basics, flights, hotel, transport, dining, restaurants, activities, interests, guidelines, narrative, outputs]);
  // Step 1 has a collapsible Output Sections panel so users can preview and
  // pick which add-on sections to include before continuing to Step 2. Default
  // collapsed to keep Step 1 visually calm; expanded by user choice. Same
  // outputs state as Step 2's panel — the two cards share one source of truth.
  const [step1OutputsOpen, setStep1OutputsOpen] = useState(false);

  // Step 2 is a two-screen flow: the Details form (false) and the
  // output-section selection screen (true). The build trigger + progress panel
  // live ONLY on the outputs screen, so reaching the details form — or even the
  // outputs screen — never starts a build until the user taps "Build itinerary".
  const [outputsStep, setOutputsStep] = useState(false);

  // #20 Land at the TOP of the outputs screen whenever it opens. The five
  // setOutputsStep(true) callers previously scrolled inline in the SAME tick as
  // the state change — i.e. before the new (taller) screen painted — so the
  // browser kept a stale offset and the user landed partway down (on the newly
  // added Expert review sources card) instead of the Output sections card.
  // Scrolling in an effect after the render lands it correctly, and fixes all
  // entry points at once. (Same scroll-before-render class as the #2 fix.)
  useEffect(() => {
    if (!outputsStep) return;
    // Defer past this render so the (taller) outputs screen has painted first;
    // a 0ms timeout lands after layout. (rAF isn't in the lint globals here.)
    const id = setTimeout(() => {
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
    }, 0);
    return () => clearTimeout(id);
  }, [outputsStep]);

  // Itinerary is locked on; never let it be toggled into an empty build.
  const togOut = k => { if (k === "itinerary") return; setOut(o => ({ ...o, [k]: !o[k] })); };

  // Multi-city helpers. cities[] is the source of truth when length > 1.
  // For single-city, basics.destination/nights are authoritative for back-compat.
  const cities = (basics.cities && basics.cities.length > 0) ? basics.cities : [{ name: basics.destination || "", nights: basics.nights || "", focus: "" }];
  const isMultiCity = cities.length > 1;
  const totalNightsFromCities = cities.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
  const updateCity = (idx, patch) => {
    const next = cities.map((c, i) => i === idx ? { ...c, ...patch } : c);
    const newTotal = next.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
    setB({
      ...basics,
      cities: next,
      destination: next.map(c => c.name).filter(Boolean).join(" → ") || basics.destination,
      nights: next.length > 1 ? String(newTotal) : (next[0]?.nights || basics.nights),
    });
  };
  const addCity = () => {
    if (cities.length >= 3) return;
    const next = [...cities, { name: "", nights: "2", focus: "" }];
    const newTotal = next.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
    setB({ ...basics, cities: next, destination: next.map(c => c.name).filter(Boolean).join(" → ") || basics.destination, nights: String(newTotal) });
  };
  const removeCity = (idx) => {
    if (cities.length <= 1) return;
    const next = cities.filter((_, i) => i !== idx);
    const newTotal = next.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
    setB({
      ...basics,
      cities: next,
      destination: next.length > 1 ? next.map(c => c.name).filter(Boolean).join(" → ") : (next[0]?.name || ""),
      nights: next.length > 1 ? String(newTotal) : (next[0]?.nights || basics.nights),
    });
  };

  // Date ⇋ Nights synchronization. Two helpers compute one from the other
  // using local-noon parsing to avoid timezone drift (DST in particular).
  // YYYY-MM-DD only — matches the native <input type="date"> format.
  const addDaysISO = (iso, n) => {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    const d = new Date(iso + "T12:00:00");
    if (isNaN(d)) return "";
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const diffDaysISO = (startIso, endIso) => {
    if (!startIso || !endIso) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso) || !/^\d{4}-\d{2}-\d{2}$/.test(endIso)) return null;
    const a = new Date(startIso + "T12:00:00");
    const b = new Date(endIso + "T12:00:00");
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  };

  // When the user changes the start date, slide the end date forward by the
  // same number of nights they already had (if any) so the trip length stays
  // constant. When the user changes the end date, recompute nights to match.
  // Unified range setter used by the single-popover DateRangeInput. Sets both
  // start + end (and synced Nights / cities[0].nights) in ONE state write so we
  // never trip the stale-state bug that two back-to-back setB() calls cause.
  const handleDateRangeChange = ({ startDate: newStart, endDate: newEnd }) => {
    const next = { ...basics, startDate: newStart || "", endDate: newEnd || "" };
    if (newStart && newEnd) {
      const nights = diffDaysISO(newStart, newEnd);
      if (nights !== null && nights > 0) {
        const v = String(nights);
        next.nights = v;
        next.cities = (basics.cities && basics.cities.length > 0)
          ? basics.cities.map((c, i) => i === 0 ? { ...c, nights: v } : c)
          : [{ name: basics.destination || "", nights: v, focus: "" }];
      }
    } else if (newStart && !newEnd) {
      // Start picked but end cleared (in-progress). Honor existing Nights if set
      // by computing the end from start+nights so the form stays internally
      // consistent until the user clicks the end day.
      const currentNights = parseInt(basics.nights, 10) || 0;
      if (currentNights > 0) {
        next.endDate = addDaysISO(newStart, currentNights);
      }
    }
    setB(next);
  };
  // When the user types Nights directly, keep the end date in sync.
  const handleNightsChange = (newNightsStr) => {
    const n = parseInt(newNightsStr, 10);
    const newEnd = (basics.startDate && Number.isFinite(n) && n > 0)
      ? addDaysISO(basics.startDate, n)
      : basics.endDate;
    setB({
      ...basics,
      nights: newNightsStr,
      endDate: newEnd,
      cities: (basics.cities && basics.cities.length > 0)
        ? basics.cities.map((c, i) => i === 0 ? { ...c, nights: newNightsStr } : c)
        : [{ name: basics.destination || "", nights: newNightsStr, focus: "" }],
    });
  };

  // End-date validation message (informational — doesn't block submit).
  const endDateError = (basics.endDate && basics.startDate && diffDaysISO(basics.startDate, basics.endDate) !== null && diffDaysISO(basics.startDate, basics.endDate) <= 0)
    ? "Return date must be after the start date"
    : "";

  const cityNamesValid = cities.every(c => c.name && c.name.trim());
  const cityNightsValid = cities.every(c => (parseInt(c.nights, 10) || 0) >= 1);
  const missing = [
    !cityNamesValid && (isMultiCity ? "All city names" : "Destination"),
    !basics.startDate.trim() && "Start date",
    !cityNightsValid && (isMultiCity ? "Nights for each city" : "Nights"),
    // Home airport only required when the user is actually flying. If they
    // tick "Not flying (driving / train)" we skip flight planning entirely.
    !flights.noFlight && !flights.homeAirport.trim() && "Home airport",
  ].filter(Boolean);
  const ready = missing.length === 0;
  const areaHint = getAreaHint(cities[0]?.name || basics.destination);
  const activeCount = Object.values(outputs).filter(Boolean).length;

  const buildSystemPrompt = () => {
    const totalNights = isMultiCity ? totalNightsFromCities : (parseInt(basics.nights, 10) || 3);
    const totalDays = totalNights + 1;
    // Train is OFF by default. The user must explicitly tick "Train / rail" in
    // the ground-transport multi-select for any rail suggestion to be allowed.
    const trainAllowedSys = Array.isArray(transport.type) && transport.type.some(t => /train|rail/i.test(t));
    // Private driver / chauffeur enforcement. The user explicitly ticked
    // "Private driver" in the ground-transport multi-select OR named a private
    // driver day-trip in activities OR typed driver/chauffeur into the free-text
    // interests box. If ANY of these are true we MUST surface a named chauffeur
    // operator, daily pickup windows, and a dedicated "Your driver" logistics
    // chip — not a vague "car service available" aside.
    const wantsPrivateDriver =
      (Array.isArray(transport.type) && transport.type.some(t => /private\s*driver|chauffeur/i.test(t))) ||
      (Array.isArray(activities) && activities.some(a => /private driver/i.test(a))) ||
      /\b(private driver|chauffeur|car service|black car)\b/i.test(interests?.text || "") ||
      /\b(private driver|chauffeur|car service|black car)\b/i.test(narrative || "") ||
      /\b(private driver|chauffeur|car service|black car)\b/i.test(guidelines || "");
    const privateDriverBlock = !wantsPrivateDriver ? "" : `

PRIVATE DRIVER — HARD RULE (USER REQUESTED THIS):
The user explicitly asked for a private driver / chauffeur. You MUST surface this in the plan, not bury it.
• OPERATOR SELECTION — RESEARCH THE DESTINATION, DON'T DEFAULT TO A BRAND. Blacklane, Carey, and Dav-El are NOT universal. Blacklane covers most major European capitals + NYC/LA/SF/Miami/Boston/DC/Chicago, but does NOT operate in many leisure destinations (Aspen, Sun Valley, Telluride, Bozeman, Jackson Hole, most Caribbean islands, Mallorca/Ibiza outside peak season, Hallstatt, Sedona, Outer Banks, Bar Harbor, Key West, Hilton Head, Cape Cod, Newport, the Hamptons, etc.). For those destinations the right answer is a LOCAL operator: a hotel-affiliated car service, a region-specific company (e.g. "High Mountain Limo" in Aspen, "Mountain Magic" in Park City, "Lux Sun Valley Transportation", "Ground Travel Specialists" in Charleston, "Wynn Worldwide Transportation" in Vegas, "Limos of Telluride", "Tuscan Driver / Stefano's Tours" for Tuscany day trips, etc.), or simply the hotel's preferred chauffeur partner. Name the operator you are HIGHLY CONFIDENT actually serves this destination. If you are unsure, write "Concierge to book — verify operator" and add a flags[] entry asking the hotel concierge to arrange the driver — do NOT invent a fake company name and do NOT name Blacklane in a city Blacklane doesn't serve.
• Emit a dedicated Transport item on EACH activity-heavy day with: time of pickup, time of return, vehicle type (Mercedes E-Class sedan / V-Class van / Cadillac Escalade / Suburban / etc. — match the traveler count), and the driver/operator name. Example text: "08:30 — Driver pickup (named operator, Mercedes E-Class) for Vatican → lunch → Trastevere; return 18:30."
• For airport arrival on Day 1 and departure on the last day, the Transport item is the driver pickup at the terminal — include meet-and-greet detail ("meets at baggage claim with name placard") and the pickup window relative to flight arrival (typically 30–45min after wheels-down for international, 20–30 for domestic).
• Inter-city legs on a multi-city trip use the private driver too (NOT a self-drive rental) unless the user ALSO ticked "Rental car". Drive time + distance + route still required.
• Add ONE logistics chip in the form "Driver · <operator>" so the top-of-page chip strip shows the user their car service at a glance.
• Add a flags[] entry confirming the driver booking workflow (e.g. "Pre-book <operator> 24–48h ahead; <hotel name> concierge can also arrange") and include cancellation-window detail when known.
• Add a tonight entry: "⚠︎ Must today: Confirm driver pickup window for Day 1 arrival."
• Do NOT also push a rental-car narrative on top of this unless the user explicitly selected BOTH "Private driver" AND "Rental car". A user who said private driver wants to be driven — don't add "or grab an Uber" as a fallback in every slot.
• EVERY private-driver Transport item MUST have a contact{} block with a real phone number (use the hotel concierge line if you don't know the operator's direct line — then put booking_note: "Booked via <hotel> concierge — ask front desk") AND, only if you are highly confident it is live, a website URL. URLs are HEAD-verified after generation; a missing URL is FAR better than a fabricated one. Do not invent driver-service URLs.`;
    // Private tour / private guide enforcement. Triggered by any of:
    //  • activities list containing "private" + "tour/guide/walking" phrasing
    //  • free-text interests mentioning private tour/guide
    //  • style preference including "VIP" or "private experiences"
    // "Private" anywhere on the same line as tour/guide/walking handles the
    // canned activity labels (e.g. "Private city walking tour") which weren't
    // matched by a stricter "private (city|walking)?\s*(tour|guide)" form.
    // NOTE: skip-the-line is its own track — it does NOT imply private guide,
    // just timed-entry tickets. Handled in a separate block below.
    const _tourRe = /\bprivate\b.*\b(tour|guide|walking)\b|\bVIP\b/i;
    const wantsPrivateTour =
      (Array.isArray(activities) && activities.some(a => _tourRe.test(a) && !/private driver/i.test(a))) ||
      _tourRe.test(interests?.text || "") ||
      _tourRe.test(narrative || "") ||
      _tourRe.test(guidelines || "") ||
      (Array.isArray(basics.style) && basics.style.some(s => /\bVIP\b|\bprivate\b/i.test(s)));
    // Skip-the-line / timed-entry enforcement. Separate from private-guide
    // because the user might just want pre-booked tickets, not a guide.
    const _stlRe = /skip[- ]the[- ]line|timed[- ]entry|fast[- ]track|priority entry/i;
    const wantsSkipTheLine =
      (Array.isArray(activities) && activities.some(a => _stlRe.test(a))) ||
      _stlRe.test(interests?.text || "") ||
      _stlRe.test(narrative || "");
    const privateTourBlock = !wantsPrivateTour ? "" : `

PRIVATE TOURS / PRIVATE GUIDES — HARD RULE (USER REQUESTED THIS):
The user asked for private tours or private guides. Group bus tours and self-guided audio walks do NOT satisfy this request.
• For each marquee experience (Vatican / Colosseum / Sagrada Família / Versailles / Alhambra / Louvre / Uffizi / Acropolis / Vasa Museum / etc.), emit an Activity item that specifies it is a PRIVATE guide — not a group tour. Example text: "Private 3-hour Vatican + Sistine tour with art-historian guide (small-group max 6 if true private unavailable)."
• Name the operator/agency when you can credibly do so (Context Travel, Walks of Italy private upgrade, Through Eternity private, LivTours private, Devour Tours private food walk, Take Walks private, ToursByLocals for vetted independents, the destination's official licensed-guide bureau). If unsure, write "Concierge to book licensed private guide" and flag for verification.
• Each private tour Activity item MUST include: duration, guide credential (art historian / licensed local guide / sommelier / chef / etc.), pickup-or-meet location, advance booking lead time (most marquee private tours need 2–6 weeks), and approximate per-group cost band if you have confidence in it.
• Add a flags[] entry: "Book private guides NOW — marquee slots (Vatican early-entry, Uffizi opening) sell out 4–8 weeks ahead."
• Add a tonight entry prefixed "⚠︎ Must today:" for the most lead-time-sensitive private booking.
• Add a snobs entry that says what a private guide unlocks vs a group tour (early access, off-hours, deeper expertise, customization of the route).
• NEVER substitute a hop-on-hop-off bus, a self-guided audio app, or a free walking tour for a requested private experience.`;
    const skipTheLineBlock = !wantsSkipTheLine ? "" : `

SKIP-THE-LINE / TIMED ENTRY — HARD RULE (USER REQUESTED THIS):
The user explicitly asked for skip-the-line access. General-admission walk-up queues are NOT acceptable for marquee sights.
• For EVERY major ticketed sight in the plan (Vatican Museums / Colosseum / Sagrada Família / Alhambra / Versailles / Uffizi / Accademia / Louvre / Acropolis / Anne Frank House / Borghese Gallery / Last Supper / Doge's Palace / Park Güell / Casa Batlló / Westminster Abbey / etc.) the Activity item MUST specify the skip-the-line / timed-entry ticket type and where to buy it.
• Preferred booking sources, in order: (1) official museum/site website (cheapest, most reliable — e.g. museivaticani.va, parcocolosseo.it, sagradafamilia.org, alhambra-patronato.es, uffizi.it, ticketmaster for the Louvre, anbefrank.org for Anne Frank, royalcollection.org.uk), (2) reputable resellers when official sells out (GetYourGuide, Tiqets, Headout), (3) hotel concierge as fallback.
• Each skip-the-line Activity item MUST include: exact ticket name ("Vatican Museums + Sistine Chapel skip-the-line, 09:00 entry"), official booking URL or platform name, advance lead time (most marquee sights need 2–8 weeks; Last Supper and Anne Frank House open ticket windows months ahead), and the specific entry time slot you're targeting.
• First-thing-in-the-morning slots (08:00–09:00) are the right default for crowd-sensitive sights — NOT mid-day. State the entry time explicitly.
• Add a flags[] entry per major sight: "Book <sight> skip-the-line NOW — <lead-time> ahead. Official: <url>."
• Add a tonight entry: "⚠︎ Must today: Book skip-the-line tickets for <most lead-time-sensitive sight>."
• If the sight ALSO offers a guided-tour upgrade that includes skip-the-line as part of the package (e.g. Vatican early-access guided tour), mention it as an option but do NOT swap the simple skip-the-line ticket for a tour unless the user separately asked for a private guide.
• NEVER write "buy tickets at the door" or "arrive 30 minutes early" or "the line moves quickly" — those defeat the entire point of the user's request.`;
    const trainRuleBlock = trainAllowedSys ? "" : `

GROUND TRANSPORT — NO TRAINS (HARD RULE):
The user did NOT request train or rail. You MUST NOT propose a train, Amtrak, regional rail, commuter rail, or any rail segment ANYWHERE in this plan. Not in days[].items, not in transport_in for any city, not in logistics chips, not in flags[], not in planb[], not in snobs, not in tonight, not as a backup, not as a "consider also" aside. Pretend trains do not exist for this trip. Every ground transport segment must be car (rental, private driver, or rideshare) or walking. This applies even to rail-friendly destinations (Saratoga Springs, Hudson Valley, Connecticut shore, the entire Northeast Corridor, European destinations with great rail). Treat any urge to mention rail as a hard violation.`;
    const multiCityBlock = isMultiCity ? `

MULTI-CITY TRIP — STRUCTURE THIS CAREFULLY:
This is a ${cities.length}-city trip: ${cities.map((c, i) => `Leg ${i + 1} = ${c.name} (${c.nights} nights)`).join(", ")}.
Total: ${totalNights} nights = ${totalDays} days.
• Emit a cities[] array with ${cities.length} entries in this exact order: ${cities.map(c => c.name).join(" → ")}. Each entry needs name, nights, days_range, focus, transport_in, stay.
• Day allocation: Leg 1 gets ${cities[0]?.nights || 0} nights but ${(parseInt(cities[0]?.nights, 10) || 0) + 1} days (arrival day + nights). Subsequent legs get N nights = N days each (the inter-city transit happens AT THE START of the leg's first day). Final departure happens on the last day of the last leg (no extra day).
• Use these PRECOMPUTED day ranges for each leg (do not recompute): Leg 1 = Day 1–Day ${(parseInt(cities[0]?.nights, 10) || 0) + 1}. ${cities.length >= 2 ? `Leg 2 starts Day ${(parseInt(cities[0]?.nights, 10) || 0) + 2}.` : ""} ${cities.length === 3 ? `Leg 3 starts Day ${(parseInt(cities[0]?.nights, 10) || 0) + (parseInt(cities[1]?.nights, 10) || 0) + 2}.` : ""}
• Each day MUST have a "city" field with the city name. Transit days (the first day of legs 2 and 3) use "From→To" format (e.g. "Santa Fe → Taos").
• PACING for transit days: the first day of legs 2/3 is a transit day. Front-load the morning with checkout + drive/fly, then a relaxed arrival lunch in the new city, then a light afternoon activity. Don't pack a transit day full — the user is moving with luggage.
• INTER-CITY TRANSPORT: For each leg after Leg 1, include a Transport item at the START of that leg's first day with: realistic drive time, distance in miles AND km if international, route (highway/road number), and any pacing notes (rest stops, scenic detours). For flight transfers between cities, treat it as a Flight item.
• LUGGAGE / LOGISTICS REALITY: When the route is drive-based, the same rental car follows the whole trip — don't return it between cities. When the route mixes drive + fly, call out the rental car return + new pickup in flags[]. Hotel checkout times (usually 11:00–12:00) constrain how early you can hit the road; plan transit departures for 10:00–11:00 unless you note a late checkout.
• MINIMUM 2 NIGHTS per city when cities.length === 3 — if the user gave 1 night for a leg in a 3-city trip, set a flags[] warning that one night doesn't leave time to enjoy that city and suggest a re-balance.
• HOTEL ITEMS: One check-in Hotel item per leg (at arrival) and a check-out item on the last morning of each leg EXCEPT the final leg's check-out which is on the very last day before flying home. Each leg's stay must be a DIFFERENT hotel (different city = different hotel).
• weather and weather_window: if cities are in very different climates (mountain vs coast vs desert), call this out in weather_window AND give per-day weather that reflects the city's actual climate for that day.` : "";
    // ------------------------------------------------------------------
    // Destination-aware filtering of the large static reference blocks
    // (MARQUEE SIGHTS list + ARRIVAL-AIRPORT mappings + ROUTE-TRUTH list).
    // The full blocks are ~14k chars of mostly-irrelevant reference data —
    // for a Santa Fe trip from EWR, only ~5 lines of marquee + 2 airport
    // lines apply. Filtering by destination keywords keeps just the
    // relevant lines and cuts the system prompt from ~29k to ~15k chars,
    // which translates to faster Anthropic streaming (less prompt to load
    // + less context overhead per token) and lower input-token cost.
    //
    // Filter is keyword-based and case-insensitive. We use a generous match
    // (destination name + each city + home/destination airport codes) so
    // we err on the side of keeping a line. If NO line matches, we keep
    // the full block — better to be slow than to drop relevant guidance.
    // ------------------------------------------------------------------
    const _destText = [basics.destination || "", ...cities.map(c => c.name || "")].join(" ").toLowerCase();
    const _homeAirportCode = (extractAirportCode(flights.homeAirport) || flights.homeAirport || "").toUpperCase();
    const _destAirportHints = []; // we can't know the dest airport, but the source text usually mentions the city name
    const _routeKeywords = new Set([_homeAirportCode, ...(_destText.match(/[a-z]{4,}/g) || [])].filter(Boolean));
    // Tokenize destination string into useful keywords. Drop short stopwords.
    const _STOP = new Set(["city","county","area","region","island","valley","state","north","south","east","west","usa","us","new","old","the"]);
    const _destKeywords = (_destText.match(/[a-z]{3,}/g) || []).filter(w => !_STOP.has(w));
    // Helper: does a line of static reference contain any destination keyword
    // OR (for flight lines) any airport code that matters to this trip?
    const _lineMatchesDestination = (line) => {
      const lc = line.toLowerCase();
      for (const k of _destKeywords) {
        if (lc.includes(k)) return true;
      }
      // Match home-airport code or destination airport code references on
      // route-truth lines. Codes appear as 3-letter all-caps in the lines.
      if (_homeAirportCode && line.includes(_homeAirportCode)) return true;
      return false;
    };

    // ---- MARQUEE SIGHTS list (continent-by-continent bullets) ----
    // Each bullet starts with "• " + a region tag. Keep the intro paragraph
    // and the closing General-rule paragraph always; filter the bullets.
    const _marqueeBullets = [
      `• Italy — Venice: Doge's Palace + St. Mark's Basilica (book Secret Itineraries tour ahead), gondola ride at golden hour, Rialto market morning, San Giorgio Maggiore campanile for the view. Florence: Uffizi, Accademia (David), Duomo + Brunelleschi dome climb (timed), Boboli Gardens, Ponte Vecchio at sunset. Rome: Vatican Museums + Sistine, Colosseum + Forum, Borghese Gallery (timed-entry mandatory), Trastevere food walk, Pantheon. Milan: Last Supper (book months ahead), Duomo + rooftop, Galleria Vittorio Emanuele.`,
      `• France — Paris: Louvre, Musée d'Orsay, Eiffel Tower (timed), Sainte-Chapelle, Versailles day trip. Provence: Pont du Gard, Avignon Palais des Papes, Les Baux. Nice/Côte d'Azur: Èze village, Cap Ferrat walk, Old Town market.`,
      `• Spain — Barcelona: Sagrada Família + Park Güell + Casa Batlló, La Boqueria, Gothic Quarter. Madrid: Prado, Reina Sofía, Retiro Park, tapas crawl in La Latina. Granada: Alhambra (book MONTHS ahead). Seville: Alcázar + Cathedral + Giralda, flamenco in Triana.`,
      `• UK — London: British Museum, Tate Modern, Westminster Abbey or Tower of London, West End show, afternoon tea. Edinburgh: Castle + Royal Mile + Holyrood + Arthur's Seat.`,
      `• Netherlands — Amsterdam: Rijksmuseum, Van Gogh, Anne Frank House (book exactly 6 weeks ahead at 10:00 release window), canal cruise.`,
      `• Czech — Prague: Castle complex, Old Town Square + astronomical clock, Charles Bridge at dawn, Jewish Quarter.`,
      `• Austria — Vienna: Schloss Schönbrunn, Kunsthistorisches, Stephansdom, coffeehouse ritual (Café Central / Demel). Salzburg: Festung Hohensalzburg, Mirabell, Mozart sites.`,
      `• Switzerland — Zürich: Altstadt walk, lake cruise, Bahnhofstrasse. Lucerne: Chapel Bridge, Mt Pilatus or Rigi excursion. Interlaken: Jungfraujoch (day trip, book ahead). St. Moritz: Muottas Muragl funicular for the view, Segantini Museum.`,
      `• Greece — Athens: Acropolis + Acropolis Museum (book pre-dawn slot), Pláka, National Archaeological Museum. Santorini: Oia sunset, Akrotiri ruins, caldera boat tour.`,
      `• Turkey — Istanbul: Hagia Sophia, Blue Mosque, Topkapı, Grand Bazaar, Bosphorus cruise.`,
      `• US — NYC: Met, MoMA, Statue of Liberty + Ellis Island, Brooklyn Bridge walk, Broadway show. Santa Fe: Georgia O'Keeffe Museum, Canyon Road galleries, Bandelier or Tent Rocks excursion, Plaza + cathedral. New Orleans: French Quarter, Garden District + Lafayette Cemetery, jazz at Preservation Hall.`,
      `• US SOUTHEAST — Greenville, SC: Falls Park on the Reedy + Liberty Bridge (the iconic curved suspension bridge over the falls — unmissable, both daytime and golden-hour), Swamp Rabbit Trail (cycle or e-bike Furman → downtown is the signature local experience), Main Street stroll + GVL Today public art, Greenville Zoo or Roper Mountain Science Center if traveling with kids, day trip to Caesar's Head State Park overlook OR Table Rock for a Blue Ridge view. Asheville, NC: Biltmore Estate (half-day minimum, book ahead), Blue Ridge Parkway scenic drive + Craggy Gardens or Graveyard Fields, River Arts District studio crawl, Grove Park Inn (high tea or sunset terrace), downtown food + craft beer walk. Charleston, SC: Battery + Rainbow Row walk, Magnolia or Middleton Place plantation/garden, carriage tour of the historic district, Fort Sumter ferry, King Street shopping + dinner. Savannah, GA: Forsyth Park, Bonaventure Cemetery, Historic District square walk (22 squares!), River Street, Wormsloe Historic Site oak avenue. Nashville, TN: Country Music Hall of Fame, Ryman Auditorium tour, honky-tonk row on Broadway, Belle Meade / Cheekwood, Grand Ole Opry show. Charlotte, NC: NASCAR Hall of Fame, Bechtler / Mint Museum, US National Whitewater Center, NoDa arts district. Memphis, TN: Graceland, Sun Studio, National Civil Rights Museum, Beale Street.`,
      `• US MOUNTAIN/WEST (non-marquee cities) — Bozeman, MT: Museum of the Rockies + T. rex, Hyalite Canyon hike/snowshoe, Bridger Bowl or Big Sky day trip, downtown Main Street. Jackson, WY: Grand Teton drive (Snake River Overlook, Schwabacher Landing), wildlife safari at dawn, Town Square antler arches, Mangy Moose or Million Dollar Cowboy. Sun Valley, ID: Sun Valley Resort + ice show, Bald Mountain gondola, Ketchum gallery walk, Hemingway's grave. Aspen, CO: Maroon Bells (book shuttle ahead in summer), Aspen Mountain gondola, Aspen Art Museum, downtown stroll + Wheeler Opera House. Vail, CO: Gondola One up Vail Mountain, Betty Ford Alpine Gardens, Vail Village stroll, day trip to Beaver Creek. Telluride, CO: Free gondola to Mountain Village, Bridal Veil Falls hike or drive, historic Main Street.`,
      `• US OTHER — Key West: Mallory Square sunset, Hemingway Home, Duval Street, Dry Tortugas day trip if 3+ nights. Sedona: Cathedral Rock + Bell Rock hikes, pink-jeep tour, Chapel of the Holy Cross, Palatki ruins. Napa/Sonoma: 2–3 winery visits with appointment, Castello di Amorosa or Sterling, Oxbow Public Market, hot-air balloon at dawn. Outer Banks: Wright Brothers National Memorial, Cape Hatteras Lighthouse, Bodie Island, Roanoke Festival Park. Hilton Head: beach day, Harbour Town Lighthouse, Pinckney Island wildlife refuge, Coastal Discovery Museum.`,
      `• CARIBBEAN — Anguilla, St. Barth, Turks & Caicos: the beach IS the marquee — still schedule one anchor experience (Shoal Bay snorkel + lunch, Gustavia harbor walk, Chalk Sound + Smith's Reef). Don't pretend a beach destination has no marquee — plan the signature beach and the signature meal.`,
      `• Japan — Tokyo: Senso-ji, Tsukiji outer market, teamLab, Meiji Shrine, Shibuya crossing + Shinjuku at night. Kyoto: Fushimi Inari at dawn, Kinkaku-ji, Arashiyama bamboo + Iwatayama monkeys, Gion at dusk, kaiseki dinner.`,
    ];
    const _marqueeMatched = _marqueeBullets.filter(_lineMatchesDestination);
    // If we matched any bullets, send only those (typically 1-2 lines). If we
    // matched none — e.g. an obscure destination — fall back to the general
    // rule alone (the model still composes a marquee list from its own
    // knowledge per the General-rule paragraph that follows).
    const _marqueeBlock = _marqueeMatched.length > 0
      ? _marqueeMatched.join("\n")
      : "";

    // ---- ARRIVAL AIRPORT mappings (regional-vs-hub guidance) ----
    // Each line is a single regional airport mapping bullet. Filter to lines
    // mentioning the destination, OR keep none and let the GENERAL RULE carry.
    const _airportLines = [
      `   - Bar Harbor / Acadia, Maine → BHB (15 min, seasonal Cape Air/JetBlue) or BGR (50 min, year-round mainline). NOT BOS (5 h drive) and NOT PWM (3 h drive).`,
      `   - Santa Fe → SAF (15 min, limited) or ABQ (1 h, most options). NOT DEN or DFW.`,
      `   - Taos → TAOS (15 min, limited) or ABQ (2.5 h) or SAF (1.5 h).`,
      `   - Jackson Hole / Grand Teton → JAC (15 min). NOT SLC unless winter weather closure.`,
      `   - Aspen → ASE (15 min) or EGE (1 h 15) or GJT (2 h 30). NOT DEN (4 h drive).`,
      `   - Vail / Beaver Creek → EGE (45 min) or ASE (1 h 30) or DEN (2 h).`,
      `   - Sun Valley → SUN (15 min) or BOI (2 h 30).`,
      `   - Big Sky / Yellowstone → BZN (1 h) or WYS (seasonal) or JAC (south entrance).`,
      `   - Glacier National Park → GPI/FCA (30 min) or MSO (2 h 30).`,
      `   - Napa / Sonoma → STS (Santa Rosa, 45 min from Napa) or OAK (1 h) or SFO (1 h 30). Avoid SJC.`,
      `   - Martha's Vineyard → MVY (10 min) or HYA (ferry + drive) or BOS (3 h+ferry).`,
      `   - Nantucket → ACK (10 min) or HYA (ferry) or BOS (3 h+ferry).`,
      `   - Hamptons / Montauk → HTO (East Hampton, seasonal) or ISP (Long Island MacArthur, 1 h 30) or JFK (2 h 30).`,
      `   - Cape Cod → HYA (Hyannis) or PVC (Provincetown) or BOS (1 h 30–3 h).`,
      `   - Newport, Rhode Island → PVD (45 min) or BOS (1 h 30).`,
      `   - Hilton Head → HHH (15 min) or SAV (45 min). NOT CHS.`,
      `   - Savannah → SAV (15 min). NOT JAX or CHS.`,
      `   - Asheville → AVL (20 min). NOT CLT (2 h 15) and NOT GSP (1 h).`,
      `   - Charleston SC → CHS (20 min).`,
      `   - Key West → EYW (10 min) or MIA (3 h 30).`,
      `   - Park City / Deer Valley → SLC (45 min).`,
      `   - Telluride → TEX (10 min) or MTJ (1 h 15) or GJT (2 h 30) or DEN (6 h+).`,
      `   - Steamboat Springs → HDN (30 min) or DEN (3 h).`,
      `   - Hallstatt → SZG (Salzburg, 1 h 15) or VIE (3 h).`,
      `   - Interlaken → BRN (1 h) or ZRH (2 h) or GVA (2 h 30).`,
      `   - St. Moritz → ZRH (3 h) or MXP (3 h 30) or LUG (2 h).`,
      `   - Zermatt → ZRH (3 h 30 + train) or GVA (3 h 30 + train).`,
      `   - Chamonix → GVA (1 h 15) or LYS (2 h 30).`,
      `   - Reykjavik → KEF (45 min).`,
      `   - Cinque Terre → PSA (1 h) or GOA (1 h 30) or MXP (3 h 30).`,
      `   - Tuscany / Florence → FLR (20 min) or PSA (1 h 30) or BLQ (1 h 30).`,
      `   - Amalfi / Positano → NAP (1 h 15).`,
      `   - Capri → NAP (1 h 30 + ferry).`,
      `   - Sicily → CTA (Catania) or PMO (Palermo).`,
      `   - Mallorca → PMI. Ibiza → IBZ. Mykonos → JMK. Santorini → JTR.`,
    ];
    const _airportMatched = _airportLines.filter(_lineMatchesDestination);
    const _airportBlock = _airportMatched.length > 0 ? _airportMatched.join("\n") + "\n" : "";

    // ---- ROUTE TRUTH (transatlantic / long-haul nonstop guidance) ----
    // Only relevant when flying internationally; for a domestic-US trip,
    // none of these lines match and the block is empty. Otherwise keep
    // lines that mention either the home airport code or any of the
    // destination's airports/regions.
    const _routeLines = [
      `   - EWR ↔ CPH: SAS operates the daily nonstop. United sells the route only as codeshare/connecting (via FRA, MUC, ZRH). Do NOT emit "United nonstop EWR-CPH".`,
      `   - JFK ↔ CPH: SAS and Norse Atlantic. Delta connects.`,
      `   - EWR ↔ ZRH: United and Swiss both operate nonstop daily.`,
      `   - JFK ↔ ZRH: Swiss and Delta operate nonstop.`,
      `   - EWR/JFK ↔ LHR: BA, United (EWR), Virgin Atlantic, American (JFK), Delta (JFK) all run nonstops.`,
      `   - JFK ↔ CDG: Air France, Delta, American operate nonstop.`,
      `   - EWR ↔ CDG: United and Air France nonstop.`,
      `   - EWR/JFK ↔ FRA: Lufthansa, United (EWR), Singapore (JFK via FRA).`,
      `   - JFK ↔ NRT/HND: ANA, JAL, Delta (HND), American (HND).`,
      `   - LAX ↔ NRT/HND: ANA, JAL, Delta, American, United.`,
    ];
    const _routeMatched = _routeLines.filter(_lineMatchesDestination);
    const _routeTruthBlock = _routeMatched.length > 0
      ? `• ROUTE TRUTH — common transatlantic / long-haul nonstops you MUST get right:\n${_routeMatched.join("\n")}\n  If the user's route is NOT in this list and you're unsure, list 2–3 candidate carriers in flags[] and DO NOT invent a single specific carrier.\n`
      : "";

    const _destinationFactsBlock = buildDestinationFactsBlock(basics.destination || (cities[0] && cities[0].name) || "");

    // -------------------------------------------------------------------
    // PROMPT SPLIT FOR ANTHROPIC CACHING.
    //
    // We return TWO strings:
    //   • staticRules    — byte-identical across every build of every trip.
    //                      This is the cache-write target; subsequent builds
    //                      hit cache (~10% of input-token cost). Includes:
    //                        - identity line ("You are a luxury travel
    //                          planner...") so the model still sees role
    //                          FIRST, as system prompts conventionally do
    //                        - the entire general rulebook
    //                        - field emission order (single-city default;
    //                          multi-city emits an explicit hint in the
    //                          dynamic preamble)
    //
    //   • dynamicPreamble — per-trip overrides only:
    //                        - conditional HARD-RULE blocks (train, private
    //                          driver, private tour, skip-the-line). Each
    //                          block is self-contained and reasserts itself
    //                          with HARD RULE language, so position-in-prompt
    //                          is not load-bearing for any individual rule.
    //                        - exact day count for this trip
    //                        - multi-city field-order override + city list
    //                        - destination-specific facts (marquee sights,
    //                          airport mappings, route truth) each labeled
    //                          with the rule they parametrize
    //                        - destination facts block
    //
    // The build call site assembles them as:
    //     [staticRules block (cached)] + [dynamicPreamble block] + user message
    //
    // SAFETY: vs. the original prompt, only the per-trip override blocks
    // (HARD RULES + destination facts + day count) moved from FIRST to AFTER
    // the rulebook. The IDENTITY line is preserved at the start of block 1.
    // The destination-filtered facts each include an explicit pointer back
    // to the rule they parametrize ("schedule each per the MARQUEE SIGHTS
    // rule", "apply per the FLIGHTS rule", etc.).
    // -------------------------------------------------------------------
    // Weekday computation is COMPUTED IN CODE and injected into the per-trip
    // preamble below — the model must NOT recompute. See COMPUTED DATE TABLE.
    const totalDaysLine = `• days[] must contain exactly ${totalDays} entries (arrival day + ${parseInt(basics.nights,10)||3} full nights). Use the COMPUTED DATE TABLE for every day's weekday and date.`;

    const staticRules = `You are a luxury travel planner. Call the submit_trip_plan tool exactly once with the finalized plan. Do not emit any prose — only the tool call.

FIELD EMISSION ORDER — CRITICAL:
Write the tool input in this exact order: destination, meta, days, logistics, flags, planb, snobs, tonight. (Multi-city trips also emit a cities[] field — see the per-trip preamble below for placement.)
days[] is the main deliverable. Write the entire days[] array BEFORE writing logistics, flags, planb, snobs, or tonight. Never write logistics/flags/planb first and then days — if anything gets cut off, we lose the whole plan. Always write days first.

TRIP REQUIREMENTS:
• The exact required day count for this trip is given in the per-trip preamble below. Use the COMPUTED DATE TABLE for every day's weekday and date — do not compute weekdays yourself.
• Each day MUST include: label, headline (the one-line "if you only do one thing" call), weather (seasonal expectation, NOT a live forecast), and items[].
• Each day's items[] needs at least 3 items — a typical full day is: morning Activity, midday Activity, evening Dinner. Arrival/departure days also include Flight + Hotel.
• DAY-SCOPED REQUESTS — HONOR LITERALLY (overrides the pacing default for the named day only): If the traveler specifies how many activities a SPECIFIC day should have (e.g. "one activity on Tuesday", "just one thing on Day 3", "keep the 14th light", "only golf on Saturday"), that count applies to THAT DAY ALONE. Do NOT propagate it to other days and do NOT back-fill the rest of the trip to match it. Days the traveler did not constrain keep the normal pacing for the stated Pace setting. On a day the traveler asked to keep light, the "at least 3 items" guideline YIELDS: that day may legitimately be just one Activity + Dinner (and Flight/Hotel on arrival/departure days). Never inflate a deliberately light day back up to hit the item minimum, and never spread one day's requested activity across every day.
• TRIP-TOTAL REQUESTS — HONOR LITERALLY AS A WHOLE-TRIP CAP (overrides the per-day pacing default for every day): If the traveler specifies how many activities the ENTIRE TRIP should have (e.g. "2 activities for the trip", "just 3 things total", "only 2 activities the whole stay", "keep it to 4 activities across the week", "minimal — one activity per couple of days"), that count is the SUM across all days, NOT a per-day target. Do NOT multiply it by the day count. Do NOT schedule one activity on every day to satisfy a trip-total ask. Place those N activities on the N most appropriate days (using the same "single most appropriate day" logic as the activities POOL) and leave the other days with NO Activity items — those days are legitimately just morning ambiance + Dinner (plus Flight/Hotel on arrival/departure days), and the "at least 3 items" guideline YIELDS for them the same way it yields on a day-scoped light day. Never spread a trip-total of N activities across more than N days, and never inflate the unconstrained days back to a full pacing default to compensate — a trip-total cap means the traveler explicitly chose a quieter trip.
• EVERY item in items[] MUST have a "time" field (24h local time, e.g. '08:30', '14:00', '19:30'). Items should appear in chronological order within each day. This is what turns the day into a real time-based itinerary instead of a vague list.
• Use realistic times: dinner 19:00–20:30, breakfast 07:30–09:00, lunch 12:00–13:30 (only when explicitly asked — see MEAL POLICY below). Activities sized to their duration (museum 2h, hike 3–4h, gallery walk 90min). Add end_time when helpful.
• TIME FORMAT IN PROSE: The structured "time"/"end_time" fields stay 24h as specified above — the app converts them for display. But in all human-readable prose you write (headlines, why-blurbs, notes, confirmation_notes, flags, tonight, and any recommended/arrival/pickup time mentioned in text), write clock times in 12-hour AM/PM format (e.g. "7:00 PM", never "19:00"). Never use 24-hour/military time in prose.

MEAL POLICY — STRICT, OPT-IN ONLY FOR BREAKFAST & LUNCH (POST-PROCESSED):
*** CRITICAL: LUNCH IS A HARD EXCLUSION BY DEFAULT. Same severity as breakfast.
*** The traveler has explicitly added LUNCH to the meal-exclusion list. Treat
*** "don't plan lunch" with the same weight as "don't plan breakfast" — they
*** are co-equal exclusions. Any Lunch item in your output without an explicit
*** named ask ("lunch at Atardi", "book lunch Day 3") will be removed by the
*** post-processor and counted as a defect. DO NOT EMIT LUNCH ITEMS.
*** Activities that span the noon window (e.g. 09:00–14:00 catamaran with food
*** included, or a wine tasting that includes a small plate) are fine as
*** Activity items — but DO NOT add a separate Lunch item alongside them.

• NOTE: The renderer runs a structural strip after you respond. Any Breakfast / Brunch / Lunch item you emit without the user explicitly asking for it WILL BE DELETED from the final output. Emitting them anyway just wastes tokens and produces a worse-looking review log. Don't.
• DINNER: Plan a Dinner item for every night the traveler is at the destination (including arrival night). This is the default and required. EVERY Dinner MUST include a same-tier backup restaurant in the same neighborhood/cuisine family — no exceptions. A Dinner without restaurant.backup will be flagged as a defect.
• BREAKFAST & LUNCH: DO NOT emit Breakfast / Brunch / Lunch items unless the user EXPLICITLY asked for them. Most travelers handle these themselves (hotel breakfast included with the room, beach club, casual on-the-fly, dietary preferences) and pre-planned mid-day reservations cut into activity time.
• An explicit ask means: a specific named meal/place in narrative or guidelines (e.g. "breakfast at X", "lunch at Y", "brunch on Sunday"), a hard time block ("book a lunch reservation Day 3"), or the dining preferences explicitly named breakfast/lunch focus. "Casual lunches" / "light breakfasts" as a general note is NOT an explicit ask.
• If the user named a SPECIFIC restaurant for breakfast or lunch, include it exactly as stated. If not, omit those slots entirely — the day flows Activity → Activity → Dinner.
• Hotel breakfast (included with room rate) does NOT count as a planned meal. Do not emit a Breakfast item for it.
• Activity items can still span breakfast/lunch windows (e.g. a 09:00–12:30 excursion). That's the traveler's signal to grab food on their own.
• For Activity items, fill "location" with a specific venue or address.
• For Transport items between activities, the "text" should include estimated drive/walk time (e.g. 'Drive to Abiquiú — 1h 15min via US-84').

 ACTIVITY CONTACT INFO — REQUIRED, NON-NEGOTIABLE:
Every Activity item MUST include a "contact" object with AT LEAST one of {phone, website, booking_url}. Activities without any way to call or book are unusable to the traveler — they have no way to confirm hours or reserve. Strongly prefer including ALL of:
   • contact.phone — in tappable format with country code: '+1-505-988-3236' (US), '+41 44 422 25 20' (CH), '+39 06 6988 1662' (IT).
   • contact.website — official site for the venue/tour.
   • contact.booking_url — only when there's a real online-booking page (Viator/GetYourGuide/timed-entry ticket site). Do not invent URLs.
   • contact.address — full street address.
   • contact.hours — operating hours for the visit window, with closed-days flagged.
   • contact.price — per-person cost.
   • contact.booking_note — e.g. 'Book 7+ days ahead', 'Free — no reservation', 'Members-only, bring NMA card'.
Also add "why" — a 1–2 sentence opinionated reason this activity is on the trip (mirrors restaurant.why). Phone numbers and websites for major museums, tours, and attractions are well-known public information — use them. Do NOT fabricate. If you genuinely don't know the phone for a specific venue, provide the website only.

VARIETY RULES — STRICT, NON-NEGOTIABLE:
• Each unique restaurant name MUST appear AT MOST ONCE across ALL days. Before emitting any restaurant, mentally check: have I already used this name on an earlier day? If yes, pick a different one. The same name for breakfast Day 2 AND breakfast Day 4 is a violation. The same name for dinner Day 1 AND lunch Day 2 is a violation.
• The hotel's in-house restaurant counts as a restaurant. It may appear AT MOST ONCE across the entire trip. For other breakfasts, pick named local spots (e.g. Tia Sophia's, Café Pasqual's, Clafoutis) — never default to the hotel restaurant.
• If the user asked for a specific cuisine focus, give each day a different EXPRESSION of that cuisine: a market café, an institution, a chef-driven spot, a wine bar, a hole-in-the-wall.
• Never repeat the same activity venue across days. Vary neighborhoods — Plaza one day, Railyard another, Tesuque another.

MARQUEE SIGHTS — NEVER ASSUME, ALWAYS SCHEDULE:
Every destination has 2–6 marquee sights that any luxury traveler will expect to see. You MUST explicitly schedule each one as a dedicated Activity item with a specific day, time slot, and (when ticketed) booking detail. Do NOT mention them only in passing in a headline or snobs entry. If a marquee sight is intentionally skipped (e.g. the user already saw it on a previous trip, or the dates exclude it), say so explicitly in flags[]. The destination-specific marquee list (when one is on file for this trip's destination) is in the per-trip preamble below.

General rule: if your destination is not in the per-trip marquee list, generate the equivalent "top 4–6 marquee experiences any first-time visitor would expect" list mentally and schedule each one. If the user gave fewer nights than needed to cover all marquees, surface the gap in flags[].

BESPOKE LOCAL SERVICES — RESEARCH PER DESTINATION, DO NOT DEFAULT TO GLOBAL BRANDS:
For private/specialty services (wine tastings, private drivers, sommelier-led dinners, fishing charters, photography guides, private chefs, helicopter tours, sailing day-charters, golf caddies, fly-fishing guides, e-bike outfitters, off-roading, ranch experiences, ski-guide / mountain-host service, spa specialists, etc.) you MUST name a service that actually operates in THIS destination. Default brands fail outside their footprints: Blacklane doesn't serve most leisure destinations; Cinq à Sept doesn't exist in mountain towns; ToursByLocals coverage is uneven; chef's-table experiences vary by city.
• SOURCES TO MENTALLY CONSULT BEFORE NAMING AN OPERATOR: TripAdvisor "Things to Do" top-10 + Traveler Reviews for the specific town, Reddit (r/<destination>, r/travel, r/<region>) for under-the-radar locals' picks, Condé Nast Traveler Gold List / Reader's Choice for the destination, NYT 36 Hours columns, the official tourism board's licensed-operator directory, and the hotel concierge partner list. The right operator is usually a 5–40-person local outfit, not a global aggregator.
• WINE TASTINGS — by region: Napa/Sonoma (named wineries with appointment-only tasting rooms like Promontory, Continuum, Larkmead; or a private wine tour with Beau Wine Tours / Pure Luxury), Willamette (Domaine Drouhin, Cristom, Beaux Frères appointments), Finger Lakes (Hermann J. Wiemer, Boundary Breaks), Tuscany (a Chianti Classico day with a private driver-guide — Tuscan Wine Tours, Castello di Ama appointment, Antinori Bargino), Piedmont (private cellar visits at Vietti, G.D. Vajra, Roagna), Burgundy (DRC waitlist, Domaine Comte de Vogüé, or a tour with Burgundy Discovery / Authentica Tours), Champagne (Krug, Salon, Selosse private tastings via a recommandation-only intermediary), Douro (Quinta do Crasto, Quinta do Vallado), South Africa (Stellenbosch — Boschendal, Delaire Graff). Name the winery AND name a credible booking path (concierge, the winery's website, or a named private tour operator), with lead time.
• PRIVATE DRIVERS by region: see PRIVATE DRIVER block. For obscure destinations: hotel concierge is the right booking path, NOT Uber Black (which has thin coverage in leisure towns) and NOT a hallucinated company name.
• PRIVATE GUIDES by region: Context Travel for cerebral cultural tours in Europe/major US, Walks (Walks of Italy, Walks of NY) for marquee-sight skip-the-line privates, Through Eternity (Rome/Florence), ToursByLocals as a marketplace (vet the specific guide's reviews), licensed local guide bureau (e.g. "Associazione Guide Turistiche Firenze"), or a chef-led food walk (Eating Europe, Devour Tours, Secret Food Tours). For US destinations look for local certifications: Aspen Center for Environmental Studies for naturalist tours, Sun Valley Heli for backcountry, Park City Mountain ski hosts.
• HIDDEN GEMS — ADD THESE TO snobs[] (the section travelers love most): the under-the-radar trattoria the locals lunch at, the gallery the doormen send their guests to, the bakery that sells out by 9 a.m., the cocktail bar that doesn't take reservations, the natural-wine list the somms in town drink off. These are exactly the items Reddit / TripAdvisor / local-newsletter sources surface that a generic itinerary misses. Each snobs[] entry should be specific (named venue + the move) and not duplicate the marquee schedule.
• CONFIDENCE FLOOR: if you cannot name a specific operator with confidence, do NOT invent one. Write "Concierge to book — verify operator" or "Ask <hotel name> concierge: ‘Who do you use for <service> in <town>?’" and surface it in flags[] as a pre-arrival task. Travelers prefer an honest open question to a fake company name they can't actually book.

PACING & ENERGY BUDGET — PROTECT THE TRAVELER FROM EXHAUSTION:
A day is a finite resource. Same-day overload is the most common failure mode of an over-eager itinerary. Apply these rules:
• ARRIVAL DAY (any day where a Flight or long Transport lands the traveler), categorize by arrival time:
  – Morning arrival (06:00–12:00): one light afternoon activity + early dinner (18:30–20:00). No dinner reservation at a marquee restaurant on Day 1 — they're jet-lagged and won't enjoy it.
  – Afternoon arrival (12:00–18:00): hotel check-in + neighborhood orientation walk + casual dinner near the hotel.
  – Evening arrival (18:00–23:00): hotel check-in + room service or a casual walk-in spot within 10 minutes of the hotel. NO reservations.
  – Red-eye / overnight arrival (23:00–05:00 local OR a flight whose origin departure was ≥6h before arrival on the same calendar day): the traveler has been awake 18–24+ hours. Day 1 is RECOVERY — hotel sleep until midday at minimum, then one light activity, then early dinner at a casual hotel-adjacent spot. ABSOLUTELY NO 20:00 marquee-restaurant reservation on a red-eye arrival day. If pacing.note says "easy arrival, settle in," the dinner item MUST reflect that.
• SAME-DAY OVERLOAD: A single day must not contain MORE THAN ONE of the following high-intensity blocks: (a) full-day excursion (>4 hours, e.g. wine country day, mountain day trip, Versailles, Pompeii day), (b) marquee 2–3 hour ticketed sight with private guide, (c) tasting menu / 3-hour anchor dinner at a fine-dining institution. If you schedule a 5-hour wine-country day and then an 8 PM Michelin-starred tasting menu the same evening, that's a violation — either downgrade the dinner to a casual spot OR move the tasting to a recovery day.
• BACK-TO-BACK INTENSITY: After any full-day excursion or red-eye arrival, the NEXT day should start no earlier than 09:30 and have a lighter midday block. After three consecutive high-intensity days, schedule a deliberate "breathing day" with one signature activity and otherwise free time.
• NIGHTS-PER-CITY BALANCE: For a marquee destination, MINIMUM nights:
  – Venice: 3 nights (2 is rushed once you account for the marquee list — Doge's Palace + Basilica + gondola + Rialto + at least one quiet morning before the day-trippers arrive). 2 nights is acceptable ONLY as part of a longer Italy trip where Venice is the bookend, and you MUST flag the compression.
  – Rome, Florence, Paris, London, Barcelona, Madrid, Vienna, Prague, Amsterdam, Tokyo, Kyoto: 3 nights minimum.
  – NYC, Istanbul, Athens (city only): 2–3 nights minimum.
  – Santorini, Capri, Hallstatt, Cinque Terre, Aspen, Vail, Sun Valley, Park City: 2 nights minimum.
  If the user gave fewer nights than the minimum for any marquee city, add a flags[] entry surfacing the gap ("2 Venice nights is tight — you'll see St. Mark's but skip the Lido and a leisurely morning. Consider adding 1 night.") and structure the days to prioritize the absolute must-sees.

CHECKOUT-DAY LOGISTICS — ALWAYS EXPLICIT, NEVER ASSUMED:
The morning a traveler changes hotels or cities is the highest-friction moment of the entire trip. Handle it explicitly:
• Every checkout day must have a Transport or Note item at the top describing HOW luggage moves: "Bellhop loads luggage into Mercedes V-Class at 09:30; depart 10:00 for Florence." Name the actual local operator (or "concierge-arranged car") — do NOT default to Blacklane in cities Blacklane doesn't serve. Don't leave the user to figure out the bag mechanics.
• VENICE arrivals/departures are special — there are NO cars and the canals are the only path. Spell out: water taxi from Piazzale Roma or Santa Lucia station to the hotel's private dock (Gritti Palace, Aman Venice, Cipriani all have private docks). Name a reputable water-taxi operator (e.g. Venezia Taxi, Consorzio Motoscafi Venezia) and budget €120–180 for a private water taxi from the airport, €70–100 from Piazzale Roma. If luggage is heavy, advise sending it ahead via the concierge service.
• SANTORINI, CAPRI, AMALFI, CINQUE TERRE — also handle the ferry/water/staircase logistics. Capri requires a porter (la portineria) for any luggage above 1 small case; the streets are too steep and narrow for self-haul.
• HOTEL CHECKOUT TIME (typically 11:00–12:00) constrains how early you can leave. If you need to depart earlier, the Activity item must include "Request 09:00 late checkout in advance" or specify "Hotel will hold luggage at concierge until your evening pickup."
• AIRPORT DEPARTURE on the last day: arrival at the airport 2.5–3 hours before international, 1.5–2 hours before domestic. The latest morning activity is constrained by the airport-arrival buffer for that flight; schedule the last activity to END at least 30 minutes before the airport-arrival buffer kicks in.

LONG-HAUL FLIGHT UPGRADES — SURFACE THE OPTIONS:
For any Flight item whose duration exceeds 6 hours OR whose cabin is Economy on a long-haul route, the confirmation_note MUST mention the upgrade path:
• If the carrier is United and the flight is transatlantic/transpacific: "Polaris (business) upgrade available with miles (typically 60–85K MileagePlus one-way) or paid up; PlusPoints if the traveler is 1K-status."
• If American: Flagship Business via AAdvantage miles (~57–85K).
• If Delta: Delta One via SkyMiles (variable; check Delta's flexible award pricing).
• If SAS: SAS Business via EuroBonus (~70K) or cash bid-for-upgrade.
• If Lufthansa/Swiss/Austrian: Business via Miles & More (~80K one-way Europe→US).
• If BA: Club Suite via Avios (~75K one-way + cash surcharge).
• If the user's cabin preference is already Business/First, instead mention: lounge access (Polaris/Flagship/SkyClub/Centurion if Amex), priority boarding, and luggage allowance.
Add a flags[] entry: "Long-haul upgrade: <carrier> <route> typically opens upgrade space 14 days out. Check at booking and again 5 days before departure."

FLIGHTS — ACCURACY OVER SPECIFICITY, PREFER NONSTOP, ALWAYS STRUCTURED:
• Every Flight item MUST include a "flight" object with: carrier, from_airport (IATA), to_airport (IATA), depart_time (rough window OK), arrive_time (rough window OK), duration, nonstop (boolean), cabin, aircraft, confirmation_note, airport_arrival_buffer, lounge_access. Include flight_number only when the user explicitly named one in their narrative or guidelines (see the FLIGHT NUMBERS rule below).
• AIRPORT ARRIVAL BUFFER — REQUIRED on every departure-day Flight item (the flight that takes the traveler HOME or to a connecting onward city). Standard buffers: domestic US '1.5 h', international '2.5 h', and THREE HOURS '3 h' for any flight DEPARTING from a US PRE-CLEARANCE airport — these are AUA (Aruba), NAS (Bahamas/Nassau), FPO (Bahamas/Freeport), BDA (Bermuda), DUB and SNN (Ireland), YUL/YVR/YYZ/YOW/YHZ/YWG/YYC and other major Canadian airports, AUH (Abu Dhabi). Pre-clearance means the traveler clears US Customs IN THE DEPARTURE COUNTRY before boarding — the process takes time. When you set a 3-h buffer, also add a flags[] entry naming the pre-clearance reason and add a departure-day Transport item that picks the traveler up from the hotel EARLY enough to clear it (typically 3.5 h before scheduled departure to allow for taxi/drive time).
• LOUNGE ACCESS — surface available lounges on EVERY Flight item via the lounge_access[] array. Include lounges accessible via the traveler's cabin (Polaris/Flagship Business/First/Delta One), via elite status (United 1K/Star Alliance Gold/oneworld Sapphire/SkyTeam Elite Plus), and via membership cards (Priority Pass, Amex Centurion / Plat with same-day boarding pass, Capital One Lounge, Chase Sapphire Reserve). If a lounge's access list is ambiguous, include it with an honest 'access' string ('Priority Pass; verify current card partner list') rather than omitting it.
• LOUNGE ORDERING — ORDER lounges by PROXIMITY TO THE LIKELY DEPARTURE GATE for this carrier+route, NOT by prestige. The lounge closest to the gate goes first. Mainline US carriers tend to use the same concourse range repeatedly (UA at EWR uses C70-C90, DL at JFK uses T4 Concourse B, etc.). Use that mapping to set the lounge_access[].terminal and gate_proximity fields. Examples: a Polaris/UA flight from EWR → list United Polaris Lounge FIRST with terminal='Terminal C, near gates C70-C90' and gate_proximity='Closest to most UA international gates'; Amex Centurion at EWR is in Terminal C too but FURTHER, so list it second with gate_proximity='Same terminal but C100s end — ~10 min walk from C70s.' A traveler with Centurion access flying out of JFK T4 should see Centurion FIRST (Concourse B, near gate B30) because it's in T4 — don't list a T8 oneworld lounge as primary.
• If you DON'T know the carrier's specific gate range at this airport, set gate_proximity to a HONEST string like 'Same terminal as the gate' or 'Different terminal — only worth a visit with 2+ hours to kill' rather than inventing precise gate numbers. The terminal field should always be set when known.
• Common high-value lounges to know with terminal locations: EWR Polaris (Terminal C, post-security, near gates C70-C90), EWR Amex Centurion (Terminal C, near gate C102 — farther from most UA intl gates), JFK Centurion (Terminal 4, Concourse B mezzanine near gate B30), JFK Delta Sky Club T4 (post-security, multiple locations), LAX Amex Centurion (Tom Bradley intl T-B, post-security level 3) + LAX United Polaris (Terminal 7, near gates 70-79) + Korean Air SKYPASS (Terminal B / TBIT), ORD United Polaris (Terminal 1 C-concourse, near gate C18) + United Club + Amex Centurion (Terminal 3 H/K, near gate K17), ATL Delta Sky Club + Amex Centurion (Concourse F intl terminal), MIA Amex Centurion (Concourse D, near gate D12) + Centurion Studio (Concourse E). International: LHR Concorde Room (Terminal 5 A-gates, post-security — BA First only), CDG Air France La Première (Terminal 2E, satellite K), FCO Casa ITA (Terminal 3 intl), ZRH Swiss First (Terminal A, post-security), AUA Aruba Airport Lounge (Priority Pass, US Departures terminal, post-pre-clearance — the only lounge once you're past US Customs).
• CARRIER SELECTION — DO THIS FIRST: name a carrier you are HIGHLY CONFIDENT actually operates a nonstop on this exact city pair. If you cannot name one with confidence, leave carrier as a comma-separated short list of candidates (e.g. "SAS or Delta") and add a flags[] entry like "Verify which carrier operates nonstop — candidates: SAS, Delta". Do NOT invent a carrier that doesn't fly the route.
• FLIGHT NUMBERS — ONLY EMIT WHEN THE USER GAVE YOU ONE, AND WHEN THEY DID, EMIT IT ALWAYS. If the user's narrative or guidelines literally name a flight number ("flight 1040", "UA1039", "on United 47", "depart on 1040", "return on 1039"), you MUST:
  1. Set flight_number to the exact digits the user stated (e.g. "1040"). That is a USER FACT and must be preserved on every Flight item that matches the direction (outbound number on outbound leg, return number on return leg).
  2. Still emit depart_time and arrive_time as realistic windows for that route. The app verifies these against a live flight-status service at render time, so a reasonable estimate is fine — it will be replaced with canonical data.
  3. Still emit carrier. If the user gave "flight 1040" without an airline, infer the most likely carrier for that route + number combination (e.g. for EWR—AUA, 1040 likely = United UA1040; for JFK—AUA, 1040 likely = JetBlue B61040).
Otherwise, when the user did NOT state a number, set "flight_number": null. Do NOT invent numbers — they will be stripped. The app handles look-up for the unstated case.
• Route-specific carrier truth (when on file for this trip's route) appears in the per-trip preamble below — follow it strictly.
• Every confirmation_note MUST literally end with this exact sentence: "Verify flight number, times and equipment at booking — schedules change." Copy it verbatim; do not paraphrase.
• WRONG confirmation_note: "Book directly on united.com for Polaris lounge access at EWR Terminal C"
• RIGHT confirmation_note: "Book directly on united.com for Polaris lounge access at EWR Terminal C. Verify flight number, times and equipment at booking — schedules change."
• Search for nonstop service from the home airport to the destination's primary airport first.
• ARRIVAL AIRPORT — PICK THE CLOSEST VIABLE ONE, NOT THE NEAREST MAJOR HUB. For destinations with smaller regional airports, the right answer is the regional, not the metro hub the model knows best. Destination-specific airport mappings (when on file for this trip) appear in the per-trip preamble below.
  GENERAL RULE: when a regional airport with scheduled passenger service exists within ~1 h of the destination, prefer it over a metro hub 2–5 h away even if the hub has more flight options. Long drives erode trip time; users prefer one short drive over a savings of a couple connecting flights.
• If no nonstop exists to the requested airport but one exists to a nearby airport in the same metro (e.g., ABQ ~60min from Santa Fe instead of SAF), RECOMMEND THE NONSTOP and add a flags[] note mentioning the drive time.
• Only return a connecting itinerary if no nonstop exists to any reasonable nearby airport. Set nonstop=false and fill "connection" with the connecting airport IATA.
• In each Flight item's text, explicitly state "nonstop" or "connecting via X".
• If the user's preferred airline doesn't fly nonstop but a competitor does, mention the competitor nonstop in flags[] AND use the competitor as the carrier — do not falsely claim the preferred airline operates a nonstop it doesn't actually fly.

HOTEL ITEMS:
• Use a Hotel-type item on arrival day (check-in) and departure day (check-out). Populate the "hotel" object with name, address, phone (formatted, tappable), check_in_time, check_out_time, room_type, website, confirmation_note. For website: include the property's official site URL only when you genuinely know it (e.g. https://www.fourseasons.com/...) — it powers the "Website ↗" button on the hotel card next to Maps/Call. Do NOT fabricate URLs; omit if uncertain. A confirmation pass fills in missing hotel websites where possible.
• The phone field is critical — it becomes a tappable "Call hotel" CTA in the app.

RESTAURANTS:
• Every Dinner/Lunch/Breakfast/Brunch item should include the full restaurant object: name, neighborhood, cuisine, price_range, why, closure_note, open_days, hours_note, reservation, contact, backup, verify_status, verify_url. verify_status and verify_url are MANDATORY — do not omit them. verify_url should be the canonical Google Maps search URL (https://www.google.com/maps/search/?api=1&query=<URL-encoded restaurant name + city>) when no better source exists, or the restaurant's own website / OpenTable / Resy listing when you know it.
• DO NOT emit the 'menu' field. Menus are lazy-fetched via /api/menu when the user taps View Menu on a card. Leaving menu out frees up thousands of tokens per build for richer why-blurbs, hours, reservation notes, and insider tips on everything else. This is mandatory for multi-day trips — emitting full menus inline can blow the token budget before the trip finishes.
• OPEN_DAYS — POPULATE WHEN KNOWN: When you know a restaurant's open-day pattern, populate open_days with lowercase 3-letter codes (e.g. ['wed','thu','fri','sat','sun'] for Closed Mon-Tue). The post-build verifier cross-checks against Google Places' authoritative hours and flags CLOSED_ON_THIS_DAY when the scheduled weekday doesn't match. open_days is your best-effort signal; the verifier is the source of truth.
• hours_note: short human-readable summary like 'Mon–Sat 5–9pm' when you know it. Omit if not sure.
• If you genuinely do NOT know a restaurant's open_days, omit the field entirely (do not guess). The renderer treats missing open_days as 'assume open' rather than 'closed every day', but you should set closure_note to 'Confirm hours — closure day uncertain' as a safety hint to the traveler.
• Many fine-dining spots close Mon or Tue. If you're unsure of a closure day, put "Confirm hours — closure day uncertain" in closure_note. The post-build hours check catches real closure-day misses; this is just a quality signal.
• Always include a same-tier backup in the same neighborhood / cuisine family. Populate open_days on the backup too when you know it — the verifier checks both.
• reservation.platform: opentable for most US/UK/EU fine dining; resy for trendy NYC/LA/Miami; tock for tasting menus; phone with a phone number for hole-in-the-walls; walkin if no reservations. Include the canonical url when you know it. (A server-side pass grounds platform + url on the actual current booking system after the build, so honest best-guess is fine — just don't fabricate URLs.) IMPORTANT: many famous restaurant names are reused across cities (there is a Per Se in New York AND a Per Se Social Corner in Vancouver; a Carbone in NYC, Miami, Las Vegas, and Dallas; a Le Bernardin in NYC AND a Le Bernardin in Paris). If you're not 100% certain a specific reservation.url points to the venue IN THIS CITY, omit reservation.url entirely — the app will build a safe platform search URL from reservation.platform. A wrong-city URL is worse than no URL.
• contact.website: include the restaurant's official site URL when you genuinely know it (e.g. https://thecompoundrestaurant.com). The website button is rendered next to Reserve so travelers can see menus, photos, and verify hours directly. Do NOT fabricate URLs — omit the field if uncertain. A separate confirmation pass fills in missing websites where possible.
• The 'menu' field on the restaurant schema is reserved for legacy use. DO NOT populate it for new builds — the View Menu button on every card lazy-fetches it from /api/menu, which is grounded on the restaurant's actual current offerings. Emitting menus inline wastes ~500 tokens per restaurant and adds 30-60 seconds to multi-day builds.

• RESTAURANT FRESHNESS — POST-BUILD VERIFIED:
  A post-build pass validates every venue against Google Places (New).
  Permanently-closed, temporarily-closed, hallucinated, and wrong-city
  venues are AUTOMATICALLY DROPPED from the plan before render.
  Phone, hours, address, and website are OVERWRITTEN with Places values
  on verified venues. The pre-export gate refuses to render a PDF that
  still contains any block-severity verification flag.
  Your job: recommend restaurants you believe are real and currently
  operating, and produce a same-tier backup for each. The verifier is
  the safety net; it lets you focus on creative direction rather than
  defensive guessing.
  — Prefer institutions with multi-year track records over fresh
    openings when you have a choice.
  — Keep populating verify_status ("confirmed_operating" or
    "verify_before_booking") and verify_url. These drive UI badges;
    the verifier overrides them when ground truth differs.
  — backup is required: must be a DIFFERENT operator (not a sister
    restaurant).

LOGISTICS chips:
• Short chips only — max 6, each ≤40 chars. Top-line facts only (airline summary, hotel name, car). DO NOT write sentences here. The full plan goes in days[].

WEATHER WINDOW (top-level):
• 1–2 sentences on the SEASONAL pattern for the destination during these dates. Include any planning-relevant pattern (monsoon afternoons, midday heat, fog, ski conditions, etc.). NEVER claim a live forecast.

PACK (top-level):
• 4–8 non-obvious essentials specific to this destination/season (altitude meds, layers, cash for cash-only spots, sun protection, charging adapters for region). Skip obvious items.

PLAN B (top-level, ≥5 entries):
• Cover: weather/rain, sold-out marquee restaurant, closed-day activity substitute, transport disruption (canceled flight or rental car issue), health/altitude/illness day, and any destination-specific risk.

TONIGHT (top-level):
• Prefix each action: '⚠︎ Must today:' for things that lose value if delayed (sold-out restaurants, advance-only tours), '· This week:' for important but flexible, 'Anytime:' for low-urgency. Order most-urgent first.

TONE: Insider, opinionated, specific. Real names, real dishes, real neighborhood detail. Avoid travel-blog vagueness.`;

    // ---- DYNAMIC PER-TRIP PREAMBLE ----------------------------------
    // Identity + every conditional constraint block + destination facts +
    // exact day count + multi-city structure + destination-filtered
    // marquee/airport/route facts. Compact (~2–10k chars depending on
    // options). Sent uncached as the second system block.
    const _marqueePreamble = _marqueeBlock
      ? `\nDESTINATION-SPECIFIC MARQUEE SIGHTS for this trip (schedule each as a dedicated Activity item per the MARQUEE SIGHTS rule):\n${_marqueeBlock}\n`
      : "";
    const _airportPreamble = _airportBlock
      ? `\nDESTINATION-SPECIFIC ARRIVAL AIRPORTS for this trip (apply per the ARRIVAL AIRPORT rule):\n${_airportBlock}`
      : "";
    const _routePreamble = _routeTruthBlock
      ? `\nDESTINATION-SPECIFIC ROUTE TRUTH for this trip (apply per the FLIGHTS rule):\n${_routeTruthBlock}`
      : "";
    const _multiCityFieldOrder = isMultiCity
      ? `\nFIELD EMISSION ORDER OVERRIDE — MULTI-CITY: this is a multi-city trip. Insert a cities[] field between meta and days in the tool input, so the order becomes: destination, meta, cities, days, logistics, flags, planb, snobs, tonight.`
      : "";

    // Activity-count hard cap. Deterministic classifier scans the
    // narrative + guidelines for phrasings the static TRIP-TOTAL
    // REQUESTS rule (above) might miss. When detected, inject a
    // machine-readable hard cap so the model has zero room to default
    // to per-day pacing. Closes the recurrence reported 2026-06-30 PM
    // ("one activity during the entire itinerary" → model gave one
    // per day). Post-build enforcement in applyQualityLayer is the
    // suspenders.
    const _activityCountConstraint = classifyActivityCountConstraint({ narrative, guidelines });
    const _activityCountRuleBlock = renderActivityCountPromptRule(_activityCountConstraint) || "";

    const dynamicPreamble = `PER-TRIP REQUIREMENTS (these are the trip-specific values + overrides referenced by the static rulebook above — follow them strictly):${trainRuleBlock}${privateDriverBlock}${privateTourBlock}${skipTheLineBlock}${_activityCountRuleBlock}
${_destinationFactsBlock}

${totalDaysLine}${_multiCityFieldOrder}${multiCityBlock}${_marqueePreamble}${_airportPreamble}${_routePreamble}`;

    return { staticRules, dynamicPreamble };
  };

  const buildUserPrompt = () => {
    const active = Object.entries(outputs).filter(([, v]) => v).map(([k]) => k).join(", ");
    const cityLine = isMultiCity
      ? `Route: ${cities.map((c, i) => `${i + 1}) ${c.name} — ${c.nights} nights`).join("  →  ")}`
      : `Destination: ${basics.destination}`;
    // Train is OFF unless the user explicitly selected "Train / rail" in the
    // ground-transport multi-select. The model must not invent an Amtrak /
    // rail segment when the user picked rental car, private driver, or
    // nothing at all — even if the destination has good rail service.
    const trainAllowed = Array.isArray(transport.type) && transport.type.some(t => /train|rail/i.test(t));
    // Mirror the system-prompt detectors so we can echo the explicit ask in the
    // user message too — surfacing it twice prevents it from being drowned out
    // by other constraints (especially the long NO-TRAINS block).
    const userWantsPrivateDriver =
      (Array.isArray(transport.type) && transport.type.some(t => /private\s*driver|chauffeur/i.test(t))) ||
      (Array.isArray(activities) && activities.some(a => /private driver/i.test(a))) ||
      /\b(private driver|chauffeur|car service|black car)\b/i.test(interests?.text || "") ||
      /\b(private driver|chauffeur|car service|black car)\b/i.test(narrative || "") ||
      /\b(private driver|chauffeur|car service|black car)\b/i.test(guidelines || "");
    const _userTourRe = /\bprivate\b.*\b(tour|guide|walking)\b|\bVIP\b/i;
    const userWantsPrivateTour =
      (Array.isArray(activities) && activities.some(a => _userTourRe.test(a) && !/private driver/i.test(a))) ||
      _userTourRe.test(interests?.text || "") ||
      _userTourRe.test(narrative || "") ||
      _userTourRe.test(guidelines || "") ||
      (Array.isArray(basics.style) && basics.style.some(s => /\bVIP\b|\bprivate\b/i.test(s)));
    const _userStlRe = /skip[- ]the[- ]line|timed[- ]entry|fast[- ]track|priority entry/i;
    const userWantsSkipTheLine =
      (Array.isArray(activities) && activities.some(a => _userStlRe.test(a))) ||
      _userStlRe.test(interests?.text || "") ||
      _userStlRe.test(narrative || "") ||
      _userStlRe.test(guidelines || "");
    const groundModeText = trainAllowed
      ? "driving or train (user opted into rail)"
      : "driving only — NO trains, NO rail, NO Amtrak under any circumstances";
    // COMPUTED DATE TABLE — weekday-of-date is computed in code and
    // injected here. The model is empirically unreliable at this math
    // (Aug 25 2027 was rendered "Monday" when it's Wednesday). Forcing
    // the model to copy from this table eliminates that failure mode.
    const _totalDaysForTable = (isMultiCity ? totalNightsFromCities : (parseInt(basics.nights, 10) || 3)) + 1;
    const dateTable = buildDateTable(basics.startDate, _totalDaysForTable);
    return `Plan this trip:
${cityLine}
Base area: ${basics.baseArea || (isMultiCity ? "—" : "suggest best area")}
Start date: ${formatDateForDisplay(basics.startDate) || basics.startDate}${basics.endDate ? `
Return date: ${formatDateForDisplay(basics.endDate) || basics.endDate}` : ""}
Nights: ${isMultiCity ? totalNightsFromCities : basics.nights}${isMultiCity ? "  (" + cities.map(c => `${c.nights} in ${c.name}`).join(" + ") + ")" : ""}
Travelers: ${basics.travelers}
Style: ${prefToText(basics.style)} · Pace: ${basics.pace || "No preference"} · Budget: ${prefToText(basics.budget)}
${flights.noFlight ? `Transportation mode: GROUND ONLY (${groundModeText}). No flights. Do NOT emit any Flight items. Day 1 arrival is a Transport item describing the ${trainAllowed ? "drive or rail" : "drive"} journey from the user's origin to the destination, with realistic time + distance.` : `Home airport: ${flights.homeAirport} (use IATA ${extractAirportCode(flights.homeAirport)} on Flight items) · Airline: ${flights.airline || "no preference"} · Cabin: ${flights.cabin || "no preference"}`}
Hotel brand: ${prefToText(hotel.brand)}${hotel.tier ? ` · ${hotel.tier}` : ""} · Must-haves: ${hotel.mustHave || "none"}
Transport: ${prefToText(transport.type)}${transport.company ? ` · ${transport.company}` : ""}
Cuisine: ${dining.cuisine || "local"} · Dinner budget: ${prefToText(dining.budget)}
Restaurants requested: ${restaurants.length ? restaurants.join(", ") : "suggest"}
Activities requested${activities.length ? " (this is a POOL to draw from — place each on the SINGLE most appropriate day; do NOT schedule the same activity on multiple days, and do NOT treat this list as a per-day quota)" : ""}: ${activities.length ? activities.join(", ") : "suggest based on style"}
Interests: ${interests.text || "not specified"} · Level: ${interests.level || "No preference"}
Include sections: ${active}
${guidelines && guidelines.trim() ? `
TRIP GUIDELINES (SOURCE OF TRUTH — READ THIS FIRST):
"""
${guidelines.trim()}
"""
This is the traveler's own description of the trip. Treat every concrete fact here as NON-NEGOTIABLE ground truth. If they name a flight number, airline, time, airport, or routing — use it EXACTLY in the Flight item, do not invent alternates. If they name a hotel — that is THE hotel; emit it as the Hotel item with the name as written, do not substitute a 'better fit' property. If they name a restaurant — put it on the day they implied (or your best read of the trip shape) as the named meal, do not swap it for something else. If they name a driver, guide, tour, or operator — use that exact name. If they cite confirmation numbers, conf codes, ticket numbers, PNRs, or reservation IDs, echo them VERBATIM in the relevant item's reservation/notes field. If anything here conflicts with a structured dropdown field below, THIS WINS. After honoring every named fact, also apply any posture / pacing / mobility / budget / anniversary framing implied here to every other choice in the plan.
` : ""}${narrative && narrative.trim() ? `
TRAVELER NARRATIVE (HIGHEST PRIORITY — read this carefully, it overrides any conflict with the structured fields above):
"""
${narrative.trim()}
"""
Treat the narrative as the source of truth when it conflicts with a dropdown field. If the narrative names a specific hotel, flight, time, restaurant, guide, driver, confirmation number, or anchor activity, USE IT EXACTLY — don't invent alternates. If the narrative implies a constraint the dropdowns missed (kids, anniversary, mobility, allergies, no-museum-day, late arrivals, jet-lag day, work calls, religious holidays, anniversaries, mourning, surprise stops), respect it on every day it touches. Surface any narrative-specified booking that isn't yet confirmed in flags[] with the exact text the traveler used.
` : ""}

${flights.noFlight ? `IMPORTANT: NO FLIGHTS. The user is ${trainAllowed ? "driving or taking the train" : "driving"}. Day 1 must be a Transport item describing the surface-travel arrival; do not invent flights, do not include any Flight items in days[].items.` : `IMPORTANT: Prefer NONSTOP flights. If ${extractAirportCode(flights.homeAirport) || flights.homeAirport} has no nonstop to the primary airport for ${isMultiCity ? cities[0]?.name : basics.destination}, recommend a nearby airport that does have nonstop service and note the drive time. The user does NOT want a connecting itinerary if a nonstop exists to any nearby airport.`}
${trainAllowed ? "" : "IMPORTANT — NO TRAINS: The user did NOT request train or rail transportation. Do NOT suggest Amtrak, regional rail, commuter rail, or any train segment anywhere in the plan — not as primary transport, not as an alternative in flags[], not in planb[], not in plan-B fallbacks, not in transport_in for any leg, not in any item.text. Every transport segment must be by car, flight (if applicable), or walking. If the destination is rail-friendly (e.g. Saratoga, the Hudson Valley, Hudson NY, Westchester, Connecticut shore, DC corridor, anywhere on the Northeast Corridor) you still must NOT suggest a train. Pretend rail does not exist for this trip."}
${dateTable ? dateTable + "\n" : ""}
IMPORTANT: Return a complete days[] array with ${(isMultiCity ? totalNightsFromCities : (parseInt(basics.nights,10)||3)) + 1} entries (arrival day + ${isMultiCity ? totalNightsFromCities : (parseInt(basics.nights,10)||3)} nights). Do not collapse the plan into the logistics chip list.${isMultiCity ? `
IMPORTANT: This is a ${cities.length}-city trip. Emit cities[] with ${cities.length} entries. Each day's "city" field must match a city in cities[] (or use From→To format for transit days). Inter-city transit is a Transport item at the start of legs 2+ with realistic drive time + distance.` : ""}
IMPORTANT: Write days[] BEFORE logistics, flags, planb, snobs, or tonight. days[] comes immediately after destination + meta in the tool input.
IMPORTANT: NO RESTAURANT MAY APPEAR TWICE. Each named restaurant gets ONE meal slot across the entire trip. Vary breakfasts — use real local spots, not the hotel restaurant on repeat.
IMPORTANT: Each day MUST have a "headline" (the one signature moment) and a "weather" line (seasonal expectation). Top-level MUST include weather_window, pack[≥3], planb[≥5], tonight (with priority prefixes).
${userWantsPrivateDriver ? `IMPORTANT — PRIVATE DRIVER REQUESTED: The user wants a private chauffeur, not a rental car or rideshare. Each activity-heavy day MUST have a Transport item with a named LOCAL operator that actually serves this destination (do NOT default to Blacklane outside the cities it covers — see PRIVATE DRIVER block for guidance), pickup time, return time, and vehicle type. If unsure of the operator, write "Concierge to book — verify operator" rather than guessing. Add a logistics chip "Driver · <operator>". The airport arrival on Day 1 is a driver meet-and-greet, not a self-drive pickup.` : ""}
${userWantsPrivateTour ? `IMPORTANT — PRIVATE TOURS / GUIDES REQUESTED: Marquee sights MUST be done with a named PRIVATE guide (Context Travel, Walks of Italy private, Through Eternity private, ToursByLocals, or destination-specific licensed-guide bureau). Group bus tours and audio walks do NOT satisfy this. Each private-tour Activity item must include: duration, guide credential, advance-booking lead time, and pickup/meet location. Add a flags[] entry urging immediate booking.` : ""}
${userWantsSkipTheLine ? `IMPORTANT — SKIP-THE-LINE REQUESTED: For EVERY major ticketed sight in the plan, the Activity item MUST name the skip-the-line / timed-entry ticket, the official booking URL (or GetYourGuide/Tiqets as reseller fallback), the targeted entry time (default first-of-day 08:00–09:00 for crowd-sensitive sights), and the advance lead time. Add per-sight flags[] entries urging immediate booking. Never tell the user to "arrive early" or "buy at the door."` : ""}`;
  };

  // Active-job storage key. When a build is in flight we write the jobId and
  // form snapshot here so a reopened window can re-attach to the server-side
  // job and continue polling exactly where it left off. Cleared on completion,
  // explicit cancel, or hard error.
  const ACTIVE_JOB_KEY = "trip-optimizer-active-job-v1";

  // Read NDJSON lines from a streaming Response body. Calls onJob with the
  // jobId as soon as it lands, then onDelta with each text chunk, then
  // resolves with the final accumulated length when {"type":"done"} arrives.
  // Throws on {"type":"error"} or transport error. This is the FAST PATH:
  // when the client stays connected to the POST, we get deltas with zero
  // KV-poll latency. If the connection breaks (network blip, mobile sleep)
  // the caller falls back to pollJob() against KV.
  const streamBuildResponse = async ({ resp, signal, onJob, onDelta }) => {
    if (!resp.body) throw new Error("Server did not return a stream body.");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let totalLen = 0;
    let stopReason = null;
    // Stall watchdog. The POST /api/build fetch is NOT bound to an abort
    // signal, so neither the hard-timeout nor the Cancel button can interrupt
    // a blocked reader.read(): the loop only re-checks signal.aborted AFTER a
    // read resolves. If the live SSE stalls without sending bytes (no deltas,
    // no pings) and without closing, reader.read() never resolves and the UI
    // spins forever with no error — the reported "still running after 14 min".
    // Unlike pollJob, this streamer had no stall guard of its own. Race each
    // read against a stall deadline; on stall, cancel the reader and return a
    // soft EOF so the caller falls through to the bounded KV poll fallback
    // (which itself enforces a poll ceiling + emits an honest error). The
    // server sends periodic pings, so a full STREAM_STALL_MS gap with zero
    // bytes genuinely means the live stream is dead. Matches pollJob's
    // MAX_STALL_MS so both transports give up at the same threshold.
    const STREAM_STALL_MS = 180 * 1000;
    try {
      while (true) {
        if (signal?.aborted) {
          try { await reader.cancel(); } catch {}
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
        let stallTimer = null;
        let readOut;
        try {
          readOut = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              stallTimer = setTimeout(() => {
                const e = new Error("Live stream stalled");
                e._streamStall = true;
                reject(e);
              }, STREAM_STALL_MS);
            }),
          ]);
        } catch (raceErr) {
          if (raceErr && raceErr._streamStall) {
            // Dead live stream — hand off to the bounded KV poll fallback.
            try { await reader.cancel(); } catch {}
            return { len: totalLen, softEnd: true, stopReason };
          }
          throw raceErr;
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
        }
        const { value, done } = readOut;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // NDJSON: each event is a single line terminated with \n.
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "job" && evt.jobId) {
            if (onJob) onJob(evt.jobId);
          } else if (evt.type === "delta" && evt.text) {
            totalLen += evt.text.length;
            onDelta(evt.text, totalLen);
          } else if (evt.type === "stop_reason" && evt.reason) {
            // Forwarded from Anthropic's message_delta event. Captured so
            // the caller can detect a max_tokens hit BEFORE the JSON
            // salvage layer fires — the salvage path can recover most
            // truncated JSON but the error message it surfaces is generic
            // ("plan was cut off"). With stopReason in hand we can surface
            // the precise actionable error ("Plan exceeded the model's
            // budget — try fewer cities or split into a multi-leg trip").
            stopReason = evt.reason;
          } else if (evt.type === "ping") {
            // Server heartbeat — silently keeps the NDJSON stream alive
            // through long model thinking pauses (big menu objects, large
            // prefill). No UI change; just prevents idle disconnects and
            // keeps the stall detector happy if it later kicks in.
            continue;
          } else if (evt.type === "done") {
            return { len: evt.len ?? totalLen, stopReason };
          } else if (evt.type === "error") {
            // If we've already streamed real output, salvage the partial.
            // Anthropic occasionally drops the SSE connection 7–9 min into
            // very long generations; the partial JSON we collected is often
            // complete enough for salvageTruncatedJSON to recover.
            const upstreamMsg = evt.error || "Build failed on server.";
            const err = new Error(upstreamMsg);
            err.partialLen = totalLen;
            err.upstreamError = true;
            throw err;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    // Stream ended without an explicit done — treat as soft EOF; caller can
    // fall back to polling KV.
    return { len: totalLen, softEnd: true, stopReason };
  };

  // Shared poller used by both fresh builds and the resume-on-mount path.
  // Polls GET /api/build/<jobId>?cursor=N, appends server-side deltas to a
  // running toolJson buffer, updates progress, and resolves with the final
  // accumulated text when status flips to "done". Throws on "error" or
  // notFound. The signal cancels the poll loop without killing the
  // server-side job (build keeps running for next time).
  const pollJob = async ({ jobId, signal, onDelta, startCursor = 0, maxPollMs }) => {
    let cursor = startCursor;
    let stopReasonFromStatus = null;
    const POLL_MS = 1500;
    // Bound both wall-clock and stall so the UI never spins forever.
    // MAX_POLL_MS is the hard ceiling; MAX_STALL_MS catches the "server is
    // up but generation has frozen" case where 5xx polls succeed but
    // no new bytes arrive.
    //
    // Default 15 min covers the long tail of legitimate builds. The wizard
    // build path overrides this with a trip-size-scaled value so 12-night,
    // 9-city builds that legitimately need 12-15 min get the headroom they
    // need. Without this override a Croatia-sized build was being killed
    // at 10 min while the model was still actively streaming Day 11.
    const MAX_POLL_MS = typeof maxPollMs === "number" && maxPollMs > 0 ? maxPollMs : 15 * 60 * 1000;
    // Stall threshold. The model can legitimately spend 90–150s emitting a
    // single large structure (a full menu object with appetizers + mains +
    // desserts + wine notes is one such block). 90s was tripping on healthy
    // builds; 180s gives real model pauses room while still catching truly
    // dead jobs.
    const MAX_STALL_MS = 180 * 1000;
    // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
    const pollStart = Date.now();
    // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
    let lastProgressAt = Date.now();
    while (true) {
      if (signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error("Build is taking longer than expected. Tap Build again to retry.");
      }
      // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
      if (Date.now() - lastProgressAt > MAX_STALL_MS) {
        throw new Error("Build stalled — no new content for 3 minutes. The live stream likely dropped and KV mirroring is unavailable. Tap Build again to retry.");
      }
      let resp;
      try {
        resp = await fetch(`/api/build/${encodeURIComponent(jobId)}?cursor=${cursor}`, {
          signal,
          headers: { "Cache-Control": "no-cache" },
        });
      } catch (netErr) {
        // Transient network blip during a poll — wait and retry. The job is
        // still running on the server; we just couldn't reach it this tick.
        if (netErr?.name === "AbortError") throw netErr;
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      if (resp.status === 404) {
        const err = new Error("Job not found or expired. Build again.");
        err.notFound = true;
        throw err;
      }
      if (!resp.ok) {
        // 5xx — inspect the body. If the server is reporting a missing JOBS
        // KV binding, NO amount of polling will recover; surface a precise
        // actionable error instead of stalling for 3 minutes. Otherwise wait
        // and retry (transient 5xx).
        try {
          const errBody = await resp.json();
          const errMsg = errBody?.error?.message || "";
          if (/JOBS\s*KV/i.test(errMsg) || /missing\s+JOBS/i.test(errMsg)) {
            throw new Error(
              "Server is missing the JOBS KV binding on Cloudflare Pages. " +
              "In the Cloudflare dashboard, open Pages \u2192 trip-optimizer \u2192 " +
              "Settings \u2192 Functions \u2192 KV namespace bindings, and add " +
              "variable name JOBS pointing to a KV namespace. Then redeploy."
            );
          }
        } catch (jsonErr) {
          if (jsonErr instanceof Error && /JOBS\s+KV/i.test(jsonErr.message)) throw jsonErr;
          // Body wasn't JSON — treat as transient and retry.
        }
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      const data = await resp.json();
      if (data?.error?.message) throw new Error(data.error.message);

      if (data.delta) {
        cursor = data.cursor;
        // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
        lastProgressAt = Date.now();
        onDelta(data.delta, cursor);
      }
      // stopReason is mirrored on the status payload by the worker once the
      // model sends message_delta. Capture it so the build call site can
      // produce a precise error message instead of the generic salvage path.
      if (data.stopReason && !stopReasonFromStatus) stopReasonFromStatus = data.stopReason;
      if (data.status === "done") return { len: data.cursor, stopReason: stopReasonFromStatus };
      if (data.status === "error") throw new Error(data.error || "Build failed on server.");

      await new Promise(r => setTimeout(r, POLL_MS));
    }
  };

  // Compute progress label given the current accumulated toolJson. Pulled out
  // of the inner stream loop so it can run identically against polled deltas
  // and against a resumed job's pre-existing buffer.
  //
  // IMPORTANT: progressLabel is the *sub-line* below the bold phase header.
  // It should ONLY render when it adds detail beyond what loadingMsg (the
  // phase cycler: "Researching destination…", "Selecting hotels…",
  // "Building day-by-day itinerary…", etc.) already conveys. So we leave it
  // EMPTY for the early/placeholder states ("Starting plan…",
  // "Planning structure…") — those would just duplicate loadingMsg and
  // produce the contradictory "Starting plan… / Finalizing your plan…"
  // mismatch users have been seeing on slow builds. progressLabel only
  // fires once we have real stream content to describe ("Day 4 of 8 ·
  // dining", "Insider notes & Plan B…").
  const updateProgressLabel = (toolJson, totalDays) => {
    const dayMatches = toolJson.match(/"label"\s*:\s*"/g) || [];
    const daysSeen = dayMatches.length;
    const restaurantMatches = toolJson.match(/"reservation"\s*:/g) || [];
    const restaurantsDone = restaurantMatches.length;
    // Detect the end-of-output sections so we can honestly say "Finalizing…"
    // only when the model is actually emitting the final blocks.
    const finalizingNow = /"flags"\s*:|"planB"\s*:|"insider"\s*:|"snobs"\s*:|"weather"\s*:/.test(toolJson)
      && daysSeen >= totalDays;

    if (daysSeen === 0) {
      // No real stream signal yet — let loadingMsg (phase cycler) own the
      // header without a competing sub-line.
      setProgressLabel("");
    } else if (finalizingNow) {
      // Genuine finalize window: all days emitted, model is on the final
      // insider/flags/planB blocks. Safe (and honest) to say "Finalizing…".
      setProgressLabel("Finalizing your plan…");
    } else if (daysSeen <= totalDays) {
      const currentDay = daysSeen;
      const lastLabelIdx = toolJson.lastIndexOf('"label"');
      const restIdx = toolJson.lastIndexOf('"restaurant"');
      const menuIdx = toolJson.lastIndexOf('"menu"');
      if (restaurantsDone > 0 && menuIdx > lastLabelIdx) {
        setProgressLabel(`Day ${currentDay} of ${totalDays} · menu`);
      } else if (restIdx > lastLabelIdx) {
        setProgressLabel(`Day ${currentDay} of ${totalDays} · dining`);
      } else {
        setProgressLabel(`Day ${currentDay} of ${totalDays} · activities`);
      }
    } else {
      setProgressLabel("Insider notes & Plan B…");
    }
  };

  const handleCancel = () => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    // Drop the stored active job so we don't auto-resume it on next mount.
    try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
    setLoading(false);
    setLoadingMsg("");
  };

  // Internal: drive the UI state machine for a running job. Used for both
  // fresh starts (jobId just minted) and resume-on-reopen (jobId loaded from
  // localStorage). Caller provides the expected nights so progress can be
  // computed without re-deriving from current form state (which may be empty
  // on a resume into a fresh tab).
  const runBuildForJob = async ({ jobId, nightsNum, expectedTokens, startedAt, citiesCount = 1, streamResp = null, onJobIdReady = null }) => {
    setLoading(true);
    setError("");
    setProgress(0);
    setProgressLabel("");
    setElapsedSec(0);
    setLoadingMsg("Researching destination…");

    const totalDays = nightsNum + 1;
    // Build-time scales with trip size. A single-city 3-night plan finishes in
    // ~2.5 min; a 3-city 9-night plan needs ~5-6 min because the model emits
    // many more days, hotels, transit legs, and restaurants.
    const targetSec = Math.round(120 + totalDays * 12 + Math.max(0, citiesCount - 1) * 60);
    let lastTokenFrac = 0;

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
      const timeFrac = Math.min(0.95, sec / targetSec);
      const frac = Math.max(lastTokenFrac, timeFrac);
      setProgress(prev => (prev >= 1 ? prev : Math.max(prev, frac)));
    }, 250);

    // Honest phase cycler. Cycles through the first 5 phases over ~30s (the
    // brief input/upstream-handoff window), then HOLDS on "Adding insider
    // notes and Plan B…" rather than lying about "Finalizing". The data-
    // driven progressLabel ("Day 2 of 4 · activities") takes over when the
    // stream actually starts emitting day content. "Finalizing your plan…"
    // is now reserved for the genuine end-of-stream window: progress ≥85%.
    // Why this matters: under the old timer the user saw "Finalizing…" for
    // 60–120 seconds before the plan was actually done, which read as a
    // hang. Now they see the cycler briefly, then either real day-by-day
    // labels OR the honest "Still building" notice — never a fake finalize.
    const phases = [
      "Researching destination…",
      "Selecting hotels and neighborhoods…",
      "Building day-by-day itinerary…",
      "Picking restaurants and reservations…",
      "Adding insider notes and Plan B…",
    ];
    let phaseIdx = 0;
    const phaseTimer = setInterval(() => {
      // Hold on the last cycled phase; do NOT advance to "Finalizing".
      if (phaseIdx >= phases.length - 1) return;
      phaseIdx += 1;
      setLoadingMsg(phases[phaseIdx]);
    }, 6000);

    // The client-side hard timeout has to outlast the server build for any
    // trip size. Single-city ~5 min; multi-city scales up. The server keeps
    // running independently — we just stop polling if we hit the ceiling.
    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeoutMs = Math.max(300000, targetSec * 1000 * 3); // 3× the target, floor 5 min
    const hardTimeout = setTimeout(() => controller.abort(new Error("Polled too long")), hardTimeoutMs);
    // Pass a poll ceiling that gives the model 2.5× the expected build time
    // before giving up — always at least 15 min so small trips keep generous
    // headroom, but scaling with trip size so a 12-day, 9-city build that
    // legitimately needs 12-15 min of streaming gets ~30 min of polling
    // window before the client guillotines it.
    const maxPollMsForTrip = Math.max(15 * 60 * 1000, Math.round(targetSec * 1000 * 2.5));

    // "Still building" notice scales with expected build time so we don't
    // claim a 3-city plan is slow at 90s when 4-5 min is normal.
    const slowNoticeMs = Math.max(90000, Math.round(targetSec * 1000 * 0.75));
    // #17 Derive the "still building" range from the trip's own targetSec so it
    // never contradicts the hero/in-build estimate with a hardcoded "2-3 min".
    const typicalMin = Math.max(2, Math.round(targetSec / 60));
    const typicalRange = `${typicalMin}–${typicalMin + 2} minutes`;
    const slowNotice = setTimeout(() => {
      setLoadingMsg(prev => prev.includes("still building") ? prev : `Still building — detailed plans typically take ${typicalRange}…`);
    }, slowNoticeMs);

    // Wake lock keeps the screen alive on iOS so polling stays fluid; with
    // server-side jobs even a screen sleep no longer kills the build, but a
    // bright phone keeps the polling visible.
    let wakeLock = null;
    const requestWakeLock = async () => {
      try {
        if ("wakeLock" in navigator && navigator.wakeLock?.request) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch {}
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && abortRef.current === controller) {
        requestWakeLock();
      }
    };
    await requestWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);

    let toolJson = "";
    const onDelta = (delta /*, totalLen */) => {
      toolJson += delta;
      const estTokens = toolJson.length / 3.5;
      const tokFrac = Math.min(0.95, estTokens / expectedTokens);
      lastTokenFrac = tokFrac;
      setProgress(prev => Math.max(prev, tokFrac));
      updateProgressLabel(toolJson, totalDays);
    };

    try {
      // Primary path: read the open POST stream (zero-latency deltas, no 30s
      // waitUntil ceiling because the client is the lifeline). Falls back to
      // KV polling if the connection drops mid-build.
      let needPollFallback = !streamResp;
      let resolvedJobId = jobId;
      // Anthropic's stop_reason for this build. "end_turn" = clean finish;
      // "max_tokens" = hit the budget (output is truncated regardless of how
      // well the JSON parses); null = stream dropped before message_delta.
      // Used below to pick a precise error message instead of the generic
      // "plan was cut off" copy.
      let buildStopReason = null;
      if (streamResp) {
        try {
          const out = await streamBuildResponse({
            resp: streamResp,
            signal: controller.signal,
            onJob: (id) => {
              resolvedJobId = id;
              if (onJobIdReady) onJobIdReady(id);
            },
            onDelta,
          });
          if (out.softEnd) needPollFallback = true;
          if (out.stopReason) buildStopReason = out.stopReason;
        } catch (streamErr) {
          if (streamErr?.name === "AbortError") throw streamErr;
          // Anthropic SSE drop with partial content already in toolJson — try
          // to salvage what we have BEFORE falling back to KV polling. For
          // very long generations the KV mirror may be stale and the partial
          // we received over the live stream is the freshest copy.
          if (streamErr?.upstreamError && toolJson && toolJson.length > 2000) {
            const salvaged = salvageTruncatedJSON(toolJson);
            if (salvaged) {
              try {
                const trial = JSON.parse(salvaged);
                if (Array.isArray(trial?.days) && trial.days.length >= 2) {
                  // Good enough — use the salvaged partial and skip polling.
                  toolJson = salvaged;
                  needPollFallback = false;
                } else {
                  needPollFallback = true;
                }
              } catch {
                needPollFallback = true;
              }
            } else {
              needPollFallback = true;
            }
          } else {
            // Network drop during stream — keep what we have and resume via KV.
            needPollFallback = true;
          }
        }
      }
      if (needPollFallback) {
        if (!resolvedJobId) {
          // Connection died before the server even sent the jobId. Nothing
          // to resume from in KV.
          throw new Error("Lost connection to server before build started. Tap Build again.");
        }
        // toolJson may already hold partial bytes from the stream — tell the
        // poller our cursor so it doesn't re-deliver them.
        const pollOut = await pollJob({
          jobId: resolvedJobId,
          signal: controller.signal,
          onDelta,
          startCursor: toolJson.length,
          maxPollMs: maxPollMsForTrip,
        });
        if (pollOut?.stopReason && !buildStopReason) buildStopReason = pollOut.stopReason;
      }

      setProgress(1);
      setProgressLabel("Finalizing…");

      if (!toolJson) throw new Error("No content returned from AI service.");

      // If the model explicitly told us it hit max_tokens, surface a
      // precise actionable error BEFORE we attempt JSON parse/salvage. The
      // salvage layer can usually recover a partial plan, but the user
      // should know the truncation was due to budget exhaustion (so they
      // can split the trip or reduce its scope) rather than think it was
      // a random model glitch they can retry through.
      const hitMaxTokens = buildStopReason === "max_tokens";

      let parsed;
      try {
        parsed = JSON.parse(toolJson);
      } catch (parseErr) {
        const salvaged = salvageTruncatedJSON(toolJson);
        if (salvaged) {
          try {
            parsed = JSON.parse(salvaged);
            parsed._truncated = true;
            if (hitMaxTokens) parsed._truncationCause = "max_tokens";
          } catch (salvageErr) {
            const msg = hitMaxTokens
              ? "The plan hit the model's token budget mid-output and couldn't be recovered. Try fewer cities or a shorter trip, or split this into a multi-leg flow."
              : "The plan was cut off before it finished. Try again.";
            throw new Error(msg, { cause: salvageErr });
          }
        } else {
          const msg = hitMaxTokens
            ? "The plan hit the model's token budget mid-output and couldn't be recovered. Try fewer cities or a shorter trip, or split this into a multi-leg flow."
            : "The plan was cut off before it finished. Try again.";
          throw new Error(msg, { cause: parseErr });
        }
      }
      // Even when JSON.parse succeeded, max_tokens means the plan is
      // genuinely truncated — mark it so the QualityBadge surfaces the
      // warning and the user knows to re-build with fewer constraints.
      if (hitMaxTokens && parsed && typeof parsed === "object") {
        parsed._truncated = true;
        parsed._truncationCause = "max_tokens";
      }

      applyBuiltPlan(parsed, { nightsNum });
    } catch (err) {
      let msg;
      if (err?.name === "AbortError") {
        msg = "Build cancelled. The server may still be finishing — reopen the page within a few minutes to resume.";
      } else if (err?.notFound) {
        msg = "That build expired or was not found. Tap Build again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      } else {
        msg = err?.message || "Something went wrong generating the plan. Please try again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      }
      setError(msg);
    } finally {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      try { if (wakeLock) await wakeLock.release(); } catch {}
      clearInterval(phaseTimer);
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      clearTimeout(slowNotice);
      abortRef.current = null;
      setLoading(false);
      setLoadingMsg("");
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  // Post-parse downstream shared by the single-call build and the chunked
  // build: validate day count, swap in the new plan, then fire the
  // background grounding passes (booking confirmation + Places verification +
  // pacing). Both paths converge here so a chunked plan renders and verifies
  // exactly like a single-call one.
  const applyBuiltPlan = (parsed, { nightsNum }) => {
      const expectedDays = nightsNum + 1;
      const gotDays = Array.isArray(parsed?.days) ? parsed.days.length : 0;
      if (gotDays === 0) {
        const keys = parsed ? Object.keys(parsed).join(", ") : "(no object)";
        const truncFlag = parsed?._truncated ? " [truncated]" : "";
        const buildId = (typeof __BUILD_ID__ !== "undefined") ? __BUILD_ID__ : "unknown";
        throw new Error(`No day-by-day plan returned (build ${buildId}${truncFlag}). Got keys: ${keys}. Tap Build again.`);
      }
      if (gotDays < Math.max(2, expectedDays - 1) && !parsed._truncated) {
        parsed._dayCountWarning = `Expected ~${expectedDays} days, got ${gotDays}`;
      }

      // Success — clear the stored active job so we don't auto-resume it.
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      // Fresh build is a brand-new plan, not yet saved — reset associations.
      setCurrentSavedTripId(null);
      setReviewState(null);
      setResult(parsed);
      setStep(3);

      // Background pass: ground every restaurant's reservation.platform on
      // the actual booking system via Sonar (Resy / OpenTable / Tock /
      // phone-only / walk-in) and fill in missing official websites. This
      // is fire-and-forget — the plan is fully usable without it; we just
      // patch reservation links to the right platform as confirmations
      // arrive. KV-cached per (name, city) for 30 days so iteration on the
      // same trip is free after the first build.
      (async () => {
        try {
          const restaurants = collectPlanRestaurants(parsed);
          if (restaurants.length === 0) return;
          const res = await fetch("/api/confirm-booking", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ restaurants }),
          });
          if (!res.ok) return;
          const data = await res.json();
          const confs = Array.isArray(data?.confirmations) ? data.confirmations : [];
          if (confs.length === 0) return;
          // Merge into whatever the current result is. If the user has
          // moved on (cleared, started a new build, loaded a saved trip),
          // skip the update to avoid stomping the new state.
          setResult(prev => {
            if (!prev || prev !== parsed) return prev;
            return mergeBookingConfirmations(prev, confs);
          });
        } catch {
          /* network or parse failure — silent, the original plan still works */
        }
      })();

      // Background pass: verify every named venue (restaurants, backups,
      // activities) against Google Places (New) via /api/places-verify-batch.
      // CLOSED_PERMANENTLY / CLOSED_TEMPORARILY / NOT_FOUND items are
      // DROPPED from the plan entirely; OPERATIONAL items get their
      // contact.{address,phone,website} overwritten with authoritative
      // Places values and contact.hours_verified populated. UNVERIFIED
      // venues (Places key missing or network error) are kept with a warn
      // flag so the pre-export gate can surface a banner.
      //
      // This is fire-and-forget — the plan renders immediately without
      // verification; we patch it as results come in. Same guarded
      // setResult pattern as the confirm-booking pass: if the user moved
      // on to a new build / saved trip, we skip the merge.
      (async () => {
        try {
          const venues = collectPlanVenues(parsed);
          if (venues.length === 0) return;

          // Chunk to stay under Cloudflare Workers' 50-subrequest-per-
          // invocation cap on the free tier. Worst case per uncached
          // venue: 1 Text Search + 1 Place Details + 1 KV get + 1 KV
          // put = 4 subrequests. 12 venues × 4 = 48 subrequests, just
          // under the cap. Cached venues skip the Places calls entirely
          // (only the KV get counts), so in steady state this is very
          // comfortable. A 60-venue trip = 5 POSTs, each its own Worker
          // invocation with its own subrequest budget.
          const CHUNK_SIZE = 12;
          const allVerifications = [];
          for (let i = 0; i < venues.length; i += CHUNK_SIZE) {
            const chunk = venues.slice(i, i + CHUNK_SIZE);
            try {
              const res = await fetch("/api/places-verify-batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ venues: chunk }),
              });
              if (!res.ok) continue; // skip this chunk, keep going
              const data = await res.json();
              if (Array.isArray(data?.verifications)) {
                allVerifications.push(...data.verifications);
              }
            } catch {
              /* one chunk failed — skip and keep the rest. */
            }
          }

          if (allVerifications.length === 0) return;

          // Per-leg location check (Spec 2, 2026-06-14). Geocode each
          // trip leg's city to get a centroid, then flag any verified
          // venue whose lat/lng is too far from any leg. Catches the
          // 'Santa Fe NM vs Santa Fe Argentina' failure mode.
          //
          // Soft-fail: if geocoding errors or a city can't be resolved,
          // location check degrades to a no-op (no false-positive blocks).
          try {
            const legCities = collectPlanLegCities(parsed);
            if (legCities.length > 0) {
              const geoRes = await fetch("/api/geocode-cities", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cities: legCities }),
              });
              if (geoRes.ok) {
                const geoData = await geoRes.json();
                const centers = (Array.isArray(geoData?.geocodes) ? geoData.geocodes : [])
                  .filter((g) => g.found && typeof g.lat === "number" && typeof g.lng === "number")
                  .map((g) => ({ name: g.name, lat: g.lat, lng: g.lng }));
                if (centers.length > 0) {
                  const legs = computeLegRadii(centers);
                  const locResult = findVenuesOutsideRadius(allVerifications, legs);
                  if (locResult.blocked > 0) {
                    // Attach the WRONG_LOCATION flag to the venues in
                    // the verifications array so mergePlacesVerifications
                    // sees it and drops the affected items.
                    for (const v of allVerifications) {
                      const flag = locResult.flagsByName.get(v.name);
                      if (flag) {
                        v.flags = [...(Array.isArray(v.flags) ? v.flags : []), flag];
                      }
                    }
                  }
                }
              }
            }
          } catch {
            /* geocoding or location-check failure — silent. We still
               apply the Places verifications below; we just skip the
               distance check. */
          }

          setResult(prev => {
            if (!prev || prev !== parsed) return prev;
            return mergePlacesVerifications(prev, allVerifications);
          });

          // Pacing check (Spec 3, 2026-06-14). After Places verification
          // attaches lat/lng to items, walk adjacent pairs and ask
          // Routes API how long each transition takes. Flag impossibles
          // (block) and tight buffers (warn). Soft-fail if Routes isn't
          // enabled — the plan still ships, just without the pacing layer.
          try {
            // Use the freshly-merged plan, not the pre-merge `parsed`,
            // so items carry lat/lng from the verification pass.
            const merged = mergePlacesVerifications(parsed, allVerifications);
            const pacingPairs = collectPacingPairs(merged);
            if (pacingPairs.length > 0) {
              const pacingRes = await fetch("/api/routes-verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pairs: pacingPairs }),
              });
              if (pacingRes.ok) {
                const pacingData = await pacingRes.json();
                const pacedPlan = applyPacingFlags(merged, pacingPairs, pacingData?.routes || []);
                if (pacedPlan !== merged) {
                  setResult(prev => {
                    if (!prev || prev !== parsed) return prev;
                    return pacedPlan;
                  });
                }
              }
            }
          } catch {
            /* pacing-check failure — silent. The verified plan from
               mergePlacesVerifications is what we render. */
          }
        } catch {
          /* network or parse failure — silent. The plan still renders; the
             user just doesn't get the Places-verified overlay. */
        }
      })();
  };

  // Generate one chunk: stream the per-chunk body and enforce the max_tokens
  // guard. Shared by the fresh chunked build and the resume path so a re-run
  // behaves identically. Returns { toolJson, stopReason }.
  const generateChunk = async ({ body, controller, maxPollMsForTrip, onJob, chunkLabel }) => {
    const { toolJson, stopReason } = await streamBuildJob(body, {
      signal: controller.signal,
      maxPollMs: maxPollMsForTrip,
      onJob,
      onDelta: () => {},
      // #24: surface a microcopy when the live stream stalls and we fall over
      // to KV polling. The build keeps progressing server-side; the UI just
      // tells the user we're switching transports so it doesn't look hung.
      onStallNotice: (msg) => { try { setLoadingMsg(msg); } catch {} },
    });
    // A chunk that ends on max_tokens is truncated regardless of how well its
    // JSON parses — its tail days/items may be cut off. Fail loudly (surface
    // the existing cut-off error) rather than stitching a partial segment that
    // would silently ship an incomplete itinerary.
    if (stopReason === "max_tokens") {
      throw new Error(`The plan was cut off while building days ${chunkLabel} (hit the length limit). Try again, or reduce the trip length.`);
    }
    return { toolJson, stopReason };
  };

  // Stitch the day-chunks + wrapper into one canonical plan and hand it to the
  // SAME downstream path as a single-call build (applyBuiltPlan). Shared by the
  // fresh and resume paths. stitchPlan throws if the assembled day count !=
  // expectedDays (a chunk came back short) — we map that to the existing
  // truncation error rather than shipping a broken plan. Because we only call
  // this after the loop has a chunkPlan for every chunk, the "wait for the full
  // set" requirement is enforced by stitchPlan's own day-count check.
  const finishChunkedBuild = ({ chunkPlans, wrapperParsed, expectedDays, nightsNum }) => {
    setProgress(1);
    setProgressLabel("Finalizing…");
    let stitched;
    try {
      stitched = stitchPlan({ dayChunks: chunkPlans, wrapper: wrapperParsed, expectedDays });
    } catch (stitchErr) {
      const e = new Error("The plan was cut off before it finished — one of the day chunks came back short. Try again.");
      e.cause = stitchErr;
      throw e;
    }
    const { plan, warnings } = stitched;
    if (warnings.length) { try { console.warn("[trip-optimizer] stitchPlan warnings:", warnings); } catch {} }
    applyBuiltPlan(plan, { nightsNum });
  };

  // Chunked build orchestrator for large trips (see CHUNKED_BUILD_SPEC.md).
  // A maxed single build needs up to 64k output tokens (~17.5 min) which
  // exceeds the 15-min client polling window, so big trips time out. We split
  // the itinerary into day-range chunks, generate each well under the ceiling,
  // run a small wrapper pass for the non-day fields, then stitch one canonical
  // plan identical in shape to the single-call output and feed it through the
  // SAME downstream path (applyBuiltPlan). Chunks run sequentially so each can
  // be told the prior chunks' restaurants for cross-chunk dedupe.
  const runChunkedBuild = async ({ nightsNum, citiesCount, chunks, staticRules, dynamicPreamble, userPromptForBuild }) => {
    setLoading(true);
    setError("");
    setProgress(0);
    setProgressLabel("");
    setElapsedSec(0);

    const expectedDays = nightsNum + 1;
    // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
    const startedAt = Date.now();
    // Total wall-clock scales with the number of chunks (+ wrapper). Each chunk
    // is short, so this is far more generous per chunk than a single maxed call.
    const targetSec = Math.round(90 + (chunks.length + 1) * 60 + Math.max(0, citiesCount - 1) * 30);

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
    }, 250);

    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeoutMs = Math.max(600000, targetSec * 1000 * 3);
    const hardTimeout = setTimeout(() => controller.abort(new Error("Polled too long")), hardTimeoutMs);
    // Per-chunk poll ceiling. Each chunk is small (<=6 days) so it finishes
    // well inside this, but we keep a generous floor so a momentary stall
    // doesn't guillotine an in-flight chunk.
    const maxPollMsForTrip = Math.max(15 * 60 * 1000, Math.round(targetSec * 1000 * 2.5));

    // Reuse the SAME cached system blocks + tools across every chunk and the
    // wrapper so the static rulebook stays the cached prefix (prompt caching).
    const systemBlocks = cachedSystemBlocks(staticRules, dynamicPreamble);
    const tools = cachedTools([TRIP_PLAN_TOOL]);
    const toolChoice = { type: "tool", name: "submit_trip_plan" };

    // Reconnect bookkeeping (version 2). We persist the EXACT per-chunk and
    // wrapper request bodies plus each chunk's jobId+status so a reopened page
    // can recover finished chunks from KV and replay only the missing ones
    // FAITHFULLY (no prompt reconstruction / drift). The single-call resume
    // effect bails when `jobId` is absent, so this {chunked:true} shape never
    // triggers (or breaks) it; the chunked branch in the resume effect routes
    // here. See CHUNKED_RESUME_IMPL_NOTES.md.
    const destination = basics.destination || (basics.cities?.[0]?.name) || "your trip";
    const chunkMeta = chunks.map((c) => ({
      startDay: c.startDay,
      endDay: c.endDay,
      cityNames: Array.isArray(c.cityNames) ? c.cityNames : [],
      maxTokens: chunkMaxTokens(c),
      jobId: null,
      status: "pending",
    }));
    const chunkBodies = new Array(chunks.length).fill(null);
    let wrapperBodyForPersist = null;
    let wrapperJobId = null;
    // Quota-safe persist: try the full payload (with bodies) first; if
    // localStorage throws (quota exceeded), retry WITHOUT the bodies so resume
    // still knows which chunks finished — it just has to re-run the missing
    // ones from inputs (acceptable degradation).
    const persist = () => {
      const base = {
        chunked: true,
        version: 2,
        startedAt,
        nightsNum,
        citiesCount,
        destination,
        expectedDays,
        chunks: chunkMeta,
        wrapperJobId,
      };
      try {
        localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({ ...base, chunkBodies, wrapperBody: wrapperBodyForPersist }));
      } catch {
        try { localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(base)); } catch {}
      }
    };

    try {
      const chunkPlans = [];
      const usedRestaurants = [];

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        setLoadingMsg(`Building days ${c.startDay}–${c.endDay} (chunk ${i + 1}/${chunks.length})…`);
        setProgress(Math.max(0.02, i / (chunks.length + 1)));

        const usedList = usedRestaurants.length ? usedRestaurants.join(", ") : "(none yet)";
        const cityHint = Array.isArray(c.cityNames) && c.cityNames.length
          ? ` These days belong to: ${c.cityNames.join(" / ")}. Set each day's "city" field to its city name (use "From→To" only on an actual inter-city transit day).`
          : "";
        const chunkConstraint = `\n\nCHUNK MODE — GENERATE ONLY Day ${c.startDay}–Day ${c.endDay}.\nReturn days[] containing ONLY those days (in order). Do NOT include any other day. Omit logistics/weather_window/pack/flags/planb/snobs/tonight in chunk mode (a final pass produces them). Still copy the weekday stamps from the COMPUTED DATE TABLE.\nIMPORTANT: every day in this chunk MUST set its "city" field.${cityHint}\nRestaurants already used on earlier days (do NOT reuse): ${usedList}.`;

        const body = {
          model: "claude-sonnet-4-5",
          max_tokens: chunkMaxTokens(c),
          system: systemBlocks,
          messages: [{ role: "user", content: userPromptForBuild + chunkConstraint }],
          tools,
          tool_choice: toolChoice,
        };
        // Store the EXACT body before the call so an interruption mid-chunk can
        // replay it faithfully on resume.
        chunkBodies[i] = body;
        persist();

        const { toolJson } = await generateChunk({
          body,
          controller,
          maxPollMsForTrip,
          chunkLabel: `${c.startDay}–${c.endDay}`,
          onJob: (id) => { chunkMeta[i].jobId = id; persist(); },
        });
        const { parsed: chunkPlan } = parseToolJson(toolJson);
        chunkPlans.push(chunkPlan);
        for (const name of collectRestaurantNames(chunkPlan)) usedRestaurants.push(name);
        // Mark this chunk done so a later interruption recovers it from KV
        // instead of re-running it.
        chunkMeta[i].status = "done";
        persist();
      }

      // Wrapper pass — one small call for the non-day fields. We hand it a
      // compact summary of the assembled days (label + city + a couple key
      // item names) so it can write a coherent intro / Plan B / snobs guide
      // WITHOUT regenerating the (token-dominant) itinerary.
      setLoadingMsg("Assembling final plan…");
      setProgress(chunks.length / (chunks.length + 1));

      const assembledDays = [];
      for (const cp of chunkPlans) {
        for (const d of (Array.isArray(cp?.days) ? cp.days : [])) assembledDays.push(d);
      }
      const summaryLines = assembledDays.map((d, idx) => {
        const items = Array.isArray(d?.items) ? d.items : [];
        const keyNames = items
          .map((it) => String(it?.name || it?.place || "").trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(", ");
        const label = String(d?.label || `Day ${idx + 1}`).trim();
        const city = d?.city ? ` (${d.city})` : "";
        return `${label}${city}: ${keyNames || "—"}`;
      });
      const wrapperConstraint = `\n\nASSEMBLED ITINERARY (for reference — do NOT regenerate days):\n${summaryLines.join("\n")}\n\nWRAPPER MODE — GENERATE ONLY the wrapper fields: destination, meta, cities[], logistics, weather_window, pack, flags, planb (>=5 entries), snobs, tonight. Return an EMPTY days[] array. Do NOT regenerate the day-by-day itinerary — it is already built above.`;

      const wrapperBody = {
        model: "claude-sonnet-4-5",
        max_tokens: 6000,
        system: systemBlocks,
        messages: [{ role: "user", content: userPromptForBuild + wrapperConstraint }],
        tools,
        tool_choice: toolChoice,
      };
      // Persist the wrapper body too so resume can replay it if interrupted.
      wrapperBodyForPersist = wrapperBody;
      persist();
      const { toolJson: wrapperJson } = await streamBuildJob(wrapperBody, {
        signal: controller.signal,
        maxPollMs: maxPollMsForTrip,
        onJob: (id) => { wrapperJobId = id; persist(); },
        onDelta: () => {},
      });
      let wrapper = {};
      try {
        wrapper = parseToolJson(wrapperJson).parsed || {};
      } catch {
        // Wrapper is non-essential — the itinerary is the product. If it
        // comes back unparseable, ship the days with empty wrapper fields
        // rather than failing the whole build.
        wrapper = {};
      }

      finishChunkedBuild({ chunkPlans, wrapperParsed: wrapper, expectedDays, nightsNum });
    } catch (err) {
      // Mirror runBuildForJob's catch semantics so the chunked path behaves
      // identically: keep ACTIVE_JOB_KEY on a cancel/timeout abort (so the
      // user can reopen to resume), use the dedicated copy for an expired job,
      // and only clear the key on a genuine hard error.
      let msg;
      if (err?.name === "AbortError") {
        msg = "Build cancelled. The server may still be finishing — reopen the page within a few minutes to resume.";
        // Intentionally DO NOT remove ACTIVE_JOB_KEY here — the chunk jobIds
        // stay persisted for a future resume (see CHUNKED_BUILD_IMPL_NOTES.md).
      } else if (err?.notFound) {
        msg = "That build expired or was not found. Tap Build again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      } else {
        msg = err?.message || "Something went wrong generating the plan. Please try again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      }
      setError(msg);
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      abortRef.current = null;
      setLoading(false);
      setLoadingMsg("");
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  // Resume an interrupted chunked build from the version-2 ACTIVE_JOB_KEY
  // payload persisted by runChunkedBuild. Recovers finished chunks from KV and
  // re-runs ONLY the missing/errored ones, then the wrapper, then stitches via
  // the SAME finishChunkedBuild path a fresh build uses. `saved` is the parsed
  // version-2 object (validated by the caller: chunked, has chunks[], fresh).
  const resumeChunkedBuild = async (saved) => {
    setLoading(true);
    setError("");
    setProgress(0);
    setProgressLabel("");
    setElapsedSec(0);

    const nightsNum = saved.nightsNum || 3;
    const citiesCount = saved.citiesCount || 1;
    const expectedDays = saved.expectedDays || nightsNum + 1;
    const savedChunks = Array.isArray(saved.chunks) ? saved.chunks : [];
    // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
    const startedAt = Date.now();
    const targetSec = Math.round(90 + (savedChunks.length + 1) * 60 + Math.max(0, citiesCount - 1) * 30);

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
    }, 250);

    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeoutMs = Math.max(600000, targetSec * 1000 * 3);
    const hardTimeout = setTimeout(() => controller.abort(new Error("Polled too long")), hardTimeoutMs);
    const maxPollMsForTrip = Math.max(15 * 60 * 1000, Math.round(targetSec * 1000 * 2.5));

    // Re-persist progress as resume advances so a SECOND interruption (during
    // the resume itself) still knows which chunks are now done. We rewrite the
    // same version-2 shape, preserving the stored bodies for any chunk we
    // haven't yet re-run.
    const chunkMeta = savedChunks.map((c) => ({
      startDay: c.startDay,
      endDay: c.endDay,
      cityNames: Array.isArray(c.cityNames) ? c.cityNames : [],
      maxTokens: c.maxTokens,
      jobId: c.jobId || null,
      status: c.status || "pending",
    }));
    const chunkBodies = Array.isArray(saved.chunkBodies)
      ? saved.chunkBodies.slice()
      : new Array(savedChunks.length).fill(null);
    let wrapperBodyForPersist = saved.wrapperBody || null;
    let wrapperJobId = saved.wrapperJobId || null;
    const persist = () => {
      const base = {
        chunked: true,
        version: 2,
        startedAt: saved.startedAt || startedAt,
        nightsNum,
        citiesCount,
        destination: saved.destination,
        expectedDays,
        chunks: chunkMeta,
        wrapperJobId,
      };
      try {
        localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({ ...base, chunkBodies, wrapperBody: wrapperBodyForPersist }));
      } catch {
        try { localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(base)); } catch {}
      }
    };

    setOutputsStep(true);
    setStep(2);
    setLoadingMsg(`Resuming build for ${saved.destination || "your trip"}…`);

    try {
      const chunkPlans = [];
      const usedRestaurants = [];

      for (let i = 0; i < savedChunks.length; i++) {
        const c = savedChunks[i];
        const chunkLabel = `${c.startDay}–${c.endDay}`;
        setProgress(Math.max(0.02, i / (savedChunks.length + 1)));

        // Probe KV for this chunk's job (if we have a jobId) and let the pure
        // classifier decide recover / reattach / rerun.
        let statusObj = null;
        const jobId = c.jobId;
        if (jobId) {
          try {
            const r = await fetch(`/api/build/${encodeURIComponent(jobId)}?cursor=0`, { signal: controller.signal });
            statusObj = r.ok ? await r.json() : { notFound: true };
          } catch (probeErr) {
            if (probeErr?.name === "AbortError") throw probeErr;
            statusObj = null; // network blip → treat as rerun
          }
        }
        const decision = classifyChunkResume(statusObj);

        let chunkPlan;
        if (decision === "recover") {
          // The whole tool JSON is already in KV (delta at cursor 0).
          setLoadingMsg(`Recovering days ${chunkLabel} (chunk ${i + 1}/${savedChunks.length})…`);
          chunkPlan = parseToolJson(statusObj.delta || "").parsed;
        } else if (decision === "reattach") {
          // Job still running — poll it to completion, accumulating the delta.
          setLoadingMsg(`Finishing days ${chunkLabel} (chunk ${i + 1}/${savedChunks.length})…`);
          let acc = "";
          await pollJob({
            jobId,
            signal: controller.signal,
            startCursor: 0,
            maxPollMs: maxPollMsForTrip,
            onDelta: (delta) => { acc += delta; },
          });
          chunkPlan = parseToolJson(acc).parsed;
        } else {
          // rerun — replay the EXACT stored body. Without it we can't faithfully
          // reproduce the prompt, so refuse rather than drift.
          setLoadingMsg(`Rebuilding days ${chunkLabel} (chunk ${i + 1}/${savedChunks.length})…`);
          const body = chunkBodies[i];
          if (!body) {
            throw new Error("Cannot resume — saved plan data is incomplete. Tap Build again.");
          }
          const { toolJson } = await generateChunk({
            body,
            controller,
            maxPollMsForTrip,
            chunkLabel,
            onJob: (id) => { chunkMeta[i].jobId = id; persist(); },
          });
          chunkPlan = parseToolJson(toolJson).parsed;
        }

        chunkPlans.push(chunkPlan);
        for (const name of collectRestaurantNames(chunkPlan)) usedRestaurants.push(name);
        chunkMeta[i].status = "done";
        persist();
      }

      // Wrapper pass — recover/reattach if its job is in KV, else replay the
      // stored wrapper body. The wrapper is non-essential: any failure here
      // soft-fails to {} so the itinerary still ships.
      setLoadingMsg("Assembling final plan…");
      setProgress(savedChunks.length / (savedChunks.length + 1));
      let wrapper = {};
      try {
        let wrapperJson = null;
        let wStatus = null;
        if (wrapperJobId) {
          try {
            const r = await fetch(`/api/build/${encodeURIComponent(wrapperJobId)}?cursor=0`, { signal: controller.signal });
            wStatus = r.ok ? await r.json() : { notFound: true };
          } catch (probeErr) {
            if (probeErr?.name === "AbortError") throw probeErr;
            wStatus = null;
          }
        }
        const wDecision = classifyChunkResume(wStatus);
        if (wDecision === "recover") {
          wrapperJson = wStatus.delta || "";
        } else if (wDecision === "reattach") {
          let acc = "";
          await pollJob({
            jobId: wrapperJobId,
            signal: controller.signal,
            startCursor: 0,
            maxPollMs: maxPollMsForTrip,
            onDelta: (delta) => { acc += delta; },
          });
          wrapperJson = acc;
        } else if (wrapperBodyForPersist) {
          const { toolJson } = await streamBuildJob(wrapperBodyForPersist, {
            signal: controller.signal,
            maxPollMs: maxPollMsForTrip,
            onJob: (id) => { wrapperJobId = id; persist(); },
            onDelta: () => {},
          });
          wrapperJson = toolJson;
        }
        wrapper = wrapperJson ? (parseToolJson(wrapperJson).parsed || {}) : {};
      } catch (wrapErr) {
        if (wrapErr?.name === "AbortError") throw wrapErr;
        wrapper = {};
      }

      finishChunkedBuild({ chunkPlans, wrapperParsed: wrapper, expectedDays, nightsNum });
    } catch (err) {
      // Same catch semantics as runChunkedBuild: keep the key on a cancel/
      // timeout abort so the user can reopen to resume, dedicated copy for an
      // expired job, clear only on a genuine hard error.
      let msg;
      if (err?.name === "AbortError") {
        msg = "Build cancelled. The server may still be finishing — reopen the page within a few minutes to resume.";
      } else if (err?.notFound) {
        msg = "That build expired or was not found. Tap Build again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      } else {
        msg = err?.message || "Something went wrong generating the plan. Please try again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      }
      setError(msg);
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      abortRef.current = null;
      setLoading(false);
      setLoadingMsg("");
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  const handleBuild = async () => {
    // Estimate plan size for the progress-bar token model. For multi-city the
    // user puts nights per leg (basics.nights stays empty) so we must derive
    // the true total from cities[] — otherwise progress caps at the wrong
    // ceiling and we under-budget the timeout.
    const totalNightsBuild = isMultiCity
      ? cities.reduce((sum, c) => sum + (parseInt(c?.nights, 10) || 0), 0)
      : (parseInt(basics.nights || "3", 10) || 3);
    const nightsNum = Math.max(1, totalNightsBuild);
    const citiesCount = isMultiCity ? cities.length : 1;
    // Multi-city plans add inter-city legs, more hotels, more restaurants —
    // budget extra tokens per additional city so progress doesn't peg at 95%.
    const expectedTokens = 1200 + (nightsNum + 1) * 1300 + Math.max(0, citiesCount - 1) * 1500;

    // Build the Anthropic request body once and ship it to the server. The
    // server stores it under a jobId, returns immediately, and runs the
    // Anthropic stream in the background using waitUntil so the build
    // survives a window close, tab close, screen sleep, or network drop.
    //
    // max_tokens scales with trip size, but the practical ceiling is set by
    // how long Claude can stream before the connection gets unhappy. At
    // ~60 output tokens/sec, 24k tokens ≈ 6.5 minutes — inside the window
    // where SSE stays stable. 32k previously pushed 9+ minute generations
    // which were timing out 7-8 minutes in for big multi-city trips.
    //
    // The previous formula (4000 + nights*2000 + cities*1200 capped at 24000)
    // was tuned for sparse trips and truncated real luxury itineraries: an
    // 11-night single-city Venice computed 28000 → capped at 24000 → "plan
    // was cut off" because the model ran out of budget mid-days[] on a
    // content-dense European city with 5 items per day.
    //
    // Revised formula:
    //   floor: 5000 (system overhead for logistics/flags/planb/snobs/tonight)
    //   per-day: 2200 (was 2000) — luxury destinations need ~2200 tokens/day
    //                              for 5 items with names, addresses,
    //                              reservation notes, confirmation hints
    //   per-extra-city: 1200 (unchanged — multi-city overhead)
    //   cap: 32000 (was 24000)
    //
    // Cap raised to 32000 to match the full-revision flow's max_tokens —
    // the original 24k build cap was perversely below its own revision
    // pass. 32k at ~60 tok/s ≈ 9 min: at the edge of SSE stability but
    // the build pipeline runs in a Worker with ctx.waitUntil and stores
    // chunks in KV, so a client-side SSE timeout doesn't lose the build
    // — the user can reconnect/poll and pick up where they left off.
    //
    // Worked examples (now capped at 40000):
    //   3-night single-city:   5000 + 4*2200 + 0           = 13800
    //   7-night single-city:   5000 + 8*2200 + 0           = 22600
    //   11-night single-city:  5000 + 12*2200 + 0          = 31400
    //   14-night single-city:  5000 + 15*2200 + 0          = 38000  (under cap)
    //   12-night 7-city:       5000 + 13*2200 + 6*1200     = 40800 → capped 40000
    //                            (the Croatia Rovinj→Plitvice→Zadar→Dubrovnik
    //                             →Korčula→Hvar→Split case — user-reported
    //                             truncation screenshot 2026-06-08)
    //   14-night 4-city:       5000 + 15*2200 + 3*1200     = 41600 → capped 40000
    //
    // Cap raised 32k → 40k → 48k → 64k as real trips saturated each prior
    // ceiling. 64k is the Sonnet-4-5 hard maximum for output tokens — we've
    // now used the full model budget, so any further truncation is a model-
    // ceiling problem (would need to split the build) rather than something
    // we can solve by raising a cap.
    //
    // Earlier ceilings and the trips that broke them:
    //   24k → truncated 11n/1c Venice (PR #11)
    //   32k → truncated 12n/7c Croatia (PR #12)
    //   40k → truncated 11n/9c Croatia empty planb (PR #19)
    //   48k → still truncated (user-reported 2026-06-08) — this PR
    //
    // 64k at ~60 tok/s ≈ 17.5 min worst case — well past the SSE comfort
    // window. The build pipeline already runs in a Worker with
    // ctx.waitUntil + JOBS KV chunk storage, so a client-side SSE drop
    // doesn't lose the build (user reconnects via /api/build/[id]). PR #15's
    // 'still building' indicator keeps long-tail waits honest.
    //
    // Cost note: max_tokens is a CEILING, not a floor. Small trips use a
    // fraction of this. A weekend trip emits ~14k tokens regardless of the
    // cap; the cap only matters for the bottom 1-2% of heroic itineraries.
    const maxTokensForTrip = Math.min(
      64000,
      // Floor reverted to 5000: the introduction is no longer generated by
      // the planner (handled externally and pasted in), so the ~600-token
      // bump that PR #18 added is no longer needed.
      Math.max(8000, 5000 + (nightsNum + 1) * 2200 + Math.max(0, citiesCount - 1) * 1200),
    );
    let userPromptForBuild = buildUserPrompt();
    // buildSystemPrompt() now returns { staticRules, dynamicPreamble } so we
    // can mark the static rulebook (byte-identical across every trip) as the
    // cached prefix and ship the per-trip preamble as a separate block.
    const { staticRules, dynamicPreamble } = buildSystemPrompt();

    // -------------------------------------------------------------------
    // Pre-build LOCAL KNOWLEDGE PASS — fire /api/review-retrieve against
    // the default reviewer sources (CN Traveler, Michelin Guide, NYT 36
    // Hours, Reddit + locals, Atlas Obscura, Substack travel) to ground
    // the plan on current, real-world picks instead of training data
    // alone. This is what users mean by "local knowledge" — the model gets
    // the SAME insider snippets the Pro Review pass would use, but
    // applies them DURING the build, not after.
    //
    // Soft-fail: if the retrieval is slow, errors, or returns empty, we
    // ship the build with the original prompt. The user's plan still
    // lands; it just doesn't get the live-source bump.
    //
    // Time cost: ~5-10s for the 6 default sources in parallel (each
    // server-side capped at 8s per Sonar call, 15s total). KV-cached so
    // re-running builds for the same destination is free.
    // -------------------------------------------------------------------
    // Flip loading state ON here so the user sees the retrieval-phase
    // message instead of an unresponsive button while we wait on Sonar.
    setLoading(true);
    setError("");
    setLoadingMsg("Pulling local sources…");
    const destForRetrieve = (basics?.destination || (Array.isArray(basics?.cities) ? basics.cities.map(c => c?.name).filter(Boolean).join(" ") : "") || "").trim();
    if (destForRetrieve) {
      try {
        const retrieveCtrl = new AbortController();
        const retrieveTimeout = setTimeout(() => retrieveCtrl.abort(), 18000);
        // #8 Use the user's PRE-BUILD picked reviewer sources (lifted to wizard
        // state) instead of the hardcoded defaults. Falls back to the dflt set if
        // somehow empty, so the pre-build local-knowledge pass always has sources.
        const preBuildSourceIds = (Array.isArray(reviewerSourceIds) && reviewerSourceIds.length)
          ? reviewerSourceIds
          : REVIEWER_SOURCES.filter(s => s.dflt).map(s => s.id);
        const retrieveResp = await fetch("/api/review-retrieve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: retrieveCtrl.signal,
          body: JSON.stringify({
            destination: destForRetrieve,
            restaurants: Array.isArray(restaurants) ? restaurants.slice(0, 6) : [],
            activities: Array.isArray(activities) ? activities.slice(0, 4) : [],
            sources: preBuildSourceIds,
          }),
        });
        clearTimeout(retrieveTimeout);
        if (retrieveResp.ok) {
          const retrieveJson = await retrieveResp.json().catch(() => ({}));
          const snippetGroups = Array.isArray(retrieveJson?.snippets) ? retrieveJson.snippets : [];
          // Render each source as a labelled block of "<title> — <snippet> [<url>]"
          // lines so the model can cite + dedupe. Keep small (~3 KB) so it
          // doesn't displace user inputs in the prompt.
          const lines = [];
          for (const group of snippetGroups) {
            const items = Array.isArray(group?.results) ? group.results : [];
            if (items.length === 0) continue;
            lines.push(`### ${group.source_name || group.source_id}`);
            for (const it of items.slice(0, 3)) {
              const title = String(it?.title || "").trim();
              const snippet = String(it?.snippet || "").trim().slice(0, 280);
              const url = String(it?.url || "").trim();
              if (!title && !snippet) continue;
              lines.push(`- ${title}${snippet ? ": " + snippet : ""}${url ? " (" + url + ")" : ""}`);
            }
          }
          if (lines.length > 0) {
            userPromptForBuild += `\n\nLOCAL KNOWLEDGE — LIVE SOURCES (auto-retrieved for this destination):\nUse these snippets to ground hotel, restaurant, and activity picks on current, real-world editorial coverage instead of training-data memory alone. Prefer venues mentioned here when they fit the trip's tier and style. Do NOT invent quotes or facts beyond what's stated.\n\n${lines.join("\n")}`;
            try { console.info("[trip-optimizer] local-knowledge injected:", { groups: snippetGroups.length, totalLines: lines.length }); } catch {}
          }
        }
      } catch (retrieveErr) {
        // Aborted = timeout (18s ceiling) or user pressed Cancel. Either way
        // we ship the build without the snippets — plan still gets made.
        try { console.warn("[trip-optimizer] local-knowledge retrieval skipped:", retrieveErr?.message || retrieveErr); } catch {}
      }
    }

    // Large trips would need a single max_tokens budget past the model's
    // output ceiling and the client polling window, so they time out. When the
    // single-call estimate exceeds the safe budget, split the build into
    // day-range chunks + a wrapper pass and stitch the result. Small/medium
    // trips (at/below the threshold) keep the EXISTING single-call path below,
    // byte-for-byte unchanged.
    if (shouldChunk({ nights: nightsNum, citiesCount })) {
      const chunks = planDayChunks({ nights: nightsNum, cities: isMultiCity ? cities : null });
      await runChunkedBuild({ nightsNum, citiesCount, chunks, staticRules, dynamicPreamble, userPromptForBuild });
      return;
    }

    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: maxTokensForTrip,
      system: cachedSystemBlocks(staticRules, dynamicPreamble),
      messages: [{ role: "user", content: userPromptForBuild }],
      tools: cachedTools([TRIP_PLAN_TOOL]),
      tool_choice: { type: "tool", name: "submit_trip_plan" },
    };
    // Diagnostic — confirm the freeform boxes are actually reaching the model.
    // Open DevTools → Console before clicking Build. If the GUIDELINES / NARRATIVE
    // line shows '(empty)' but you typed in the box, we have a state-capture bug.
    // If it shows your text, but the resulting plan ignores it, the prompt itself
    // needs to be louder.
    try {
      console.info(
        "[trip-optimizer] build prompt freeform inputs:",
        {
          guidelinesChars: (guidelines || "").length,
          guidelinesPreview: (guidelines || "").slice(0, 240) || "(empty)",
          narrativeChars: (narrative || "").length,
          narrativePreview: (narrative || "").slice(0, 240) || "(empty)",
          userPromptIncludesGuidelinesBlock: userPromptForBuild.includes("TRIP GUIDELINES"),
          userPromptIncludesNarrativeBlock: userPromptForBuild.includes("TRAVELER NARRATIVE"),
        },
      );
    } catch {}

    setLoadingMsg("Starting build…");

    // Open the streaming POST. The server now returns an NDJSON body whose
    // FIRST line is {"type":"job","jobId":"..."} so we read just enough to
    // capture the jobId, persist it for resume, and then hand the same
    // open response to runBuildForJob which reads the remaining deltas.
    let streamResp;
    let startedAt;
    try {
      streamResp = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!streamResp.ok) {
        const txt = await streamResp.text();
        let msg = `Could not start build (HTTP ${streamResp.status}).`;
        try { const j = JSON.parse(txt); msg = j?.error?.message || msg; } catch { if (txt) msg = txt.slice(0, 240); }
        throw new Error(msg);
      }
      // Peek the first NDJSON line via a tee'd reader so runBuildForJob can
      // still consume the full body. Simpler: read the head ourselves and
      // pre-prime toolJson via a small jobOnly handler. We use a one-shot
      // reader that grabs lines until we see the job event, then we pass the
      // SAME reader-bound body to the streamer by reading the underlying
      // body's reader via a TransformStream pipe. Implementation: use a
      // Response/ReadableStream split.
      //
      // Implementation chosen for simplicity: read the body ourselves in
      // streamBuildResponse() from inside runBuildForJob and use the
      // onJob callback to capture the jobId.
      // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
      startedAt = Date.now();
    } catch (err) {
      setError(cleanErrorMessage(err?.message, "Could not start build. Please try again."));
      setLoading(false);
      setLoadingMsg("");
      return;
    }

    // We need the jobId for the localStorage active-job key before we hand
    // the response off to runBuildForJob. Read just the first line here.
    // streamBuildResponse() inside runBuildForJob will continue from the
    // remaining bytes (the TextDecoder buffer is per-reader so we keep one).
    //
    // To keep this simple and robust, runBuildForJob accepts the open
    // response and calls streamBuildResponse with an onJob callback that
    // writes localStorage as soon as the jobId lands.
    await runBuildForJob({
      jobId: null,
      nightsNum,
      expectedTokens,
      startedAt,
      citiesCount,
      streamResp,
      onJobIdReady: (id) => {
        try {
          localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({
            jobId: id,
            startedAt,
            nightsNum,
            expectedTokens,
            citiesCount,
            destination: basics.destination || (basics.cities?.[0]?.name) || "your trip",
          }));
        } catch {}
      },
    });
  };

  // Auto-scroll the streaming-progress panel into view when a build starts.
  // On a long wizard the panel renders below the fold, so without this the
  // user clicks Build and sees no visible change. We fire only on the rising
  // edge of `loading` (false -> true) so it scrolls exactly once per build and
  // does NOT re-scroll on the many progress-driven re-renders while the build
  // is already running — which means if the user manually scrolls away
  // mid-build, we don't snap them back. Cancelling resets loading to false
  // (handleCancel), so a fresh start gives a new rising edge and re-scrolls.
  useEffect(() => {
    const rising = loading && !prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (!rising) return;
    // Wait one frame so the panel (gated on `loading`) has mounted before we
    // measure/scroll to it; the ref is null on the render that flips loading.
    const raf = window.requestAnimationFrame(() => {
      progressPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [loading]);

  // Deferred build trigger for the "Build from this" shortcut.
  // buildFromGuidelines extracts fields from the narrative, calls all the
  // setters, and sets pendingBuildFromGuidelines=true. On the NEXT render
  // (after React flushes those setters), this effect fires handleBuild() with
  // the fresh closure, so the prompt builders see the extracted values. We
  // also gate on basics.destination because the build can't resolve geography
  // without one — if extraction couldn't find a destination, the effect
  // disarms itself and the API's 422 path has already surfaced a clear error.
  useEffect(() => {
    if (!pendingBuildFromGuidelines) return;
    // All state changes happen on the next tick so the eslint react-compiler
    // doesn't flag synchronous-setState-in-effect. We still run on the very
    // next event-loop turn, which is what we want — prompt builders need to
    // see the extracted values that just flushed.
    setTimeout(() => {
      if (!basics?.destination) {
        // Extraction succeeded server-side but didn't yield a destination on
        // this render. Surface a clear message instead of silently disarming
        // — prior behavior was "button dims for a moment then comes back, no
        // other activity", which was indistinguishable from a no-op click.
        setPendingBuildFromGuidelines(false);
        setLoadingMsg("");
        setError("Couldn't pick a destination out of your narrative. Add a city or region name and try again, or fill the form below.");
        setOutputsStep(false);
        setStep(1);
        return;
      }
      setPendingBuildFromGuidelines(false);
      setOutputsStep(true);
      setStep(2);
      handleBuild();
    }, 0);
    // We intentionally only depend on the trigger flag + destination — every
    // other state piece is read fresh inside handleBuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBuildFromGuidelines, basics?.destination]);

  // Resume an in-flight build if the user reopens the page during one. We
  // store the jobId + a few stats in localStorage when a build starts; if we
  // find a fresh one here on mount, re-attach to its server-side stream. The
  // build kept running on Cloudflare while the page was gone (waitUntil) —
  // we just rejoin the polling loop and pick up wherever the server is now.
  // Stale jobs (>30 min) are discarded so we don't poll into 404s forever.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    let raw;
    try { raw = localStorage.getItem(ACTIVE_JOB_KEY); } catch { return; }
    if (!raw) return;
    let saved;
    try { saved = JSON.parse(raw); } catch { return; }
    // Chunked builds persist a {chunked:true} payload with NO top-level jobId.
    // Route those to the sequential chunk-resume path. The single-call branch
    // below (which requires saved.jobId) stays reachable and unchanged.
    if (saved?.chunked) {
      // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
      const chunkedAge = Date.now() - (saved.startedAt || 0);
      if (chunkedAge > 30 * 60 * 1000 || !Array.isArray(saved.chunks) || !saved.chunks.length) {
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
        return;
      }
      // Defer to a microtask so the resume's synchronous setState calls (step,
      // loading) run outside the effect body — mirrors how the single-call
      // branch only flips state inside its async probe `.then`. resumeChunkedBuild
      // sets step 2 + the resuming message itself.
      Promise.resolve().then(() => resumeChunkedBuild(saved));
      return;
    }
    if (!saved?.jobId) return;
    // eslint-disable-next-line react-hooks/purity -- inside async event handler, not render
    const age = Date.now() - (saved.startedAt || 0);
    if (age > 30 * 60 * 1000) {
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      return;
    }
    // Probe the job first so we don't show a spinner for an expired/missing one.
    // ONLY resume if the server says the build is still running. If status is
    // 'done' or 'error' (e.g. previous timeout / partial completion), clear
    // the key and stay on the home page — the user already navigated away
    // and we shouldn't force them back into a stuck build screen.
    fetch(`/api/build/${encodeURIComponent(saved.jobId)}?cursor=0`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || data.notFound || data?.status !== "running") {
          try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
          return;
        }
        setOutputsStep(true);
        setStep(2);
        setLoadingMsg(`Resuming build for ${saved.destination || "your trip"}…`);
        runBuildForJob({
          jobId: saved.jobId,
          nightsNum: saved.nightsNum || 3,
          expectedTokens: saved.expectedTokens || 6500,
          startedAt: saved.startedAt || Date.now(),
          citiesCount: saved.citiesCount || 1,
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const outputDefs = [
    ["itinerary","Day-by-day itinerary","Full sequenced schedule with timing"],
    ["weather","Weather per day","Forecast strip with rain %, wind, sunrise / sunset"],
    ["navigation","One-tap navigation","Google Maps, Apple Maps, Waze on each driving day"],
    ["logistics","Logistics callout cards","Flights, hotel, car — each as a structured card"],
    ["tonight",'"Do this tonight" prompts',"Sequenced evening reminders keyed to the next day"],
    ["menus","Restaurant menu links","Inline menu link per dining recommendation"],
    ["flags","Constraint flags","Closed days, booking lead times, dead zones"],
    ["planb","Plan B alternatives","Fallbacks for weather cancellations or closures"],
    ["snobs","Snob's guide","Insider tone — what to know, skip, and say"],
    ["practical","Practical notes","Tipping, dress, connectivity, altitude"],
    ["badges","Personal recommendation badges","Flag places you've personally visited"],
    ["pronunciation","Pronunciation guide","Phonetic hints on unfamiliar place names"],
  ];

  // Called by ReviewPanel when the user applies revisions and we have a new
  // plan (either surgically patched or fully re-planned). We replace the
  // displayed result and, if this plan came from a saved trip entry, also
  // persist the new plan into that entry so re-opening preserves the edits.
  const handlePlanRevised = (newPlan) => {
    if (!newPlan) return;
    // Carry over any pre-existing _review marker; ReviewPanel will overwrite
    // it shortly via onReviewChange.
    const merged = reviewState ? { ...newPlan, _review: reviewState } : newPlan;
    setResult(merged);
    if (currentSavedTripId) {
      const list = loadSavedTrips();
      const next = list.map(t => t.id === currentSavedTripId ? { ...t, result: merged } : t);
      writeSavedTrips(next);
      refreshSavedTrips();
    }
  };

  // Called by ReviewPanel whenever review state changes (sources/findings/
  // applied_ids). We attach it to the current result as _review and persist
  // back into the saved-trip entry if we have one.
  const handleReviewChange = (next) => {
    setReviewState(next);
    setResult(prev => prev ? { ...prev, _review: next } : prev);
    if (currentSavedTripId) {
      const list = loadSavedTrips();
      const updated = list.map(t => {
        if (t.id !== currentSavedTripId) return t;
        return { ...t, result: { ...t.result, _review: next } };
      });
      writeSavedTrips(updated);
      refreshSavedTrips();
    }
  };

  // Phones can't fit the 2- and 3-column form grids without overflowing a
  // ~390px viewport, so collapse them to a single column on mobile. Desktop
  // and tablet keep the multi-column layout via the shared g2/g3 consts.
  const g2r = vp.isMobile ? { ...g2, gridTemplateColumns: "1fr", gap: "14px" } : g2;
  const g3r = vp.isMobile ? { ...g3, gridTemplateColumns: "1fr", gap: "14px" } : g3;
  // Trim the card's horizontal padding on phones so nested fields keep more
  // usable width inside a ~390px viewport.
  const cardStyleR = vp.isMobile ? { ...cardStyle, padding: "1rem 1.1rem" } : cardStyle;

  // Shared centered-column width for the wizard. The header band and the body
  // both center their content to this width so the brand/mode-toggle line up
  // with the form cards instead of the header hugging the far-left gutter on
  // wide desktops while the cards sit in a centered column.
  const colMaxWidth = vp.isMobile ? "100%" : vp.isTablet ? "720px" : vp.isDesktop ? "960px" : "1180px";

  return (
    <div style={{ fontFamily: "var(--font-sans)", color: "var(--color-text-primary)" }}>

      {/* #9 — First-visit App Intro overlay. Self-gated; renders null when
          already dismissed, when ?direct=1 is on the URL, or when running
          as an installed PWA. Sits above the wizard chrome at z-index 9999. */}
      <AppIntroOverlay />

      <div style={{ padding: vp.isMobile ? "1.5rem 0 1.25rem" : "2rem 0 1.75rem", borderBottom: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)" }}>
        <div style={{ maxWidth: colMaxWidth, margin: "0 auto", padding: vp.isMobile ? "0 1rem" : "0 1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: "500", margin: "0 0 8px", color: "var(--color-text-secondary)" }}>Travel planning</p>
            <img src="/rs3-wordmark.svg?v=3" alt="Route Smith" style={{ display: "block", height: vp.isMobile ? "44px" : "64px", width: "auto", margin: "0 0 10px" }} />
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
              <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Powered by</span>
              <img
                src="/brand-wordmark.png?v=2"
                alt="Barrier Island Digital, LLC"
                style={{ display: "block", height: "22px", width: "auto", opacity: 0.9 }}
              />
            </div>
          </div>
          {/* #1 Hero Reset — always available on the hero so the user can start
              fresh without hunting for the in-form reset. Destructive, so it
              confirms first; resets form, plan, review state, and outputs. */}
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Start over? This clears the current trip details, the built itinerary, and resets section choices.")) {
                resetFormToBlank();
                setOut(resolveOutputs(null));
                setResult(null);
                setCurrentSavedTripId(null);
                setReviewState(null);
                setOutputsStep(false);
                setStep(1);
                try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
              }
            }}
            aria-label="Reset and start over"
            title="Clear everything and start a fresh trip"
            style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "6px", background: "transparent", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "7px 12px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", fontWeight: 500, whiteSpace: "nowrap" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 3v5h5" />
            </svg>
            <span>Reset</span>
          </button>
        </div>
        <hr style={{ border: "none", borderTop: `1px solid ${GOLD}`, width: "32px", margin: "14px 0 18px" }} />

        {/* Single primary surface (full trip build) with a mode toggle for
            find-only. The toggle lives here — outside the wizard module — so
            flipping it swaps the whole body to the inline FindView without
            navigating to /find. The intro copy tracks the active mode so the
            header never reads as an orphaned card. */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: "1 1 280px" }}>
            <p style={{ fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, color: GOLD_DARK, margin: "0 0 6px" }}>
              {findOnly ? "Find local info only" : "Full itinerary build"}
            </p>
            <p style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-text-primary)", margin: "0 0 4px", lineHeight: 1.3 }}>
              {findOnly ? "Find places in a location" : "Build a full trip plan"}
            </p>
            <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.45, maxWidth: "52ch" }}>
              {findOnly
                ? "Skip the wizard. Type a city, get hand-picked restaurants and activities in about a minute, with locals' picks auto-added."
                : (() => {
                    const base = "Day-by-day itinerary with hotels, restaurants, activities, transport. ";
                    if (canEstimateBuild(basics)) {
                      const { text } = estimateBuildMinutes({
                        nights: basics.nights,
                        citiesCount: (cities && cities.length) || 1,
                        outputsCount: Object.values(outputs || {}).filter(Boolean).length,
                      });
                      return base + `Estimated ${text} for this trip — larger trips take longer.`;
                    }
                    return base + "Can take more than 5 minutes depending on trip size.";
                  })()}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={findOnly}
            aria-label="Find local info only"
            title="Toggle find-only mode — restaurants and activities, no full itinerary"
            onClick={() => setFindOnly(v => !v)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px 14px",
              border: `1px solid ${findOnly ? GOLD : "var(--color-border-secondary)"}`,
              borderRadius: "var(--border-radius-md)",
              background: findOnly ? GOLD_LIGHT : "var(--color-background-primary)",
              cursor: "pointer",
              fontFamily: "inherit",
              minHeight: "44px",
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>Find local info only</span>
            <span aria-hidden="true" style={{ width: "34px", height: "20px", borderRadius: "999px", background: findOnly ? GOLD : "var(--color-border-secondary)", position: "relative", transition: "background 0.15s", flexShrink: 0 }}>
              <span style={{ position: "absolute", top: "2px", left: findOnly ? "16px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "var(--color-background-primary)", transition: "left 0.15s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
            </span>
          </button>
        </div>
        </div>
      </div>

      {findOnly ? (
        // Find-only mode reuses the standalone FindView verbatim, rendered
        // inline. `embedded` suppresses FindView's own brand/back-link header
        // band because this surface already shows the brand header above with
        // the mode toggle; the toggle is the way back to the wizard.
        <FindView embedded />
      ) : (
      /* Wizard body container. The 100% → 720 → 960 → 1180 progression
          gives mobile full bleed for tappability, tablet a comfortable
          centered column, desktop room to breathe, and wide screens
          (1280px+ external monitors / Windows desktops at 1536+) enough
          width that the page no longer looks like a mobile site stranded
          in a sea of grey. We still cap at 1180 even on 4K screens because
          the wizard is fundamentally a single-column form — a 1600px-wide
          form is harder to scan, not easier. */
      <div style={{
        maxWidth: colMaxWidth,
        margin: "0 auto",
        padding: vp.isMobile ? "1.5rem 1rem 2.5rem" : "1.75rem 1.5rem 2.5rem",
      }}>

        {/* Step pills double as navigation — a tap jumps to that step,
            including back to Step 3 once a plan has been built. The Your
            plan pill is only navigable when a result exists; Essentials
            and Details are always navigable. Current step is bold + gold,
            other navigable steps render as buttons styled like text. */}
        <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "1.75rem", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-text-secondary)", flexWrap: "wrap" }}>
          {["Essentials", "Details", "Your plan"].map((s, i) => {
            const targetStep = i + 1;
            const isCurrent = step === targetStep;
            // Step 3 is only navigable when a plan exists. Steps 1 & 2 are
            // always navigable so the user can revisit inputs at any time.
            const isNavigable = !isCurrent && (targetStep < 3 || (targetStep === 3 && !!result));
            const dotColor = step >= targetStep ? GOLD : "var(--color-border-secondary)";
            const textColor = isCurrent
              ? GOLD
              : (step > targetStep || isNavigable ? "var(--color-text-primary)" : "var(--color-text-tertiary)");
            const navHandler = () => {
              if (!isNavigable) return;
              // Re-entering Details via the step nav always lands on the Details
              // screen, not the Outputs screen, so the build trigger stays gated.
              if (targetStep === 2) setOutputsStep(false);
              setStep(targetStep);
              try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
            };
            return (
              <Fragment key={s}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: dotColor, display: "inline-block", flexShrink: 0 }} />
                {isNavigable ? (
                  <button
                    type="button"
                    onClick={navHandler}
                    title={`Go to ${s}`}
                    style={{ background: "transparent", border: "none", padding: "2px 0", cursor: "pointer", color: textColor, fontSize: "inherit", letterSpacing: "inherit", textTransform: "inherit", fontFamily: "inherit", textDecoration: "underline", textDecorationColor: "rgba(91, 101, 119, 0.4)", textUnderlineOffset: "3px" }}
                  >{s}</button>
                ) : (
                  <span style={{ color: textColor, fontWeight: isCurrent ? 600 : 400 }}>{s}</span>
                )}
                {i < 2 && <span style={{ color: "var(--color-border-secondary)", margin: "0 2px" }}>·</span>}
              </Fragment>
            );
          })}
        </div>

        {step === 1 && (
          <div>
            <SavedTripsPanel trips={savedTrips} onOpen={handleOpenSavedTrip} onDelete={handleDeleteSavedTrip} />
            <StaleChipsBanner suggestion={staleSuggestion} onClear={clearStaleChips} onDismiss={dismissStale} />
            {(() => {
              const hasContent = !!(basics.destination || basics.startDate || basics.endDate || basics.baseArea || basics.travelers || (cities && cities.some(c => c.name)) || (restaurants && restaurants.length > 0) || (activities && activities.length > 0) || result);
              if (!hasContent) return null;
              return (
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm("Clear all trip details and start fresh?")) {
                        resetFormToBlank();
                        setResult(null);
                        setCurrentSavedTripId(null);
                        setReviewState(null);
                      }
                    }}
                    aria-label="Reset plan"
                    title="Clear all trip details and start fresh"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      background: "transparent",
                      color: GOLD,
                      border: `0.5px solid ${GOLD}`,
                      borderRadius: "var(--border-radius-md)",
                      padding: "7px 12px",
                      fontSize: "11px",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontWeight: 500,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 12a9 9 0 1 0 3-6.7" />
                      <path d="M3 3v5h5" />
                    </svg>
                    <span>Reset plan</span>
                  </button>
                </div>
              );
            })()}
            {/* HERO GUIDELINES — the very first thing the user sees on step 1.
                High-level direction the planner should apply to every decision
                below. Conceptually a level above the destination/dates form
                and a level above the per-trip narrative. Distinct from the
                step-2 "Tell me about the trip" narrative: guidelines are the
                META-rules (pacing posture, mobility, anniversary framing,
                budget posture, anchor rhythm), narrative is the SPECIFICS
                (confirmation numbers, named guides, exact hotels). Both flow
                into the prompt; guidelines render first. */}
            <div style={{ ...cardStyleR, borderLeft: `2px solid ${GOLD}`, marginBottom: "1.25rem" }}>
              <p style={ctStyle}>Trip guidelines</p>
              <Field label="Tell the planner everything you already know about this trip" hint="Type or dictate. Dump anything that matters: booked flights with numbers and times, hotel names, restaurants with reservation times, named drivers or guides, anniversary or kids' ages, mobility notes, pacing preferences, things to avoid. The planner reads this as the source of truth — every named flight, hotel, and restaurant is used EXACTLY, not substituted.">
                <NarrativeBox
                  value={guidelines}
                  onChange={e => setGuidelines(e.target.value)}
                  placeholder={"e.g. United UA 57 EWR→CDG Sept 12 dep 18:55, return UA 58 Sept 19. Staying at Le Bristol Paris Sept 12–19, conf #BRST44A21. Dinners: Le Comptoir du Relais night 1, Le Cinq for anniversary on the 14th (already booked, 8pm), Frenchie night 3. Want a private driver from arrival through departure. Wife has a knee injury — no long walks or stairs-heavy days. Home by 9pm. Skip the Louvre, we've done it."}
                />
              </Field>
              {/* "Build from this →" shortcut. Appears when the box looks like
                  a real trip prompt: ≥ 20 chars AND ≥ 4 whitespace-separated
                  tokens. Covers short brain-dumps like "3 nights in Saratoga.
                  High end. October" (39 chars / 7 tokens) while still hiding
                  the button for one-word fragments or random scribbles.
                  Click → extract fields from narrative → jump straight to
                  build. The full guidelines text still flows through to the
                  build prompt as SOURCE OF TRUTH, so nothing is lost in
                  translation. /api/extract-trip returns a 422 (already
                  surfaced inline below) if it can't find a destination, so a
                  generous client gate is safe. */}
              {(() => {
                const t = (guidelines || "").trim();
                if (t.length < 20) return false;
                const tokens = t.split(/\s+/).filter(Boolean).length;
                return tokens >= 4;
              })() && (
                <div style={{ marginTop: "14px", display: "flex", flexDirection: "column", alignItems: "stretch", gap: "6px" }}>
                  <button
                    type="button"
                    onClick={buildFromGuidelines}
                    disabled={extractingFromGuidelines || loading}
                    style={{
                      border: "none",
                      borderRadius: "var(--border-radius-md)",
                      padding: "13px 20px",
                      fontSize: "11px",
                      fontWeight: 500,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      cursor: (extractingFromGuidelines || loading) ? "not-allowed" : "pointer",
                      width: "100%",
                      fontFamily: "inherit",
                      background: GOLD,
                      color: ON_NAVY,
                      opacity: (extractingFromGuidelines || loading) ? 0.6 : 1,
                    }}
                    aria-label="Build the trip directly from this narrative"
                  >
                    {extractingFromGuidelines ? "Reading your narrative…" : "Build from this →"}
                  </button>
                  {/* Inline error surface for the shortcut. Step 1 has no
                      global error banner, so a 422 from /api/extract-trip
                      (or a network blip) used to dim the button and vanish
                      with no feedback. Render error here so the user sees it. */}
                  {error && (
                    <p role="alert" style={{ fontSize: "12px", color: "var(--color-text-danger, var(--color-text-danger))", margin: 0, textAlign: "center", lineHeight: 1.5 }}>{error}</p>
                  )}
                  <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0, textAlign: "center", fontStyle: "italic", lineHeight: 1.5 }}>
                    Skip the form — we'll extract destination, dates, and details and build straight from your narrative.
                  </p>
                </div>
              )}
            </div>

            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "1.5rem", lineHeight: "1.65" }}>Four essentials to start. Refine the details after, or build immediately.</p>

            <div style={cardStyleR}>
              <p style={ctStyle}>Where & when</p>
              <div style={g2r}>
                {/* When multi-city, Trip Route needs the full row width or the city
                    input collapses to zero. Span both grid columns; Home airport
                    wraps to the next row below. */}
                <div style={{ gridColumn: isMultiCity ? "1 / -1" : "auto", minWidth: 0 }}>
                <Field label={isMultiCity ? "Trip route" : "Destination"} hint={isMultiCity ? `${cities.length}-city trip · ${totalNightsFromCities} nights total` : null}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {cities.map((c, i) => (
                      <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                        {isMultiCity && (
                          <span style={{ fontSize: "9.5px", fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 0 0", whiteSpace: "nowrap", flex: "0 0 auto" }}>Leg {i + 1}</span>
                        )}
                        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                          <CityAutocomplete value={c.name} onChange={e => updateCity(i, { name: e.target.value })} placeholder={i === 0 ? "Start typing a city…" : "Next city…"} />
                        </div>
                        {isMultiCity && (
                          <div style={{ flex: "0 0 64px" }}>
                            <input type="number" min="1" max="14" value={c.nights} onChange={e => updateCity(i, { nights: e.target.value })} placeholder="nights" aria-label={`Nights in ${c.name || `city ${i + 1}`}`} style={{ fontSize: "14px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", textAlign: "center" }} />
                          </div>
                        )}
                        {isMultiCity && cities.length > 1 && (
                          <button onClick={() => removeCity(i)} aria-label={`Remove ${c.name || `city ${i + 1}`}`} style={{ background: "none", border: "none", color: "var(--color-text-tertiary)", fontSize: "20px", cursor: "pointer", padding: "4px 4px", lineHeight: 1, flex: "0 0 auto" }}>×</button>
                        )}
                      </div>
                    ))}
                    {cities.length < 3 && (
                      <button onClick={addCity} style={{ background: "none", border: `0.5px dashed ${GOLD}`, color: GOLD, fontSize: "10.5px", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", padding: "7px 10px", borderRadius: "4px", cursor: "pointer", alignSelf: "flex-start", fontFamily: "inherit" }}>+ Add city{cities.length === 1 ? " (multi-city trip)" : ""}</button>
                    )}
                  </div>
                </Field>
                </div>
                <Field label="Home airport" hint={flights.noFlight ? "Not flying — skip this" : (lookupAirport(flights.homeAirport) ? `${lookupAirport(flights.homeAirport).city} · ${lookupAirport(flights.homeAirport).name}` : null)}>
                  {flights.noFlight ? (
                    <div style={{ height: "38px", lineHeight: "38px", borderBottom: "0.5px solid var(--color-border-secondary)", fontSize: "14px", color: "var(--color-text-secondary)", fontStyle: "italic", opacity: 0.6 }}>Not flying</div>
                  ) : (
                    <AirportAutocomplete value={flights.homeAirport} onChange={e => setF({ ...flights, homeAirport: e.target.value })} placeholder="e.g. EWR" />
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "6px", fontSize: "11px", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>
                    <input type="checkbox" checked={!!flights.noFlight} onChange={e => setF({ ...flights, noFlight: e.target.checked, homeAirport: e.target.checked ? "" : flights.homeAirport, airline: e.target.checked ? "" : flights.airline, cabin: e.target.checked ? "" : flights.cabin })} style={{ accentColor: GOLD, margin: 0, cursor: "pointer" }} />
                    <span>Not flying (driving / train)</span>
                  </label>
                </Field>
              </div>
              <Field
                label="Trip dates"
                hint={endDateError || (basics.endDate && basics.startDate && diffDaysISO(basics.startDate, basics.endDate) > 0
                  ? `${diffDaysISO(basics.startDate, basics.endDate)} nights \u00b7 tap a day for start, then tap again for return`
                  : "Tap a day for start, then tap again for return")}
              >
                <DateRangeInput
                  startDate={basics.startDate}
                  endDate={basics.endDate || ""}
                  onRangeChange={handleDateRangeChange}
                />
              </Field>
              <div style={g2r}>
                <Field label={isMultiCity ? "Total nights" : "Nights"} hint={isMultiCity ? "Auto-summed from cities" : (basics.startDate && basics.endDate ? "Synced with dates" : null)}>
                  <Inp value={isMultiCity ? String(totalNightsFromCities) : basics.nights} onChange={e => { if (isMultiCity) return; handleNightsChange(e.target.value); }} placeholder="7" />
                </Field>
                <Field label="Travelers"><TravelersAutocomplete value={basics.travelers} onChange={e => setB({ ...basics, travelers: e.target.value })} placeholder="2 adults" /></Field>
              </div>
              {!isMultiCity && (
                <Field label="Base area or neighborhood" hint={areaHint}>
                  <BaseAreaAutocomplete value={basics.baseArea} onChange={e => setB({ ...basics, baseArea: e.target.value })} placeholder="Where in the destination?" destination={basics.destination} />
                </Field>
              )}
            </div>

            {/* Output Sections — collapsible, available on Step 1 so users can
                preview and trim add-on sections before continuing. Same outputs
                state as Step 2's Output Sections card. */}
            <div style={cardStyleR}>
              <button
                type="button"
                onClick={() => setStep1OutputsOpen(!step1OutputsOpen)}
                style={{ width: "100%", border: "none", background: "transparent", padding: 0, cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}
              >
                <span>
                  <span style={ctStyle}>{`Output sections  ·  ${activeCount} of 12 active`}</span>
                  {!step1OutputsOpen && (
                    <span style={{ display: "block", fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px", fontStyle: "italic" }}>
                      Want a slimmer PDF? Tap to choose which sections to include.
                    </span>
                  )}
                </span>
                <span style={{ flex: "0 0 auto", fontSize: "18px", color: GOLD, fontWeight: 300 }}>
                  {step1OutputsOpen ? "−" : "+"}
                </span>
              </button>
              {step1OutputsOpen && (
                <div style={{ marginTop: "10px" }}>
                  {outputDefs.map(([k, l, d]) => <Toggle key={k} label={l} desc={d} checked={outputs[k]} onChange={() => togOut(k)} disabled={k === "itinerary"} />)}
                </div>
              )}
            </div>

            <button disabled={!ready} onClick={() => { if (ready) { setOutputsStep(false); setStep(2); /* #2: always land at the top of Details (Trip style) on every viewport. Without this, mobile kept the prior scroll offset and opened partway down at Flights while desktop showed the top. */ try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); } } }}
              style={{ border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: ready ? "pointer" : "not-allowed", width: "100%", marginTop: "0.25rem", fontFamily: "inherit", background: ready ? "var(--color-text-primary)" : "var(--color-surface-offset)", color: ready ? "var(--color-background-primary)" : "var(--color-text-tertiary)", opacity: ready ? 1 : 0.7 }}>
              Continue — Add Details →
            </button>
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "8px", textAlign: "center", minHeight: "16px", fontStyle: "italic" }}>
              {!ready ? `Still needed: ${missing.join(", ")}` : ""}
            </p>
          </div>
        )}

        {step === 2 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem", gap: "10px" }}>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Return to the start? Your current trip details will be cleared.")) {
                    resetFormToBlank();
                    setCurrentSavedTripId(null);
                    setReviewState(null);
                    setStep(1);
                  }
                }}
                aria-label="Return to the start"
                title="Return to the start"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  border: "0.5px solid var(--color-border-secondary)",
                  borderRadius: "var(--border-radius-md)",
                  padding: "7px 12px",
                  fontSize: "11px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 10.5 12 3l9 7.5" />
                  <path d="M5 9.5V21h14V9.5" />
                </svg>
                <span>Home</span>
              </button>
              <button
                type="button"
                onClick={() => setStep(1)}
                aria-label="Back to essentials"
                style={{
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  border: "none",
                  fontSize: "11px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "7px 4px",
                }}
              >
                ← Essentials
              </button>
            </div>
            <StaleChipsBanner suggestion={staleSuggestion} onClear={clearStaleChips} onDismiss={dismissStale} />

            {/* Step 2 is a two-screen flow. The Details screen collects the
                structured inputs + the written description; the build trigger
                and progress panel live ONLY on the Outputs screen below, so
                nothing here can start a build. */}
            {!outputsStep ? (
            <>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "1.5rem", lineHeight: "1.65" }}>Fill in what you know. Leave anything blank and the planner will suggest.</p>

            <div style={cardStyleR}>
              <p style={ctStyle}>Trip style</p>
              <Field label="Style" hint="Tap one or more"><Sel multi value={basics.style} onChange={e => setB({ ...basics, style: e.target.value })} opts={["Cultural / sightseeing","Golf / sport","Food & wine","Beach / relaxation","Adventure / outdoor","Mixed"]} /></Field>
              <div style={{ ...g2r, marginTop: "16px" }}>
                <Field label="Pace"><Sel value={basics.pace} onChange={e => setB({ ...basics, pace: e.target.value })} opts={["Relaxed (1–2 things/day)","Moderate (2–3 things/day)","Full (3–4 things/day)"]} /></Field>
                <Field label="Budget" hint="Tap one or more"><Sel multi value={basics.budget} onChange={e => setB({ ...basics, budget: e.target.value })} opts={["$$ — value","$$$ — mid range","$$$$ — luxury","$$$$$ — ultra high end"]} /></Field>
              </div>
            </div>

            {/* Free-form narrative box — the escape hatch for anything the
                structured dropdowns can't capture. Read by the build prompt
                as the highest-priority directive. Sits high in the form
                (right after basics) so it's the first thing users see when
                they have specifics in mind. */}
            <div style={cardStyleR}>
              <p style={ctStyle}>Tell me about the trip</p>
              <Field label="Anything else" hint="Type or dictate. Mention specific hotels with confirmation numbers, flight legs, named guides or drivers, kids’ ages, anniversaries, dietary needs, days you want quiet, anchor reservations — anything the form above didn’t capture. The planner treats this as the source of truth.">
                <NarrativeBox
                  value={narrative}
                  onChange={e => setNarrative(e.target.value)}
                  placeholder={"e.g. Anniversary trip. Already booked: Four Seasons George V Sept 12–15, conf #ABC123. United Polaris IAD→CDG outbound, return open. Want a private driver from Tour d’Argent dinner on the 13th — Tuesday is our anniversary, please make it special. Skip the Louvre, we’ve done it. Kids are not coming, but my mother (78, walks with a cane) is joining us for two days mid-trip. Need to be back at hotel by 9pm each night."}
                />
              </Field>
            </div>

            {!flights.noFlight && (
              <div style={cardStyleR}>
                <p style={ctStyle}>Flights</p>
                <div style={g3r}>
                  <Field label="Preferred airline"><AirlineAutocomplete value={flights.airline} onChange={e => setF({ ...flights, airline: e.target.value })} placeholder="Click to see airlines…" homeAirport={flights.homeAirport} destination={basics.destination} /></Field>
                  <Field label="Cabin"><Sel value={flights.cabin} onChange={e => setF({ ...flights, cabin: e.target.value })} opts={["Business / Polaris","Premium economy","Economy"]} /></Field>
                  <Field label="Date flexibility"><Sel value={flights.flex} onChange={e => setF({ ...flights, flex: e.target.value })} opts={["Exact date only","± 1 day","± 2 days"]} /></Field>
                </div>
              </div>
            )}

            <div style={cardStyleR}>
              <p style={ctStyle}>Hotel</p>
              <Field label="Brand family" hint="Tap one or more"><Sel multi value={hotel.brand} onChange={e => setH({ ...hotel, brand: e.target.value })} opts={["Marriott / Bonvoy","Hilton Honors","Hyatt","IHG","Four Seasons","Ritz-Carlton","Aman","Independent / boutique"]} /></Field>
              <div style={{ marginTop: "16px" }}>
                <Field label="Sub-brand or tier"><HotelTierAutocomplete value={hotel.tier} onChange={e => setH({ ...hotel, tier: e.target.value })} placeholder="e.g. Ritz-Carlton, W, Autograph" /></Field>
              </div>
              <Field label="Must-haves"><HotelMustHaveAutocomplete value={hotel.mustHave} onChange={e => setH({ ...hotel, mustHave: e.target.value })} placeholder="e.g. pool, walkable to dining" /></Field>
            </div>

            <div style={cardStyleR}>
              <p style={ctStyle}>Ground transport</p>
              <Field label="Type" hint="Tap one or more"><Sel multi value={transport.type} onChange={e => setT({ ...transport, type: e.target.value })} opts={["Rental car","Private driver","Rideshare / taxi","Train / rail","No car needed"]} /></Field>
              <div style={{ ...g2r, marginTop: "16px" }}>
                <Field label="Preferred company"><RentalCompanyAutocomplete value={transport.company} onChange={e => setT({ ...transport, company: e.target.value })} placeholder="e.g. Hertz, Sixt" airport={flights.homeAirport} /></Field>
                <Field label="Vehicle type"><VehicleAutocomplete value={transport.vehicle} onChange={e => setT({ ...transport, vehicle: e.target.value })} placeholder="e.g. SUV, sedan" /></Field>
              </div>
            </div>

            <div style={cardStyleR}>
              <p style={ctStyle}>Dining</p>
              <div style={g2r}>
                <Field label="Cuisine preferences"><CuisineAutocomplete value={dining.cuisine} onChange={e => setD({ ...dining, cuisine: e.target.value })} placeholder="e.g. local, seafood, wine-focused" /></Field>
                <Field label="Per-dinner budget" hint="Tap one or more"><Sel multi value={dining.budget} onChange={e => setD({ ...dining, budget: e.target.value })} opts={["$$ — casual ($30–60pp)","$$$ — mid ($60–120pp)","$$$$ — fine dining ($120pp+)"]} /></Field>
              </div>
              <TagInput placeholder="Add a restaurant or dining type" tags={restaurants} setTags={setRest} suggestions={getRestaurantSuggestions(basics.destination)} />
            </div>

            <div style={cardStyleR}>
              <p style={ctStyle}>Activities</p>
              <div style={g2r}>
                <Field label="Physical level"><Sel value={interests.level} onChange={e => setInt({ ...interests, level: e.target.value })} opts={["Easy — mostly walking","Moderate — some hiking","Active — full days on feet"]} /></Field>
                <Field label="Interests"><InterestsAutocomplete value={interests.text} onChange={e => setInt({ ...interests, text: e.target.value })} placeholder="e.g. art, wine, architecture, golf" /></Field>
              </div>
              <TagInput placeholder="Add a specific activity" tags={activities} setTags={setActs} suggestions={getActivitySuggestions(basics.destination)} />
            </div>

            {/* Primary CTA off the Details screen — pure navigation to the
                Outputs screen. It does NOT start a build (see Issue 1). */}
            <button onClick={() => { setOutputsStep(true); /* #20 scroll handled by the outputsStep effect (after render) */ }}
              style={{ border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", width: "100%", marginTop: "0.25rem", fontFamily: "inherit", background: "var(--color-text-primary)", color: "var(--color-background-primary)" }}>
              Jump to select outputs →
            </button>
            </>
            ) : (
            <>
            {/* OUTPUTS SCREEN — the output-section choices plus the single build
                trigger. The progress panel only mounts here, and only once
                `loading` is true from an explicit "Build itinerary" tap. */}
            <div style={cardStyleR}>
              <p style={ctStyle}>{`Output sections  ·  ${activeCount} of 12 active`}</p>
              {outputDefs.map(([k, l, d]) => <Toggle key={k} label={l} desc={d} checked={outputs[k]} onChange={() => togOut(k)} disabled={k === "itinerary"} />)}
            </div>

            {/* #8 Pre-build expert-review source picker. The review runs
                automatically after the build (#8 part 1); choosing the sources
                HERE means the pre-build local-knowledge pass and the auto-review
                both use exactly what the user wants. Selected = navy pill w/
                light label (ON_NAVY, avoiding the navy-on-navy contrast bug). */}
            {!findOnly && (
              <div style={cardStyleR}>
                <p style={ctStyle}>{`Expert review sources  ·  ${reviewerSourceIds.length} selected`}</p>
                <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 10px", lineHeight: 1.4 }}>
                  After the build, a panel of these sources reviews your plan and suggests fixes. Tap to add or remove.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {REVIEWER_SOURCES.filter(s => s.lens !== "hyperlocal").map(s => {
                    const on = reviewerSourceIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        title={s.blurb}
                        onClick={() => setReviewerSourceIds(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id])}
                        style={{ fontSize: "11px", padding: "6px 12px", borderRadius: "999px", border: `0.5px solid ${on ? "var(--color-text-primary)" : "var(--color-border-secondary)"}`, background: on ? "var(--color-text-primary)" : "transparent", color: on ? ON_NAVY : "var(--color-text-secondary)", fontWeight: on ? 600 : 400, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em", whiteSpace: "nowrap" }}
                      >{on ? "\u2713 " : ""}{s.name}</button>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: "10px", marginTop: "0.5rem" }}>
              <button onClick={() => { setOutputsStep(false); try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); } }} disabled={loading} style={{ background: "transparent", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap", opacity: loading ? 0.5 : 1 }}>← Back</button>
              {loading ? (
                <button onClick={handleCancel}
                  style={{ flex: 1, border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                  Cancel
                </button>
              ) : extractingFromGuidelines ? (
                // Extraction is fast (~2s) and not cancellable. Show a disabled
                // "reading…" state so the user knows the build is in motion;
                // the loading panel below renders the actual spinner + label.
                <button disabled aria-busy="true"
                  style={{ flex: 1, border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "not-allowed", fontFamily: "inherit", background: "var(--color-text-primary)", color: "var(--color-background-primary)", opacity: 0.7 }}>
                  Reading your narrative…
                </button>
              ) : (
                <button onClick={handleBuild} disabled={loading}
                  style={{ flex: 1, border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "var(--color-text-primary)", color: "var(--color-background-primary)" }}>
                  Build itinerary
                </button>
              )}
            </div>
            {/* Uncertain-name confirmation. Renders between extraction and
                build when the extractor flagged ambiguous names. Each check
                lets the user pick: original / a candidate / custom text.
                Continue rewrites form state and arms the build; Edit narrative
                bounces back to step 1 unchanged. */}
            {pendingNameChecks && pendingNameChecks.checks.length > 0 && (
              <div style={{ marginTop: "14px", padding: "14px 16px", border: `1px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", background: "var(--color-background-primary)" }}>
                <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 4px" }}>Please confirm</p>
                <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 12px", lineHeight: 1.5 }}>
                  A couple of names in your narrative aren't a clean match. Pick the right one so we don't silently substitute the wrong property.
                </p>
                {pendingNameChecks.checks.map((c, i) => {
                  const resolution = pendingNameChecks.resolutions[i] || { choice: "original", value: "" };
                  const setRes = (patch) => setPendingNameChecks((prev) => prev ? {
                    ...prev,
                    resolutions: { ...prev.resolutions, [i]: { ...resolution, ...patch } },
                  } : prev);
                  return (
                    <div key={i} style={{ marginBottom: "14px", paddingBottom: "12px", borderBottom: i < pendingNameChecks.checks.length - 1 ? "1px solid var(--color-surface-2)" : "none" }}>
                      <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.08em" }}>{c.kind}</p>
                      <p style={{ fontSize: "14px", color: "var(--color-text-primary)", margin: "0 0 4px", fontWeight: 500 }}>
                        You wrote: <span style={{ fontStyle: "italic" }}>“{c.original}”</span>
                      </p>
                      {c.reason && (
                        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>{c.reason}</p>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                          <input type="radio" name={`namecheck-${i}`} checked={resolution.choice === "original"} onChange={() => setRes({ choice: "original" })} style={{ accentColor: GOLD, margin: 0 }} />
                          <span>Use exactly as written: <span style={{ fontStyle: "italic" }}>“{c.original}”</span></span>
                        </label>
                        {Array.isArray(c.candidates) && c.candidates.map((cand, ci) => (
                          <label key={ci} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                            <input type="radio" name={`namecheck-${i}`} checked={resolution.choice === `candidate:${ci}`} onChange={() => setRes({ choice: `candidate:${ci}` })} style={{ accentColor: GOLD, margin: 0 }} />
                            <span>{cand}</span>
                          </label>
                        ))}
                        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer" }}>
                          <input type="radio" name={`namecheck-${i}`} checked={resolution.choice === "custom"} onChange={() => setRes({ choice: "custom" })} style={{ accentColor: GOLD, margin: 0 }} />
                          <span>Something else:</span>
                          <input
                            type="text"
                            value={resolution.value || ""}
                            placeholder="Type the correct name"
                            onChange={(e) => setRes({ choice: "custom", value: e.target.value })}
                            onFocus={() => setRes({ choice: "custom" })}
                            style={{ flex: 1, fontSize: "13px", padding: "6px 8px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "4px", background: "var(--color-background-primary)", fontFamily: "inherit", color: "var(--color-text-primary)", outline: "none" }}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
                <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
                  <button onClick={cancelNameChecks} style={{ background: "transparent", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>← Edit narrative
                  </button>
                  <button onClick={confirmNameChecks} style={{ flex: 1, border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: GOLD, color: ON_NAVY }}>
                    Continue →
                  </button>
                </div>
              </div>
            )}
            {(loading || extractingFromGuidelines) && (
              <div ref={progressPanelRef} style={{ marginTop: "12px", padding: "12px 14px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary, var(--color-background-secondary))" }}>
                {/* Progress bar honesty.
                    Once progress pegs at ≥95% the percentage is no longer
                    informative — the time-based estimator has saturated and
                    we genuinely don't know how much longer the model needs.
                    Showing "95%" frozen for 2–3 minutes reads as a hang.
                    Switch to "still building · m:ss" with an indeterminate
                    moving stripe so the user knows the build is alive and
                    we're being honest about not knowing the ETA. */}
                {(() => {
                  const longTail = progress >= 0.95;
                  const elapsedTxt = elapsedSec > 0
                    ? `${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,'0')}`
                    : "";
                  return (
                    <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px", gap: "10px" }}>
                        <p style={{ fontSize: "12px", color: "var(--color-text-primary)", margin: 0, fontWeight: 500, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {/* Single source of truth: stream-driven progressLabel wins
                             whenever it has real content ("Day 4 of 8 · dining",
                             "Insider notes & Plan B…"). Otherwise fall back to the
                             phase cycler (loadingMsg). progressLabel is intentionally
                             blank for placeholder states so we never show two
                             contradictory strings simultaneously. */}
                          {progressLabel || loadingMsg || "Working…"}
                        </p>
                        <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {longTail
                            ? (elapsedTxt ? `still building · ${elapsedTxt}` : "still building…")
                            : `${progress > 0 ? `${Math.round(progress * 100)}%` : ""}${elapsedTxt ? `  ·  ${elapsedTxt}` : ""}`}
                        </p>
                      </div>
                      {/* In normal mode show the real progress bar.
                          In long-tail mode show the indeterminate stripe so
                          the bar visibly KEEPS MOVING instead of sitting
                          frozen at 95%. */}
                      <div style={{ height: "5px", borderRadius: "3px", background: "var(--color-border-tertiary, var(--color-border-tertiary))", overflow: "hidden", position: "relative" }}>
                        {longTail ? (
                          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "40%", background: GOLD, animation: "slideBar 1.6s ease-in-out infinite" }} />
                        ) : progress > 0 ? (
                          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(progress * 100)}%`, background: GOLD, transition: "width 0.3s ease-out", borderRadius: "3px" }} />
                        ) : (
                          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "40%", background: GOLD, animation: "slideBar 1.6s ease-in-out infinite" }} />
                        )}
                      </div>
                    </>
                  );
                })()}
                {/* Sub-line: show loadingMsg (phase) only when progressLabel is
                   driving the header. That way the user always sees BOTH the
                   data-driven detail ("Day 4 of 8 · dining") AND the broader
                   phase context ("Picking restaurants…"), but never two
                   conflicting versions of the same thing. */}
                {progressLabel && loadingMsg && progressLabel !== loadingMsg && (
                  <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "6px 0 0" }}>{loadingMsg}</p>
                )}
              </div>
            )}
            {error && <p style={{ fontSize: "12px", color: "var(--color-text-danger, var(--color-text-danger))", marginTop: "8px", textAlign: "center" }}>{error}</p>}
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "10px", textAlign: "center", fontStyle: "italic" }}>{(() => {
              // #17 Use the SAME dynamic estimate as the hero (estimateBuildMinutes)
              // so the in-build caption never contradicts the pre-build figure.
              // Falls back to the generic message if we somehow can't estimate.
              if (canEstimateBuild(basics)) {
                const { text } = estimateBuildMinutes({
                  nights: basics.nights,
                  citiesCount: (cities && cities.length) || 1,
                  outputsCount: Object.values(outputs || {}).filter(Boolean).length,
                });
                return `Estimated ${text} for this trip. Stays building if you switch tabs.`;
              }
              return "Can take more than 5 minutes. Stays building if you switch tabs.";
            })()}</p>
            </>
            )}
          </div>
        )}

        {step === 3 && result && (
          <ItineraryView
            data={result}
            inputs={{ basics, flights, hotel, transport, dining, restaurants, activities, interests, guidelines, narrative, outputs }}
            onBack={() => {
              // Navigate to step 1 without clearing the built itinerary or
              // form inputs. The user can come back to the plan via the
              // step nav, or rebuild from scratch by editing the inputs.
              setStep(1);
              try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
            }}
            onEditTrip={() => {
              // Go back to the input form without wiping anything. The user's
              // basics/flights/hotel/transport/dining/restaurants/activities/
              // interests state is already populated (it's what built this
              // plan), so they can tweak dates/cities/etc and rebuild.
              setStep(1);
              // Smooth scroll to top so they land on the "Where & when" card.
              try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
            }}
            onReset={() => {
              // Destructive reset — the parent button confirms before calling.
              // Wipes ALL state so the user lands on a blank Step 1:
              //   • form buckets (basics/flights/hotel/.../narrative/outputs)
              //   • the built plan (result)
              //   • the reviewer state (findings, applied ids)
              //   • the current saved-trip association so a re-save creates a
              //     new entry instead of overwriting the prior trip
              // Matches what the Reset plan button on Step 1 has always done,
              // just reachable from Step 3 without the Home + scroll detour.
              resetFormToBlank();
              setResult(null);
              setReviewState(null);
              setCurrentSavedTripId(null);
              setStep(1);
              try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
            }}
            onSaved={(entry) => { setCurrentSavedTripId(entry?.id || null); refreshSavedTrips(); }}
            savedTripId={currentSavedTripId}
            onPlanRevised={handlePlanRevised}
            onReviewChange={handleReviewChange}
            initialReview={reviewState}
            reviewerSourceIds={reviewerSourceIds}
            onReviewerSourcesChange={setReviewerSourceIds}
          />
        )}

        {step !== 3 && (
          <>
            <hr style={{ border: "none", borderTop: "0.5px solid var(--color-border-tertiary)", margin: "1.75rem 0" }} />
            <div style={{ border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)", padding: "1.25rem 1.5rem", background: "var(--color-background-primary)" }}>
              <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: "500", margin: "0 0 5px" }}>Your trip</p>
              <p style={{ fontSize: "20px", fontWeight: "400", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 4px", color: "var(--color-text-primary)" }}>{basics.destination || "Destination not set"}</p>
              <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0, lineHeight: "1.6" }}>
                {[basics.baseArea, (basics.startDate && basics.endDate) ? `${formatDateForDisplay(basics.startDate)} – ${formatDateForDisplay(basics.endDate)}` : formatDateForDisplay(basics.startDate), basics.nights ? `${basics.nights} nights` : null, flights.homeAirport ? `from ${extractAirportCode(flights.homeAirport) || flights.homeAirport}` : null].filter(Boolean).join("  ·  ") || "Complete the form above"}
              </p>
              {(restaurants.length > 0 || activities.length > 0) && (
                <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: "10px", marginTop: "12px" }}>
                  <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: "500", marginBottom: "5px" }}>Added</p>
                  {[...restaurants, ...activities].map(t => (
                    <p key={t} style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "3px", display: "flex", gap: "6px" }}>
                      <span style={{ color: GOLD }}>—</span>{t}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Footer branding — mirrors the hero: "POWERED BY" caption + wordmark image. */}
        <div style={{ paddingTop: "1.25rem", borderTop: "0.5px solid var(--color-border-tertiary)", marginTop: "1.75rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Powered by</span>
            <img
              src="/brand-wordmark.png?v=2"
              alt="Barrier Island Digital, LLC"
              style={{ display: "block", height: "22px", width: "auto", opacity: 0.9 }}
            />
          </div>
          <hr style={{ border: "none", borderTop: `1px solid ${GOLD}`, width: "32px", margin: "4px 0 0" }} />
          <span style={{ color: "var(--color-text-tertiary)", fontSize: "10px", letterSpacing: "0.06em", marginTop: "2px" }}>
            build {(typeof __BUILD_ID__ !== "undefined") ? __BUILD_ID__ : "dev"}
          </span>
        </div>

      </div>
      )}
    </div>
  );
}
