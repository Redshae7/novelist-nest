import { env, ok, err, loadSong } from "../lib/core.mjs";
import { markPaidAndGenerate } from "./stripe-webhook.mjs";

/* ------------------------------------------------------------------ *
 * verify-payment.mjs — called by the delivery page right after the
 * Stripe redirect, so the song unlocks and starts rendering even
 * before the webhook lands. Retrieves the session server-side from
 * Stripe (the client can't forge a paid state).
 * ------------------------------------------------------------------ */

export default async (req) => {
  if (req.method !== "POST") return err("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch (e) { return err("Invalid request"); }

  const rec = await loadSong(body.songId);
  if (!rec) return err("Song not found", 404);

  if (rec.paid) return ok({ paid: true });

  if (!body.sessionId) return ok({ paid: false });

  const stripeKey = env("STRIPE_SECRET_KEY");
  if (!stripeKey || stripeKey.startsWith("PASTE")) return err("Stripe not configured", 500);

  let resp;
  try {
    resp = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(body.sessionId), {
      headers: { Authorization: "Bearer " + stripeKey },
    });
  } catch (e) { return err("Network error", 502); }
  if (!resp.ok) return ok({ paid: false, error: "Could not verify session" });

  const session = await resp.json();
  // The session must belong to THIS song — no cross-unlocking.
  if (session.metadata?.songId !== rec.id) return ok({ paid: false });

  if (session.payment_status === "paid") {
    const origin = req.headers.get("origin") || env("SITE_URL", new URL(req.url).origin);
    await markPaidAndGenerate(session, origin);
    return ok({ paid: true, verified: true });
  }
  return ok({ paid: false, paymentStatus: session.payment_status });
};

export const config = { path: "/api/verify-payment" };
