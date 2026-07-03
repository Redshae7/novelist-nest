import { getStore } from "@netlify/blobs";
import { safeKey } from "../lib/core.mjs";

/* ------------------------------------------------------------------ *
 * song-audio.mjs — serves rendered ElevenLabs tracks out of Blobs.
 * IDs are opaque random tokens (see newId() in core.mjs), so knowing
 * one is equivalent to knowing a Suno CDN URL — no extra auth needed.
 * ------------------------------------------------------------------ */

export default async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });

  const store = getStore({ name: "audio" });
  const buf = await store.get("track-" + safeKey(id), { type: "arrayBuffer" }).catch(() => null);
  if (!buf) return new Response("Not found", { status: 404 });

  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};

export const config = { path: "/api/song-audio" };
