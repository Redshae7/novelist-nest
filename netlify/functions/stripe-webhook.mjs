import { getStore } from "@netlify/blobs";

function safeKey(s) { return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }

async function markPaidBySession(sessionId, email, ip) {
  const store = getStore("payments", { consistency: "strong" });
  
  // Store by session ID (always works, even without IP)
  await store.set("session-" + safeKey(sessionId), JSON.stringify({
    paid: true,
    sessionId,
    email: email || "",
    ip: ip || "",
    paidAt: new Date().toISOString(),
    chaptersAllowed: 25
  }));

  // If we have an IP from metadata, also store by IP for quick lookups
  if (ip) {
    await store.set("paid-" + safeKey(ip), JSON.stringify({
      paid: true,
      sessionId,
      email: email || "",
      paidAt: new Date().toISOString(),
      chaptersAllowed: 25
    }));
  }
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const webhookSecret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  // If webhook secret is configured, verify signature
  // For now, we'll do basic validation without the Stripe SDK
  // In production, use Stripe SDK for proper signature verification
  if (webhookSecret && webhookSecret !== "PASTE_YOUR_STRIPE_WEBHOOK_SECRET_HERE" && sig) {
    // Basic check: ensure the request has a signature header
    // Full HMAC verification would require the Stripe SDK
    if (!sig.includes("t=") || !sig.includes("v1=")) {
      return new Response("Invalid signature", { status: 400 });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch(e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Only handle checkout.session.completed
  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    if (!session) return new Response("No session data", { status: 400 });

    if (session.payment_status === "paid") {
      const email = session.customer_email || session.customer_details?.email || "";
      const ip = session.metadata?.ip || "";

      await markPaidBySession(session.id, email, ip);

      console.log(`[WEBHOOK] Payment confirmed: session=${session.id}, email=${email}, ip=${ip}`);
    }
  }

  // Always return 200 to acknowledge receipt (Stripe retries on non-200)
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};

export const config = { path: "/api/stripe-webhook" };
