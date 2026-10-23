import { platform, readJsonArg, textSearchWhere } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DigifabDB } from "../../db.js";
import { createFiring, finishFiring, KilnRefusal, saveKilnProfile } from "./store.js";
let registered = false;
export function registerKilnActions() {
 if (registered) return; registered = true;
 platform().actions.registerHandler("digifab.kiln-log", async ctx => {
  if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Recording a kiln firing requires an admin." };
  try {
   const args = ctx.args ?? {}, fields = readJsonArg(args, "fields") ?? {}, db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
   const id = z.string().uuid().parse(args.id);
   if (args.operation === "profile") return await saveKilnProfile(db, ctx.orgId, id, fields);
   if (args.operation === "create") return { ok: true, firing: await createFiring(db, ctx.orgId, { ...fields, id }, ctx.userId) };
   if (args.operation === "finish") return { ok: true, firing: await finishFiring(db, ctx.orgId, ctx.userId, id, fields) };
   return { ok: false, error: "Choose profile, create or finish. Start and Stop are at the authorized station." };
  } catch(e) { if (e instanceof z.ZodError || e instanceof KilnRefusal) return { ok: false, error: e.message }; throw e; }
 });
 const entity = async (orgId: string, r: { id: string; name: string; machine_id: string; status: string; peak_c: number | null; duration_hours: number | null }) => ({ kind: "digifab:firing", id: r.id, title: r.name, subtitle: r.status, detailUrl: (await platform().entities.lookup(orgId, "machines:machine", r.machine_id))?.detailUrl, fields: { name: r.name, status: r.status, machine_id: r.machine_id, peak_c: r.peak_c, duration_hours: r.duration_hours } });
 platform().entities.registerResolver("digifab:firing", async (orgId, id) => {
  const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;
  const row = await db.selectFrom("digifab_firings").selectAll().where("id", "=", id).executeTakeFirst(); return row ? entity(orgId, row) : null;
 });
 platform().entities.registerListResolver("digifab:firing", async (orgId, query) => {
  const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;
  let q = db.selectFrom("digifab_firings").selectAll();
  if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { unreadable: query.unreadable, text: ["name", "status"], json: ["recipe"] })!);
  const rows = await q.orderBy("created_at", "desc").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute(); return { items: await Promise.all(rows.map(row => entity(orgId, row))) };
 });
}
