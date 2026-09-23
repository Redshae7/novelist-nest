import { env, ok, err, getIP, checkRateLimit, track } from "../lib/core.mjs";
import { checkAdmin, createCodes, listCodes, setRevoked, publicCode, MAX_CODES_PER_BATCH } from "../lib/promo.mjs";

/* ------------------------------------------------------------------ *
 * promo-admin.mjs — create and manage comp codes. Owner only.
 *
 * Auth is a single shared secret (ADMIN_SECRET) sent as x-admin-secret.
 * Failed attempts are rate-limited per IP, and the endpoint refuses to
 * operate at all until a real secret is configured — there is no
 * default password and no unauthenticated mode.
 * ------------------------------------------------------------------ */

export default async (req) => {
  if (req.method !== "POST") return err("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch (e) { return err("Invalid request"); }

  const ip = getIP(req);
  if (!(await checkRateLimit(ip, "promo-admin", Number(env("ADMIN_ATTEMPTS_PER_HOUR", "60")))))
    return err("Too many admin requests. Please wait an hour.", 429);

  const auth = checkAdmin(req, body);
  if (!auth.ok) return err(auth.message, auth.status);

  try {
    switch (body.action) {
      case "create": {
        const codes = await createCodes(body.count, {
          label: body.label,
          note: body.note,
          maxUses: body.maxUses,
          deluxe: body.deluxe,
          expiresInDays: body.expiresInDays,
        });
        if (!codes.length) return err("Could not generate codes — please try again.", 500);
        await track("promo_codes_created");
        return ok({ ok: true, codes: codes.map(publicCode), max: MAX_CODES_PER_BATCH });
      }

      case "list": {
        const recs = await listCodes(Number(body.limit) || 300);
        const codes = recs.map(publicCode);
        const summary = codes.reduce((a, c) => {
          a.total++;
          a[c.status] = (a[c.status] || 0) + 1;
          a.redemptions += c.used;
          return a;
        }, { total: 0, redemptions: 0 });
        return ok({ ok: true, codes, summary });
      }

      case "revoke":
      case "unrevoke": {
        const rec = await setRevoked(body.code, body.action === "revoke");
        if (!rec) return err("Code not found.", 404);
        return ok({ ok: true, code: publicCode(rec) });
      }

      default:
        return err("Unknown action.", 400);
    }
  } catch (e) {
    return err("Server error: " + e.message, 500);
  }
};

export const config = { path: "/api/promo-admin" };
