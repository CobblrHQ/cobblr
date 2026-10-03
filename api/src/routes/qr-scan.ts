// /api/v1/qr/:token — the unauthenticated scan-target route.
//
// Resolves token → (org_id, entity_kind, entity_id, mode, auth) in
// one query against cobblr_meta. Logs the scan to the tenant DB's
// labels_qr_scans table (best-effort). Returns a JSON payload
// the web shell uses to navigate or surface a confirmation card.
//
// See docs/modules/labels.md (QR half merged in from core-labels-qr,
// labels 0.6.0; the meta token table keeps its historical name).

import { Router } from "express";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as events from "../platform/events.js";
import { detailPathForEntity, resolveKind } from "../platform/entities.js";
import { labelJoinLink } from "../platform/join-invite.js";
import { labelIsPublic } from "../platform/public-page.js";

export const qrScanRouter = Router({ mergeParams: true });

interface ResolveResult {
  ok: boolean;
  status: "active" | "revoked" | "expired" | "not_found";
  token_id?: string;
  org_id?: string;
  org_slug?: string;
  entity_kind?: string;
  entity_id?: string;
  mode?: "navigate" | "action";
  action_id?: string | null;
  auth?: "public" | "session";
  /** When the resolver knows the entity's detail page, this is its
   *  workspace-relative path with placeholders substituted. Web uses
   *  it to redirect on navigate-mode scans. */
  detail_path?: string;
  /** The workspace's join link, when its admin let item labels offer it: a
   *  signed-out scan of the closet's cable can say "Join <club> to take
   *  one" instead of a sign-in page that person has no account for. */
  join?: { token: string; org_name: string };
  /** A stranger scanning this label sees the record's public view (a live
   *  public page opens its labels, #4502). */
  public_view?: boolean;
}

/** Resolve a QR token slug → its target (org, entity, mode, detail_path), or a
 *  non-ok status. Pure lookup, no HTTP / audit — shared by the public scan route
 *  AND the scan-drives-screen router (api/src/platform/scan-drive.ts). */
export async function resolveQrToken(token: string): Promise<ResolveResult> {
  const row = await meta
    .selectFrom("core_labels_qr_tokens")
    .selectAll()
    .where("token", "=", token)
    .executeTakeFirst();
  if (!row) return { ok: false, status: "not_found" };
  if (row.revoked_at) return { ok: false, status: "revoked" };
  if (row.expires_at && row.expires_at < new Date()) return { ok: false, status: "expired" };

  const orgRow = await meta
    .selectFrom("orgs")
    .select(["id", "slug"])
    .where("id", "=", row.org_id)
    .executeTakeFirst();
  if (!orgRow) return { ok: false, status: "not_found" };

  // A sticker names the RECORD. Labels were once minted under an instance's
  // alias for its rows ("bookshelf:item"), and those are already on shelves:
  // read as the alias, the scanner took the book for somewhere to file things
  // into instead of opening it (#3591). The alias and the module kind name
  // one row, so every token answers with the module kind, printed when it may.
  const { base: entityKind } = await resolveKind(row.org_id, row.entity_kind);

  // Instance-aware detail path: a label for a Vehicle (assets instance) or a 3D
  // Printer (machines instance) lands on THAT item's instance page, not the empty
  // base page. Shared with the scan registry + search via detailPathForEntity.
  const detailPath =
    (await detailPathForEntity(row.org_id, entityKind, row.entity_id)) ??
    (await detailPathForEntity(row.org_id, row.entity_kind, row.entity_id));

  return {
    ok: true,
    status: "active",
    token_id: row.id,
    org_id: row.org_id,
    org_slug: orgRow.slug,
    entity_kind: entityKind,
    entity_id: row.entity_id,
    mode: row.mode,
    action_id: row.action_id,
    auth: row.auth,
    detail_path: detailPath,
  };
}

// :token(.*) so a descriptive multi-segment token ("location/<uuid>") matches
// the same route as a single-segment opaque one.
qrScanRouter.get("/:token(.*)", async (req, res, next) => {
  try {
    const slug = req.params.token;
    if (!slug) {
      res.status(400).json({ error: { code: "missing_token", message: "token required" } });
      return;
    }
    const result = await resolveQrToken(slug);
    if (!result.ok) {
      res.status(result.status === "not_found" ? 404 : 410).json(result);
      return;
    }
    // Best-effort scan audit log. Failures here don't 500 the scan.
    try {
      const tdb = (await getTenantDb(result.org_id!)) as unknown as {
        insertInto: (table: string) => {
          values: (v: Record<string, unknown>) => { execute: () => Promise<unknown> };
        };
      };
      await tdb
        .insertInto("labels_qr_scans")
        .values({
          token_id: result.token_id!,
          ua_hint: ((req.headers["user-agent"] as string | undefined) ?? "").slice(0, 200),
          referer: ((req.headers["referer"] as string | undefined) ?? "").slice(0, 500),
        })
        .execute();
    } catch (err) {
      console.error("[qr-scan] audit log write failed:", err);
    }
    void events.emit("labels.qr.scan.received", {
      orgId: result.org_id,
      tokenId: result.token_id,
      entityKind: result.entity_kind,
      entityId: result.entity_id,
      mode: result.mode,
      ua: ((req.headers["user-agent"] as string | undefined) ?? "").slice(0, 200),
    });

    const join = result.mode === "navigate" ? await labelJoinLink(result.org_id!) : null;
    const publicView = result.mode === "navigate" ? await labelIsPublic(result.org_id!, result.entity_id!) : false;
    res.json({ ...result, ...(join ? { join } : {}), ...(publicView ? { public_view: true } : {}) });
  } catch (err) {
    next(err);
  }
  void sql;
});
