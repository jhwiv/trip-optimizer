# routesmith.ai — Design Notes

Design decisions, peer review findings, and UI conventions for the luxury travel planner.
Updated: 2026-07-02.

---

## Brand positioning

routesmith.ai is a **luxury-tier travel planning tool** — not a booking platform, not a
spreadsheet optimizer. The reference tier is Journy, Black Tomato, Abercrombie & Kent: a
knowledgeable concierge who builds a coherent, curated itinerary, not a search result list.

Every design decision should be tested against: *Does this feel like something a five-star
concierge would hand you, or does it feel like SaaS software?*

---

## Typography

- **Serif headings:** Cormorant Garamond, italic, variable weight (400–600). Used for destination
  names, hero callouts, day headers in the itinerary. This is the luxury signal — protect it.
- **Sans body:** system-ui stack. 13–14px for body, 10–11px for labels and metadata.
- **Small-caps labels:** Used sparingly for section headers (e.g., TRAVEL PLANNING, DAY 1).
  Do not expand — overuse of all-caps is already a problem (see critique below).
- **Do not mix** serif display text with aggressive all-caps navigation labels on the same screen.
  The current ESSENTIALS / DETAILS / YOUR PLAN tab bar clashes with the editorial serif tone.

---

## Color

- **Background:** Near-white / warm paper (`--color-background-primary`). Never pure white.
- **Text:** Near-black (`--color-text-primary`). Not pure black.
- **Accent:** Teal. Used on progress bars, active states, key CTAs. Commit to it — don't let
  it get diluted by too many competing highlight colors.
- **Hero gradient:** Dark overlay (bottom to top) over destination photography. Currently using
  CSS-only gradients — see critique. Photography is the priority fix.
- **Error / warning:** Restrained. The current yellow warning strip on step 3 breaks the luxury
  tone. Warnings should be styled as subtle annotations, not system alerts.

---

## Screen-by-screen design notes

### Hero / Intro overlay (AppIntroOverlay)

**What works:**
- Full-screen take-over with slide carousel — correct for luxury positioning.
- Cormorant Garamond italic for destination name, small regional label above, italic tagline below.
  This hierarchy is correct and should be preserved exactly.
- Dismiss animation (scale + fade) is tasteful.
- "Did you know" editorial fact card adds depth without clutter.
- The `?direct=1` bypass for embeds and QA is the right pattern.

**What doesn't work:**
- **CSS gradients instead of photography.** This is the single highest-impact fix in the entire
  product. The gradient backgrounds look like placeholder art. Luxury travel brands — Aman,
  Belmond, COMO, even well-designed OTAs — lead with photography that makes you want to be there.
  Each carousel slide needs a real destination photo (ideally full-bleed, high-res, the landscape
  shot that defines the place). The Cormorant Garamond looks stunning on top of photography.
  It looks like a 2016 hotel concept mockup on top of a dark gradient.
- "Begin planning" CTAs were removed from each slide (2026-07-01). Correct — the slide is for
  desire-building, not task initiation. The CTA lives at the bottom of the overlay as a single
  consistent action.

**Priority:** Add real photography to carousel slides. Until then, improve gradient craft —
the current gradients are too uniform and flat for a luxury context.

---

### Step 1 — Input form

**What works:**
- Narrative textarea as primary input is the right choice. Users describe trips in natural
  language; a structured form is secondary.
- The "Describe your trip" / "Use the form" segmented toggle is clean.
- "Plan my trip →" button is appropriately prominent.

**What doesn't work:**
- After the luxury hero, this screen looks like a plain SaaS sign-up form. The background is
  flat, the label ("TRAVEL PLANNING / POWERED BY") is generic, and there's no visual connection
  to the hero destination photography.
- "POWERED BY" in the header — this should either be removed or moved to a footer. A luxury
  product doesn't wear its vendors on its sleeve. It's especially jarring on mobile where it
  appears as the very first thing on screen.
- The gradient accent wash (`heroEntry`) that appears when a user selects a destination from the
  hero is a good idea but subtle to the point of being invisible. Make it more expressive.

**Priority:** Add a visual bridge between the hero and the form — a subtle background wash
or a destination image thumbnail that persists after the modal dismisses.

---

### Step 2 — Sources / Outputs

**What works:**
- Source chip grid (Condé Nast Traveler, Michelin Guide, NYT 36 Hours, etc.) as the trust
  signal is smart. These are names the target user recognizes and respects.
- The Essentials/Details tab structure keeps the screen from being overwhelming.

**What doesn't work:**
- "OUTPUT SECTIONS · 10 OF 12 ACTIVE" is SaaS admin language. A luxury concierge doesn't
  tell you that 10 of 12 output modules are active. Reconsider the framing entirely.
- Too much visual density. Checkboxes, labels, toggle states, counts. The step needs
  breathing room.
- "FULL ITINERARY BUILD" as the section header is functional but not elegant.

**Priority:** Reduce label density on step 2. Hide or rename "Output sections" — users
shouldn't manage output modules, they should just say "build my trip."

---

### Build overlay (BuildAndReviewOverlay)

**What works:**
- Bottom sheet with blurred backdrop — contemporary, mobile-native.
- Two-stage progress (① Initial build → ② Expert review) is genuinely informative.
  Users know what's happening and how long to wait.
- Destination name in the header personalizes it.
- Cancel button during build phase only is correct behavior.
- Elapsed time display is appropriate for a process that takes 3–15 minutes.
- Pre-arm pattern ensures the overlay spans both phases without gap (fixed 2026-07-01).

**What doesn't work:**
- Nothing significant. This is one of the stronger UI elements in the product.

---

### Step 3 — Itinerary view

**What works:**
- Day-by-day tab navigation is intuitive.
- Inline contact info, phone, and website links are practical.
- "Save as PDF" and "Export for Web" are the right exports to offer.
- The "Suggest a change" free-text revision field is a differentiator.

**What doesn't work:**
- **The Quality Check warning banner is the biggest UX problem on step 3.**
  "⚠︎ 11 warnings: Plan B has only 0 entries (expected ≥5)" is a developer validation
  message that should never reach a user. These warnings expose internal scoring logic,
  use developer terminology ("Plan B"), and undermine trust in the output. Hide this
  entirely in production or replace it with a single, user-facing quality signal
  (e.g., a green/amber/red indicator with plain-language text).
- Venue items have no visual hierarchy between types. A hotel check-in, a Michelin dinner,
  a private boat charter, and a museum visit all render with the same visual weight. The
  venue name should be the headline. Time and type should be metadata.
- On desktop (1440px), the single-column layout leaves a lot of empty space on the sides.
  Consider a two-column layout at large viewports: navigation/metadata on the left, day
  content on the right.
- The tab bar (ESSENTIALS / DETAILS / YOUR PLAN) uses all-caps which clashes with the
  editorial serif headings.

**Priority:** Hide the Quality Check warning. Then: itinerary item visual hierarchy.

---

### Review panel

**What works:**
- Auto-runs after build without requiring user action — correct.
- "Re-run review" for iteration is essential.
- Finding severity levels (critical / suggested / nice) are the right taxonomy.

**What doesn't work:**
- "REVIEW BY 6 SOURCES" is admin-facing language. Consider "Expert review" as the heading.
- "INCLUDE ALL / CLEAR SELECTION" buttons look like a spreadsheet interface. This is where
  a user decides whether to apply AI findings — it deserves more careful design.
- The findings list uses a checkbox-and-button pattern that is functional but not refined.

---

### Mobile

**What works:**
- The bottom sheet overlay scales well to mobile.
- Step navigation with tabs is accessible on small screens.
- The hero takes the full viewport height on mobile — correct.

**What doesn't work:**
- The "POWERED BY" attribution is the first thing a user reads on mobile after the hero.
  This needs to either be removed or pushed to the footer.
- Source chip grid on mobile requires horizontal scrolling in some cases — verify.

---

## Prioritized design backlog

These are ordered by impact on luxury positioning, not difficulty.

| # | Fix | Why |
|---|---|---|
| 1 | **Real photography in hero carousel** | Biggest single gap from luxury tier |
| 2 | **Hide Quality Check warning** | Developer debug output shown to users |
| 3 | **Step 2 density reduction** | "SaaS admin panel" feel after luxury hero |
| 4 | **Itinerary item visual hierarchy** | All items look the same; venue needs to be the hero |
| 5 | **Remove or relocate "POWERED BY"** | Undermines brand; jarring on mobile |
| 6 | **Reduce all-caps usage in navigation** | Clashes with editorial serif tone |
| 7 | **Desktop two-column layout** | Empty space at 1440px+ |
| 8 | **Review panel — language and layout** | "INCLUDE ALL / CLEAR SELECTION" is spreadsheet UI |
| 9 | **Step 1 visual bridge to hero** | Abrupt transition from luxury hero to plain form |
| 10 | **Review panel heading** | "REVIEW BY 6 SOURCES" → "Expert review" |

---

## What to preserve

These elements are working and should not be changed without strong reason:

- Cormorant Garamond italic for destination names and hero headings
- The bottom-sheet build overlay with two-stage progress
- Escape key dismisses the intro modal
- `?direct=1` URL bypass for embeds and QA flows
- Teal accent color (commit to it, don't dilute)
- Source publication chips on step 2 (Condé Nast, Michelin, etc.)
- The narrative textarea as the primary input mode on step 1
- Auto-run expert review after build (no manual trigger required for fresh builds)
- "Suggest a change" free-text revision on step 3

---

## Hero photography guidance (when added)

- Full-bleed, landscape orientation, high-res (2000px+ width)
- Shot at dawn, dusk, or golden hour — avoid flat midday light
- People optional but if present: anonymous, from behind, experiencing the place
- No logos, watermarks, or text overlays in the source photo
- Subject: the landscape or architecture that defines the destination, not a hotel pool
- Each slide needs one definitive image — not a collage
- CSS overlay: `linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.3) 45%, transparent 75%)`
  This is already in the code and is calibrated for readability. Keep it.

---

## Peer review summary (2026-07-02)

**Conducted by:** Claude Code, in the role of luxury travel web designer, reviewing live
screenshots of desktop (1440px) and mobile (390px) across all screens.

**Overall verdict:** The ambition is correct. The bones — Cormorant Garamond, bottom-sheet
overlay, editorial hierarchy in the hero, source chips as trust signals — are genuinely good.
The gap is that the luxury feel established on screen 1 (the hero) is not carried through to
screens 2 and 3. The hero is a hotel lobby; step 2 is a spreadsheet. Fix photography first,
then address the quality check warning, then the density of step 2.
