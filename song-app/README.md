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
   `paid=true` and enqueues the render: the job is handed to a small
   stateless renderer (Supabase Edge Function — Netlify free-tier
   functions are killed at 10s, too short for a music render), which
   calls the ElevenLabs Music API and posts the finished tracks back.
3. `gift.html?id=…` — delivery page: live "Producing your song…" progress →
   auto-plays when ready. Two version tabs, MP3 download, lyric sheet, and a
   share button — the same URL is the recipient's gift page (referral loop).

## Files

```
public/index.html      landing + wizard + lyric approval + checkout
public/gift.html       delivery + producing-progress + gift/share page
public/terms.html      ToS incl. refunds, license, AI disclosure
public/privacy.html    privacy policy
netlify/lib/core.mjs   shared: blobs, rate limits, render enqueue/retry, gating
netlify/functions/song.mjs             /api/song (lyrics/revise/edit/status/gift/lead/track/attach)
netlify/functions/song-audio.mjs       /api/song-audio (serves rendered tracks from Blobs, Range-aware)
netlify/functions/create-checkout.mjs  /api/create-checkout
netlify/functions/stripe-webhook.mjs   /api/stripe-webhook (HMAC-verified; enqueues render)
netlify/functions/verify-payment.mjs   /api/verify-payment (redirect race; enqueues render)
supabase/functions/render-song/index.ts  stateless renderer (ElevenLabs Music API), deployed to Supabase
```

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Lyric writing. |
| `ANTHROPIC_MODEL` | | `claude-opus-4-8` | |
| `ELEVENLABS_API_KEY` | ✅ for audio | — | Music (Eleven Music API — needs a paid ElevenLabs plan). Without it, paid songs queue as `no_provider`. Legacy spellings like `Elevenlabs_Api_Key` are also accepted. |
| `ELEVENLABS_MUSIC_LENGTH_MS` | | `180000` | Target render length per track, in ms (clamped 10000–300000). |
| `RENDER_ENDPOINT` | ✅ for audio | — | URL of the deployed `render-song` Supabase Edge Function. |
| `INTERNAL_API_SECRET` | ✅ for audio | — | Random string; authenticates the renderer's `attach` callbacks. |
| `STRIPE_SECRET_KEY` | ✅ | — | |
| `STRIPE_WEBHOOK_SECRET` | ✅ | — | `whsec_…` |
| `SITE_URL` | recommended | request origin | Used for renderer callbacks + webhook-side generation. |
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
4. Deploy the renderer: `supabase functions deploy render-song --no-verify-jwt`
   (or via the Supabase dashboard/MCP), then set `RENDER_ENDPOINT` to its URL
   (`https://<project-ref>.supabase.co/functions/v1/render-song`) and
   `INTERNAL_API_SECRET` to a long random string — both on the Netlify site.
5. Health check: `GET /api/song` returns `{status, elevenlabs, renderer, anthropic}`.

**Why the renderer lives on Supabase:** Netlify free-tier functions are
killed after 10 seconds; an ElevenLabs music render takes longer. Supabase
Edge Functions allow long background work, so the render happens there and
the finished MP3s are posted back into Netlify Blobs. If you upgrade Netlify
to Pro, this could be folded back into a Netlify
[background function](https://docs.netlify.com/functions/background-functions/)
instead. Caveat: free Supabase projects pause after ~1 week of inactivity —
if renders stop with songs stuck "queued", restore the project in the
Supabase dashboard (the app auto-retries queued songs on the next poll).

## Deliberate scope cuts (add later if data says so)

- Delivery email (Resend/Postmark) on purchase — today the success redirect +
  gift page ARE delivery; add email for abandoned-tab insurance.
- Deluxe currently prices the bump; wiring the extra alternate-style render is
  a follow-up (`rec.deluxe` is already stored).
- Lead re-marketing automation (leads are captured in the `leads` blob store).
