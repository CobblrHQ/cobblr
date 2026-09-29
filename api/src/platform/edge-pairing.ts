// Installing a bridge with a code instead of a token.
//
// The setup screen used to hand out a `docker run` line with a long-lived
// token pasted into it, which then sat in a shell history, a chat message to
// whoever was helping, and a screenshot. Now Cobblr shows a short code that
// works once, for fifteen minutes; the installer on the box trades it for the
// bridge's own token, which never leaves that box.
//
// Eight characters from an alphabet without the look-alikes (0/O, 1/I/L), so
// it can be read off a screen and typed on a Pi's keyboard: 31^8 is about
// 8.5e11, against a code that lives fifteen minutes behind a per-IP limit.
// Only the hash is stored, like every other credential here.

import { createHash, randomInt } from "node:crypto";
import { meta } from "../db/meta.js";
import { mintTokenString } from "../auth/api-tokens.js";
import { bridgeTokenName } from "@cobblr/platform-contract/edge-channel";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 15 * 60_000;

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** What a person typed, as the code it means: case, spaces and the dash are
 *  ignored. Null when it cannot be a code at all. */
export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (c.length !== LENGTH) return null;
  for (const ch of c) if (!ALPHABET.includes(ch)) return null;
  return c;
}

export async function createPairingCode(p: {
  orgId: string;
  userId: string;
  name: string;
  bridge: string | null;
}): Promise<{ code: string; expires_at: string }> {
  let code = "";
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const expires = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  // Spent and expired codes are worth nothing; clear them on the way.
  await meta
    .deleteFrom("edge_pairing_codes")
    .where((eb) => eb.or([eb("expires_at", "<", new Date()), eb("used_at", "is not", null)]))
    .execute();
  await meta
    .insertInto("edge_pairing_codes")
    .values({
      code_hash: hash(code),
      org_id: p.orgId,
      user_id: p.userId,
      bridge: p.bridge,
      name: p.name.trim().slice(0, 120) || "Home bridge",
      expires_at: expires,
    })
    .execute();
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: expires.toISOString() };
}

export type PairingResult =
  | { ok: true; slug: string; bridge: string | null; name: string; token: string }
  | { ok: false; reason: "unknown" | "no_longer_allowed" };

/** Trade a code for the bridge's token. Works once: the UPDATE that marks it
 *  used is the claim, so two installers racing with one code get one token. */
export async function redeemPairingCode(raw: unknown): Promise<PairingResult> {
  const code = normalizePairingCode(raw);
  if (!code) return { ok: false, reason: "unknown" };
  const row = await meta
    .updateTable("edge_pairing_codes")
    .set({ used_at: new Date() })
    .where("code_hash", "=", hash(code))
    .where("used_at", "is", null)
    .where("expires_at", ">", new Date())
    .returning(["org_id", "user_id", "bridge", "name"])
    .executeTakeFirst();
  if (!row) return { ok: false, reason: "unknown" };

  // Whoever made the code must still be able to add a bridge now: a code made
  // by an admin who has since been removed does not outlive them.
  const who = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["o.slug", "m.role", "u.active"])
    .where("m.org_id", "=", row.org_id)
    .where("m.user_id", "=", row.user_id)
    .executeTakeFirst();
  if (!who || !who.active || !roleSatisfies(who.role, ["owner", "admin"])) {
    return { ok: false, reason: "no_longer_allowed" };
  }

  const { plaintext, hash: tokenHash, tokenPrefix } = mintTokenString();
  await meta
    .insertInto("api_tokens")
    .values({
      user_id: row.user_id,
      name: bridgeTokenName(row.name),
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      expires_at: null,
      scopes: ["devices:edge"],
      source: "bridge pairing",
      meta: null,
      org_id: null,
      access: null,
    })
    .execute();
  return { ok: true, slug: who.slug, bridge: row.bridge, name: row.name, token: plaintext };
}
