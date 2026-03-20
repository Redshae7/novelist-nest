import { getStore } from "@netlify/blobs";

function getIP(req) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
function safeKey(s) { return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }

export default async (req, context) => {
  const headers = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const stripeKey = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey || stripeKey.startsWith("PASTE")) {
    return new Response(JSON.stringify({ error: "Stripe not configured. Add STRIPE_SECRET_KEY in Netlify env vars." }), { status: 500, headers });
  }

  const ip = getIP(req);
  let body;
  try { body = await req.json(); } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers });
  }

  // Get the origin for redirect URLs
  const origin = req.headers.get("origin") || "https://novelistnest.netlify.app";

  try {
    // Determine which price to use - default to Book Pass
    const VALID_PRICES = [
      "price_1TCdhPGfC89Ah6OShoSU2EIR", // Book Pass $19.99
      "price_1TD7OwGfC89Ah6OSTBL3E0b3"  // Edit Pass $14.99
    ];
    const requestedPrice = body.priceId || "price_1TCdhPGfC89Ah6OShoSU2EIR";
    const priceId = VALID_PRICES.includes(requestedPrice) ? requestedPrice : VALID_PRICES[0];

    // Create Stripe Checkout Session via raw API (no SDK needed)
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", origin + "/app.html?payment=success&session_id={CHECKOUT_SESSION_ID}");
    params.append("cancel_url", origin + "/app.html?payment=cancelled");
    params.append("line_items[0][price]", priceId);
    params.append("line_items[0][quantity]", "1");
    params.append("metadata[ip]", ip);
    params.append("metadata[source]", "novelist-nest-app");
    params.append("metadata[product_type]", priceId === VALID_PRICES[1] ? "edit-pass" : "book-pass");
    if (body.email) params.append("customer_email", body.email);

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + stripeKey,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(JSON.stringify({ error: "Stripe error", details: err.slice(0, 300) }), { status: resp.status, headers });
    }

    const session = await resp.json();
    return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), { status: 200, headers });

  } catch(err) {
    return new Response(JSON.stringify({ error: "Checkout creation failed: " + err.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/create-checkout" };
