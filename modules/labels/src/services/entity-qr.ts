// Server-side navigate-token resolution for an entity — the piece the wire /
// automation print path needs. The HTTP token routes (api/qr-tokens.ts) do the
// same reuse-or-mint dance with request context; this is the headless half:
// reuse the entity's unrevoked navigate token, else mint one in the style the
// workspace uses. Tokens live cross-tenant in cobblr_meta
// (core_labels_qr_tokens), same as the routes.

import { randomBytes } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { sql } from "kysely";
import { qrShortcode } from "../api/qr-db.js";
import { permanentNavToken, type NavTokenRow } from "./permanent-nav-token.js";

function slug(): string {
  return randomBytes(9).toString("base64url"); // 12 chars — matches the routes
}

function isDupKey(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err.code === "23505" || /duplicate key|unique constraint/i.test(err.message ?? "");
}

/** Reuse the entity's permanent navigate token, else mint one (permanent-nav-token.ts). Returns the token
 *  string (`p/ab12…` descriptive or an opaque slug), ready for qrScanUrl(). */
export async function ensureNavToken(
  orgId: string,
  entityKind: string,
  entityId: string,
  style: "descriptive" | "opaque",
): Promise<string> {
  // One record, one QR, whichever door asked: an instance's alias
  // (`bookshelf:item`) and the module kind name the same row (#3591).
  entityKind = await platform().entities.baseKindOf(orgId, entityKind);
  const meta = platform().db.meta as unknown as {
    insertInto: (t: string) => {
      values: (v: Record<string, unknown>) => {
        returningAll: () => { executeTakeFirstOrThrow: () => Promise<NavTokenRow> };
      };
    };
  };
  const mkToken = () =>
    style === "descriptive" ? `${qrShortcode(entityKind)}/${slug()}` : slug();
  const mint = async (): Promise<NavTokenRow> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // check-then-insert: the key is a random QR token minted here
        return await meta
          .insertInto("core_labels_qr_tokens")
          .values({
            token: mkToken(),
            org_id: orgId,
            entity_kind: entityKind,
            entity_id: entityId,
            mode: "navigate",
            action_id: null,
            auth: "session",
            config: sql`'{}'::jsonb` as never,
            expires_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (e) {
        if (isDupKey(e) && attempt < 4) continue;
        throw e;
      }
    }
    throw new Error("could not mint a unique QR token");
  };
  // A label printed now must open the record for as long as it is on the shelf.
  return (await permanentNavToken(orgId, entityKind, entityId, mint)).row.token;
}
