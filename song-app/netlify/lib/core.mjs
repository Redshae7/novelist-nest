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
export function elevenLabsConfig() {
  return {
    key: env("ELEVENLABS_API_KEY", ""),
    base: (env("ELEVENLABS_API_BASE", "https://api.elevenlabs.io") || "").replace(/\/$/, ""),
    musicLengthMs: Number(env("ELEVENLABS_MUSIC_LENGTH_MS", "180000")),
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

// ---- ElevenLabs: music generation -----------------------------------
// Called ONLY from payment-confirmed paths (webhook / verify-payment)
// or as an idempotent no-op re-check. Never from unauthenticated actions.
// The Eleven Music API is synchronous (audio bytes come back on the same
// request) — there's no task/polling/callback dance like Suno had.
export async function startGeneration(rec, origin) {
  if (!rec.paid) return rec;                                   // hard gate
  if (rec.audioStatus === "generating" || rec.audioStatus === "complete") return rec; // idempotent
  const { key, base, musicLengthMs } = elevenLabsConfig();
  if (!key) { rec.audioStatus = "no_provider"; await saveSong(rec); return rec; }

  rec.audioStatus = "generating";
  rec.audioError = null;
  await saveSong(rec);

  const prompt = `${rec.style}\n\n${rec.lyrics}`;

  let tracks;
  try {
    // Two versions per purchase (matches the original value prop).
    const renders = await Promise.all([
      generateTrack({ key, base, musicLengthMs, prompt, title: rec.title, songId: rec.id }),
      generateTrack({ key, base, musicLengthMs, prompt, title: rec.title, songId: rec.id }),
    ]);
    tracks = renders.filter(Boolean);
  } catch (e) {
    rec.audioStatus = "failed";
    rec.audioError = "generation: " + e.message;
    await saveSong(rec);
    return rec;
  }

  if (!tracks.length) {
    rec.audioStatus = "failed";
    rec.audioError = "No tracks were produced.";
    await saveSong(rec);
    return rec;
  }

  applyTracks(rec, tracks);
  await saveSong(rec);
  await track("generation_started");
  if (!rec._completeTracked) {
    rec._completeTracked = true;
    await track("song_delivered");
    await saveSong(rec);
  }
  return rec;
}

async function generateTrack({ key, base, musicLengthMs, prompt, title, songId }) {
  const resp = await fetch(base + "/v1/music", {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": key },
    body: JSON.stringify({ prompt, music_length_ms: musicLengthMs }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error("ElevenLabs " + resp.status + ": " + detail.slice(0, 200));
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const audioId = newId();
  const store = getStore({ name: "audio" });
  await store.set("track-" + audioId, buf, { metadata: { songId, title } });
  return {
    audioUrl: "/api/song-audio?id=" + audioId,
    streamUrl: "/api/song-audio?id=" + audioId,
    imageUrl: null,
    duration: Math.round(musicLengthMs / 1000),
    title,
  };
}

export function applyTracks(rec, tracks) {
  rec.tracks = tracks;
  // keep legacy single-track fields for older records / delivery email
  rec.audioUrl = tracks[0]?.audioUrl || rec.audioUrl || null;
  rec.streamUrl = tracks[0]?.streamUrl || rec.streamUrl || null;
  rec.imageUrl = tracks[0]?.imageUrl || rec.imageUrl || null;
  rec.duration = tracks[0]?.duration || rec.duration || null;
  rec.audioStatus = tracks.length ? "complete" : "failed";
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
