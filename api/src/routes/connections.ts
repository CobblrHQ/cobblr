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
import * as connectionProviders from "../platform/connections.js";
import { notifyAccount } from "../platform/notifications.js";
import { absoluteAppUrl } from "../platform/public-url.js";
import { verificationOf, type ConnectionVerification } from "@cobblr/platform-contract/connection-verification";
import {
  addUserCredential,
  updateUserCredential,
  deleteUserCredential,
  storedUserCredentials,
  setMyConnectionOrder,
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
  /** Save a key the probe rejected anyway, marked unverified. The person's
   *  say-so, never the default. */
  confirm_unverified: z.boolean().optional(),
});

const PatchBody = z.object({
  label: z.string().max(160).optional(),
  credentials: z.record(z.unknown()).optional(),
  route_mode: RouteMode.optional(),
  route_scope: RouteScope.optional(),
  auto_enable_new: z.boolean().optional(),
  org_ids: z.array(z.string().uuid()).max(200).optional(),
  routes: z.array(Route).max(200).optional(),
  confirm_unverified: z.boolean().optional(),
});

/**
 * The probe a save runs before a key is presented as ready (#2895): the
 * provider's cheapest call, no workspace data, and the verdict becomes the
 * connection's verification. A provider with no probe is "unverified" by
 * construction and says so. `null` when the credentials carry nothing to
 * probe (an edit that changed only the label or the routing).
 */
async function probeForSave(
  providerId: string,
  credentials: Record<string, unknown> | undefined,
  userId: string,
): Promise<ConnectionVerification | null> {
  if (!credentials || !Object.values(credentials).some((v) => typeof v === "string" && v.trim())) return null;
  const def = aiImpl.getProvider(providerId);
  if (!def) return null;
  if (!def.testConnection) return { state: "unverified", at: new Date().toISOString(), message: "This provider has no way to be tested from here." };
  try {
    const model = typeof credentials.model === "string" && credentials.model.trim() ? credentials.model.trim() : null;
    return verificationOf(await def.testConnection({ ...credentials, __connection_user_id: userId }), model);
  } catch (err) {
    return verificationOf({ ok: false, reason: "unknown", error: (err as Error)?.message });
  }
}

/** A key the probe rejected is saved only on the person's say-so, and so is
 *  a REPLACEMENT the probe could not settle: the key it would displace works
 *  (a made-up key replaced a working one on the rig while the probe read
 *  "unverifiable", #2895). On create there is nothing to lose. */
function refuseUnverified(res: import("express").Response, verification: ConnectionVerification): void {
  const invalid = verification.state === "invalid";
  res.status(409).json({
    error: {
      code: invalid ? "key_invalid" : "key_unverifiable",
      message: verification.message ?? (invalid ? "The provider rejected this key." : "The key could not be verified just now."),
    },
    verification,
  });
}

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
    // Stored relative (see receipt-ingest); the absolute form is for the DM body.
    const configPath = "/configuration/ai";
    const configUrl = absoluteAppUrl(configPath);
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
        message: `${offererName} offered to share their AI with this workspace. Review it under Configuration → AI.`,
        link_url: configPath,
        email: {
          subject: `${offererName} wants to share their AI with ${wsName}`,
          text:
            `${offererName} offered to share their AI connection with ${wsName} on Cobblr.\n\n` +
            `Until you approve it, the workspace's Ask Cobb chat and other AI features stay off. ` +
            `Approve or decline the offer here:\n${configUrl}\n\n` +
            `(You can always change this later under Configuration → AI.)`,
        },
      }).catch(() => {});
    }
  }
}

// The secret-free provider catalogue (same shape the per-workspace AI page uses)
// so the "add a personal connection" form can render the right credential fields.
//
// Every registered KIND, not only AI. Each item carries its kind so the page can
// group them; AI's entries additionally carry capabilities + models, which only
// the AI catalogue has, so they are merged in rather than flattened away.
connectionsRouter.get("/me/connections/catalogue", requireAuth, (_req, res) => {
  const ai = new Map(aiImpl.listProviders().map((p) => [p.id, p]));
  res.json({
    items: connectionProviders.listProviders().map((p) => ({ ...ai.get(p.id), ...p })),
  });
});

// Check credentials someone has just typed, WITHOUT saving them.
//
// The personal twin of the workspace route (core-ai providers /test-credentials).
// This page is where an individual user or a self-hoster adds their own key, so a
// capability that only reaches the workspace form is a capability most of them
// never see. That has already happened once here.
//
// Nothing is stored: the credentials live for the length of this request. The reply
// carries the provider's model list, because for an OpenAI-compatible provider
// "is this key good" IS a model-list request, and the list is what lets the form
// offer a dropdown instead of asking for an exact model name.
connectionsRouter.post("/me/connections/test", requireAuth, async (req, res) => {
  const Body = z.object({
    provider_id: z.string().min(1).max(80),
    credentials: z.record(z.unknown()),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "provider_id + credentials required" } });
    return;
  }
  const def = aiImpl.getProvider(parsed.data.provider_id);
  if (!def?.testConnection) {
    res.json({ ok: true, note: "provider has no test implementation; assumed ok" });
    return;
  }
  // The personal routing context, so a bridge-transit provider resolves to THIS
  // user's edge agent rather than failing for want of an org.
  const result = await def.testConnection({
    ...parsed.data.credentials,
    __connection_user_id: req.session!.id,
  });
  res.json(result);
});

// Is MY personal edge agent connected right now? Drives the transit hint in
// the add-a-connection dialog (a bridge-transit provider routes through it).
connectionsRouter.get("/me/edge-agent", requireAuth, async (req, res) => {
  res.json({ connected: await platform().edge.hasChannel(req.session!.id) });
});

connectionsRouter.get("/me/connections", requireAuth, async (req, res, next) => {
  try {
    // The secrecy lookup spans every catalogue (see platform/connections.ts):
    // it decides which stored values may be echoed back to pre-fill the edit
    // form, and an unknown provider is treated as all-secret.
    res.json({
      items: await listUserCredentials(req.session!.id, connectionProviders.secretLookup()),
    });
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
    const provider = connectionProviders.getProvider(parsed.data.provider_id);
    if (!provider) {
      res.status(400).json({ error: { code: "unknown_provider", message: "No such provider." } });
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
    // The key is tested before the connection is presented as ready. A
    // rejected key is not saved unless the person says so, and then it is
    // saved as unverified, not as ready.
    let verification = await probeForSave(parsed.data.provider_id, parsed.data.credentials, req.session!.id);
    if (verification?.state === "invalid" && !parsed.data.confirm_unverified) {
      refuseUnverified(res, verification);
      return;
    }
    if (verification?.state === "invalid") verification = { ...verification, state: "unverified" };
    const { confirm_unverified: _c, ...input } = parsed.data;
    // The KIND comes from the provider, never from the body: it decides which
    // resolver will later find this credential, so letting a client name it
    // would let one connection answer for a service it is not.
    const id = await addUserCredential(req.session!.id, { ...input, kind: provider.kind, ...(verification ? { verification } : {}) });
    if (parsed.data.routes?.length) {
      const me = await meta.selectFrom("users").select("display_name").where("id", "=", req.session!.id).executeTakeFirst();
      await notifyOwnersOfOffers(req.session!.id, me?.display_name ?? "A member", parsed.data.routes);
    }
    res.status(201).json({ id, ...(verification ? { verification } : {}) });
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
    // A replacement key is probed with the stored values it merges over
    // (the form sends only what was re-typed), and a rejected one leaves the
    // working credential in place until the person confirms the swap.
    const stored = parsed.data.credentials !== undefined ? await storedUserCredentials(req.session!.id, id) : null;
    if (parsed.data.credentials !== undefined && !stored) {
      res.status(404).json({ error: { code: "not_found", message: "Connection not found." } });
      return;
    }
    let verification =
      stored && parsed.data.credentials !== undefined
        ? await probeForSave(stored.provider_id, { ...stored.credentials, ...parsed.data.credentials }, req.session!.id)
        : null;
    // A rejected key is always refused until confirmed; an unsettled one only
    // when it would displace a key that VERIFIED. A row never verified takes
    // the new state as it is.
    const displacesWorking = stored?.verification?.state === "verified";
    if (verification && (verification.state === "invalid" || (verification.state !== "verified" && displacesWorking)) && !parsed.data.confirm_unverified) {
      refuseUnverified(res, verification);
      return;
    }
    if (verification?.state === "invalid") verification = { ...verification, state: "unverified" };
    const { confirm_unverified: _c, ...patch } = parsed.data;
    const ok = await updateUserCredential(req.session!.id, id, { ...patch, ...(verification ? { verification } : {}) });
    if (!ok) {
      res.status(404).json({ error: { code: "not_found", message: "Connection not found." } });
      return;
    }
    if (parsed.data.routes?.length) {
      const me = await meta.selectFrom("users").select("display_name").where("id", "=", req.session!.id).executeTakeFirst();
      await notifyOwnersOfOffers(req.session!.id, me?.display_name ?? "A member", parsed.data.routes);
    }
    if (verification) res.json({ verification });
    else res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// The Test button: the same probe as a save, on the stored key nobody can
// read back, and the verdict replaces the row's verification.
connectionsRouter.post("/me/connections/:id/test", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    const stored = id ? await storedUserCredentials(req.session!.id, id) : null;
    if (!id || !stored) {
      res.status(404).json({ error: { code: "not_found", message: "Connection not found." } });
      return;
    }
    const verification = (await probeForSave(stored.provider_id, stored.credentials, req.session!.id)) ?? {
      state: "unverified" as const,
      at: new Date().toISOString(),
      message: "This connection holds nothing to test.",
    };
    await updateUserCredential(req.session!.id, id, { verification });
    res.json({ verification });
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

// The ORDER of my connections in a workspace, first to last. Without it the
// answer was "whichever I edited last", which changed when I touched the OTHER
// one for an unrelated reason. `capability` narrows the order to one kind of
// work; omit it for the workspace's general order.
connectionsRouter.post("/me/connections/order", requireAuth, async (req, res, next) => {
  try {
    const body = z
      .object({
        org_id: z.string().uuid(),
        credential_ids: z.array(z.string().uuid()).max(20),
        capability: z.string().min(1).max(64).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "org_id and credential_ids required" } });
      return;
    }
    const ok = await setMyConnectionOrder(
      req.session!.id,
      body.data.org_id,
      body.data.credential_ids,
      body.data.capability ?? null,
    );
    if (!ok) {
      res.status(404).json({ error: { code: "not_found", message: "That connection is not yours." } });
      return;
    }
    res.json({ ok: true });
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
// AI-REACH: accepting, refusing or switching WHOSE AI powers this workspace. It is
// somebody's own account paying for the calls, offered deliberately and taken up
// deliberately; an assistant must not decide that, least of all about itself.
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

// AI-REACH: accepting, refusing or switching WHOSE AI powers this workspace. It is
// somebody's own account paying for the calls, offered deliberately and taken up
// deliberately; an assistant must not decide that, least of all about itself.
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
// AI-REACH: accepting, refusing or switching WHOSE AI powers this workspace. It is
// somebody's own account paying for the calls, offered deliberately and taken up
// deliberately; an assistant must not decide that, least of all about itself.
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
