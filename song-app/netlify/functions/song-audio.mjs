import { getStore } from "@netlify/blobs";
import { safeKey } from "../lib/core.mjs";

/* ------------------------------------------------------------------ *
 * song-audio.mjs — serves rendered tracks out of Netlify Blobs.
 * IDs are opaque random tokens (see newId() in core.mjs), and tracks
 * only ever exist for paid songs, so possession of an ID is the same
 * grant as possessing the gift URL itself.
 * Range requests are supported — iOS Safari needs them for seeking.
 * ------------------------------------------------------------------ */

export default async (req) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });

  const store = getStore({ name: "audio" });
  const ab = await store.get("track-" + safeKey(id), { type: "arrayBuffer" }).catch(() => null);
  if (!ab) return new Response("Not found", { status: 404 });

  const total = ab.byteLength;
  const common = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get("range") || "").trim());
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, total - parseInt(m[2], 10));
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (!(start >= 0) || start >= total || start > end) {
      return new Response(null, { status: 416, headers: { ...common, "Content-Range": "bytes */" + total } });
    }
    return new Response(ab.slice(start, end + 1), {
      status: 206,
      headers: {
        ...common,
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(ab, { status: 200, headers: { ...common, "Content-Length": String(total) } });
};

export const config = { path: "/api/song-audio" };
