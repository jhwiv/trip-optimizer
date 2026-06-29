# Visual regression runbook — palette PRs

This runbook protects against **unintended visual change** during a palette
reskin (the upcoming Barrier Island Digital alignment, or any future token
edit in `index.html`). Color tokens touch nearly every view, so a "no visual
change" or "only-intended change" claim must be backed by before/after
screenshots, not by eyeballing a diff.

This is a **manual runbook, not an executable script**. Playwright/Puppeteer
is intentionally **not** installed — adding it is a separate decision. Run the
steps below by hand (or wire them into your own throwaway script) when you open
or review a palette PR.

---

## 1. Views and states to capture

Capture each of these. If a state needs seed data, use the smallest fixture
that renders the surface; the goal is pixel coverage of every colored region,
not a realistic trip.

| # | View / state | How to reach it |
| - | --- | --- |
| 1 | Landing / input form (empty) | Fresh load of `/` |
| 2 | Input form filled, validation idle | Enter origin, destination, dates |
| 3 | Input form with a validation error | Submit with a missing required field |
| 4 | City autocomplete dropdown open | Type a partial city into the destination field |
| 5 | Build in progress (loading / progress bar) | Submit a valid trip; capture mid-build |
| 6 | Itinerary result — day block | After a build completes |
| 7 | Itinerary result — meal/flight/hotel cards | Scroll to those card types |
| 8 | Verification flag badges (warn + block) | A result containing flagged venues |
| 9 | Danger / error text state | Trigger an error toast or `--color-text-danger` copy |
| 10 | "Build from this" / replan controls | Open the replan affordance |
| 11 | PDF export pre-flight gate (block dialog) | Attempt export on a result with a blocking flag |
| 12 | Print / rides print-only sheet | Trigger the print-rides path (print preview) |

Capture each at **both** viewports:

- **Mobile:** 390 × 844
- **Desktop:** 1440 × 900

Naming convention: `NN-slug__viewport.png`, e.g.
`06-itinerary-day-block__mobile.png`, `06-itinerary-day-block__desktop.png`.

---

## 2. Capture command

Start the dev server first:

```bash
npm run dev   # serves on http://localhost:5173 by default
```

Then capture with Playwright (install in a throwaway environment — do **not**
add it to this repo's dependencies):

```bash
# one-off, outside the repo's package.json
npx --yes playwright@latest install chromium

# Example capture for one view/viewport. Repeat per row in the table above,
# scripting navigation/interactions as needed.
node - <<'EOF'
import { chromium } from 'playwright';

const viewports = {
  mobile:  { width: 390,  height: 844 },
  desktop: { width: 1440, height: 900 },
};

const browser = await chromium.launch();
for (const [name, vp] of Object.entries(viewports)) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto('http://localhost:5173/');
  // …drive the UI into the target state here…
  await page.screenshot({
    path: `scripts/visual-baseline/01-landing__${name}.png`,
    fullPage: true,
  });
  await page.close();
}
await browser.close();
EOF
```

Puppeteer works equally well if preferred; the only requirements are the two
fixed viewports and `fullPage: true`.

---

## 3. Where screenshots live

Commit captures to `scripts/visual-baseline/`. This directory is **gitignored**
(see `.gitignore`) because the PNGs are large binaries — they are working
artifacts shared out-of-band (PR attachment, shared drive, or a local diff),
not committed to the repo. Keep the baseline set and the PR-branch set in
sibling folders, e.g. `scripts/visual-baseline/base/` and
`scripts/visual-baseline/pr/`.

---

## 4. Diff workflow

1. Check out `master`, start the dev server, run the capture into
   `scripts/visual-baseline/base/`.
2. Check out the palette PR branch, restart the dev server, run the **same**
   capture into `scripts/visual-baseline/pr/`.
3. Diff each matching pair. Either:
   - **Automated:** `pixelmatch` per pair, e.g.

     ```bash
     npx --yes pixelmatch base/06-...__mobile.png pr/06-...__mobile.png \
       diff/06-...__mobile.png 0.1
     ```

     A non-trivial pixel-diff count on a view that was supposed to be
     unchanged is a regression. On a view the PR *intends* to recolor, confirm
     the diff matches the intended token change and nothing else.
   - **Manual:** open both side by side and inspect.

---

## 5. Reviewer checklist (fill in before approving any palette PR)

- [ ] Baseline captured from `master` at this PR's merge base.
- [ ] PR-branch captures taken with the identical script and viewports.
- [ ] All 12 views captured at both 390×844 and 1440×900.
- [ ] Every diff reviewed; each non-zero diff is an **intended** color change.
- [ ] No unintended layout shift, spacing, or font change in any capture.
- [ ] Contrast audit (`npm run audit:contrast`) passes on the PR branch.
- [ ] Hex-leak audit (`npm run audit:hex-leaks`) passes; baseline lowered if
      literals were migrated.
- [ ] `contrast-known-issues.json` entries fixed by this PR were removed.
- [ ] PDF/print surfaces (#11, #12) verified — print color-adjust intact.
