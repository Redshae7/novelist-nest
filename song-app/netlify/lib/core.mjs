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
export function envAny(names, fallback) {
  for (const n of names) { const v = env(n, ""); if (v) return v; }
  return fallback;
}
export function elevenLabsConfig() {
  return {
    // Netlify env keys are case-sensitive and this one has been entered
    // by hand in more than one spelling — accept the known variants.
    key: envAny(["ELEVENLABS_API_KEY", "Elevenlabs_Api_Key", "ELEVEN_LABS_API_KEY", "XI_API_KEY"], ""),
    musicLengthMs: Number(env("ELEVENLABS_MUSIC_LENGTH_MS", "180000")),
  };
}
export function renderConfig() {
  return {
    endpoint: env("RENDER_ENDPOINT", ""),
    secret: env("INTERNAL_API_SECRET", ""),
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

// ---- audio generation (ElevenLabs, via external renderer) ----------
// Netlify free-tier functions are killed at 10 seconds and a music
// render takes longer than that, so payment paths only ENQUEUE: they
// POST the job to the renderer (a Supabase Edge Function) which answers
// 202 immediately, renders in the background via the ElevenLabs Music
// API, and POSTs each finished track back to /api/song?action=attach
// (authenticated with INTERNAL_API_SECRET).
// Called ONLY from payment-confirmed paths (webhook / verify-payment)
// or as an idempotent re-check. Never from unauthenticated actions.

export const MAX_RENDER_ATTEMPTS = 3;
const QUEUED_STALE_MS = 8 * 60 * 1000; // renderer calls back well within this

export function buildMusicPrompt(rec) {
  // Eleven Music prompt limit is 4100 chars; style brief first, then lyrics.
  const style = String(rec.style || "").slice(0, 600);
  return ((style ? style + "\n\nLyrics:\n" : "Lyrics:\n") + String(rec.lyrics || "")).slice(0, 4100);
}

export async function enqueueGeneration(rec, origin, { retry = false } = {}) {
  if (!rec.paid) return rec;                       // hard gate
  const st = rec.audioStatus;
  if (st === "complete") return rec;
  if (st === "queued" && !retry) return rec;       // idempotent
  if ((rec.renderAttempts || 0) >= MAX_RENDER_ATTEMPTS) {
    if (st !== "failed") { rec.audioStatus = "failed"; await saveSong(rec); }
    return rec;
  }
  const { key, musicLengthMs } = elevenLabsConfig();
  const { endpoint, secret } = renderConfig();
  if (!key || !endpoint || !secret) { rec.audioStatus = "no_provider"; await saveSong(rec); return rec; }

  rec.audioStatus = "queued";
  rec.queuedAt = Date.now();
  rec.renderAttempts = (rec.renderAttempts || 0) + 1;
  rec.audioError = null;
  await saveSong(rec);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        songId: rec.id,
        prompt: buildMusicPrompt(rec),
        musicLengthMs,
        versions: 2,                               // two versions per purchase
        elevenLabsKey: key,                        // renderer is stateless; all config lives here
        callbackUrl: origin + "/api/song?action=attach",
        callbackSecret: secret,
      }),
    });
    if (!resp.ok) throw new Error("renderer " + resp.status);
    await track("generation_started");
  } catch (e) {
    rec.audioStatus = "queue_failed";              // status polling retries this
    rec.audioError = "enqueue: " + e.message;
    await saveSong(rec);
  }
  return rec;
}

// Self-healing: status/gift polls land here for paid songs, so a lost
// trigger or crashed render restarts instead of hanging forever.
export async function ensureGeneration(rec, origin) {
  if (!rec.paid) return rec;
  const st = rec.audioStatus;
  const staleQueue = st === "queued" && Date.now() - (rec.queuedAt || 0) > QUEUED_STALE_MS;
  const retriableFail = st === "failed" &&
    (rec.renderAttempts || 0) < MAX_RENDER_ATTEMPTS && !(rec.tracks || []).length;
  if (st === "queue_failed" || st === "no_provider" || staleQueue || retriableFail) {
    return enqueueGeneration(rec, origin, { retry: true });
  }
  return rec;
}

export function addTrack(rec, audioId, durationSec) {
  rec.tracks = rec.tracks || [];
  rec.tracks.push({
    audioUrl: "/api/song-audio?id=" + audioId,
    streamUrl: "/api/song-audio?id=" + audioId,
    imageUrl: null,
    duration: durationSec || null,
    title: rec.title || null,
  });
  // keep legacy single-track fields for older records / delivery email
  rec.audioUrl = rec.tracks[0].audioUrl;
  rec.streamUrl = rec.tracks[0].streamUrl;
  rec.duration = rec.tracks[0].duration;
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
