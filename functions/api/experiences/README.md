# Experiences module

Unified, provider-agnostic experiences search for Trip Optimizer.

## What this is

One endpoint — `POST /api/experiences/search` — that fans out to every booking
provider we've wired up (Viator, GetYourGuide, Tiqets, plus a curated
private-operator directory), normalizes the responses to a single
`Experience` shape, ranks them, and returns the merged list.

Every provider soft-fails: if its API key is missing or it errors out, the
others still respond. The client never sees a hard error from one dead
upstream.

## Files

| Path | Purpose |
|------|---------|
| `_shared.js` | Normalized `Experience` shape, helpers (`fetchWithTimeout`, `priceTier`, `withAffiliate`, etc.) |
| `_private-directory.js` | Hand-curated private operators (Context Travel, ToursByLocals, Withlocals, Atlas Obscura, individual driver-guides). **Edit this file to add operators.** |
| `viator.js` | Viator Partner API adapter — Basic Access by default, upgradeable to Full / Full+Booking with the same code. |
| `getyourguide.js` | GetYourGuide Partner API adapter (requires partner approval). |
| `tiqets.js` | Tiqets Distributor API adapter (self-serve token in the affiliate portal). |
| `private.js` | Reads `_private-directory.js` and returns matching operators. |
| `search.js` | The `/api/experiences/search` endpoint — fan-out, normalize, rank, dedupe. |

## Environment variables

All keys are **optional** — each provider self-disables if its key isn't set.

| Var | Used by | How to get it |
|-----|---------|---------------|
| `VIATOR_API_KEY` | viator.js | [Viator affiliate dashboard](https://partnerresources.viator.com) → Tools → Affiliate API → Start. Basic Access is instant, no approval. |
| `VIATOR_PARTNER_ID` | viator.js | Same dashboard. Tags clicks for commission attribution. |
| `VIATOR_SUB_ID` | viator.js | Optional sub-ID for per-trip analytics. |
| `GYG_API_KEY` | getyourguide.js | [GetYourGuide partner portal](https://partner.getyourguide.com). Requires approval. |
| `GYG_API_SECRET` | getyourguide.js | If your account uses Basic auth (key:secret). Omit for Bearer tokens. |
| `GYG_PARTNER_ID` | getyourguide.js | Affiliate tracking. |
| `GYG_CMP` | getyourguide.js | Optional campaign tag. |
| `TIQETS_API_TOKEN` | tiqets.js | [Tiqets affiliate portal](https://www.tiqets.com/partner-program/) → Tools → API Access → Create a token. Self-serve. |
| `TIQETS_PARTNER_ID` | tiqets.js | Affiliate tracking. |

Set them in **Cloudflare Pages → Settings → Environment variables → Production**
(and Preview if you want them in branch deploys). Mark each as **Encrypted**.

## Calling it from the client

```js
const r = await fetch("/api/experiences/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    destination: "Lisbon, Portugal",
    interests: ["food", "history"],
    startDate: "2026-09-12",
    endDate: "2026-09-15",
    limit: 24,
  }),
});
const { results, debug } = await r.json();
```

Each result is an `Experience`:

```ts
{
  id: "viator:5678-LISBONTOUR",
  provider: "viator" | "getyourguide" | "tiqets" | "private",
  name: "Private Lisbon Food Tour with Local Host",
  url: "https://www.viator.com/tours/...?pid=...",     // affiliate-tagged
  destination: "Lisbon",
  summary: "...",
  description: "...",
  categories: ["food", "private"],
  thumbnail: "https://...",
  images: [...],
  rating: 4.8,
  reviewCount: 1247,
  priceFromUsd: 89,
  currency: "USD",
  durationMinutes: 180,
  tier: "mid",              // low / mid / high / ultra
  skipTheLine: false,
  privateTour: true,
  operator: "...",          // private only
  bookingMode: "redirect",  // or "inquiry" for private contact-the-operator flow
  contactEmail: "...",      // inquiry-mode only
  contactPhone: "...",
  highlights: ["...", "..."],
}
```

## Ranking model

Score components, summed:

- `rating × 0.6` (0–3.0)
- `log10(reviewCount) × 0.3` (saturates so 50k reviews ≠ 50× a 100-review tour)
- `+0.5` if `provider === "private"` (push the curated layer up — this is the moat)
- `+0.2` if `privateTour`
- `+0.15` if `skipTheLine`
- `+0.5 × (overlap with body.interests)` (category text match)

Then dedupe by normalized name (kills the case where Viator and GYG carry the
same operator's product). The first 24 wins go to the client.

If you want to A/B different weights, tweak `scoreExperience()` in `search.js`.

## Adding a new private operator

Edit `_private-directory.js`. Each row is editorial — add operators only after
Jeff has vetted them. Inquiry-mode operators don't need an API; the UI shows
a "Request to book" CTA that hands off to email or a future form-handler.

## Upgrading Viator from Basic → Full → Full + Booking

The adapter already requests the data Full Access provides (reviews, traveler
photos, real-time availability via `pricing.summary`). When your account is
upgraded:

1. Re-issue the API key in the dashboard if Viator rotates it.
2. The same `VIATOR_API_KEY` will start returning richer fields automatically.
3. For Full + Booking, add a new endpoint `functions/api/experiences/viator-book.js`
   that calls `/bookings/cart/book`. Keep this file's `bookingMode` defaulting
   to `"redirect"` for now; flip to `"instant"` per-product when booking is wired.

## Inbound email parsing

See `functions/api/inbound/email.js` for the SendGrid Inbound Parse webhook
that ingests forwarded booking confirmations. That feature works independently
of the providers above and is the recommended way to capture bookings that
happen on the provider's own site after a redirect.
