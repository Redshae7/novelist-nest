/* ------------------------------------------------------------------ *
 * render-song — stateless song renderer (Supabase Edge Function).
 *
 * The Netlify app can't render in-request (free-tier functions die at
 * 10s), so it POSTs the job here. This function answers 202 at once,
 * renders via the ElevenLabs Music API in the background, and POSTs
 * each finished track back to the app's /api/song?action=attach.
 *
 * It holds no secrets of its own: the ElevenLabs key and the callback
 * secret arrive with each job, so all configuration lives in Netlify.
 * An attacker calling this endpoint gains nothing — rendering needs
 * their own ElevenLabs key, and attaching needs the callback secret.
 * ------------------------------------------------------------------ */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

type Job = {
  songId: string;
  prompt: string;
  musicLengthMs?: number;
  versions?: number;
  elevenLabsKey: string;
  callbackUrl: string;
  callbackSecret: string;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let job: Job;
  try { job = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: JSON_HEADERS });
  }
  if (!job?.songId || !job?.prompt || !job?.elevenLabsKey || !job?.callbackUrl || !job?.callbackSecret) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: JSON_HEADERS });
  }

  EdgeRuntime.waitUntil(render(job));
  return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: JSON_HEADERS });
});

async function render(job: Job) {
  const versions = Math.min(Math.max(Number(job.versions) || 1, 1), 2);
  const lengthMs = Math.min(Math.max(Number(job.musicLengthMs) || 180000, 10000), 300000);

  const renders = await Promise.allSettled(
    Array.from({ length: versions }, () => renderOne(job, lengthMs)),
  );

  // Attach sequentially — the app stores tracks with read-modify-write,
  // so there must be only one writer per song at a time.
  let delivered = 0;
  let lastError = "";
  for (const r of renders) {
    if (r.status === "rejected") {
      lastError = String((r.reason as Error)?.message || r.reason);
      continue;
    }
    try {
      await callback(job, { audioBase64: r.value, durationSec: Math.round(lengthMs / 1000) });
      delivered++;
    } catch (e) {
      lastError = String((e as Error).message);
    }
  }
  await callback(job, {
    status: delivered ? "complete" : "failed",
    error: lastError || undefined,
  }).catch(() => {});
}

async function renderOne(job: Job, lengthMs: number): Promise<string> {
  const resp = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": job.elevenLabsKey },
    body: JSON.stringify({ prompt: job.prompt, music_length_ms: lengthMs }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs ${resp.status}: ${detail.slice(0, 300)}`);
  }
  return toBase64(new Uint8Array(await resp.arrayBuffer()));
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function callback(job: Job, payload: Record<string, unknown>) {
  const resp = await fetch(job.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": job.callbackSecret },
    body: JSON.stringify({ action: "attach", songId: job.songId, ...payload }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`callback ${resp.status}: ${detail.slice(0, 200)}`);
  }
}
