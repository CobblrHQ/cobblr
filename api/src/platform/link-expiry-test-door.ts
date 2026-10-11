// A test door: end an emailed sign-in link early, so a walk can open an
// expired one at once instead of waiting out its hour or its day. The pages a
// verify, reset or address-change link opens each say "this link has expired"
// in their own words, and nothing could reach that state on staging without
// a clock to wind (#4286's coverage of the signup-account-backup area).
//
// Mounted only where test doors are open (test-doors.ts: never production or
// canary). It takes the link's own token, so it can do nothing the caller
// could not already do with the link in hand, and it only ever shortens a
// link: one already used or already expired is left as it is, and nothing
// here makes a link live again.

import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const hash = (plain: string) => createHash("sha256").update(plain).digest("hex");

const TABLES = ["auth_email_verify_tokens", "auth_password_reset_tokens", "auth_email_change_tokens"] as const;

/** POST /api/v1/test/expire-link { token }: which kind of link it was, or 404. */
export async function expireLinkDoor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.length < 8 || token.length > 200) {
      res.status(400).json({ error: { code: "bad_request", message: "body needs { token }, the link's own token" } });
      return;
    }
    const { meta } = await import("../db/meta.js");
    const past = new Date(Date.now() - 60_000);
    for (const table of TABLES) {
      const r = await meta
        .updateTable(table)
        .set({ expires_at: past })
        .where("token_hash", "=", hash(token))
        .where("consumed_at", "is", null)
        .where("expires_at", ">", new Date())
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) > 0) {
        res.json({ expired: table });
        return;
      }
    }
    res.status(404).json({ error: { code: "not_found", message: "No live link has that token: unknown, already used, or already expired." } });
  } catch (err) {
    next(err);
  }
}
