import { env, ok, err, loadSong, saveSong, track } from "../lib/core.mjs";

/* ------------------------------------------------------------------ *
 * create-checkout.mjs — Stripe Checkout for one song.
 *
 * Pricing philosophy: ONE impulse-friendly price that includes
 * everything (two versions, downloads, gift page, lyric sheet), plus a
 * single optional Deluxe bump. No pre-created Stripe products needed —
 * inline price_data, env-configurable.
 * ------------------------------------------------------------------ */

function catalog() {
  return {
    base: {
      name: "Your Custom Song — Full Package",
      desc: "Two studio-quality versions, MP3 downloads, lyric sheet & shareable gift page.",
      cents: Number(env("PRICE_BASE_CENTS", "2499")),
    },
    deluxe: {
      name: "Deluxe Upgrade",
      desc: "A third version in an alternate style + extended cut.",
      cents: Number(env("PRICE_DELUXE_CENTS", "999")),
    },
  };
}

export default async (req) => {
  if (req.method !== "POST") return err("Method not allowed", 405);

  const stripeKey = env("STRIPE_SECRET_KEY");
  if (!stripeKey || stripeKey.startsWith("PASTE"))
    return err("Stripe not configured. Add STRIPE_SECRET_KEY in Netlify env vars.", 500);

  let body;
  try { body = await req.json(); } catch (e) { return err("Invalid request"); }

  const rec = await loadSong(body.songId);
  if (!rec) return err("Song not found — please create your song first.", 404);
  if (rec.paid) return ok({ alreadyPaid: true, url: "/gift.html?id=" + rec.id });

  const origin = req.headers.get("origin") || env("SITE_URL", "https://example.netlify.app");
  const currency = env("CURRENCY", "usd");
  const cat = catalog();
  const deluxe = !!body.deluxe;

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", origin + "/gift.html?id=" + encodeURIComponent(rec.id) + "&session_id={CHECKOUT_SESSION_ID}");
  params.append("cancel_url", origin + "/?resume=" + encodeURIComponent(rec.id));
  params.append("allow_promotion_codes", "true");
  if (body.email) params.append("customer_email", body.email);

  const items = deluxe ? ["base", "deluxe"] : ["base"];
  items.forEach((k, i) => {
    params.append(`line_items[${i}][price_data][currency]`, currency);
    params.append(`line_items[${i}][price_data][product_data][name]`, cat[k].name);
    params.append(`line_items[${i}][price_data][product_data][description]`, cat[k].desc);
    params.append(`line_items[${i}][price_data][unit_amount]`, String(cat[k].cents));
    params.append(`line_items[${i}][quantity]`, "1");
  });

  params.append("metadata[songId]", String(rec.id));
  params.append("metadata[deluxe]", deluxe ? "1" : "0");
  params.append("metadata[source]", "heartnote");

  let resp;
  try {
    resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + stripeKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (e) { return err("Network error: " + e.message, 502); }

  if (!resp.ok) {
    const detail = await resp.text();
    return err("Stripe error", resp.status, { details: detail.slice(0, 300) });
  }

  const session = await resp.json();
  rec.checkoutSessionId = session.id;
  rec.deluxe = deluxe;
  if (body.email) rec.email = body.email;
  await saveSong(rec);
  await track("checkout_created");

  return ok({ url: session.url, sessionId: session.id });
};

export const config = { path: "/api/create-checkout" };
