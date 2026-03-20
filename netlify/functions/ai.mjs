import { getStore } from "@netlify/blobs";

function getApiKey() {
  try { const k = Netlify.env.get("ANTHROPIC_API_KEY"); if (k?.length > 20 && k.startsWith("sk-")) return k; } catch(e){}
  try { const k = process.env.ANTHROPIC_API_KEY; if (k?.length > 20 && k.startsWith("sk-")) return k; } catch(e){}
  return null;
}

function getIP(req) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function safeKey(s) { return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }

async function getUsage(ip) {
  const store = getStore("usage");
  const day = new Date().toISOString().slice(0, 10);
  const key = "u-" + safeKey(ip) + "-" + day;
  try { const r = await store.get(key, { type: "json" }); if (r) return r; } catch(e){}
  return { outline: 0, chapter: 0, meta: 0, total: 0, day };
}

async function incUsage(ip, type) {
  const store = getStore("usage");
  const u = await getUsage(ip);
  u[type] = (u[type] || 0) + 1;
  u.total = (u.total || 0) + 1;
  const day = new Date().toISOString().slice(0, 10);
  await store.set("u-" + safeKey(ip) + "-" + day, JSON.stringify(u));
  return u;
}

async function checkBeta(ip) {
  // Beta access: check if beta password was verified for this IP
  const store = getStore("beta-access");
  try { const r = await store.get("beta-" + safeKey(ip)); if (r === "granted") return true; } catch(e){}
  return false;
}

export default async (req, context) => {
  const headers = { "Content-Type": "application/json" };

  // GET = diagnostic
  if (req.method === "GET") {
    const key = getApiKey();
    return new Response(JSON.stringify({ status: "running", keyFound: !!key }), { status: 200, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const apiKey = getApiKey();
  if (!apiKey) return new Response(JSON.stringify({ error: "API not configured" }), { status: 500, headers });

  let body;
  try { body = await req.json(); } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400, headers });
  }

  const ip = getIP(req);

  // BETA LOGIN endpoint
  if (body.action === "beta-login") {
    const betaPw = Netlify.env.get("BETA_PASSWORD") || "NestBeta2026";
    if (body.password === betaPw) {
      const store = getStore("beta-access");
      await store.set("beta-" + safeKey(ip), "granted");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: "Invalid beta access code" }), { status: 401, headers });
  }

  // TOS ACCEPT endpoint — stores consent record
  if (body.action === "tos-accept") {
    const tosVersion = body.tosVersion || "1.0";
    const privacyVersion = body.privacyVersion || "1.0";
    const store = getStore("tos-consent", { consistency: "strong" });
    const record = {
      accepted: true,
      tosVersion,
      privacyVersion,
      acceptedAt: new Date().toISOString(),
      ip: ip
    };
    await store.set("tos-" + safeKey(ip), JSON.stringify(record));
    return new Response(JSON.stringify({ ok: true, tosVersion, privacyVersion }), { status: 200, headers });
  }

  // TOS CHECK endpoint — checks if user has accepted current version
  if (body.action === "tos-check") {
    const currentTosVersion = "1.0";
    const currentPrivacyVersion = "1.0";
    const store = getStore("tos-consent", { consistency: "strong" });
    try {
      const rec = await store.get("tos-" + safeKey(ip), { type: "json" });
      if (rec && rec.accepted && rec.tosVersion === currentTosVersion && rec.privacyVersion === currentPrivacyVersion) {
        return new Response(JSON.stringify({ accepted: true, tosVersion: rec.tosVersion, privacyVersion: rec.privacyVersion, acceptedAt: rec.acceptedAt }), { status: 200, headers });
      }
    } catch(e) {}
    return new Response(JSON.stringify({ accepted: false, currentTosVersion, currentPrivacyVersion }), { status: 200, headers });
  }

  // CHECK BETA ACCESS
  const hasBeta = await checkBeta(ip);
  if (!hasBeta) {
    return new Response(JSON.stringify({ error: "beta-required", msg: "This app is in private beta. Enter your access code to continue." }), { status: 403, headers });
  }

  // CHECK TOS ACCEPTANCE — block AI generation if TOS not accepted
  try {
    const tosStore = getStore("tos-consent", { consistency: "strong" });
    const tosRec = await tosStore.get("tos-" + safeKey(ip), { type: "json" });
    if (!tosRec || !tosRec.accepted || tosRec.tosVersion !== "1.0") {
      return new Response(JSON.stringify({ error: "tos-required", msg: "You must accept the Terms of Service before using this feature." }), { status: 403, headers });
    }
  } catch(e) {
    // On blob read failure, allow through to not block users
  }

  // RATE LIMIT: 40 calls/hour
  try {
    const store = getStore("rate-limits");
    const rlKey = "rl-" + safeKey(ip);
    const now = Date.now();
    let rec = null;
    try { rec = await store.get(rlKey, { type: "json" }); } catch(e){}
    if (!rec || now - rec.s > 3600000) rec = { c: 0, s: now };
    if (rec.c >= 40) return new Response(JSON.stringify({ error: "Rate limit: 40 requests/hour. Please wait." }), { status: 429, headers });
    rec.c++;
    await store.set(rlKey, JSON.stringify(rec));
  } catch(e) { /* allow on blob failure */ }

  // CHECK IF USER IS PAID
  let userIsPaid = false;
  try {
    const payStore = getStore("payments", { consistency: "strong" });
    const payRec = await payStore.get("paid-" + safeKey(ip), { type: "json" });
    if (payRec && payRec.paid) userIsPaid = true;
  } catch(e) {}

  // USAGE LIMITS — detect request type
  const prompt = body.messages?.[0]?.content || "";
  let reqType = "chapter";
  if (body._type) reqType = body._type;
  else if (prompt.toLowerCase().includes("outline")) reqType = "outline";
  else if (prompt.toLowerCase().includes("metadata") || prompt.toLowerCase().includes("keywords")) reqType = "meta";

  const usage = await getUsage(ip);

  // FREE vs PAID limits
  const LIMITS = userIsPaid
    ? { outline: 10, chapter: 150, meta: 10, total: 200 }
    : { outline: 3, chapter: 15, meta: 3, total: 50 };
  if (usage.total >= LIMITS.total) {
    return new Response(JSON.stringify({ error: "Daily limit reached (" + LIMITS.total + " requests). Come back tomorrow." }), { status: 429, headers });
  }

  await incUsage(ip, reqType);

  // BUILD SAFE REQUEST
  const maxTok = Math.min(body.max_tokens || 1200, 1200);
  const safeReq = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTok,
    system: typeof body.system === "string" ? body.system.slice(0, 800) : "You are a professional book writing assistant.",
    messages: (body.messages || []).slice(0, 6).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content.slice(0, 4000) : ""
    })).filter(m => m.content)
  };

  if (!safeReq.messages.length) return new Response(JSON.stringify({ error: "No content" }), { status: 400, headers });

  // CALL ANTHROPIC
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(safeReq)
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      let hint = resp.status === 401 ? "Check API key" : resp.status === 400 ? err.slice(0, 200) : "";
      return new Response(JSON.stringify({ error: "AI error " + resp.status, hint }), { status: resp.status, headers });
    }
    const data = await resp.json();
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: "Network: " + err.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/ai" };
