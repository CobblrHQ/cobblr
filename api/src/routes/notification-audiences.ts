// Who each kind of workspace notification is for.
//
//   GET  /orgs/:slug/notification-audiences
//     every kind this workspace can be told about (declared by its enabled
//     modules, plus any kind already seen in its notifications), with the
//     current rule for each: everyone, the owners, or a chosen few.
//   PUT  /orgs/:slug/notification-audiences/:eventType   { mode, user_ids? }
//
// Owner/admin only: deciding who in a workspace is told what is governance,
// like membership. The rule itself is applied by the dispatcher
// (platform/notification-audience.ts); this is only where it is set.

import { Router } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import type { OrgRole } from "../db/schema.js";
import { listEntries } from "../modules/registry.js";
import { audienceRules, setAudience } from "../platform/notification-audience.js";

export const notificationAudiencesRouter = Router({ mergeParams: true });

const ADMINISH: ReadonlyArray<OrgRole> = ["owner", "admin"];

function assertAdmin(req: import("express").Request, res: import("express").Response): boolean {
  // role-gate: exact — who is told what is governance, not action.
  if (!ADMINISH.includes(req.tenant!.role as OrgRole)) {
    res.status(403).json({ error: { code: "forbidden", message: "Workspace owners/admins only." } });
    return false;
  }
  return true;
}

interface KindRow {
  event_type: string;
  label: string;
  description: string | null;
  module: string;
  mode: "all" | "owners" | "custom";
  user_ids: string[];
}

/** Kinds this workspace can be told about: what its enabled modules declare,
 *  plus anything that has already arrived (a module that dispatches a kind it
 *  never declared still shows up here, named by its event type, so it can be
 *  pointed at fewer people). */
async function kindsFor(orgId: string): Promise<KindRow[]> {
  const enabled = new Set(
    (await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map((r) => r.module_name),
  );
  const declared = new Map<string, { label: string; description: string | null; module: string }>();
  for (const e of listEntries()) {
    if (!enabled.has(e.manifest.name)) continue;
    for (const k of e.manifest.exposes.notifications) {
      declared.set(k.eventType, { label: k.label, description: k.description ?? null, module: e.manifest.name });
    }
  }
  const seen = await meta
    .selectFrom("notifications")
    .select(["event_type", "module_name"])
    .distinct()
    .where("org_id", "=", orgId)
    .execute();
  for (const s of seen) {
    if (declared.has(s.event_type)) continue;
    // Account-scoped kinds (platform.*) are not the workspace's to route.
    if (s.event_type.startsWith("platform.")) continue;
    declared.set(s.event_type, { label: s.event_type, description: null, module: s.module_name ?? s.event_type.split(".")[0] ?? "" });
  }
  const rules = await audienceRules(orgId);
  return [...declared.entries()]
    .map(([event_type, d]) => {
      const rule = rules.get(event_type);
      return { event_type, ...d, mode: rule?.mode ?? "all", user_ids: rule?.userIds ?? [] };
    })
    .sort((a, b) => a.module.localeCompare(b.module) || a.label.localeCompare(b.label));
}

// AI-REACH: exempt — a workspace GOVERNANCE setting (who in the workspace is
// told what). Deciding that is the owner's hand on the lever, like membership;
// the assistant reaches notifications through the bell and the press door.
notificationAudiencesRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    res.json({ items: await kindsFor(req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

const PutBody = z.object({
  mode: z.enum(["all", "owners", "custom"]),
  user_ids: z.array(z.string().uuid()).max(500).optional(),
});

// AI-REACH: exempt — see the GET above (governance, human-only).
notificationAudiencesRouter.put("/:eventType", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const parsed = PutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: parsed.error.message } });
      return;
    }
    const eventType = String(req.params.eventType ?? "");
    if (!/^[a-z0-9-]+\.[a-z0-9._-]+$/.test(eventType)) {
      res.status(400).json({ error: { code: "bad_event_type", message: "eventType is <module>.<what>" } });
      return;
    }
    const orgId = req.tenant!.org.id;
    let userIds = parsed.data.user_ids ?? [];
    if (parsed.data.mode === "custom") {
      // Only current members can be chosen; a stranger's id is dropped, not
      // stored, so the list can never name someone who is not in the room.
      const members = new Set(
        (await meta.selectFrom("org_memberships").select("user_id").where("org_id", "=", orgId).execute()).map((r) => String(r.user_id)),
      );
      userIds = userIds.filter((id) => members.has(id));
      if (userIds.length === 0) {
        res.status(400).json({ error: { code: "empty_audience", message: "Choose at least one member, or pick everyone or owners." } });
        return;
      }
    }
    await setAudience(orgId, eventType, { mode: parsed.data.mode, userIds });
    const items = await kindsFor(orgId);
    res.json({ item: items.find((k) => k.event_type === eventType) ?? null });
  } catch (err) {
    next(err);
  }
});
