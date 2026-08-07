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

interface MetaQrTokenRow {
  token: string;
  revoked_at: Date | null;
}

function slug(): string {
  return randomBytes(9).toString("base64url"); // 12 chars — matches the routes
}

function isDupKey(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err.code === "23505" || /duplicate key|unique constraint/i.test(err.message ?? "");
}

/** Reuse the entity's live navigate token, else mint one. Returns the token
 *  string (`p/ab12…` descriptive or an opaque slug), ready for qrScanUrl(). */
export async function ensureNavToken(
  orgId: string,
  entityKind: string,
  entityId: string,
  style: "descriptive" | "opaque",
): Promise<string> {
  const meta = platform().db.meta as unknown as {
    selectFrom: (t: string) => {
      select: (cols: string[]) => {
        where: (c: string, o: string, v: unknown) => {
          where: (c: string, o: string, v: unknown) => {
            where: (c: string, o: string, v: unknown) => {
              where: (c: string, o: string, v: unknown) => {
                executeTakeFirst: () => Promise<MetaQrTokenRow | undefined>;
              };
            };
          };
        };
      };
    };
    insertInto: (t: string) => {
      values: (v: Record<string, unknown>) => {
        returning: (cols: string[]) => { executeTakeFirstOrThrow: () => Promise<{ token: string }> };
      };
    };
  };

  const existing = await meta
    .selectFrom("core_labels_qr_tokens")
    .select(["token", "revoked_at"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", entityKind)
    .where("entity_id", "=", entityId)
    .where("mode", "=", "navigate")
    .executeTakeFirst();
  if (existing && !existing.revoked_at) return existing.token;

  const mkToken = () =>
    style === "descriptive" ? `${qrShortcode(entityKind)}/${slug()}` : slug();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = await meta
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
        .returning(["token"])
        .executeTakeFirstOrThrow();
      return row.token;
    } catch (e) {
      if (isDupKey(e) && attempt < 4) continue;
      throw e;
    }
  }
  throw new Error("could not mint a unique QR token");
}
