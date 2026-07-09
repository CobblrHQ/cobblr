// /api/v1/me/connections — personal (user-scoped) credential manager.
//
// A user configures a provider ONCE and routes it to chosen workspaces (so it
// follows them instead of being re-added per workspace). The credential's
// secret lives encrypted in cobblr_meta; the AI resolver projects it into a
// workspace per its routing policy (see platform/user-credentials.ts). Secrets
// are write-only — never returned (the list shows which keys are set, not their
// values).

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import * as aiImpl from "../platform/ai.js";
import { notifyAccount } from "../platform/notifications.js";
import { absoluteAppUrl } from "../platform/public-url.js";
import {
  addUserCredential,
  updateUserCredential,
  deleteUserCredential,
  listUserCredentials,
  listWorkspaceAiOffers,
  approveWorkspaceAiOffer,
  rejectWorkspaceAiOffer,
  setActiveWorkspaceAi,
  workspaceOwnerIds,
  type CredentialRoute,
} from "../platform/user-credentials.js";

export const connectionsRouter = Router();
export const workspaceAiSharesRouter = Router({ mergeParams: true });

const RouteMode = z.enum(["my-calls", "workspace-default"]);
const RouteScope = z.enum(["sole_member", "owner", "all_mine", "explicit"]);
const Route = z.object({ org_id: z.string().uuid(), mode: RouteMode });

const CreateBody = z.object({
  provider_id: z.string().min(1).max(80),
  label: z.string().max(160).optional(),
  credentials: z.record(z.unknown()).default({}),
  route_mode: RouteMode.optional(),
  route_scope: RouteScope.optional(),
  auto_enable_new: z.boolean().optional(),
  org_ids: z.array(z.string().uuid()).max(200).optional(),
  routes: z.array(Route).max(200).optional(),
});

const PatchBody = z.object({
  label: z.string().max(160).optional(),
  credentials: z.record(z.unknown()).optional(),
  route_mode: RouteMode.optional(),
  route_scope: RouteScope.optional(),
  auto_enable_new: z.boolean().optional(),
  org_ids: z.array(z.string().uuid()).max(200).optional(),
  routes: z.array(Route).max(200).optional(),
});

/** Every org id the user actually belongs to — guards explicit routing so you
 *  can't route a personal cred into a workspace you're not in. */
async function memberOrgIds(userId: string): Promise<Set<string>> {
  const rows = await meta
    .selectFrom("org_memberships")
    .select("org_id")
    .where("user_id", "=", userId)
    .execute();
  return new Set(rows.map((r) => r.org_id));
}

/** All org_ids referenced by a body's routing (routes preferred, else org_ids). */
function routedOrgIds(body: { routes?: CredentialRoute[]; org_ids?: string[] }): string[] {
  if (body.routes) return body.routes.map((r) => r.org_id);
  return body.org_ids ?? [];
}

/** Clear an owner's OLD, now-stale AI-share offer notifications for a workspace
 *  so only the current action item stands. A member who toggles Share off/on (or
 *  the owner who approves/declines) leaves behind identical "X offered to share
 *  their AI" bell rows that all look actionable — this marks the superseded ones
 *  read. Best-effort; never blocks the caller. */
async function supersedeShareOffers(ownerId: string, orgId: string): Promise<void> {
  await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", ownerId)
    .where("org_id", "=", orgId)
    .where("event_type", "=", "platform.ai.share_offered")
    .where("read_at", "is", null)
    .execute()
    .catch(() => {});
}

/** Approve/decline resolves the offer for EVERY owner, not just the one who
 *  clicked — clear the stale action item for all of them (a co-owner shouldn't
 *  keep an unread "wants to share their AI" for an offer that's settled). */
async function supersedeShareOffersForAllOwners(orgId: string): Promise<void> {
  const owners = await workspaceOwnerIds(orgId).catch(() => [] as string[]);
  for (const o of owners) await supersedeShareOffers(o, orgId);
}

/** Ping a workspace's owners when a member OFFERS to share their AI there (a
 *  workspace-default route into a workspace they don't own). Best-effort. */
async function notifyOwnersOfOffers(
  offererId: string,
  offererName: string,
  routes: CredentialRoute[],
): Promise<void> {
  const shares = routes.filter((r) => r.mode === "workspace-default");
  for (const r of shares) {
    const owners = await workspaceOwnerIds(r.org_id);
    const nonSelf = owners.filter((o) => o !== offererId);
    if (nonSelf.length === 0) continue; // self-share needs no offer
    // Workspace name for a human subject line — falls back gracefully.
    const org = await meta
      .selectFrom("orgs")
      .select(["name"])
      .where("id", "=", r.org_id)
      .executeTakeFirst();
    const wsName = org?.name ?? "your workspace";
    const configUrl = absoluteAppUrl("/configuration");
    for (const ownerId of nonSelf) {
      // Collapse any prior unread offer for this owner+workspace first, so a
      // re-share doesn't stack up identical "wants to share their AI" rows — the
      // newest one below is the single live action item.
      await supersedeShareOffers(ownerId, r.org_id);
      // A shared AI can't power the workspace until the owner approves it, and
      // the in-app bell is easy to miss — so this rides email too (a tier-2
      // platform notification; delivered only if the owner hasn't opted out and
      // a mail sender is configured — notifyAccount gates both).
      await notifyAccount({
        userId: ownerId,
        representativeOrgId: r.org_id,
        notificationType: "platform.ai.share_offered",
        message: `${offererName} offered to share their AI with this workspace. Review it in Settings → AI sharing.`,
        link_url: configUrl,
        email: {
          subject: `${offererName} wants to share their AI with ${wsName}`,
          text:
            `${offererName} offered to share their AI connection with ${wsName} on Cobblr.\n\n` +
            `Until you approve it, the workspace's Ask Cobb chat and other AI features stay off. ` +
            `Approve or decline the offer here:\n${configUrl}\n\n` +
            `(You can always change this later in Settings → AI sharing.)`,
        },
      }).catch(() => {});
    }
  }
}

// The secret-free provider catalogue (same shape the per-workspace AI page uses)
// so the "add a personal connection" form can render the right credential fields.
connectionsRouter.get("/me/connections/catalogue", requireAuth, (_req, res) => {
  res.json({ items: aiImpl.listProviders() });
});

// Is MY personal edge agent connected right now? Drives the transit hint in
// the add-a-connection dialog (a bridge-transit provider routes through it).
connectionsRouter.get("/me/edge-agent", requireAuth, (req, res) => {
  res.json({ connected: platform().edge.hasChannel(req.session!.id) });
});

connectionsRouter.get("/me/connections", requireAuth, async (req, res, next) => {
  try {
    res.json({ items: await listUserCredentials(req.session!.id) });
  } catch (err) {
    next(err);
  }
});

connectionsRouter.post("/me/connections", requireAuth, async (req, res, next) => {
  try {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues } });
      return;
    }
    if (!aiImpl.getProvider(parsed.data.provider_id)) {
      res.status(400).json({ error: { code: "unknown_provider", message: "No such AI provider." } });
      return;
    }
    const routedOrgs = routedOrgIds(parsed.data);
    if (routedOrgs.length) {
      const mine = await memberOrgIds(req.session!.id);
      const bad = routedOrgs.filter((id) => !mine.has(id));
      if (bad.length) {
        res.status(403).json({ error: { code: "not_a_member", message: "Can only route to workspaces you belong to." } });
        return;
      }
    }
    const id = await addUserCredential(req.session!.id, parsed.data);
    if (parsed.data.routes?.length) {
      const me = await meta.selectFrom("users").select("display_name").where("id", "=", req.session!.id).executeTakeFirst();
      await notifyOwnersOfOffers(req.session!.id, me?.display_name ?? "A member", parsed.data.routes);
    }
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

connectionsRouter.patch("/me/connections/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues } });
      return;
    }
    const routedOrgs = routedOrgIds(parsed.data);
    if (routedOrgs.length) {
      const mine = await memberOrgIds(req.session!.id);
      const bad = routedOrgs.filter((o) => !mine.has(o));
      if (bad.length) {
        res.status(403).json({ error: { code: "not_a_member", message: "Can only route to workspaces you belong to." } });
        return;
      }
    }
    const ok = await updateUserCredential(req.session!.id, id, parsed.data);
    if (!ok) {
      res.status(404).json({ error: { code: "not_found", message: "Connection not found." } });
      return;
    }
    if (parsed.data.routes?.length) {
      const me = await meta.selectFrom("users").select("display_name").where("id", "=", req.session!.id).executeTakeFirst();
      await notifyOwnersOfOffers(req.session!.id, me?.display_name ?? "A member", parsed.data.routes);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

connectionsRouter.delete("/me/connections/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ok = await deleteUserCredential(req.session!.id, id);
    if (!ok) {
      res.status(404).json({ error: { code: "not_found", message: "Connection not found." } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─────────── Owner-side: review AI-share offers for a workspace ───────────
// Mounted at /orgs/:slug. requireAuth + withTenant resolve the workspace; the
// user-credentials helpers enforce that only the workspace OWNER can act.
const orgId = (req: { tenant?: { org: { id: string } } }): string =>
  (req as { tenant: { org: { id: string } } }).tenant.org.id;

workspaceAiSharesRouter.get("/ai-shares", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ items: await listWorkspaceAiOffers(orgId(req)) });
  } catch (err) {
    next(err);
  }
});

const ApproveBody = z.object({ active: z.boolean().optional() });
workspaceAiSharesRouter.post("/ai-shares/:credentialId/approve", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = ApproveBody.safeParse(req.body ?? {});
    const ok = await approveWorkspaceAiOffer(
      req.session!.id,
      orgId(req),
      req.params.credentialId!,
      parsed.success ? parsed.data.active ?? false : false,
    );
    if (!ok) {
      res.status(403).json({ error: { code: "not_owner", message: "Only the workspace owner can approve shared AI." } });
      return;
    }
    // Resolved — clear the offer notification so it stops reading as a to-do.
    await supersedeShareOffersForAllOwners(orgId(req));
    res.json({ items: await listWorkspaceAiOffers(orgId(req)) });
  } catch (err) {
    next(err);
  }
});

workspaceAiSharesRouter.post("/ai-shares/:credentialId/reject", requireAuth, withTenant, async (req, res, next) => {
  try {
    const ok = await rejectWorkspaceAiOffer(req.session!.id, orgId(req), req.params.credentialId!);
    if (!ok) {
      res.status(403).json({ error: { code: "not_owner", message: "Only the workspace owner can decline shared AI." } });
      return;
    }
    // Resolved — clear the offer notification so it stops reading as a to-do.
    await supersedeShareOffersForAllOwners(orgId(req));
    res.json({ items: await listWorkspaceAiOffers(orgId(req)) });
  } catch (err) {
    next(err);
  }
});

const ActiveBody = z.object({ credential_id: z.string().uuid().nullable() });
workspaceAiSharesRouter.post("/ai-shares/active", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = ActiveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "credential_id required (or null)." } });
      return;
    }
    const ok = await setActiveWorkspaceAi(req.session!.id, orgId(req), parsed.data.credential_id);
    if (!ok) {
      res.status(403).json({ error: { code: "not_owner", message: "Only the workspace owner can pick the workspace AI." } });
      return;
    }
    res.json({ items: await listWorkspaceAiOffers(orgId(req)) });
  } catch (err) {
    next(err);
  }
});
