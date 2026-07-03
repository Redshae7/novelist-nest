import { getStore } from "@netlify/blobs";

/* ------------------------------------------------------------------ *
 * core.mjs — shared helpers for all Heartnote functions.
 *
 * The single most important business rule lives here:
 *   AUDIO IS ONLY EVER GENERATED AFTER PAYMENT.
 * Free traffic can only trigger (rate-limited, cheap) lyric writing.
 * ------------------------------------------------------------------ */

export const JSON_HEADERS = { "Content-Type": "application/json" };

export function env(name, fallback) {
  try { const v = Netlify.env.get(name); if (v) return v; } catch (e) {}
  try { const v = process.env[name]; if (v) return v; } catch (e) {}
  return fallback;
}
export function anthropicKey() {
  const k = env("ANTHROPIC_API_KEY", "");
  return k && k.startsWith("sk-") ? k : null;
}
export function sunoConfig() {
  return {
    key: env("SUNO_API_KEY", ""),
    base: (env("SUNO_API_BASE", "https://api.sunoapi.org") || "").replace(/\/$/, ""),
    model: env("SUNO_MODEL", "V4_5"),
  };
}

export function getIP(req) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
export function safeKey(s) { return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }
export function newId() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).toLowerCase();
}
export function ok(body) { return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS }); }
export function err(msg, status = 400, extra = {}) {
  return new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: JSON_HEADERS });
}

// ---- song records --------------------------------------------------
export async function loadSong(id) {
  const store = getStore({ name: "songs", consistency: "strong" });
  try { return await store.get("song-" + safeKey(id), { type: "json" }); } catch (e) { return null; }
}
export async function saveSong(rec) {
  const store = getStore({ name: "songs", consistency: "strong" });
  await store.set("song-" + safeKey(rec.id), JSON.stringify(rec));
  return rec;
}

// ---- analytics (best-effort, never throws) ------------------------
export async function track(eventName, revenueCents = 0) {
  try {
    const store = getStore({ name: "analytics" });
    const day = new Date().toISOString().slice(0, 10);
    const key = "a-" + day + "-" + safeKey(eventName);
    const cur = (await store.get(key, { type: "json" })) || { count: 0, revenue: 0 };
    cur.count = (cur.count || 0) + 1;
    if (revenueCents) cur.revenue = (cur.revenue || 0) + revenueCents;
    await store.set(key, JSON.stringify(cur));
  } catch (e) {}
}

// ---- rate limiting -------------------------------------------------
export async function checkRateLimit(ip, bucket, max, windowMs = 3600000) {
  try {
    const store = getStore({ name: "rate-limits" });
    const key = "rl-" + safeKey(bucket) + "-" + safeKey(ip);
    const now = Date.now();
    let rec = await store.get(key, { type: "json" }).catch(() => null);
    if (!rec || now - rec.s > windowMs) rec = { c: 0, s: now };
    if (rec.c >= max) return false;
    rec.c++;
    await store.set(key, JSON.stringify(rec));
    return true;
  } catch (e) { return true; } // fail open — availability over strictness
}

// ---- Suno: start + refresh ----------------------------------------
// Called ONLY from payment-confirmed paths (webhook / verify-payment)
// or as an idempotent no-op re-check. Never from unauthenticated actions.
export async function startGeneration(rec, origin) {
  if (!rec.paid) return rec;                       // hard gate
  if (rec.taskId && rec.audioStatus !== "failed") return rec; // idempotent
  const { key, base, model } = sunoConfig();
  if (!key) { rec.audioStatus = "no_provider"; await saveSong(rec); return rec; }

  const payload = {
    prompt: rec.lyrics,
    style: rec.style,
    title: rec.title,
    customMode: true,
    instrumental: false,
    model,
    callBackUrl: origin + "/api/song?action=callback&songId=" + encodeURIComponent(rec.id),
  };

  let resp, data = {};
  try {
    resp = await fetch(base + "/api/v1/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(payload),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    rec.audioStatus = "failed"; rec.audioError = "network: " + e.message;
    await saveSong(rec); return rec;
  }

  const taskId = data?.data?.taskId || data?.data?.task_id || data?.taskId;
  if (!resp.ok || (data.code && data.code !== 200) || !taskId) {
    rec.audioStatus = "failed";
    rec.audioError = JSON.stringify(data).slice(0, 200);
    await saveSong(rec); return rec;
  }

  rec.taskId = taskId;
  rec.audioStatus = "generating";
  rec.audioError = null;
  await saveSong(rec);
  await track("generation_started");
  return rec;
}

function mapSunoStatus(s) {
  const t = String(s || "").toUpperCase();
  if (["SUCCESS", "COMPLETE", "COMPLETED"].includes(t)) return "complete";
  if (t.includes("FAIL") || t.includes("ERROR") || t.includes("SENSITIVE")) return "failed";
  return "generating";
}

// Extract track list from either the record-info response or a callback body.
export function extractTracks(payload) {
  const d = payload?.data || payload || {};
  const arr = d?.response?.sunoData || d?.response?.data || d?.sunoData ||
              (Array.isArray(d?.data) ? d.data : null) || (Array.isArray(d) ? d : []);
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => ({
    audioUrl: t.audioUrl || t.audio_url || null,
    streamUrl: t.streamAudioUrl || t.stream_audio_url || null,
    imageUrl: t.imageUrl || t.image_url || null,
    duration: t.duration || null,
    title: t.title || null,
  })).filter((t) => t.audioUrl || t.streamUrl);
}

export function applyTracks(rec, tracks, statusStr) {
  if (tracks.length) {
    rec.tracks = tracks;
    // keep legacy single-track fields for older records / delivery email
    rec.audioUrl = tracks[0].audioUrl || rec.audioUrl || null;
    rec.streamUrl = tracks[0].streamUrl || rec.streamUrl || null;
    rec.imageUrl = tracks[0].imageUrl || rec.imageUrl || null;
    rec.duration = tracks[0].duration || rec.duration || null;
  }
  const mapped = mapSunoStatus(statusStr);
  const anyFinal = tracks.some((t) => t.audioUrl);
  rec.audioStatus = anyFinal ? "complete" : (tracks.length ? "streaming" : mapped);
  if (mapped === "failed" && !tracks.length) rec.audioStatus = "failed";
  return rec;
}

export async function refreshFromSuno(rec) {
  const { key, base } = sunoConfig();
  if (!key || !rec.taskId) return rec;
  if (rec.audioStatus === "complete") return rec;
  let resp, data;
  try {
    resp = await fetch(base + "/api/v1/generate/record-info?taskId=" + encodeURIComponent(rec.taskId), {
      headers: { Authorization: "Bearer " + key },
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) { return rec; } // transient; caller keeps polling
  const status = data?.data?.status;
  applyTracks(rec, extractTracks(data), status);
  if (rec.audioStatus === "complete" && !rec._completeTracked) {
    rec._completeTracked = true;
    await track("song_delivered");
  }
  await saveSong(rec);
  return rec;
}

// ---- public projection --------------------------------------------
// What the browser is allowed to see. Audio ONLY when paid.
export function publicSong(rec) {
  if (!rec) return null;
  const out = {
    id: rec.id,
    recipient: rec.recipient,
    sender: rec.sender || null,
    occasion: rec.occasion || null,
    title: rec.title,
    style: rec.style,
    genre: rec.genre,
    lyrics: rec.lyrics || null,          // lyrics are the free preview
    paid: !!rec.paid,
    status: rec.paid ? (rec.audioStatus || "pending") : "awaiting_payment",
    revisionsLeft: Math.max(0, REVISION_LIMIT - (rec.revisionsUsed || 0)),
    createdAt: rec.createdAt,
  };
  if (rec.paid) {
    out.tracks = (rec.tracks || []).map((t) => ({
      audioUrl: t.audioUrl, streamUrl: t.streamUrl, imageUrl: t.imageUrl, duration: t.duration,
    }));
    out.imageUrl = rec.imageUrl || null;
    if (rec.audioStatus === "failed") out.audioError = true;
  }
  return out;
}

export const REVISION_LIMIT = Number(env("FREE_LYRIC_REVISIONS", "3"));
