# Heartnote v2 — Personalized AI Song Gifts

A conversion-first custom-song product. Competitive positioning vs. services
like UniqueSong ($60–$200, 3–7 day delivery, pay-before-you-see-anything):

> **Read the lyrics free → approve/edit/rewrite them → pay $24.99 →
> hear your produced song in ~1–3 minutes.**

## Why this funnel wins (and protects you)

| Concern | How v2 handles it |
|---|---|
| **API cost & abuse** | Audio (the expensive call) is generated **only after Stripe confirms payment** — enforced server-side in three places. Free traffic can only trigger rate-limited lyric calls (~pennies). Your keys never reach the browser. |
| **Purchase hesitation** | The buyer has already read and approved their exact lyrics before paying — the product is de-risked at the moment of purchase. Plus a love-it guarantee (free re-production + 7-day refund). |
| **Price** | $24.99 one-time (impulse territory vs. competitors' $60+), includes **two versions** (we render 2 tracks per purchase via ElevenLabs — zero extra cost, doubled perceived value). One optional Deluxe bump (+$9.99). |
| **Speed** | Minutes, not days — the single strongest differentiator vs. human-in-the-loop studios. |
| **Legal exposure** | No fabricated testimonials/user counts (FTC risk), explicit AI disclosure, real Terms + Privacy + refund policy, personal-use license defined, Stripe handles all card data, HMAC-verified webhooks. |
| **Effort on your end** | Fully automated: no fulfillment, no Stripe product setup (inline `price_data`), state in Netlify Blobs — no database to run. |

## The funnel

1. `index.html` — landing (honest value props + competitor comparison) →
   3-step wizard (Who → Sound → Story, mostly taps) → "Writing your song…" →
   **full lyrics revealed free** with Rewrite (AI, with feedback, 3 free) and
   Edit (manual) → buy card → Stripe Checkout.
2. Payment (webhook **and** redirect-verify, whichever lands first) flips
   `paid=true` and starts the ElevenLabs render (synchronous — the render
   finishes within that same request, no polling/callback needed).
3. `gift.html?id=…` — delivery page: live "Producing your song…" progress →
   auto-plays when ready. Two version tabs, MP3 download, lyric sheet, and a
   share button — the same URL is the recipient's gift page (referral loop).

## Files

```
public/index.html      landing + wizard + lyric approval + checkout
public/gift.html       delivery + producing-progress + gift/share page
public/terms.html      ToS incl. refunds, license, AI disclosure
public/privacy.html    privacy policy
netlify/lib/core.mjs   shared: blobs, rate limits, ElevenLabs generation, gating
netlify/functions/song.mjs             /api/song (lyrics/revise/edit/status/gift/lead/track)
netlify/functions/song-audio.mjs       /api/song-audio (streams rendered tracks out of Blobs)
netlify/functions/create-checkout.mjs  /api/create-checkout
netlify/functions/stripe-webhook.mjs   /api/stripe-webhook (HMAC-verified; starts render)
netlify/functions/verify-payment.mjs   /api/verify-payment (redirect race; starts render)
```

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Lyric writing. |
| `ANTHROPIC_MODEL` | | `claude-opus-4-8` | |
| `ELEVENLABS_API_KEY` | ✅ for audio | — | Music (Eleven Music API). Without it, paid songs queue as `no_provider`. |
| `ELEVENLABS_API_BASE` | | `https://api.elevenlabs.io` | |
| `ELEVENLABS_MUSIC_LENGTH_MS` | | `180000` | Target render length per track, in ms (max ~300000). |
| `STRIPE_SECRET_KEY` | ✅ | — | |
| `STRIPE_WEBHOOK_SECRET` | ✅ | — | `whsec_…` |
| `SITE_URL` | recommended | request origin | Used for webhook-side generation and link building. |
| `CURRENCY` | | `usd` | |
| `PRICE_BASE_CENTS` | | `2499` | Keep in sync with `PRICE_BASE` in index.html. |
| `PRICE_DELUXE_CENTS` | | `999` | Keep in sync with `PRICE_DELUXE` in index.html. |
| `LYRICS_PER_HOUR` | | `10` | Per-IP free lyric-writing limit. |
| `FREE_LYRIC_REVISIONS` | | `3` | Free AI rewrites per song. |

## Setup

1. New Netlify site → base directory `song-app/` (publish `song-app/public`,
   functions `song-app/netlify/functions`).
2. Add env vars above.
3. Stripe → webhook endpoint `https://<site>/api/stripe-webhook`, event
   `checkout.session.completed`, copy signing secret.
4. Health check: `GET /api/song` returns `{status, elevenlabs, anthropic}`.

**Note on function timeouts:** each purchase now renders 2 tracks
synchronously in-request via the ElevenLabs Music API (no async
task/callback). If `ELEVENLABS_MUSIC_LENGTH_MS` is pushed toward the max and
renders start timing out on Netlify's default function limit, either lower
it or move `stripe-webhook`/`verify-payment` to
[background functions](https://docs.netlify.com/functions/background-functions/).

## Deliberate scope cuts (add later if data says so)

- Delivery email (Resend/Postmark) on purchase — today the success redirect +
  gift page ARE delivery; add email for abandoned-tab insurance.
- Deluxe currently prices the bump; wiring the extra alternate-style render is
  a follow-up (`rec.deluxe` is already stored).
- Lead re-marketing automation (leads are captured in the `leads` blob store).
