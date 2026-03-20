import { getStore } from "@netlify/blobs";

function getIP(req) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
function safeKey(s) { return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }

async function markPaid(ip, sessionId, email) {
  const store = getStore("payments", { consistency: "strong" });
  const key = "paid-" + safeKey(ip);
  const record = {
    paid: true,
    sessionId: sessionId,
    email: email || "",
    paidAt: new Date().toISOString(),
    chaptersAllowed: 25
  };
  await store.set(key, JSON.stringify(record));
  return record;
}

async function checkPaid(ip) {
  const store = getStore("payments", { consistency: "strong" });
  try {
    const rec = await store.get("paid-" + safeKey(ip), { type: "json" });
    if (rec && rec.paid) return rec;
  } catch(e) {}
  return null;
}

export default async (req, context) => {
  const headers = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const stripeKey = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey || stripeKey.startsWith("PASTE")) {
    return new Response(JSON.stringify({ error: "Stripe not configured" }), { status: 500, headers });
  }

  let body;
  try { body = await req.json(); } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers });
  }

  const ip = getIP(req);

  // ACTION: check-status — just check if this IP has paid
  if (body.action === "check-status") {
    const rec = await checkPaid(ip);
    if (rec) {
      return new Response(JSON.stringify({ paid: true, paidAt: rec.paidAt, chaptersAllowed: rec.chaptersAllowed }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ paid: false }), { status: 200, headers });
  }

  // ACTION: verify — verify a specific checkout session
  if (body.action === "verify" && body.sessionId) {
    // Retrieve session from Stripe
    try {
      const resp = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(body.sessionId), {
        headers: { "Authorization": "Bearer " + stripeKey }
      });

      if (!resp.ok) {
        return new Response(JSON.stringify({ error: "Could not verify session", paid: false }), { status: 200, headers });
      }

      const session = await resp.json();

      if (session.payment_status === "paid") {
        // Mark as paid — idempotent (safe to call multiple times)
        const rec = await markPaid(ip, session.id, session.customer_email || session.customer_details?.email || "");
        return new Response(JSON.stringify({
          paid: true,
          verified: true,
          paidAt: rec.paidAt,
          chaptersAllowed: rec.chaptersAllowed,
          status: "confirmed"
        }), { status: 200, headers });
      } else {
        return new Response(JSON.stringify({
          paid: false,
          verified: true,
          paymentStatus: session.payment_status,
          status: session.payment_status === "unpaid" ? "pending" : session.payment_status
        }), { status: 200, headers });
      }
    } catch(err) {
      return new Response(JSON.stringify({ error: "Verification failed: " + err.message, paid: false }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Invalid action. Use 'check-status' or 'verify'" }), { status: 400, headers });
};

export const config = { path: "/api/verify-payment" };
