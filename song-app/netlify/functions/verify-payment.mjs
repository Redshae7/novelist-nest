import { getStore } from "@netlify/blobs";

/* ------------------------------------------------------------------ *
 * verify-payment.mjs — called on the success redirect to confirm payment
 * even before the webhook lands (Stripe retrieve), then unlock the song.
 *   { action: "verify",  songId, sessionId }
 *   { action: "status",  songId }
 * ------------------------------------------------------------------ */

function env(name, fallback) {
  try { const v = Netlify.env.get(name); if (v) return v; } catch (e) {}
  try { const v = process.env[name]; if (v) return v; } catch (e) {}
  return fallback;
}
function safeKey(s) { return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }

async function loadSong(id) {
  const store = getStore({ name: "songs", consistency: "strong" });
  return store.get("song-" + safeKey(id), { type: "json" }).catch(() => null);
}
async function unlock(rec, session) {
  const store = getStore({ name: "songs", consistency: "strong" });
  rec.paid = true;
  rec.paidAt = rec.paidAt || new Date().toISOString();
  rec.email = session.customer_email || session.customer_details?.email || rec.email || "";
  rec.amountTotal = session.amount_total || rec.amountTotal || null;
  if (session.metadata?.upsells) rec.upsells = session.metadata.upsells.split(",").filter(Boolean);
  await store.set("song-" + safeKey(rec.id), JSON.stringify(rec));
}

export default async (req) => {
  const headers = { "Content-Type": "application/json" };
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  let body;
  try { body = await req.json(); } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers });
  }

  const rec = await loadSong(body.songId);
  if (!rec) return new Response(JSON.stringify({ error: "Song not found", paid: false }), { status: 404, headers });

  if (body.action === "status") {
    return new Response(JSON.stringify({ paid: !!rec.paid, paidAt: rec.paidAt || null }), { status: 200, headers });
  }

  if (body.action === "verify" && body.sessionId) {
    if (rec.paid) {
      return new Response(JSON.stringify({ paid: true, giftUrl: "/gift.html?id=" + rec.id }), { status: 200, headers });
    }
    const stripeKey = env("STRIPE_SECRET_KEY");
    if (!stripeKey || stripeKey.startsWith("PASTE")) {
      return new Response(JSON.stringify({ error: "Stripe not configured", paid: false }), { status: 500, headers });
    }
    let resp;
    try {
      resp = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(body.sessionId), {
        headers: { Authorization: "Bearer " + stripeKey },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Network error", paid: false }), { status: 502, headers });
    }
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: "Could not verify session", paid: false }), { status: 200, headers });
    }
    const session = await resp.json();
    if (session.payment_status === "paid") {
      await unlock(rec, session);
      return new Response(JSON.stringify({ paid: true, verified: true, giftUrl: "/gift.html?id=" + rec.id }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ paid: false, paymentStatus: session.payment_status }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: "Invalid action. Use 'verify' or 'status'." }), { status: 400, headers });
};

export const config = { path: "/api/verify-payment" };
