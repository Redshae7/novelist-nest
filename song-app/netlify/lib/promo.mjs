import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { env } from "./core.mjs";

/* ------------------------------------------------------------------ *
 * promo.mjs — comp codes for influencers, press and partners.
 *
 * A comp code is a one-time (by default) key that unlocks a song
 * without payment. It is the ONLY route to a paid song that doesn't
 * involve Stripe, so it is deliberately narrow:
 *   - codes exist only if an admin created one (no self-service),
 *   - redemption is per-song and recorded, so a code can't be reused,
 *   - every redeem attempt is rate-limited per IP (see redeem.mjs).
 *
 * Percentage discounts are NOT handled here — Stripe's own promotion
 * codes already do that, and checkout passes allow_promotion_codes.
 * This file is for 100%-free comps only.
 * ------------------------------------------------------------------ */

// Unambiguous alphabet: no O/0, I/1, so codes survive being read off a
// press packet, a phone screen or a handwritten note.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BODY_LEN = 8; // 32^8 ≈ 1.1e12 — with rate limiting, unguessable

export const MAX_CODES_PER_BATCH = 100;

export function promoStore() {
  return getStore({ name: "promo-codes", consistency: "strong" });
}

export function codePrefix() {
  return String(env("PROMO_PREFIX", "HEART")).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "HEART";
}

export function generateCode(prefix = codePrefix()) {
  let s = "";
  for (let i = 0; i < BODY_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4)}`;
}

// Lookup form: case-, space- and dash-insensitive, so "heart-ab12-cd34",
// "HEART AB12 CD34" and "heartab12cd34" all find the same record.
export function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40);
}
function keyFor(codeOrNorm) { return "code-" + normalizeCode(codeOrNorm); }

export async function getCode(codeInput) {
  const norm = normalizeCode(codeInput);
  if (!norm) return null;
  return promoStore().get(keyFor(norm), { type: "json" }).catch(() => null);
}

export function usesLeft(rec) {
  return Math.max(0, (rec.maxUses || 1) - (rec.redemptions || []).length);
}

export function codeStatus(rec) {
  if (rec.revoked) return "revoked";
  if (rec.expiresAt && Date.now() > Date.parse(rec.expiresAt)) return "expired";
  if (usesLeft(rec) <= 0) return "used";
  return "active";
}

/* ---- creation (admin only) --------------------------------------- */

export async function createCodes(count, opts = {}) {
  const store = promoStore();
  const n = Math.max(1, Math.min(MAX_CODES_PER_BATCH, Number(count) || 1));
  const maxUses = Math.max(1, Math.min(10000, Number(opts.maxUses) || 1));
  const label = String(opts.label || "").slice(0, 120).trim();
  const note = String(opts.note || "").slice(0, 400).trim();
  const deluxe = !!opts.deluxe;

  let expiresAt = null;
  const days = Number(opts.expiresInDays);
  if (days > 0) expiresAt = new Date(Date.now() + days * 86400000).toISOString();

  const out = [];
  for (let i = 0; i < n; i++) {
    // Collisions are astronomically unlikely, but a blind write would
    // silently clobber a live code, so check before claiming one.
    let code = null;
    for (let tries = 0; tries < 6 && !code; tries++) {
      const candidate = generateCode();
      const taken = await store.get(keyFor(candidate), { type: "json" }).catch(() => null);
      if (!taken) code = candidate;
    }
    if (!code) break;

    const rec = {
      code,
      label,
      note,
      maxUses,
      deluxe,
      createdAt: new Date().toISOString(),
      expiresAt,
      revoked: false,
      redemptions: [],
    };
    await store.set(keyFor(code), JSON.stringify(rec));
    out.push(rec);
  }
  return out;
}

export async function listCodes(limit = 300) {
  const store = promoStore();
  const { blobs } = await store.list({ prefix: "code-" });
  const keys = (blobs || []).map((b) => b.key).slice(0, Math.max(1, Math.min(1000, limit)));
  const recs = await Promise.all(keys.map((k) => store.get(k, { type: "json" }).catch(() => null)));
  return recs
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export async function setRevoked(codeInput, revoked) {
  const store = promoStore();
  const rec = await getCode(codeInput);
  if (!rec) return null;
  rec.revoked = !!revoked;
  await store.set(keyFor(rec.code), JSON.stringify(rec));
  return rec;
}

/* ---- redemption --------------------------------------------------- */

/**
 * Consume one use of a code on behalf of one song.
 * Returns { rec } on success, { rec, already: true } if this same song
 * already redeemed it (idempotent), or { error } with a message meant
 * to be shown to the person holding the code.
 */
export async function redeemCode(codeInput, { songId, ip, email, recipient } = {}) {
  const norm = normalizeCode(codeInput);
  if (!norm) return { error: "Please enter your code." };
  if (!songId) return { error: "No song to apply this code to." };

  const store = promoStore();
  const key = keyFor(norm);
  const rec = await store.get(key, { type: "json" }).catch(() => null);
  if (!rec) return { error: "We don't recognize that code. Please check it for typos." };
  if (rec.revoked) return { error: "That code is no longer active." };
  if (rec.expiresAt && Date.now() > Date.parse(rec.expiresAt)) return { error: "That code has expired." };

  // Re-applying to the same song is a no-op success, not a second use —
  // a double-click or a page reload must not burn the code.
  if ((rec.redemptions || []).some((r) => r.songId === songId)) return { rec, already: true };

  if (usesLeft(rec) <= 0) return { error: "That code has already been used." };

  rec.redemptions = rec.redemptions || [];
  rec.redemptions.push({
    songId,
    at: new Date().toISOString(),
    ip: ip || null,
    email: email || null,
    recipient: recipient || null,
  });
  await store.set(key, JSON.stringify(rec));

  // Blobs give us no transaction, so confirm after the write: if two
  // songs raced for the last use, the loser's entry lands past the
  // limit and we refuse rather than comping a song for free twice.
  const after = await store.get(key, { type: "json" }).catch(() => null);
  const idx = (after?.redemptions || []).findIndex((r) => r.songId === songId);
  if (!after || idx === -1 || idx >= (after.maxUses || rec.maxUses || 1)) {
    return { error: "That code was just used up. Please get in touch for another one." };
  }
  return { rec: after };
}

/* ---- admin auth ---------------------------------------------------- */

export function adminSecret() {
  const s = env("ADMIN_SECRET", "");
  return s && !s.startsWith("PASTE") && s.length >= 12 ? s : null;
}

export function checkAdmin(req, body = {}) {
  const secret = adminSecret();
  if (!secret) return { ok: false, status: 503, message: "Admin area not configured. Set ADMIN_SECRET (12+ characters) in your Netlify environment variables." };
  const given = req.headers.get("x-admin-secret") || body.adminSecret || "";
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return { ok: false, status: 401, message: "Wrong admin password." };
  return { ok: true };
}

/* ---- public projection -------------------------------------------- */

export function publicCode(rec) {
  return {
    code: rec.code,
    label: rec.label || "",
    note: rec.note || "",
    maxUses: rec.maxUses || 1,
    used: (rec.redemptions || []).length,
    usesLeft: usesLeft(rec),
    deluxe: !!rec.deluxe,
    status: codeStatus(rec),
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt || null,
    redemptions: (rec.redemptions || []).map((r) => ({
      songId: r.songId, at: r.at, email: r.email || null, recipient: r.recipient || null,
    })),
  };
}
