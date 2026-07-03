import {
  env, anthropicKey, elevenLabsConfig, getIP, safeKey, newId, ok, err,
  loadSong, saveSong, track, checkRateLimit,
  publicSong, REVISION_LIMIT,
} from "../lib/core.mjs";
import { getStore } from "@netlify/blobs";

/* ------------------------------------------------------------------ *
 * song.mjs — the funnel API.
 *
 * FREE (rate-limited, cheap):
 *   lyrics   -> write title + lyrics + style from the wizard (Anthropic)
 *   revise   -> rewrite lyrics with the user's feedback (max N free)
 *   edit     -> save user-edited lyrics verbatim
 *   status   -> public state of a song (audio only appears once paid)
 *   gift     -> public gift/delivery record
 *   lead     -> capture email for delivery + recovery
 *   track    -> funnel analytics counter
 *
 * Generation itself is synchronous (ElevenLabs Music API returns audio
 * directly) and is started by stripe-webhook / verify-payment, which
 * await it before responding — so by the time a client polls `status`
 * or `gift`, the record already holds the final state.
 * ------------------------------------------------------------------ */

// ---------- lyric writing (the free hook — pennies per call) --------
const LYRIC_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    lyrics: { type: "string" },
    style: { type: "string" },
  },
  required: ["title", "lyrics", "style"],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  "You are a hit songwriter who writes deeply personal gift songs. " +
  "Your lyrics are specific, vivid and singable — never generic greeting-card " +
  "filler. You weave the real names, memories and details you're given into " +
  "lines that feel like they could only be about this one person. The chorus " +
  "must contain a memorable hook that uses the recipient's name. Avoid " +
  "clichés (no 'shining star', 'journey of life', 'through thick and thin'). " +
  "Keep total length suited to a ~2-3 minute song.";

function buildBrief(b) {
  return (
    `Recipient: ${b.recipient}\n` +
    (b.sender ? `From: ${b.sender}\n` : "") +
    (b.relationship ? `Relationship: ${b.relationship}\n` : "") +
    (b.occasion ? `Occasion: ${b.occasion}\n` : "") +
    `Genre: ${b.genre || "Pop"}\nMood: ${b.mood || "Heartfelt"}\n` +
    (b.memories ? `Real details and memories to weave in:\n${b.memories}\n` : "")
  );
}

async function callClaude(userPrompt) {
  const key = anthropicKey();
  if (!key) return { error: "Lyrics service not configured (set ANTHROPIC_API_KEY)." };
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env("ANTHROPIC_MODEL", "claude-opus-4-8"),
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        output_config: { format: { type: "json_schema", schema: LYRIC_SCHEMA } },
      }),
    });
  } catch (e) { return { error: "Network error contacting lyrics service." }; }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return { error: "Lyric writing failed (" + resp.status + ").", detail: detail.slice(0, 200) };
  }
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return { parsed: JSON.parse(text) }; } catch (e) { return { error: "Could not parse lyrics. Please try again." }; }
}

function cleanInputs(body) {
  return {
    recipient: String(body.recipient || "").slice(0, 80).trim(),
    sender: String(body.sender || "").slice(0, 80).trim(),
    relationship: String(body.relationship || "").slice(0, 80).trim(),
    occasion: String(body.occasion || "").slice(0, 80).trim(),
    genre: String(body.genre || "Pop").slice(0, 60).trim(),
    mood: String(body.mood || "Heartfelt").slice(0, 60).trim(),
    memories: String(body.memories || "").slice(0, 1500).trim(),
  };
}

async function actionLyrics(body, req) {
  const b = cleanInputs(body);
  if (!b.recipient) return err("Please tell us who the song is for.");

  const ip = getIP(req);
  if (!(await checkRateLimit(ip, "lyrics", Number(env("LYRICS_PER_HOUR", "10")))))
    return err("You've written quite a few songs this hour — please come back a little later.", 429);

  const prompt =
    `Write an original ${b.genre} song as a gift.\n\n` + buildBrief(b) +
    `\nUse [Verse 1], [Chorus], [Verse 2], [Bridge], [Chorus] section tags ` +
    `(these guide the music production). Also produce:\n` +
    `- title: short and evocative\n` +
    `- style: a comma-separated production brief for a music model ` +
    `(genre, tempo, key instruments, vocal type, mood) matching the genre "${b.genre}" and mood "${b.mood}".`;

  const r = await callClaude(prompt);
  if (r.error) return err(r.error, 502, r.detail ? { detail: r.detail } : {});

  const rec = {
    id: newId(),
    createdAt: new Date().toISOString(),
    ...b,
    title: r.parsed.title,
    lyrics: r.parsed.lyrics,
    style: r.parsed.style,
    revisionsUsed: 0,
    paid: false,
    audioStatus: "not_started",
  };
  await saveSong(rec);
  await track("lyrics_created");
  return ok(publicSong(rec));
}

async function actionRevise(body, req) {
  const rec = await loadSong(body.songId);
  if (!rec) return err("Song not found.", 404);
  if ((rec.revisionsUsed || 0) >= REVISION_LIMIT && !rec.paid)
    return err("You've used all free rewrites for this song. You can still edit the lyrics directly.", 429);

  const ip = getIP(req);
  if (!(await checkRateLimit(ip, "lyrics", Number(env("LYRICS_PER_HOUR", "10")))))
    return err("Too many requests this hour — please try again soon.", 429);

  const feedback = String(body.feedback || "").slice(0, 500).trim();
  const prompt =
    `Here is a gift-song brief:\n\n` + buildBrief(rec) +
    `\nHere is the current draft:\n\nTitle: ${rec.title}\n\n${rec.lyrics}\n\n` +
    `Rewrite the song. ` +
    (feedback ? `The customer asked for these changes: "${feedback}". Honor them faithfully.\n` :
      `Take a fresh angle — different imagery and a different hook.\n`) +
    `Keep the [Verse]/[Chorus]/[Bridge] tags. Return title, lyrics and an updated style brief.`;

  const r = await callClaude(prompt);
  if (r.error) return err(r.error, 502);

  rec.title = r.parsed.title;
  rec.lyrics = r.parsed.lyrics;
  rec.style = r.parsed.style;
  rec.revisionsUsed = (rec.revisionsUsed || 0) + 1;
  await saveSong(rec);
  await track("lyrics_revised");
  return ok(publicSong(rec));
}

async function actionEdit(body) {
  const rec = await loadSong(body.songId);
  if (!rec) return err("Song not found.", 404);
  if (rec.paid && rec.audioStatus && rec.audioStatus !== "not_started" && rec.audioStatus !== "no_provider")
    return err("This song is already in production and can't be edited.", 409);
  const lyrics = String(body.lyrics || "").slice(0, 5000).trim();
  const title = String(body.title || rec.title || "").slice(0, 120).trim();
  if (!lyrics) return err("Lyrics can't be empty.");
  rec.lyrics = lyrics;
  if (title) rec.title = title;
  rec.userEdited = true;
  await saveSong(rec);
  await track("lyrics_edited");
  return ok(publicSong(rec));
}

// ---------- status / gift / callback --------------------------------
async function actionStatus(body) {
  const rec = await loadSong(body.songId);
  if (!rec) return err("Song not found.", 404);
  return ok(publicSong(rec));
}

async function actionGift(body, url) {
  const id = url.searchParams.get("id") || body.id || body.songId;
  const rec = await loadSong(id);
  if (!rec) return err("Gift not found.", 404);
  await track("gift_viewed");
  return ok(publicSong(rec));
}

// ---------- leads / analytics ---------------------------------------
async function actionLead(body) {
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Invalid email.");
  try {
    const store = getStore({ name: "leads" });
    await store.set("lead-" + safeKey(email), JSON.stringify({
      email, songId: body.songId || null, recipient: body.recipient || null,
      at: new Date().toISOString(), converted: false,
    }));
  } catch (e) {}
  if (body.songId) {
    const rec = await loadSong(body.songId);
    if (rec) { rec.email = email; await saveSong(rec); }
  }
  await track("lead_captured");
  return ok({ ok: true });
}

// ---------- router ---------------------------------------------------
export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || null;

  if (req.method === "GET" && !action) {
    return ok({ status: "running", elevenlabs: !!elevenLabsConfig().key, anthropic: !!anthropicKey() });
  }
  if (req.method === "GET" && action === "gift") {
    return actionGift({}, url);
  }

  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch (e) {} }
  const act = action || body.action;

  try {
    switch (act) {
      case "lyrics":   return await actionLyrics(body, req);
      case "revise":   return await actionRevise(body, req);
      case "edit":     return await actionEdit(body);
      case "status":   return await actionStatus(body);
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
