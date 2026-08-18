// /api/v1/orgs/:slug/modules/digifab/edge-shares — OWNER side of bridge sharing.
//
// A workspace that runs an edge bridge can grant ANOTHER Cobblr workspace scoped
// access to a checklist of its bridge machines (edge_adapter connections), via a
// single-use invite. The grantee never receives the machine's credentials — on
// redeem they get a POINTER connection, and the relay assembles each request from
// the owner's config at send time (see jobs-core buildEdgeRelay + PR-2 routing),
// enforcing scope + the grant's revoked/expiry status LIVE.
//
// This router is just the owner's CRUD: mint a grant (pick machines + read/write
// + optional expiry → a one-time link), list grants with status, and revoke.
// Admin/owner only — sharing a machine is granting PHYSICAL capability.

import { Router } from "express";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { tenantDb, tenantContext, type DigifabDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const edgeSharesRouter = Router({ mergeParams: true });

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Owner's shareable machines = its edge_adapter (bridge) connections. */
async function edgeConnections(orgId: string) {
  return (await platform().devices.connections().list(orgId)).filter((c) => c.type === "edge_adapter");
}

function shareStatus(s: { revoked_at: Date | null; expires_at: Date | null; redeemed_at: Date | null }): string {
  if (s.revoked_at) return "revoked";
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return "expired";
  if (s.redeemed_at) return "active";
  return "pending";
}

// GET / — every grant this workspace has minted, with status + machine labels.
edgeSharesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const rows = await db.selectFrom("digifab_edge_shares").selectAll().orderBy("created_at", "desc").execute();
    const conns = await edgeConnections(tenantContext(req).org.id);
    const labelOf = new Map(conns.map((c) => [c.id, c.label]));
    res.json({
      items: rows.map((s) => ({
        id: s.id,
        label: s.label,
        scope: s.scope,
        status: shareStatus(s),
        machines: (s.instances as string[]).map((id) => ({ id, label: labelOf.get(id) ?? "(removed)" })),
        grantees: (s.grantee_orgs as { label: string }[]).map((g) => g.label),
        created_at: s.created_at,
        expires_at: s.expires_at,
        revoked_at: s.revoked_at,
        last_used_at: s.last_used_at,
      })),
    });
  }),
);

const Create = z.object({
  label: z.string().min(1).max(120),
  scope: z.enum(["read", "write"]),
  instance_ids: z.array(z.string().min(1)).min(1).max(100),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

// POST / — mint a grant. Validates the picked machines are this workspace's own
// bridge connections, then returns a ONE-TIME invite token (shown once).
// AI-REACH: mints an edge-share grant; credentials
edgeSharesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = Create.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const conns = await edgeConnections(orgId);
    const valid = new Set(conns.map((c) => c.id));
    const picked = [...new Set(parsed.data.instance_ids)].filter((id) => valid.has(id));
    if (picked.length === 0) {
      return void res.status(400).json({ error: { code: "no_machines", message: "Pick at least one of your bridge machines to share." } });
    }
    const token = randomBytes(24).toString("base64url");
    const expires = parsed.data.expires_in_days
      ? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000)
      : null;
    const db = tenantDb(req);
    const row = await db
      .insertInto("digifab_edge_shares")
      .values({
        label: parsed.data.label.trim(),
        scope: parsed.data.scope,
        instances: JSON.stringify(picked) as unknown as string[],
        token_hash: hashToken(token),
        expires_at: expires,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // The token is returned ONCE; only its hash is stored. The web builds the
    // full /join-machines/<token> link.
    res.status(201).json({ id: row.id, token, owner_org: orgId, scope: row.scope, machine_count: picked.length, expires_at: row.expires_at });
  }),
);

const Redeem = z.object({ owner_org: z.string().min(1), token: z.string().min(1) });

// POST /redeem — the GRANTEE accepts an invite. Runs in the grantee's workspace;
// the link carries the owner_org so we can resolve the grant in the owner's DB.
// Creates one POINTER connection per shared machine (no machine creds — just a
// reference the relay resolves to the owner's bridge at request time).
// AI-REACH: redeems an edge-share grant; credentials
edgeSharesRouter.post(
  "/redeem",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = Redeem.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const granteeCtx = tenantContext(req);
    const ownerOrg = parsed.data.owner_org;
    if (ownerOrg === granteeCtx.org.id) {
      return void res.status(400).json({ error: { code: "own_share", message: "That's a share from your own workspace." } });
    }
    let ownerDb: Kysely<DigifabDB>;
    try {
      ownerDb = (await platform().tenants.getDb(ownerOrg)) as Kysely<DigifabDB>;
    } catch {
      return void res.status(404).json({ error: { code: "not_found", message: "This share link is invalid." } });
    }
    try {
      const share = await ownerDb
        .selectFrom("digifab_edge_shares")
        .selectAll()
        .where("token_hash", "=", hashToken(parsed.data.token))
        .executeTakeFirst();
      if (!share || share.revoked_at) {
        return void res.status(410).json({ error: { code: "invalid", message: "This link is revoked or invalid." } });
      }
      if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
        return void res.status(410).json({ error: { code: "expired", message: "This link has expired." } });
      }
      // Idempotent per workspace: if this org already redeemed, don't duplicate.
      const redeemers = (share.grantee_orgs as { org: string; label: string; at: string }[]) ?? [];
      if (redeemers.some((g) => g.org === granteeCtx.org.id)) {
        return void res.json({ scope: share.scope, machines: [], already: true });
      }
      // Resolve the owner's shared machines → labels (for the grantee's pointers).
      const ownerConns = await edgeConnections(ownerOrg);
      const byId = new Map(ownerConns.map((c) => [c.id, c]));
      const store = platform().devices.connections();
      const created: { id: string; label: string }[] = [];
      for (const connId of share.instances as string[]) {
        const oc = byId.get(connId);
        if (!oc) continue; // owner removed the machine since sharing
        const row = await store.create(granteeCtx.org.id, {
          type: "edge_adapter",
          label: oc.label,
          base_url: oc.base_url, // cobblr-edge://<ownerConnId> — same instance, routed to the owner
          creds: { shared: { owner_org: ownerOrg, owner_conn_id: connId, share_id: share.id, scope: share.scope } },
          config: { shared: true, scope: share.scope, shared_from: ownerOrg },
        });
        created.push({ id: row.id, label: row.label });
      }
      // Record this workspace as a redeemer (the token stays valid → the person can
      // add the machines to more of their workspaces; revoke cuts off all of them).
      const next = [...redeemers, { org: granteeCtx.org.id, label: granteeCtx.org.name, at: new Date().toISOString() }];
      await ownerDb
        .updateTable("digifab_edge_shares")
        .set({ grantee_orgs: JSON.stringify(next) as unknown as never, redeemed_at: share.redeemed_at ?? new Date() })
        .where("id", "=", share.id)
        .execute();
      res.status(201).json({ scope: share.scope, machines: created });
    } finally {
      await platform().tenants.releaseIdleDb(ownerOrg);
    }
  }),
);

// POST /:id/revoke — cut off a grant immediately (the relay re-checks per request).
// AI-REACH: holds or mints credentials; the assistant must never handle these
edgeSharesRouter.post(
  "/:id/revoke",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const updated = await db
      .updateTable("digifab_edge_shares")
      .set({ revoked_at: new Date(), token_hash: null })
      .where("id", "=", req.params.id!)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) return void res.status(404).json({ error: { code: "not_found", message: "Share not found or already revoked." } });
    res.json({ ok: true });
  }),
);
