# Heartnote — Personalized AI Song Gifts

A revenue-focused rebuild of the SonglyGift funnel: a visitor tells the story of
someone they love, we **write original lyrics (Claude) and produce a real,
sung song (Suno)**, play a **free, length-capped preview**, then sell the full
studio-quality song for a one-time price — with order-bump upsells, email
capture, a shareable gift page, and funnel analytics.

Same stack as the rest of your projects: **static frontend + Netlify Functions
+ Netlify Blobs + Stripe + Anthropic**, plus a music-generation provider.

## The funnel

1. **`/` (index.html)** — landing + creation form → "Creating Your Song…"
   progress screen (Lyrics → Song → Listen) with rotating testimonials →
   **"Imagine [name]'s reaction"** preview + paywall.
2. **Stripe Checkout** — base song + optional upsells (express rendering,
   extended cut, second version, animated video page). Apple/Google Pay & cards.
3. **`/gift.html?id=…`** — the buyer's shareable gift page with full audio,
   download, lyrics, and a "make your own" CTA (referral loop).

## How it improves on the original (to grow revenue)

- **Order-bump upsells** at checkout to lift average order value.
- **Email capture before checkout** → stored as leads for abandoned-cart recovery.
- **Shareable gift pages** → every delivered gift markets the product.
- **Funnel analytics** (per-day counters incl. revenue) to optimize conversion.
- **Real Stripe webhook signature verification** (HMAC-SHA256), not a shortcut.
- **No Stripe product setup needed** — prices are inline `price_data`, all
  configurable via env vars.
- **Abuse control** on the cost-bearing free preview (per-IP rate limit).

## Environment variables (set in Netlify → Site settings → Environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Lyrics generation. |
| `ANTHROPIC_MODEL` | | `claude-opus-4-8` | Lyrics model. |
| `SUNO_API_KEY` | ✅ for audio | — | Music generation. Funnel still works without it (preview shows lyrics; full song emailed). |
| `SUNO_API_BASE` | | `https://api.sunoapi.org` | Swap if you use a different Suno provider. |
| `SUNO_MODEL` | | `V4_5` | Suno model version. |
| `STRIPE_SECRET_KEY` | ✅ | — | `sk_live_…` / `sk_test_…`. |
| `STRIPE_WEBHOOK_SECRET` | ✅ | — | `whsec_…` from the Stripe webhook endpoint. |
| `CURRENCY` | | `usd` | |
| `PRICE_BASE_CENTS` | | `3499` | Full song price. |
| `PRICE_RUSH_CENTS` / `PRICE_EXTENDED_CENTS` / `PRICE_ALT_CENTS` / `PRICE_VIDEO_CENTS` | | `1499/1000/1500/1900` | Upsell prices. |
| `PREVIEW_SECONDS` | | `45` | Free preview length cap. |
| `FREE_SONGS_PER_HOUR` | | `6` | Per-IP free-generation limit. |
| `SITE_URL` | | (auto) | Used for callback/redirect URLs. |

> Keep the upsell list in `public/index.html` (`UPSELLS`) in sync with the
> catalogue in `netlify/functions/create-checkout.mjs`.

## Stripe setup

1. Add `STRIPE_SECRET_KEY`.
2. Create a webhook endpoint pointing at `https://<your-site>/api/stripe-webhook`,
   subscribe to `checkout.session.completed`, copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`.

## Suno notes

Built against the widely-used `api.sunoapi.org` schema (`POST /api/v1/generate`
→ `taskId`, `GET /api/v1/generate/record-info?taskId=…`, plus a `callBackUrl`).
If your provider differs, adjust `netlify/functions/song.mjs` (`actionGenerate`,
`actionStatus`, `actionCallback`).

## Local / deploy

Static site — no build step. Deploy to Netlify (publish `public/`, functions in
`netlify/functions`). Functions expose `/api/song`, `/api/create-checkout`,
`/api/verify-payment`, `/api/stripe-webhook`.

## Hardening backlog (not blocking launch)

- Proxy/transcode the preview so the full file can't be pulled from the network
  tab (today the preview is the front of the track, capped client-side).
- Send the delivery email on purchase (Resend/Postmark) — currently the gift
  page is the delivery surface.
- Add a real revisions flow.
