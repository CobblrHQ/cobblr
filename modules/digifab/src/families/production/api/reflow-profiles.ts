import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ActionRefusal, platform, readJsonArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import { parseReflowProfile, controleoProfile, type ReflowProfile } from "@cobblr/platform-contract/reflow-profile";
import type { Kysely } from "kysely";
import { tenantContext, type DigifabDB } from "../../../db.js";
import { asyncHandler } from "../../../api/util.js";
import { REFLOW_BRIDGE_PACKAGE } from "../reflow-bridge-package.generated.js";
const Paste = z.object({ paste_kind: z.string().min(3).max(120), paste_id: z.string().uuid() });
export async function reflowProfiles(orgId: string, paste: z.infer<typeof Paste>) {
  const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;
  return { items: await db.selectFrom("digifab_reflow_profiles").selectAll().where("paste_kind", "=", paste.paste_kind).where("paste_id", "=", paste.paste_id).orderBy("created_at", "desc").execute() };
}
export async function reflowProfile(orgId: string, id: string) {
  const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;
  const row = await db.selectFrom("digifab_reflow_profiles").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new ActionRefusal("Choose a saved paste reflow profile from this workspace.");
  return row;
}
export function registerReflowProfiles() {
  platform().actions.registerHandler("digifab.reflow-profiles", async ctx => ({ ok: true, data: await reflowProfiles(ctx.orgId, Paste.parse(ctx.args)) }));
  platform().actions.registerHandler("digifab.reflow-profile", async ctx => ({ ok: true, data: await reflowProfile(ctx.orgId, z.object({ profile_id: z.string().uuid() }).parse(ctx.args).profile_id) }));
  platform().actions.registerHandler("digifab.reflow-bridge-package", async () => ({ ok: true, data: { filename: "cobblr-reflow.mjs", content: REFLOW_BRIDGE_PACKAGE, sha256: createHash("sha256").update(REFLOW_BRIDGE_PACKAGE).digest("hex") } }));
  platform().actions.registerHandler("digifab.save-reflow-profile", async (ctx: ActionInvokeContext) => {
    const args = ctx.args ?? {}, paste = Paste.parse(args);
    const record = await platform().entities.lookup(ctx.orgId, paste.paste_kind, paste.paste_id, { userId: ctx.userId ?? undefined });
    if (!record || record.retired || record.fields.unit !== "ml") throw new ActionRefusal("Choose a liquid paste jar measured in ml.");
    let profile: ReflowProfile;
    try { profile = parseReflowProfile(readJsonArg(args, "profile")); } catch (e) { throw new ActionRefusal((e as Error).message); }
    const fingerprint = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
    const row = await db.insertInto("digifab_reflow_profiles").values({ ...paste, fingerprint, profile, created_by: ctx.userId }).onConflict(oc => oc.columns(["paste_kind", "paste_id", "fingerprint"]).doNothing()).returningAll().executeTakeFirst();
    const saved = row ?? await db.selectFrom("digifab_reflow_profiles").selectAll().where("paste_kind", "=", paste.paste_kind).where("paste_id", "=", paste.paste_id).where("fingerprint", "=", fingerprint).executeTakeFirstOrThrow();
    if (row) await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "created", ref: { module: "digifab", entityType: "reflow-profile", entityId: row.id }, diff: { name: profile.name } });
    return { ok: true, changed: !!row, data: saved };
  });
}
export const reflowProfilesRouter = Router({ mergeParams: true });
reflowProfilesRouter.get("/reflow/profiles", asyncHandler(async (req, res) => { res.json(await reflowProfiles(tenantContext(req).org.id, Paste.parse(req.query))); }));
reflowProfilesRouter.get("/reflow/profiles/:id", asyncHandler(async (req, res) => { const row = await reflowProfile(tenantContext(req).org.id, String(req.params.id)); res.json({ ...row, controleo_txt: controleoProfile(row.profile) }); }));
reflowProfilesRouter.get("/reflow/bridge-package", asyncHandler(async (_req, res) => { res.type("text/javascript").attachment("cobblr-reflow.mjs").send(REFLOW_BRIDGE_PACKAGE); }));
