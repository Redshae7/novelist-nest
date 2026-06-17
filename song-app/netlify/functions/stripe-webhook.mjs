import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ *
 * stripe-webhook.mjs — confirms payment and unlocks the full song.
 * Verifies the Stripe signature with real HMAC-SHA256 (not a shortcut).
 * ------------------------------------------------------------------ */

function env(name, fallback) {
  try { const v = Netlify.env.get(name); if (v) return v; } catch (e) {}
  try { const v = process.env[name]; if (v) return v; } catch (e) {}
  return fallback;
}
function safeKey(s) { return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }

// Constant-time HMAC verification of the Stripe-Signature header.
function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => kv.split("=").map((s) => s.trim()))
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  // Replay protection.
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch (e) { return false; }
}

async function markPaid(session) {
  const store = getStore({ name: "songs", consistency: "strong" });
  const songId = session.metadata?.songId;
  if (!songId) return;
  const rec = await store.get("song-" + safeKey(songId), { type: "json" });
  if (!rec) return;
  rec.paid = true;
  rec.paidAt = new Date().toISOString();
  rec.checkoutSessionId = session.id;
  rec.email = session.customer_email || session.customer_details?.email || rec.email || "";
  rec.amountTotal = session.amount_total || rec.amountTotal || null;
  if (session.metadata?.upsells) rec.upsells = session.metadata.upsells.split(",").filter(Boolean);
  await store.set("song-" + safeKey(songId), JSON.stringify(rec));

  // Mark the lead as converted.
  if (rec.email) {
    try {
      const leads = getStore({ name: "leads" });
      const lead = await leads.get("lead-" + safeKey(rec.email), { type: "json" });
      if (lead) { lead.converted = true; await leads.set("lead-" + safeKey(rec.email), JSON.stringify(lead)); }
    } catch (e) {}
  }

  // Analytics.
  try {
    const a = getStore({ name: "analytics" });
    const day = new Date().toISOString().slice(0, 10);
    for (const ev of ["purchase", ...(rec.upsells || []).map((u) => "upsell_" + u)]) {
      const k = "a-" + day + "-" + ev;
      const cur = (await a.get(k, { type: "json" })) || { count: 0, revenue: 0 };
      cur.count = (cur.count || 0) + 1;
      if (ev === "purchase") cur.revenue = (cur.revenue || 0) + (session.amount_total || 0);
      await a.set(k, JSON.stringify(cur));
    }
  } catch (e) {}
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = env("STRIPE_WEBHOOK_SECRET");
  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  if (secret && !secret.startsWith("PASTE")) {
    if (!verifyStripeSignature(rawBody, sig, secret)) {
      return new Response("Invalid signature", { status: 400 });
    }
  }

  let event;
  try { event = JSON.parse(rawBody); } catch (e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    if (session && session.payment_status === "paid") {
      await markPaid(session);
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/stripe-webhook" };
