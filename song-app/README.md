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
public/index.html      landing + wizard + lyric approval + checkout + comp-code box
public/gift.html       delivery + producing-progress + gift/share page
public/admin.html      owner-only console for influencer comp codes
public/terms.html      ToS incl. refunds, license, AI disclosure
public/privacy.html    privacy policy
netlify/lib/core.mjs   shared: blobs, rate limits, render enqueue/retry, gating
netlify/lib/promo.mjs  comp-code generation, redemption, admin auth
netlify/functions/song.mjs             /api/song (lyrics/revise/edit/status/gift/lead/track/attach)
netlify/functions/song-audio.mjs       /api/song-audio (serves rendered tracks from Blobs, Range-aware)
netlify/functions/create-checkout.mjs  /api/create-checkout
netlify/functions/stripe-webhook.mjs   /api/stripe-webhook (HMAC-verified; enqueues render)
netlify/functions/verify-payment.mjs   /api/verify-payment (redirect race; enqueues render)
netlify/functions/redeem.mjs           /api/redeem (comp code → unlocks one song)
netlify/functions/promo-admin.mjs      /api/promo-admin (create/list/revoke codes; ADMIN_SECRET)
supabase/functions/render-song/index.ts  stateless renderer (ElevenLabs Music API), deployed to Supabase
```

## Influencer / press comp codes

A comp code is a one-time key that unlocks one song **for free** — the same
product a paying customer gets (two versions, downloads, gift page). Built for
sending with a press packet or a collab DM.

**To create codes:** set `ADMIN_SECRET` in Netlify (any random string, 12+
characters), then open `https://<your-site>/admin.html` and enter it. Pick who
the codes are for, how many, and whether they expire. You get back both the
raw codes and ready-to-send share links.

**What the influencer does:** either open the share link
(`https://<your-site>/?code=HEART-XXXX-XXXX` — the code fills itself in) or
write a song normally and click **"Have a code? Enter it here"** on the buy
card. Stripe is skipped entirely and production starts immediately.

**How it stays safe:**

- Codes exist only if you created one — there is no self-service path, and
  `/api/promo-admin` returns 503 until `ADMIN_SECRET` is set (no default
  password, no unauthenticated mode; the secret is compared in constant time).
- Redemption attempts are rate-limited to 8/hour per IP, so the ~1.1 trillion
  code space can't be brute-forced.
- A code is consumed only after the song is confirmed to exist and be unpaid,
  so a mistyped request never burns an influencer's one-time code. Re-applying
  the same code to the same song is a no-op, not a second use.
- Every redemption is recorded (song, time, email), and the last use is
  re-checked after writing, so two songs racing for one use can't both win.
- Revoke any code from `/admin.html` and it stops working immediately.

`admin.html` is `noindex` and holds no secret of its own — every action is
authorized server-side, so the page is useless to anyone without the password.

**Percentage discounts** (e.g. 20% off for a follower audience) are *not* this
system — use Stripe's own promotion codes in the Stripe Dashboard. Checkout
already sends `allow_promotion_codes`, so they work at the payment step with
no code changes. Use comp codes for 100%-free, Stripe promotion codes for
everything else.

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
| `ADMIN_SECRET` | ✅ for comp codes | — | Password for `/admin.html`. 12+ characters; without it the admin API refuses every request. |
| `PROMO_PREFIX` | | `HEART` | Prefix on generated codes, e.g. `HEART-AB12-CD34`. |
| `REDEEM_ATTEMPTS_PER_HOUR` | | `8` | Per-IP comp-code attempt limit (anti-brute-force). |
| `ADMIN_ATTEMPTS_PER_HOUR` | | `60` | Per-IP limit on admin API calls. |

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
