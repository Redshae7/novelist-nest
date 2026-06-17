import { getStore } from "@netlify/blobs";

/* ------------------------------------------------------------------ *
 * create-checkout.mjs — Stripe Checkout session for a song.
 *
 * Uses inline price_data so NO products/prices need to be pre-created in
 * Stripe. Base song + optional order-bump upsells, all configurable here.
 * ------------------------------------------------------------------ */

function env(name, fallback) {
  try { const v = Netlify.env.get(name); if (v) return v; } catch (e) {}
  try { const v = process.env[name]; if (v) return v; } catch (e) {}
  return fallback;
}
function safeKey(s) { return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }

// Catalogue: base product + the upsells offered as checkout order-bumps.
// Prices in cents. Change freely — nothing is pre-registered in Stripe.
const CATALOG = {
  base:        { name: "Your Full Custom Song (studio quality)", cents: Number(env("PRICE_BASE_CENTS", "3499")) },
  rush:        { name: "Express priority rendering",             cents: Number(env("PRICE_RUSH_CENTS", "1499")) },
  extended:    { name: "Extended full-length version",           cents: Number(env("PRICE_EXTENDED_CENTS", "1000")) },
  alt_version: { name: "Second version in a different style",    cents: Number(env("PRICE_ALT_CENTS", "1500")) },
  video:       { name: "Animated video gift page",               cents: Number(env("PRICE_VIDEO_CENTS", "1900")) },
};

export default async (req) => {
  const headers = { "Content-Type": "application/json" };
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  const stripeKey = env("STRIPE_SECRET_KEY");
  if (!stripeKey || stripeKey.startsWith("PASTE")) {
    return new Response(JSON.stringify({ error: "Stripe not configured. Add STRIPE_SECRET_KEY in Netlify env vars." }), { status: 500, headers });
  }

  let body;
  try { body = await req.json(); } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers });
  }

  const songId = body.songId;
  if (!songId) return new Response(JSON.stringify({ error: "Missing songId" }), { status: 400, headers });

  const origin = req.headers.get("origin") || env("SITE_URL", "https://example.netlify.app");
  const currency = env("CURRENCY", "usd");

  // Build line items: base + any valid upsells the client selected.
  const selected = Array.isArray(body.upsells) ? body.upsells.filter((u) => CATALOG[u] && u !== "base") : [];
  const lineKeys = ["base", ...selected];

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", origin + "/?payment=success&session_id={CHECKOUT_SESSION_ID}&song=" + encodeURIComponent(songId));
  params.append("cancel_url", origin + "/?payment=cancelled&song=" + encodeURIComponent(songId));
  params.append("allow_promotion_codes", "true");
  if (body.email) params.append("customer_email", body.email);

  lineKeys.forEach((k, i) => {
    const item = CATALOG[k];
    params.append(`line_items[${i}][price_data][currency]`, currency);
    params.append(`line_items[${i}][price_data][product_data][name]`, item.name);
    params.append(`line_items[${i}][price_data][unit_amount]`, String(item.cents));
    params.append(`line_items[${i}][quantity]`, "1");
  });

  params.append("metadata[songId]", String(songId));
  params.append("metadata[upsells]", selected.join(","));
  params.append("metadata[source]", "song-app");

  let resp;
  try {
    resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + stripeKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Network error: " + e.message }), { status: 502, headers });
  }

  if (!resp.ok) {
    const detail = await resp.text();
    return new Response(JSON.stringify({ error: "Stripe error", details: detail.slice(0, 300) }), { status: resp.status, headers });
  }

  const session = await resp.json();

  // Record the pending order on the song.
  try {
    const store = getStore({ name: "songs", consistency: "strong" });
    const rec = await store.get("song-" + safeKey(songId), { type: "json" });
    if (rec) {
      rec.checkoutSessionId = session.id;
      rec.upsells = selected;
      if (body.email) rec.email = body.email;
      await store.set("song-" + safeKey(songId), JSON.stringify(rec));
    }
  } catch (e) { /* best-effort */ }

  return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), { status: 200, headers });
};

export const config = { path: "/api/create-checkout" };
