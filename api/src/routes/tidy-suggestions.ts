import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { listTidySuggestions, tidyAllowed } from "../platform/tidy-suggestions.js";

export const tidyRouter = Router({ mergeParams: true });
tidyRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const orgId = req.tenant!.org.id;
    const available = await tidyAllowed(orgId);
    const row = available ? await meta.selectFrom("orgs").select("tidy_enabled").where("id", "=", orgId).executeTakeFirst() : null;
    res.json({ available, enabled: row?.tidy_enabled === true, items: available ? await listTidySuggestions(orgId, req.tenant!.role) : [] });
  } catch (err) { next(err); }
});
// UI-REACH: Settings → Tidy → Tidy-up suggestions
// AI-REACH: exempt — opting in is an explicit workspace setting
tidyRouter.patch("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: { code: "invalid_body", message: "Choose on or off." } }); return; }
    const orgId = req.tenant!.org.id;
    if (body.data.enabled && !await tidyAllowed(orgId)) { res.status(403).json({ error: { code: "unavailable", message: "Tidy-up suggestions are unavailable on this instance." } }); return; }
    await meta.updateTable("orgs").set({ tidy_enabled: body.data.enabled }).where("id", "=", orgId).execute();
    res.json({ enabled: body.data.enabled });
  } catch (err) { next(err); }
});
// UI-REACH: home Needs you, Not now / Never suggest this / after Do it
// AI-REACH: exempt — these are a person's suggestion preferences
tidyRouter.post("/:id/decision", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const body = z.object({ decision: z.enum(["later", "never", "done"]) }).strict().safeParse(req.body);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!body.success || !id.success) { res.status(400).json({ error: { code: "invalid_body", message: "Choose a suggestion and a decision." } }); return; }
    const orgId = req.tenant!.org.id;
    const row = await meta.selectFrom("tidy_suggestions").select(["candidate"]).where("org_id", "=", orgId).where("id", "=", id.data).where("decided_at", "is", null).executeTakeFirst();
    if (!row) { res.status(404).json({ error: { code: "not_found", message: "That suggestion is no longer waiting." } }); return; }
    const now = new Date();
    await meta.transaction().execute(async (tx) => {
      await tx.updateTable("tidy_suggestions").set({ decided_at: now }).where("org_id", "=", orgId).where("id", "=", id.data).execute();
      if (body.data.decision !== "done") for (const r of row.candidate.records) {
        const until = body.data.decision === "never" ? null : new Date(now.getTime() + 7 * 86400000);
        await tx.insertInto("tidy_suppressions").values({ org_id: orgId, kind: row.candidate.kind, record_kind: r.kind, record_id: r.id, until_at: until }).onConflict((oc) => oc.columns(["org_id", "kind", "record_kind", "record_id"]).doUpdateSet({ until_at: until })).execute();
      }
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
