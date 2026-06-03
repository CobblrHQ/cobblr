// /api/v1/qr/:token — the unauthenticated scan-target route.
//
// Resolves token → (org_id, entity_kind, entity_id, mode, auth) in
// one query against cobblr_meta. Logs the scan to the tenant DB's
// core_labels_qr_scans table (best-effort). Returns a JSON payload
// the web shell uses to navigate or surface a confirmation card.
//
// See docs/modules/core-labels-qr.md.

import { Router } from "express";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as events from "../platform/events.js";

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
}

qrScanRouter.get("/:token", async (req, res, next) => {
  try {
    const slug = req.params.token;
    if (!slug) {
      res.status(400).json({ error: { code: "missing_token", message: "token required" } });
      return;
    }
    const row = await meta
      .selectFrom("core_labels_qr_tokens")
      .selectAll()
      .where("token", "=", slug)
      .executeTakeFirst();
    if (!row) {
      const out: ResolveResult = { ok: false, status: "not_found" };
      res.status(404).json(out);
      return;
    }
    if (row.revoked_at) {
      res.status(410).json({ ok: false, status: "revoked" } satisfies ResolveResult);
      return;
    }
    if (row.expires_at && row.expires_at < new Date()) {
      res.status(410).json({ ok: false, status: "expired" } satisfies ResolveResult);
      return;
    }

    const orgRow = await meta
      .selectFrom("orgs")
      .select(["id", "slug"])
      .where("id", "=", row.org_id)
      .executeTakeFirst();
    if (!orgRow) {
      // Token's org was deleted out from under it. Treat as not_found.
      res.status(404).json({ ok: false, status: "not_found" } satisfies ResolveResult);
      return;
    }

    // Look up the entity kind's detail_route from the registry.
    const ekRow = await meta
      .selectFrom("entity_kinds")
      .select(["detail_route"])
      .where("id", "=", row.entity_kind)
      .executeTakeFirst();
    const detailPath =
      ekRow?.detail_route
        ? ekRow.detail_route.replace("{id}", row.entity_id)
        : undefined;

    const result: ResolveResult = {
      ok: true,
      status: "active",
      token_id: row.id,
      org_id: row.org_id,
      org_slug: orgRow.slug,
      entity_kind: row.entity_kind,
      entity_id: row.entity_id,
      mode: row.mode,
      action_id: row.action_id,
      auth: row.auth,
      detail_path: detailPath,
    };

    // Best-effort scan audit log. Failures here don't 500 the scan.
    try {
      const tdb = (await getTenantDb(row.org_id)) as unknown as {
        insertInto: (table: string) => {
          values: (v: Record<string, unknown>) => { execute: () => Promise<unknown> };
        };
      };
      await tdb
        .insertInto("core_labels_qr_scans")
        .values({
          token_id: row.id,
          ua_hint: ((req.headers["user-agent"] as string | undefined) ?? "").slice(0, 200),
          referer: ((req.headers["referer"] as string | undefined) ?? "").slice(0, 500),
        })
        .execute();
    } catch (err) {
      console.error("[qr-scan] audit log write failed:", err);
    }
    void events.emit("core-labels-qr.scan.received", {
      orgId: row.org_id,
      tokenId: row.id,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
      mode: row.mode,
      ua: ((req.headers["user-agent"] as string | undefined) ?? "").slice(0, 200),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
  void sql;
});
