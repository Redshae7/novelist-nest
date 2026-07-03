import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { env, safeKey, loadSong, saveSong, track, enqueueGeneration } from "../lib/core.mjs";

/* ------------------------------------------------------------------ *
 * stripe-webhook.mjs — payment confirmation is the ONLY event that
 * unlocks a song and starts (paid) audio generation.
 * Signature verified with real HMAC-SHA256 + replay protection.
 * ------------------------------------------------------------------ */

function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch (e) { return false; }
}

export async function markPaidAndGenerate(session, origin) {
  const songId = session.metadata?.songId;
  if (!songId) return null;
  const rec = await loadSong(songId);
  if (!rec) return null;

  const firstTime = !rec.paid;
  rec.paid = true;
  rec.paidAt = rec.paidAt || new Date().toISOString();
  rec.checkoutSessionId = session.id;
  rec.email = session.customer_email || session.customer_details?.email || rec.email || "";
  rec.amountTotal = session.amount_total ?? rec.amountTotal ?? null;
  rec.deluxe = session.metadata?.deluxe === "1" || rec.deluxe || false;
  await saveSong(rec);

  if (firstTime) {
    await track("purchase", session.amount_total || 0);
    if (rec.deluxe) await track("upsell_deluxe");
    if (rec.email) {
      try {
        const leads = getStore({ name: "leads" });
        const lead = await leads.get("lead-" + safeKey(rec.email), { type: "json" });
        if (lead) { lead.converted = true; await leads.set("lead-" + safeKey(rec.email), JSON.stringify(lead)); }
      } catch (e) {}
    }
  }

  // Kick off (or idempotently re-check) the paid render.
  return enqueueGeneration(rec, origin);
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret || secret.startsWith("PASTE")) {
    // No signing secret -> we can't authenticate events, so accept none.
    // Payment unlock still works via /api/verify-payment on the redirect;
    // the webhook is closed-tab insurance, never an unverified side door.
    return new Response("Webhook not configured", { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();
  if (!verifyStripeSignature(rawBody, sig, secret)) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch (e) { return new Response("Invalid JSON", { status: 400 }); }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    if (session && session.payment_status === "paid") {
      const origin = env("SITE_URL", new URL(req.url).origin);
      await markPaidAndGenerate(session, origin);
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/stripe-webhook" };
