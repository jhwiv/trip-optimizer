// Meal-policy classifier. Deterministic pre-build classification of the
// traveler's narrative + guidelines + dining preferences + restaurant
// chips to decide whether Breakfast/Brunch and Lunch were actually asked
// for.
//
// Why this module exists: the build prompt carried an emphatic MEAL
// POLICY block AND three unconditional strings that presupposed
// breakfasts exist ("Vary breakfasts" in the user message; VARIETY RULES
// written against a two-breakfast baseline with three named breakfast
// venues). The model resolved the contradiction in favor of the more
// recent, more concrete instruction and emitted meals that
// applyQualityLayer then deleted — the reported "Auto-fixed 13 items …
// per meal policy" build.
//
// Investigation: meal_policy_leak_report.md (2026-07-31). It found four
// further defects that this module closes by construction:
//
//   1. The old detector read `${inputs.dining}` — an object — which
//      interpolated to the literal string "[object Object]". Dining
//      preferences contributed nothing.
//   2. It never read `inputs.restaurants[]`, so the "Casual lunch" /
//      "Brunch spot" / "Cafe / breakfast" chips were sent to the model
//      as an explicit ask and then silently stripped. A user got the
//      opposite of what they clicked.
//   3. It had no negation handling: "don't plan lunch" matched the
//      intent regex on "plan …  lunch" and disabled the strip entirely.
//   4. The prompt's per-trip meal state lived in `staticRules`, which is
//      byte-identical across every build of every trip, so it could only
//      shout one hardcoded default at everybody.
//
// The structural fix mirrors src/activityCountConstraint.js:
//
//   1. (THIS MODULE) Pre-build classifier. One function reads every
//      input surface and returns a structured policy the prompt
//      assembly injects into the dynamic preamble.
//   2. Post-build enforcement in applyQualityLayer §1c consumes the
//      SAME classifier, so prompt and enforcement can never disagree
//      about what "explicitly asked" means. Belt + suspenders.
//
// Pure functions: never throw, never mutate inputs.

// ---------------------------------------------------------------------------
// Meal vocabulary
// ---------------------------------------------------------------------------

const BREAKFAST_WORDS = new Set(["breakfast", "breakfasts", "brunch", "brunches"]);
const LUNCH_WORDS = new Set(["lunch", "lunches", "luncheon", "luncheons"]);

// ---------------------------------------------------------------------------
// Negation handling
// ---------------------------------------------------------------------------
//
// The old detector's failure mode: /\b(book|reserve|plan|…)\b[^.]{0,40}\blunch\b/
// matches "don't PLAN LUNCH" just as happily as "plan lunch", and any hit
// set explicitLunch = true, which DISABLED the strip. The user got the
// exact opposite of what they asked for, silently.
//
// Rather than bolt negative lookbehinds onto each pattern (unreadable, and
// lookbehind width is fixed), we scan a TOKEN WINDOW around each meal
// mention:
//
//   • Split the text into CLAUSES first, on . ! ? ; and newlines. This is
//     the important part — without it, "We don't want a rental car. Book
//     lunch at Atardi." would see "don't" six tokens before "lunch" and
//     wrongly exclude. A negator in a previous sentence is about a
//     different subject and must not leak forward.
//   • Within a clause, look at the NEGATION_WINDOW (8) tokens immediately
//     preceding the meal word. Any negator in that window negates the
//     mention: "don't plan any lunches", "skip breakfast", "no lunch".
//     Eight tokens is wide enough for "we really would rather not bother
//     with lunch" and narrow enough that an unrelated "no rental car"
//     earlier in the same clause doesn't reach.
//   • Then check a tight COPULA SUFFIX: the meal word followed by up to
//     three tokens that are copulas, terminating at the first negator.
//     This catches post-posed negation — "lunch is not included in the
//     plan", "lunches aren't needed" — which no prefix window can see.
//     It stops at the first non-copula token so "lunch at Atardi, not the
//     hotel" is NOT treated as a negation of lunch.
//
// Known limit: this is token proximity, not parsing. "I wouldn't say no to
// lunch" is a double negative and classifies as excluded. That is the safe
// direction to fail — the traveler can add "book lunch at X" and the
// include path wins (see the precedence rule in classifyMealPolicy).

const NEGATION_TOKENS = new Set([
  "no", "not", "non", "don't", "dont", "doesn't", "doesnt", "didn't", "didnt",
  "won't", "wont", "isn't", "isnt", "aren't", "arent", "never", "skip",
  "skipping", "skipped", "without", "exclude", "excluding", "excluded",
  "avoid", "avoiding", "omit", "omitting", "drop", "dropping", "nix",
  "cancel", "forget", "rather",
]);

const NEGATION_WINDOW = 8;

const COPULAS = new Set([
  "is", "are", "was", "were", "be", "will", "wont", "won't",
  "isn't", "isnt", "aren't", "arent",
]);

// Verbs of intent. A meal mention in a clause carrying one of these is an
// explicit ask rather than a passing vibe note ("casual lunches" alone is
// not an ask — that distinction is deliberate and predates this module).
const INTENT_TOKENS = new Set([
  "book", "booking", "booked", "reserve", "reserving", "reserved",
  "reservation", "reservations", "plan", "planning", "schedule",
  "scheduling", "scheduled", "want", "wants", "need", "needs", "include",
  "including", "add", "adding", "have", "get", "grab", "do", "keep",
]);

// A meal word directly followed by a locator ("lunch AT Atardi", "brunch ON
// Sunday") is an explicit ask even with no intent verb in the clause.
const LOCATOR_TOKENS = new Set(["at", "in", "on", "near"]);

function normalize(value) {
  return String(value == null ? "" : value).replace(/[‘’ʼ]/g, "'").toLowerCase();
}

// Split on sentence punctuation AND on contrastive conjunctions. "but",
// "however" and friends explicitly reset polarity, so in "no breakfast
// normally, but book breakfast at Tia Sophia's on Day 2" the negator
// belongs only to the first half. Without this split the 8-token window
// reaches across the "but" and negates the actual ask.
function toClauses(text) {
  return normalize(text)
    .split(/[.!?;\n\r]+|\b(?:but|however|although|though|whereas|except)\b/g)
    .map((c) => (c || "").trim())
    .filter(Boolean);
}

function tokenize(clause) {
  return clause.match(/[a-z0-9']+/g) || [];
}

// Is the meal mention at tokens[i] negated? See the block comment above.
function isNegated(tokens, i) {
  const start = Math.max(0, i - NEGATION_WINDOW);
  for (let k = start; k < i; k += 1) {
    if (NEGATION_TOKENS.has(tokens[k])) return true;
  }
  for (let k = i + 1; k < Math.min(tokens.length, i + 4); k += 1) {
    if (NEGATION_TOKENS.has(tokens[k])) return true;
    if (!COPULAS.has(tokens[k])) break;
  }
  return false;
}

function hasIntent(tokens, i) {
  for (let k = 0; k < i; k += 1) {
    if (INTENT_TOKENS.has(tokens[k])) return true;
  }
  return LOCATOR_TOKENS.has(tokens[i + 1] || "");
}

// Scan free prose for meal mentions.
//
// bareMentionCounts=true is used for the dining-preferences field, where the
// traveler picked a cuisine focus rather than writing a sentence — "brunch,
// coffee" is an ask without needing an intent verb.
//
// Returns { included: string[], excluded: string[] } of evidence snippets.
function scanProse(text, words, bareMentionCounts = false) {
  const included = [];
  const excluded = [];
  for (const clause of toClauses(text)) {
    const tokens = tokenize(clause);
    for (let i = 0; i < tokens.length; i += 1) {
      if (!words.has(tokens[i])) continue;
      const snippet = clause.length > 60 ? `${clause.slice(0, 60)}…` : clause;
      if (isNegated(tokens, i)) excluded.push(snippet);
      else if (bareMentionCounts || hasIntent(tokens, i)) included.push(snippet);
    }
  }
  return { included, excluded };
}

function chipMentions(restaurants, pattern) {
  if (!Array.isArray(restaurants)) return [];
  return restaurants.filter((r) => typeof r === "string" && pattern.test(r));
}

// Classify the full inputs object into a structured meal policy.
//
// Reads every surface that can carry a meal signal:
//   inputs.narrative     — free prose
//   inputs.guidelines    — free prose
//   inputs.dining        — { cuisine, budget }; an OBJECT, not a string
//   inputs.restaurants[] — chip labels from RESTAURANT_TYPES_BASE
//
// Returns:
//   {
//     breakfast: "included" | "excluded" | "unspecified",
//     lunch:     "included" | "excluded" | "unspecified",
//     reasons:   { breakfast: string[], lunch: string[] }
//   }
//
// Precedence: "included" beats "excluded". An explicit ask anywhere wins
// over an exclusion anywhere, because the exclusion is the default and the
// ask is the traveler going out of their way. A user who clicks the
// "Casual lunch" chip and also wrote "skip lunch" in the narrative gets
// lunch — and both reasons are recorded so the disagreement is visible.
export function classifyMealPolicy(inputs) {
  const empty = {
    breakfast: "unspecified",
    lunch: "unspecified",
    reasons: { breakfast: [], lunch: [] },
  };
  if (!inputs || typeof inputs !== "object") return empty;

  const dining = inputs.dining && typeof inputs.dining === "object" ? inputs.dining : null;
  // The old code interpolated the whole dining object and got
  // "[object Object]". Read the real fields.
  const diningText = dining
    ? [dining.cuisine || "", Array.isArray(dining.budget) ? dining.budget.join(" ") : dining.budget || ""].join(" ")
    : typeof inputs.dining === "string"
      ? inputs.dining
      : "";

  const prose = `${inputs.narrative || ""}\n${inputs.guidelines || ""}`;

  const result = {
    breakfast: "unspecified",
    lunch: "unspecified",
    reasons: { breakfast: [], lunch: [] },
  };

  const meals = [
    { key: "breakfast", words: BREAKFAST_WORDS, chip: /breakfast|brunch/i },
    { key: "lunch", words: LUNCH_WORDS, chip: /lunch/i },
  ];

  for (const meal of meals) {
    const reasons = result.reasons[meal.key];
    let included = false;
    let excluded = false;

    for (const label of chipMentions(inputs.restaurants, meal.chip)) {
      included = true;
      reasons.push(`chip:${label}`);
    }

    const fromProse = scanProse(prose, meal.words);
    const fromDining = scanProse(diningText, meal.words, true);

    for (const snippet of [...fromProse.included, ...fromDining.included]) {
      included = true;
      reasons.push(`prose:${snippet}`);
    }
    for (const snippet of [...fromProse.excluded, ...fromDining.excluded]) {
      excluded = true;
      reasons.push(`negated:${snippet}`);
    }

    if (included) result[meal.key] = "included";
    else if (excluded) result[meal.key] = "excluded";
  }

  return result;
}

// Render the per-trip meal rule for the dynamic preamble.
//
// This replaces the hardcoded assertion that used to live in staticRules
// ("*** The traveler has explicitly added LUNCH to the meal-exclusion
// list."), which was shipped byte-identically to every user of the app
// regardless of what they actually asked for.
//
// Always returns a string — unlike renderActivityCountPromptRule, there is
// no "no opinion" case: every trip has a meal policy, and the default
// (exclude) still needs stating.
export function renderMealPolicyPromptRule(policy) {
  const breakfast = mealPolicyAllowsBreakfast(policy);
  const lunch = mealPolicyAllowsLunch(policy);

  let body;
  if (breakfast && lunch) {
    body = "The traveler has explicitly requested BREAKFAST and LUNCH. Emit those meal items.";
  } else if (breakfast) {
    body = "The traveler has explicitly requested BREAKFAST. Emit breakfast items. Do NOT emit Lunch items — they will be deleted.";
  } else if (lunch) {
    body = "The traveler has explicitly requested LUNCH. Emit lunch items. Do NOT emit Breakfast or Brunch items — they will be deleted.";
  } else {
    body = "The traveler has NOT requested Breakfast or Lunch. DO NOT emit any Breakfast, Brunch, or Lunch items. Doing so wastes tokens; they will be deleted before render.";
  }

  return `\n\nMEAL POLICY (per-trip): ${body}`;
}

export function mealPolicyAllowsBreakfast(policy) {
  return policy?.breakfast === "included";
}

export function mealPolicyAllowsLunch(policy) {
  return policy?.lunch === "included";
}
