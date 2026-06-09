// /api/v1/me/connections — personal (user-scoped) credential manager.
//
// A user configures a provider ONCE and routes it to chosen workspaces (so it
// follows them instead of being re-added per workspace). The credential's
// secret lives encrypted in cobblr_meta; the AI resolver projects it into a
// workspace per its routing policy (see platform/user-credentials.ts). Secrets
// are write-only — never returned (the list shows which keys are set, not their
// values).

import { Router } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import * as aiImpl from "../platform/ai.js";
import {
  addUserCredential,
  updateUserCredential,
  deleteUserCredential,
  listUserCredentials,
} from "../platform/user-credentials.js";

export const connectionsRouter = Router();

const RouteMode = z.enum(["my-calls", "workspace-default"]);
const RouteScope = z.enum(["sole_member", "owner", "all_mine", "explicit"]);

const CreateBody = z.object({
  provider_id: z.string().min(1).max(80),
  label: z.string().max(160).optional(),
  credentials: z.record(z.unknown()).default({}),
  route_mode: RouteMode.optional(),
  route_scope: RouteScope.optional(),
  auto_enable_new: z.boolean().optional(),
  org_ids: z.array(z.string().uuid()).max(200).optional(),
});

const PatchBody = z.object({
  label: z.string().max(160).optional(),
  credentials: z.record(z.unknown()).optional(),
  route_mode: RouteMode.optional(),
  route_scope: RouteScope.optional(),
  auto_enable_new: z.boolean().optional(),
  org_ids: z.array(z.string().uuid()).max(200).optional(),
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

// The secret-free provider catalogue (same shape the per-workspace AI page uses)
// so the "add a personal connection" form can render the right credential fields.
connectionsRouter.get("/me/connections/catalogue", requireAuth, (_req, res) => {
  res.json({ items: aiImpl.listProviders() });
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
    if ((parsed.data.route_scope ?? "sole_member") === "explicit" && parsed.data.org_ids?.length) {
      const mine = await memberOrgIds(req.session!.id);
      const bad = parsed.data.org_ids.filter((id) => !mine.has(id));
      if (bad.length) {
        res.status(403).json({ error: { code: "not_a_member", message: "Can only route to workspaces you belong to." } });
        return;
      }
    }
    const id = await addUserCredential(req.session!.id, parsed.data);
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
    if (parsed.data.org_ids?.length) {
      const mine = await memberOrgIds(req.session!.id);
      const bad = parsed.data.org_ids.filter((o) => !mine.has(o));
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
