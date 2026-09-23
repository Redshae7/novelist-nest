import { env, ok, err, getIP, loadSong, saveSong, track, checkRateLimit, enqueueGeneration } from "../lib/core.mjs";
import { redeemCode } from "../lib/promo.mjs";

/* ------------------------------------------------------------------ *
 * redeem.mjs — apply an influencer / press comp code to one song.
 *
 * This is the only unpaid path that flips rec.paid, so it is guarded:
 *   - the code must already exist (admin-created; nothing self-service),
 *   - attempts are rate-limited per IP so codes can't be brute-forced,
 *   - the code is consumed only after the song is known-good and unpaid,
 *     so a bad request never burns an influencer's one-time code.
 * ------------------------------------------------------------------ */

export default async (req) => {
  if (req.method !== "POST") return err("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch (e) { return err("Invalid request"); }

  const ip = getIP(req);
  if (!(await checkRateLimit(ip, "redeem", Number(env("REDEEM_ATTEMPTS_PER_HOUR", "8")))))
    return err("Too many code attempts. Please wait an hour and try again.", 429);

  const rec = await loadSong(body.songId);
  if (!rec) return err("Song not found — please write your song first.", 404);

  // Already unlocked (paid or previously comped): nothing to spend.
  if (rec.paid) return ok({ ok: true, alreadyUnlocked: true, url: "/gift.html?id=" + rec.id });

  const email = String(body.email || "").trim().toLowerCase().slice(0, 200) || rec.email || null;
  const result = await redeemCode(body.code, {
    songId: rec.id,
    ip,
    email,
    recipient: rec.recipient || null,
  });
  if (result.error) {
    await track("promo_rejected");
    return err(result.error, 400);
  }

  const code = result.rec;
  rec.paid = true;
  rec.comped = true;
  rec.promoCode = code.code;
  rec.promoLabel = code.label || "";
  rec.paidAt = rec.paidAt || new Date().toISOString();
  rec.amountTotal = 0;
  if (code.deluxe) rec.deluxe = true;
  if (email) rec.email = email;
  await saveSong(rec);

  if (!result.already) {
    await track("promo_redeemed");
    if (code.label) await track("promo_redeemed_" + code.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40));
  }

  const origin = env("SITE_URL", new URL(req.url).origin);
  await enqueueGeneration(rec, origin);

  return ok({ ok: true, url: "/gift.html?id=" + rec.id, label: code.label || null });
};

export const config = { path: "/api/redeem" };
