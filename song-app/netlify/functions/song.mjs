import { getStore } from "@netlify/blobs";

/* ------------------------------------------------------------------ *
 * song.mjs — single action-routed function for the song funnel.
 *
 * Actions (POST JSON { action: "..." }):
 *   lyrics   -> generate title + lyrics + style from the gift form (Anthropic)
 *   generate -> kick off audio generation for a song (Suno)
 *   status   -> poll generation; returns a GATED preview until paid
 *   callback -> Suno calls this when a task finishes (stores result)
 *   gift     -> fetch a public gift record by id (for gift.html)
 *   lead     -> capture an email lead (abandoned-cart / marketing)
 *   track    -> record a funnel analytics event
 *
 * State lives in Netlify Blobs:
 *   songs        song-<id>        the full record (lyrics, task, audio, paid)
 *   leads        lead-<email>     captured emails
 *   analytics    a-<day>-<event>  per-day funnel counters
 *   rate-limits  rl-<ip>          abuse control on free generation
 * ------------------------------------------------------------------ */

const JSON_HEADERS = { "Content-Type": "application/json" };

// ---- config / env helpers ----------------------------------------
function anthropicKey() {
  try { const k = Netlify.env.get("ANTHROPIC_API_KEY"); if (k?.startsWith("sk-")) return k; } catch (e) {}
  try { const k = process.env.ANTHROPIC_API_KEY; if (k?.startsWith("sk-")) return k; } catch (e) {}
  return null;
}
function env(name, fallback) {
  try { const v = Netlify.env.get(name); if (v) return v; } catch (e) {}
  try { const v = process.env[name]; if (v) return v; } catch (e) {}
  return fallback;
}
function sunoConfig() {
  return {
    key: env("SUNO_API_KEY", ""),
    base: (env("SUNO_API_BASE", "https://api.sunoapi.org") || "").replace(/\/$/, ""),
    model: env("SUNO_MODEL", "V4_5"),
  };
}

function getIP(req) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
function safeKey(s) { return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200); }
function newId() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).toLowerCase();
}
function ok(body) { return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS }); }
function err(msg, status = 400, extra = {}) {
  return new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: JSON_HEADERS });
}

// ---- blob helpers -------------------------------------------------
async function loadSong(id) {
  const store = getStore({ name: "songs", consistency: "strong" });
  try { return await store.get("song-" + safeKey(id), { type: "json" }); } catch (e) { return null; }
}
async function saveSong(rec) {
  const store = getStore({ name: "songs", consistency: "strong" });
  await store.set("song-" + safeKey(rec.id), JSON.stringify(rec));
  return rec;
}
async function track(eventName) {
  try {
    const store = getStore({ name: "analytics" });
    const day = new Date().toISOString().slice(0, 10);
    const key = "a-" + day + "-" + safeKey(eventName);
    const cur = (await store.get(key, { type: "json" })) || { count: 0 };
    cur.count = (cur.count || 0) + 1;
    await store.set(key, JSON.stringify(cur));
  } catch (e) { /* analytics best-effort */ }
}

// ---- rate limiting (protect the paid Suno calls) -----------------
async function checkRateLimit(ip, max = 6, windowMs = 3600000) {
  try {
    const store = getStore({ name: "rate-limits" });
    const key = "rl-" + safeKey(ip);
    const now = Date.now();
    let rec = await store.get(key, { type: "json" }).catch(() => null);
    if (!rec || now - rec.s > windowMs) rec = { c: 0, s: now };
    if (rec.c >= max) return false;
    rec.c++;
    await store.set(key, JSON.stringify(rec));
    return true;
  } catch (e) { return true; } // fail open on blob error
}

// ---- preview gating ----------------------------------------------
// Free users get a preview URL + a hard cap (seconds) enforced client-side.
// The full, downloadable file is only returned once `paid` is true.
const PREVIEW_SECONDS = Number(env("PREVIEW_SECONDS", "45"));

function publicSong(rec, { includeFull = false } = {}) {
  if (!rec) return null;
  const out = {
    id: rec.id,
    recipient: rec.recipient,
    occasion: rec.occasion,
    title: rec.title,
    style: rec.style,
    status: rec.audioStatus || "pending",
    imageUrl: rec.imageUrl || null,
    duration: rec.duration || null,
    paid: !!rec.paid,
    previewSeconds: PREVIEW_SECONDS,
    createdAt: rec.createdAt,
  };
  // Preview audio (capped client-side). Suno stream URL is used while the
  // track is still rendering; the final mp3 once available.
  const previewUrl = rec.streamUrl || rec.audioUrl || null;
  if (previewUrl) out.previewUrl = previewUrl;
  if (includeFull && rec.paid) {
    out.fullUrl = rec.audioUrl || rec.streamUrl || null;
    out.lyrics = rec.lyrics || null;
  }
  return out;
}

// =====================================================================
// ACTION: lyrics — write the song words with Claude
// =====================================================================
async function actionLyrics(body) {
  const key = anthropicKey();
  if (!key) return err("Lyrics service not configured (set ANTHROPIC_API_KEY).", 500);

  const recipient = String(body.recipient || "").slice(0, 80).trim();
  const sender = String(body.sender || "").slice(0, 80).trim();
  const occasion = String(body.occasion || "").slice(0, 80).trim();
  const relationship = String(body.relationship || "").slice(0, 80).trim();
  const genre = String(body.genre || "Pop").slice(0, 60).trim();
  const mood = String(body.mood || "").slice(0, 60).trim();
  const memories = String(body.memories || "").slice(0, 1500).trim();

  if (!recipient) return err("Please tell us who the song is for.");

  const system =
    "You are an award-winning songwriter who writes deeply personal, " +
    "emotionally resonant gift songs. You write vivid, specific, singable " +
    "lyrics — never generic. You weave in the real details provided. " +
    "Avoid cliché rhymes. Keep it heartfelt and authentic.";

  const user =
    `Write an original ${genre} song as a gift.\n\n` +
    `For (recipient): ${recipient}\n` +
    (sender ? `From (sender): ${sender}\n` : "") +
    (relationship ? `Relationship: ${relationship}\n` : "") +
    (occasion ? `Occasion: ${occasion}\n` : "") +
    (mood ? `Desired mood: ${mood}\n` : "") +
    (memories ? `Memories / details to include:\n${memories}\n` : "") +
    `\nWrite a complete song: verses, a memorable chorus, and a bridge. ` +
    `Use [Verse], [Chorus], [Bridge] section tags. ` +
    `Also give a short evocative title and a comma-separated list of ` +
    `musical style tags (genre, instruments, vocal type, tempo, mood) ` +
    `suitable for a music-generation model.`;

  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      lyrics: { type: "string" },
      style: { type: "string" },
    },
    required: ["title", "lyrics", "style"],
    additionalProperties: false,
  };

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env("ANTHROPIC_MODEL", "claude-opus-4-8"),
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema } },
      }),
    });
  } catch (e) {
    return err("Network error contacting lyrics service: " + e.message, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return err("Lyrics generation failed (" + resp.status + ")", 502, { detail: detail.slice(0, 200) });
  }

  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return err("Could not parse lyrics output. Please try again.", 502);
  }

  const id = newId();
  const rec = {
    id,
    createdAt: new Date().toISOString(),
    recipient, sender, occasion, relationship, genre, mood, memories,
    title: parsed.title,
    lyrics: parsed.lyrics,
    style: parsed.style,
    audioStatus: "not_started",
    paid: false,
  };
  await saveSong(rec);
  await track("lyrics_created");

  return ok({ id, title: rec.title, lyrics: rec.lyrics, style: rec.style });
}

// =====================================================================
// ACTION: generate — start audio rendering on Suno
// =====================================================================
async function actionGenerate(body, req, origin) {
  const { key, base, model } = sunoConfig();
  const id = body.songId;
  const rec = await loadSong(id);
  if (!rec) return err("Song not found.", 404);

  // Already generating / done? Return current state (idempotent).
  if (rec.taskId && rec.audioStatus !== "not_started" && rec.audioStatus !== "failed") {
    return ok({ id, taskId: rec.taskId, status: rec.audioStatus });
  }

  // Abuse control on the (cost-bearing) free preview generation.
  const ip = getIP(req);
  const allowed = await checkRateLimit(ip, Number(env("FREE_SONGS_PER_HOUR", "6")));
  if (!allowed) return err("You've created several songs recently. Please try again in a little while.", 429);

  if (!key) {
    // Graceful degradation so the funnel is testable before the music
    // provider is wired up. The preview just won't have audio yet.
    rec.audioStatus = "no_provider";
    await saveSong(rec);
    return ok({ id, status: "no_provider", message: "Music provider not configured (set SUNO_API_KEY)." });
  }

  const payload = {
    prompt: rec.lyrics,
    style: rec.style,
    title: rec.title,
    customMode: true,
    instrumental: false,
    model,
    callBackUrl: origin + "/api/song?action=callback&songId=" + encodeURIComponent(id),
  };

  let resp;
  try {
    resp = await fetch(base + "/api/v1/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return err("Network error contacting music service: " + e.message, 502);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data.code && data.code !== 200)) {
    return err("Music generation failed.", 502, { detail: JSON.stringify(data).slice(0, 200) });
  }

  const taskId = data?.data?.taskId || data?.data?.task_id || data?.taskId;
  if (!taskId) return err("No task id returned by music service.", 502);

  rec.taskId = taskId;
  rec.audioStatus = "generating";
  await saveSong(rec);
  await track("generation_started");

  return ok({ id, taskId, status: "generating" });
}

// =====================================================================
// ACTION: status — poll Suno and return a gated preview
// =====================================================================
function mapSunoStatus(s) {
  const t = String(s || "").toUpperCase();
  if (["SUCCESS", "COMPLETE", "COMPLETED"].includes(t)) return "complete";
  if (["FIRST_SUCCESS", "TEXT_SUCCESS", "PENDING", "PROCESSING", "GENERATING", "QUEUED"].includes(t)) return "generating";
  if (t.includes("FAIL") || t.includes("ERROR")) return "failed";
  return "generating";
}

async function actionStatus(body) {
  const id = body.songId;
  const rec = await loadSong(id);
  if (!rec) return err("Song not found.", 404);

  if (rec.audioStatus === "no_provider") {
    return ok(publicSong(rec));
  }

  // If a callback already populated audio, just return it.
  if (rec.audioUrl || rec.streamUrl) {
    if (rec.audioStatus !== "complete" && rec.audioUrl) { rec.audioStatus = "complete"; await saveSong(rec); }
    return ok(publicSong(rec));
  }

  const { key, base } = sunoConfig();
  if (!key || !rec.taskId) return ok(publicSong(rec));

  let resp;
  try {
    resp = await fetch(base + "/api/v1/generate/record-info?taskId=" + encodeURIComponent(rec.taskId), {
      headers: { Authorization: "Bearer " + key },
    });
  } catch (e) {
    return ok(publicSong(rec)); // transient — let the client keep polling
  }

  const data = await resp.json().catch(() => ({}));
  const d = data?.data || {};
  const status = mapSunoStatus(d.status);
  const items = d?.response?.sunoData || d?.response?.data || d?.sunoData || [];
  const first = Array.isArray(items) ? items[0] : null;

  if (first) {
    rec.streamUrl = first.streamAudioUrl || first.stream_audio_url || rec.streamUrl || null;
    rec.audioUrl = first.audioUrl || first.audio_url || rec.audioUrl || null;
    rec.imageUrl = first.imageUrl || first.image_url || rec.imageUrl || null;
    rec.duration = first.duration || rec.duration || null;
  }
  rec.audioStatus = (rec.audioUrl || rec.streamUrl) ? (status === "failed" ? "complete" : status) : status;
  if (rec.audioStatus === "complete" && !rec._completeTracked) {
    rec._completeTracked = true;
    await track("preview_ready");
  }
  await saveSong(rec);
  return ok(publicSong(rec));
}

// =====================================================================
// ACTION: callback — Suno notifies us when a task is done
// =====================================================================
async function actionCallback(body, url) {
  const id = url.searchParams.get("songId") || body.songId;
  const rec = await loadSong(id);
  if (!rec) return ok({ received: true }); // ack regardless

  const d = body?.data || body;
  const items = d?.response?.sunoData || d?.data || d?.sunoData || (Array.isArray(d) ? d : []);
  const first = Array.isArray(items) ? items[0] : (items?.sunoData?.[0] || null);
  if (first) {
    rec.streamUrl = first.streamAudioUrl || first.stream_audio_url || rec.streamUrl || null;
    rec.audioUrl = first.audioUrl || first.audio_url || rec.audioUrl || null;
    rec.imageUrl = first.imageUrl || first.image_url || rec.imageUrl || null;
    rec.duration = first.duration || rec.duration || null;
    rec.audioStatus = rec.audioUrl ? "complete" : "generating";
    await saveSong(rec);
  }
  return ok({ received: true });
}

// =====================================================================
// ACTION: gift — public read for the shareable gift page
// =====================================================================
async function actionGift(body, url) {
  const id = url.searchParams.get("id") || body.id || body.songId;
  const rec = await loadSong(id);
  if (!rec) return err("Gift not found.", 404);
  await track("gift_viewed");
  // Full audio is only exposed on the gift page once the song is paid for.
  return ok(publicSong(rec, { includeFull: true }));
}

// =====================================================================
// ACTION: lead — capture an email (abandoned-cart / marketing)
// =====================================================================
async function actionLead(body) {
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Invalid email.");
  try {
    const store = getStore({ name: "leads" });
    const rec = {
      email,
      songId: body.songId || null,
      recipient: body.recipient || null,
      at: new Date().toISOString(),
      converted: false,
    };
    await store.set("lead-" + safeKey(email), JSON.stringify(rec));
  } catch (e) { /* best-effort */ }
  // Attach email to the song record for delivery + recovery.
  if (body.songId) {
    const rec = await loadSong(body.songId);
    if (rec) { rec.email = email; await saveSong(rec); }
  }
  await track("lead_captured");
  return ok({ ok: true });
}

// =====================================================================
// Router
// =====================================================================
export default async (req, context) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || null;
  const origin = req.headers.get("origin") || env("SITE_URL", url.origin);

  if (req.method === "GET" && !action) {
    return ok({ status: "running", suno: !!sunoConfig().key, anthropic: !!anthropicKey() });
  }

  let body = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch (e) { body = {}; }
  }
  const act = action || body.action;

  try {
    switch (act) {
      case "lyrics":   return await actionLyrics(body);
      case "generate": return await actionGenerate(body, req, origin);
      case "status":   return await actionStatus(body);
      case "callback": return await actionCallback(body, url);
      case "gift":     return await actionGift(body, url);
      case "lead":     return await actionLead(body);
      case "track":    await track(String(body.event || "unknown").slice(0, 60)); return ok({ ok: true });
      default:         return err("Unknown action.", 400);
    }
  } catch (e) {
    return err("Server error: " + e.message, 500);
  }
};

export const config = { path: "/api/song" };
