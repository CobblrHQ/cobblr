import { sql, type Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { DigifabDB } from "../db.js";
import { buildDriverById } from "../jobs-core.js";
import { FiringSchema, FinishSchema, ProfileSchema, TelemetrySchema, firingLinks, replacementReminders, type Firing } from "./model.js";
import { z } from "zod";
export class KilnRefusal extends Error {}
export const CreateSchema = z.object({ id: z.string().uuid(), machine_id: z.string().uuid(), firing: FiringSchema });
export async function firingHours(db: Kysely<DigifabDB>, machineId: string) {
 const row = await db.selectFrom("digifab_firings").select(sql<string>`coalesce(sum(duration_hours), 0)`.as("hours")).where("machine_id", "=", machineId).where("ended_at", "is not", null).executeTakeFirstOrThrow();
 return Number(row.hours);
}
export async function saveKilnProfile(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown) {
 const profile = ProfileSchema.parse(value);
 const machine = await platform().entities.lookup(orgId, "machines:machine", machineId);
 if (!machine || machine.retired) throw new KilnRefusal("Choose an existing machine for this kiln.");
 const hours = await firingHours(db, machineId);
 if (profile.components.some(c => c.replaced_at_hours > hours)) throw new KilnRefusal("A component's replacement counter cannot be ahead of this kiln's firing hours.");
 if (profile.connection_id) {
  const driver = await buildDriverById(db, orgId, profile.connection_id);
  const device = (await driver?.listDevices())?.find(d => d.id === profile.device_id);
  if (!device || !TelemetrySchema.safeParse(device.raw?.kiln).success) throw new KilnRefusal("Choose a kiln on your bridge with supported telemetry.");
 }
 const values = { connection_id: profile.connection_id, device_id: profile.device_id, components: JSON.stringify(profile.components), schedules: JSON.stringify(profile.schedules) };
 await db.insertInto("digifab_kiln_profiles").values({ machine_id: machineId, ...values }).onConflict(oc => oc.column("machine_id").doUpdateSet(values)).execute();
 return { ok: true };
}
async function checkLoad(orgId: string, recipe: Firing) {
 for (const piece of recipe.pieces) {
  const found = await platform().entities.lookup(orgId, piece.kind, piece.id);
  if (!found || found.retired) throw new KilnRefusal("A piece in this load no longer exists in this workspace.");
 }
 for (const glaze of recipe.glazes) await readGlaze(orgId, glaze);
}
const LiquidStock = z.object({ shape: z.literal("liquid"), unit: z.literal("ml"), revision: z.number().int().nonnegative() });
async function readGlaze(orgId: string, glaze: Firing["glazes"][number]) {
 const part = await platform().entities.lookup(orgId, glaze.kind ?? "inventory:part", glaze.part_id);
 const stock = LiquidStock.safeParse(part?.fields.stock);
 if (!part || part.retired || !stock.success) throw new KilnRefusal("Keep each glaze as liquid stock before recording its use.");
 return stock.data;
}
export async function createFiring(db: Kysely<DigifabDB>, orgId: string, value: unknown, userId: string | null = null) {
 const input = CreateSchema.parse(value);
 const profile = await db.selectFrom("digifab_kiln_profiles").selectAll().where("machine_id", "=", input.machine_id).executeTakeFirst();
 if (!profile) throw new KilnRefusal("Set up firing logs on this machine first.");
 await checkLoad(orgId, input.firing);
 const inserted = await db.insertInto("digifab_firings").values({ id: input.id, machine_id: input.machine_id, name: input.firing.name, recipe: JSON.stringify(input.firing), connection_id: profile.connection_id, device_id: profile.device_id, peak_c: null, duration_hours: null, started_at: null, ended_at: null }).onConflict(oc => oc.column("id").doNothing()).returning("id").executeTakeFirst();
 if (inserted) await platform().activity.log({ orgId, userId, action: "firing_created", ref: { module: "digifab", entityType: "firing", entityId: input.id }, diff: { name: input.firing.name, machine_id: input.machine_id } });
 const row = await db.selectFrom("digifab_firings").selectAll().where("id", "=", input.id).executeTakeFirstOrThrow();
 if (row.machine_id !== input.machine_id || JSON.stringify(FiringSchema.parse(row.recipe)) !== JSON.stringify(input.firing)) throw new KilnRefusal("This firing id already has a different load. Use a new id.");
 await platform().pairings.createMany(firingLinks(orgId, row.id, row.recipe.pieces));
 return row;
}
export async function finishFiring(db: Kysely<DigifabDB>, orgId: string, userId: string | null, id: string, value: unknown) {
 const finish = FinishSchema.parse(value);
 const row = await db.transaction().execute(async trx => {
  const firing = await trx.selectFrom("digifab_firings").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  if (!firing) throw new KilnRefusal("No such firing.");
  if (firing.ended_at) return firing;
  if (firing.duration_hours && finish.duration_hours < firing.duration_hours || firing.peak_c !== null && finish.peak_c < firing.peak_c) throw new KilnRefusal("The log cannot discard recorded firing time or peak temperature.");
  if (firing.connection_id && firing.device_id) {
   const driver = await buildDriverById(db, orgId, firing.connection_id);
   const device = (await driver?.listDevices())?.find(d => d.id === firing.device_id);
   const telemetry = TelemetrySchema.safeParse(device?.raw?.kiln);
   if (telemetry.success && telemetry.data.running) throw new KilnRefusal("Stop or complete the firing on the kiln before finishing its log.");
  }
  await checkLoad(orgId, firing.recipe);
  await platform().pairings.createMany(firingLinks(orgId, id, firing.recipe.pieces));
  for (const glaze of firing.recipe.glazes) {
   const stock = await readGlaze(orgId, glaze);
   try {
    const result = normaliseActionResult(await platform().actions.invoke("inventory:consume-stock", { orgId, userId, entity: { kind: glaze.kind ?? "inventory:part", id: glaze.part_id }, args: { fields: { revision: stock.revision, source: `kiln:${id}:glaze:${glaze.part_id}`, verdict: finish.outcome === "completed" ? "good" : "scrap", amount: glaze.ml, unit: "ml" } }, event: { name: "digifab.firing.completed", payload: { firingId: id }, actor: { user_id: userId, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" } }), "inventory.consume-stock");
    if (!result.ok) throw new KilnRefusal(typeof result.error === "string" ? result.error : "The glaze use could not be recorded. Check the liquid stock and finish this log again.");
   } catch (e) {
    if (e instanceof ActionRefusal) throw new KilnRefusal(e.message);
    throw e;
   }
  }
  return trx.updateTable("digifab_firings").set({ status: finish.outcome, duration_hours: finish.duration_hours, peak_c: finish.peak_c, ended_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
 });
 return row;
}
export async function readKiln(db: Kysely<DigifabDB>, orgId: string, machineId: string) {
 const profile = await db.selectFrom("digifab_kiln_profiles").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
 const hours = await firingHours(db, machineId);
 let telemetry: z.infer<typeof TelemetrySchema> | null = null, connection_error: string | null = null;
 if (profile?.connection_id) {
  try {
   const driver = await buildDriverById(db, orgId, profile.connection_id);
   const device = (await driver?.listDevices())?.find(d => d.id === profile.device_id);
   telemetry = TelemetrySchema.parse(device?.raw?.kiln);
  } catch { connection_error = "The kiln did not answer. Check its controller and bridge; its last log is kept."; }
 }
 return { profile: profile ?? null, firing_hours: hours, reminders: replacementReminders(hours, profile?.components ?? []), telemetry, connection_error };
}
