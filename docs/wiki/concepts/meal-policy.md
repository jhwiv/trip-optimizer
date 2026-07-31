# Meal Policy — Root Cause, Fix, and Limits

Why the build model emitted Breakfast/Brunch/Lunch items that the quality layer
immediately deleted, and how the classifier closes it.
Last updated: 2026-07-31.

---

## Why this was hard

Meal emission was controlled by **four competing forces** in the build prompt.
The policy itself was never weak — it was the most forceful language in the
file — but three unconditional strings elsewhere presupposed that breakfasts
exist, and the strongest of those sat in the highest-salience position in the
whole context.

| Force | Where | Strength |
|---|---|---|
| `MEAL POLICY` block (`DO NOT EMIT LUNCH ITEMS`) | static system prompt | **CRITICAL** — but fixed text, same for every trip |
| `Vary breakfasts — use real local spots…` | **user** message, after both cached system blocks | Highest recency salience — won |
| VARIETY RULES breakfast examples (`Tia Sophia's, Café Pasqual's, Clafoutis`) | static system prompt | Concrete worked example — reinforced |
| `submit_trip_plan` tool schema `type` enum | tool definition | Presents Breakfast/Brunch/Lunch as legitimate types |

The model was resolving a flat contradiction between "DO NOT emit Breakfast"
and "Vary breakfasts", and recency plus concreteness beat the rule. The result
was the reported build: *"Auto-fixed 13 items … per meal policy."* Every one of
those 13 items cost generation tokens, was reviewed by the expert reviewer, and
was then deleted before render.

The full investigation is `meal_policy_leak_report.md`.

---

## What was actually broken

Five distinct defects, only one of which was the reported symptom:

1. **Contradiction (the reported symptom).** `Vary breakfasts` in the user
   message, plus VARIETY RULES written against a two-breakfast baseline.
2. **A per-user assertion hardcoded into the shared cached prompt.** The line
   `*** The traveler has explicitly added LUNCH to the meal-exclusion list.`
   lived inside `staticRules`, which is byte-identical across every build of
   every trip. Every user of the app was being told this about themselves.
3. **`${inputs.dining}` interpolated to `"[object Object]"`.** `dining` is
   `{ cuisine, budget }`. Dining preferences contributed literally nothing to
   the detector, even though the prompt told the model they counted.
4. **`inputs.restaurants[]` was never read — the chip trap.** The
   `"Cafe / breakfast"`, `"Brunch spot"` and `"Casual lunch"` chips were sent
   to the model as an explicit ask, the model complied, and the strip deleted
   the result. A user got the exact opposite of what they clicked. This was a
   correctness bug, not an efficiency one.
5. **No negation handling.** `/\b(book|reserve|plan|…)\b[^.]{0,40}\blunch\b/`
   matches *"don't **plan** lunch"*. Any hit set `explicitLunch = true`, which
   **disabled the strip entirely** — silently.

---

## The fix — one classifier, two consumers

`src/mealPolicy.js` follows the belt + suspenders pattern established by
`src/activityCountConstraint.js` (see `activity-count.md`): the *same*
classifier feeds both the prompt and the post-build enforcement, so the two
can never disagree about what "explicitly asked" means.

### Inputs

`classifyMealPolicy(inputs)` takes the **full inputs object**, not a
pre-flattened blob, and reads every surface that can carry a meal signal:

| Surface | Shape | How it's read |
|---|---|---|
| `inputs.narrative` | string | Prose scan; intent verb or locator required |
| `inputs.guidelines` | string | Prose scan; same |
| `inputs.dining` | `{ cuisine, budget }` — **object** | `.cuisine` and `.budget` read as fields. A bare mention counts (picking a brunch cuisine focus *is* the ask) |
| `inputs.restaurants[]` | array of chip labels | `/breakfast\|brunch/i` → breakfast, `/lunch/i` → lunch |

### Output

```js
{
  breakfast: "included" | "excluded" | "unspecified",
  lunch:     "included" | "excluded" | "unspecified",
  reasons:   { breakfast: [...], lunch: [...] }   // "chip:Casual lunch", "prose:…", "negated:…"
}
```

**Precedence: `included` beats `excluded`.** Exclusion is the default; an
explicit ask is the traveler going out of their way. A user who clicks the
"Casual lunch" chip *and* wrote "skip lunch" gets lunch — and both reasons are
recorded so the disagreement is visible rather than silently arbitrated.

### The two consumers

- **Belt (pre-build):** `renderMealPolicyPromptRule(policy)` returns a
  parametrized `MEAL POLICY (per-trip):` line injected into `dynamicPreamble`
  in `buildSystemPrompt`. This is where per-trip meal state belongs — the
  preamble is sent uncached. The static block now states only the default and
  defers to the per-trip line. Unlike `renderActivityCountPromptRule`, this one
  **never returns null**: every trip has a meal policy, and the default still
  needs stating.
- **Suspenders (post-build):** `applyQualityLayer` §1c calls
  `mealPolicyAllowsBreakfast()` / `mealPolicyAllowsLunch()` on the same
  classifier and filters the offending items, logging to `fixes[]`.

Removals stay in `fixes[]` — there is deliberately **no new flag taxonomy
entry**. Surfacing silent strips as `structural_flags` is tracked separately
in issue #153.

---

## Negation handling, and its limits

This is the subtlest part of the module. Rather than bolt negative lookbehinds
onto each pattern (unreadable, and JS lookbehind width is awkward), the module
scans a **token window** around each meal mention:

1. **Clause-split first**, on sentence punctuation *and* on contrastive
   conjunctions (`but`, `however`, `although`, `though`, `whereas`, `except`).
   This is the load-bearing step. Without the sentence split,
   *"We don't want a rental car. Book lunch at Atardi."* sees `don't` six
   tokens before `lunch` and wrongly excludes. Without the contrastive split,
   *"no breakfast normally, **but** book breakfast at Tia Sophia's"* does the
   same — a comma is not a polarity reset, but "but" is.
2. **Prefix window of 8 tokens** immediately before the meal word. Any negator
   in that window negates the mention. Eight is wide enough for *"we really
   would rather not bother with lunch"* and narrow enough that an unrelated
   *"no rental car"* earlier in the same clause doesn't reach.
3. **Tight copula suffix.** The meal word followed by up to three tokens that
   are copulas, terminating at the first negator. This catches post-posed
   negation — *"lunch is not included in the plan"*, *"lunches aren't
   needed"* — which no prefix window can see. It stops at the first
   non-copula token, so *"lunch at Atardi, not the hotel"* is **not** read as
   negating lunch.

### Known limits

- **This is token proximity, not parsing.** *"I wouldn't say no to lunch"* is a
  double negative and classifies as excluded. That is the safe direction to
  fail: the traveler can add "book lunch at X" and the include path wins.
- **Sarcasm, conditionals, and future-tense hedges are not modeled.**
  *"If the weather's bad maybe lunch somewhere"* reads as an ask.
- **The negator list is a fixed set**, not a morphological analyzer. Novel
  negations ("sans lunch", "lunch-free") will not be caught and fall through to
  the default, which is exclusion — again the safe direction.

---

## Adding a new signal

To make a new input surface contribute to the policy:

1. Read it inside `classifyMealPolicy`, not at the call site — the whole point
   is that one function sees everything.
2. Decide whether a **bare mention** counts (like `dining.cuisine`, where
   picking a focus is itself the ask) or whether an **intent verb / locator**
   is required (like free prose, where "casual lunches" is a vibe note rather
   than a request). Pass `bareMentionCounts` to `scanProse` accordingly.
3. Push a namespaced string onto `reasons[meal]` (`chip:`, `prose:`,
   `negated:`) so the evidence stays inspectable.
4. Add a case to `tests/test_meal_policy.mjs` **and** an end-to-end case to
   `tests/test_apply_quality_layer_meal_policy.mjs` — the second one is what
   proves the prompt and the strip still agree.

If you add a new negator, add it to `NEGATION_TOKENS` and add a positive case
*and* an over-reach case, because widening negation is the change most likely
to start deleting meals the traveler actually asked for.

---

## Files

| File | Role |
|---|---|
| `src/mealPolicy.js` | Classifier, prompt renderer, two boolean accessors |
| `src/App.jsx` (`buildSystemPrompt`) | Injects the per-trip rule into `dynamicPreamble` |
| `src/App.jsx` (`applyQualityLayer` §1c) | Post-build strip, consuming the same classifier |
| `tests/test_meal_policy.mjs` | 56 assertions — classifier, negation, chips, dining, renderer |
| `tests/test_apply_quality_layer_meal_policy.mjs` | 23 assertions — end-to-end strip behavior + the 13-meal regression |
| `meal_policy_leak_report.md` | The original investigation |
