import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionRefusal, platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { parseReflowProfile, analyzeReflow, analyzeManualReflow, controleoProfile, type ReflowProfile, type ReflowSample } from "@cobblr/platform-contract/reflow-profile";
import type { Kysely } from "kysely";
import { assemblyOrder, assemblyOrderView } from "./assembly-orders.js";
import { invoke, operator } from "./placement.js";
import { tenantContext, sessionUser, type BuildsDB } from "../db.js";
import { asyncHandler } from "./util.js";
export interface PasteReflowProfile { id: string; paste_kind: string; paste_id: string; fingerprint: string; profile: ReflowProfile }
export interface AssemblyReflow {
  run_id: string; profile_id: string; profile_hash: string; profile: ReflowProfile;
  machine_kind: string; machine_id: string; model: "manual" | "controleo3" | "t962-ue" | "yarc"; connection_id: string | null;
  slot?: number; controller_name?: string; state: "prepared" | "controller-prepared" | "starting" | "running" | "uncertain" | "interrupted" | "completed";
  station_id?: string; operator_id?: string | null; started_at?: string; finished_at?: string;
  samples?: ReflowSample[]; report?: ReturnType<typeof analyzeReflow> | ReturnType<typeof analyzeManualReflow>;
  source?: "controller" | "manual" | "manual-recovery"; notes?: string; completion_signature?: string;
}
const Order = z.object({ order_id: z.string().uuid() });
const Station = Order.extend({ station_token: z.string().min(32).max(128) });
const Prepare = Order.extend({ profile_id: z.string().uuid(), machine_kind: z.string().min(3).max(120), machine_id: z.string().uuid(), model: z.enum(["manual", "controleo3", "t962-ue", "yarc"]), connection_id: z.string().uuid().nullable().default(null), slot: z.number().int().min(0).max(127).optional(), controller_name: z.string().trim().min(1).max(80).optional(), confirmed_profile_matches: z.literal(true) });
const Step = Station.extend({ confirmed_all_boards: z.literal(true) });
const Finish = Step.extend({ source: z.enum(["controller", "manual", "manual-recovery"]), peak_c: z.number().min(0).max(400).optional(), duration_s: z.number().positive().max(14400).optional(), above_liquidus_s: z.number().min(0).max(14400).optional(), notes: z.string().trim().max(2000).default("") });
const Telemetry = z.object({ run_id: z.string().uuid(), profile_hash: z.string(), state: z.enum(["running", "completed", "interrupted", "uncertain"]), controller_started: z.boolean(), samples: z.array(z.object({ seconds: z.number().finite().min(0).max(14400), celsius: z.number().finite().min(-20).max(400) })).max(50000) });
async function dbFor(orgId: string) { return await platform().tenants.getDb(orgId) as Kysely<BuildsDB>; }
async function command(orgId: string, run: AssemblyReflow, name: string, args: Record<string, unknown>) {
  if (!run.connection_id) throw new ActionRefusal("Choose this oven's bridge connection.");
  const driver = await platform().devices.getDriver(orgId, run.connection_id);
  if (!driver?.runCommand) throw new ActionRefusal("This connection has no reflow bridge driver.");
  const result = await driver.runCommand(name, args);
  if (!result.ok) throw new ActionRefusal(result.detail || "The oven did not confirm this step.");
  return result.data;
}
async function station(ctx: ActionInvokeContext, run: AssemblyReflow, token: string) {
  await operator(ctx);
  return platform().devices.authorizeAtStation(ctx.orgId, { ...run, purpose: "reflow", token });
}
async function observed(orgId: string, run: AssemblyReflow) {
  const data = Telemetry.parse(await command(orgId, run, "reflow.status", { run_id: run.run_id }));
  if (data.run_id !== run.run_id || data.profile_hash !== run.profile_hash) throw new ActionRefusal("The bridge temperature curve belongs to another run or profile.");
  const previous = run.samples ?? [];
  if (data.samples.length < previous.length || previous.some((sample, i) => sample.seconds !== data.samples[i]?.seconds || sample.celsius !== data.samples[i]?.celsius)) throw new ActionRefusal("The bridge has changed previously recorded samples. Keep the run for review.");
  return data;
}
export async function reflowResources(ctx: ActionInvokeContext, id: string) {
  const row = await assemblyOrder(await dbFor(ctx.orgId), id);
  const profiles = row.assembly.paste ? await invoke<{ items: PasteReflowProfile[] }>(ctx, "digifab:reflow-profiles", { paste_kind: row.assembly.paste.kind, paste_id: row.assembly.paste.part_id }) : { items: [] };
  return { machines: (await platform().devices.machineRecords(ctx.orgId, ctx.userId)).map(({ kind, record }) => ({ kind, id: record.id, name: record.title })), connections: (await platform().devices.connections().list(ctx.orgId)).map(c => ({ id: c.id, label: c.label })), profiles: profiles.items, controleo_txt: row.assembly.reflow ? controleoProfile(row.assembly.reflow.profile) : null };
}
export type ReflowResources = Awaited<ReturnType<typeof reflowResources>>;
export function registerReflowActions() {
  platform().actions.registerHandler("builds.reflow-resources", async ctx => ({ ok: true, data: await reflowResources(ctx, Order.parse(ctx.args).order_id) }));
  platform().actions.registerHandler("builds.prepare-reflow", async ctx => {
    await operator(ctx); const p = Prepare.parse(ctx.args), db = await dbFor(ctx.orgId);
    const machine = await platform().devices.machineRecord(ctx.orgId, p.machine_kind, p.machine_id, ctx.userId);
    if (!machine) throw new ActionRefusal("Choose an available native oven machine.");
    if (["t962-ue", "yarc"].includes(p.model) && !p.connection_id) throw new ActionRefusal("Choose the bridge connection for this open controller.");
    if (p.model === "t962-ue" && (p.slot === undefined || !p.controller_name)) throw new ActionRefusal("Record the verified firmware profile slot and its exact name.");
    if (p.connection_id && !await platform().devices.connections().get(ctx.orgId, p.connection_id)) throw new ActionRefusal("Choose this workspace's oven connection.");
    const profile = await invoke<PasteReflowProfile>(ctx, "digifab:reflow-profile", { profile_id: p.profile_id });
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      const a = row?.assembly;
      if (!row || !a || a.state !== "placed" || !a.paste) throw new ActionRefusal("Complete placement before preparing reflow.");
      if (profile.paste_id !== a.paste.part_id || profile.paste_kind !== a.paste.kind) throw new ActionRefusal("Choose a profile for the paste lot used on these boards.");
      if (a.reflow && !["prepared", "interrupted"].includes(a.reflow.state)) throw new ActionRefusal("This oven run already has a physical start. Finish or stop it before changing its profile.");
      const reflow: AssemblyReflow = { run_id: randomUUID(), profile_id: profile.id, profile_hash: profile.fingerprint, profile: parseReflowProfile(profile.profile), machine_kind: p.machine_kind, machine_id: p.machine_id, model: p.model, connection_id: p.connection_id, slot: p.slot, controller_name: p.controller_name, state: "prepared" };
      await trx.updateTable("builds_planned").set({ assembly: { ...a, reflow, reflow_history: a.reflow ? [...(a.reflow_history ?? []), a.reflow] : a.reflow_history }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    const savedMachine = await platform().entities.mergeMetadata(ctx.orgId, p.machine_kind, p.machine_id, { assembly_reflow: { model: p.model, connection_id: p.connection_id } });
    if (!savedMachine) throw new ActionRefusal("The oven could not save its controller settings. Reload the work order before starting.");
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
  platform().actions.registerHandler("builds.send-reflow-profile", async ctx => {
    const p = Station.parse(ctx.args), db = await dbFor(ctx.orgId);
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      const a = row?.assembly, run = a?.reflow;
      if (!row || !a || !run || a.state !== "placed" || !["prepared", "controller-prepared"].includes(run.state)) throw new ActionRefusal("Prepare this oven run before sending its profile.");
      const grant = await station(ctx, run, p.station_token);
      if (["t962-ue", "yarc"].includes(run.model)) {
        const result = await command(ctx.orgId, run, "reflow.prepare", { profile: run.profile, slot: run.slot, controller_name: run.controller_name });
        if (result?.profile_hash !== run.profile_hash) throw new ActionRefusal("The bridge did not confirm this exact paste profile.");
      }
      await trx.updateTable("builds_planned").set({ assembly: { ...a, reflow: { ...run, state: "controller-prepared", station_id: grant.id } }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
  platform().actions.registerHandler("builds.start-reflow", async ctx => {
    const p = Step.parse(ctx.args), db = await dbFor(ctx.orgId);
    const run = await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      const a = row?.assembly, run = a?.reflow;
      if (!row || !a || !run || a.state !== "placed" || run.state !== "controller-prepared") throw new ActionRefusal("Send or confirm the selected profile at this station before Start. A started run cannot start again.");
      const grant = await station(ctx, run, p.station_token);
      if (grant.id !== run.station_id) throw new ActionRefusal("Prepare and Start at the same authorized oven screen.");
      const next: AssemblyReflow = { ...run, state: "starting", operator_id: ctx.userId, started_at: new Date().toISOString() };
      await trx.updateTable("builds_planned").set({ assembly: { ...a, reflow: next }, updated_at: new Date() }).where("id", "=", row.id).execute();
      return next;
    });
    let error: unknown;
    try { if (run.model === "t962-ue" || run.model === "yarc") await command(ctx.orgId, run, run.model === "yarc" ? "reflow.monitor" : "reflow.start", { run_id: run.run_id, profile_hash: run.profile_hash }); }
    catch (e) { error = e; }
    await db.transaction().execute(async trx => { const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirstOrThrow(); if (row.assembly?.reflow?.run_id === run.run_id && row.assembly.reflow.state === "starting") await trx.updateTable("builds_planned").set({ assembly: { ...row.assembly, reflow: { ...row.assembly.reflow, state: error ? "uncertain" : "running" } }, updated_at: new Date() }).where("id", "=", row.id).execute(); });
    if (error) throw new ActionRefusal("Start was recorded without controller confirmation. Check the oven; do not resend Start. Record a manual recovery or Stop at its station.");
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
  platform().actions.registerHandler("builds.sample-reflow", async ctx => {
    const p = Station.parse(ctx.args), db = await dbFor(ctx.orgId);
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirstOrThrow(); const a = row.assembly, run = a?.reflow;
      if (!a || !run || !["running", "uncertain"].includes(run.state) || !["t962-ue", "yarc"].includes(run.model)) throw new ActionRefusal("Choose a running open-controller oven job.");
      await station(ctx, run, p.station_token); const data = await observed(ctx.orgId, run);
      await trx.updateTable("builds_planned").set({ assembly: { ...a, reflow: { ...run, samples: data.samples, state: data.state === "uncertain" || data.state === "interrupted" ? data.state : run.state } }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
  platform().actions.registerHandler("builds.finish-reflow", async ctx => {
    const p = Finish.parse(ctx.args), db = await dbFor(ctx.orgId);
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirstOrThrow(); const a = row.assembly, run = a?.reflow;
      if (!a || !run) throw new ActionRefusal("Choose this board batch's reflow run.");
      await station(ctx, run, p.station_token);
      const signature = JSON.stringify({ source: p.source, peak_c: p.peak_c, duration_s: p.duration_s, above_liquidus_s: p.above_liquidus_s, notes: p.notes });
      if (run.state === "completed") { if (signature !== run.completion_signature) throw new ActionRefusal("A completed reflow log cannot change. Keep corrections in its rework notes."); return; }
      if (!["running", "uncertain"].includes(run.state)) throw new ActionRefusal("Start this oven run before recording its completion.");
      let report: AssemblyReflow["report"], samples = run.samples;
      if (p.source === "controller") {
        const data = await observed(ctx.orgId, run);
        if (!data.controller_started || data.state === "uncertain" || data.state === "interrupted" || run.model === "t962-ue" && data.state !== "completed") throw new ActionRefusal("The controller has not confirmed a completed run. Keep the log for review or record a manual recovery.");
        try { report = analyzeReflow(run.profile, data.samples); } catch (e) { throw new ActionRefusal((e as Error).message); } samples = data.samples;
      } else {
        if (["t962-ue", "yarc"].includes(run.model) && (p.source !== "manual-recovery" || p.notes.length < 10)) throw new ActionRefusal("Explain the controller problem when recording a manual recovery.");
        if (p.peak_c === undefined || p.duration_s === undefined || p.above_liquidus_s === undefined) throw new ActionRefusal("Record peak, total duration and time above liquidus from the oven or thermometer.");
        try { report = analyzeManualReflow(run.profile, { peak_c: p.peak_c, duration_s: p.duration_s, above_liquidus_s: p.above_liquidus_s }); } catch (e) { throw new ActionRefusal((e as Error).message); }
        if (p.source === "manual-recovery") report = { ...report, in_spec: false, problems: [...report.problems, "Controller recording failed; this manual recovery needs inspection review."] };
      }
      await trx.updateTable("builds_planned").set({ assembly: { ...a, state: "reflowed", reflow: { ...run, state: "completed", source: p.source, report, samples, notes: p.notes, finished_at: new Date().toISOString(), completion_signature: signature } }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
  platform().actions.registerHandler("builds.stop-reflow", async ctx => {
    const p = Step.parse(ctx.args), db = await dbFor(ctx.orgId);
    const row = await assemblyOrder(db, p.order_id), run = row.assembly.reflow;
    if (!run || !["starting", "running", "uncertain"].includes(run.state)) throw new ActionRefusal("Choose an active oven run to stop.");
    await station(ctx, run, p.station_token);
    if (run.model === "t962-ue" || run.model === "yarc") await command(ctx.orgId, run, "reflow.stop", { run_id: run.run_id });
    await db.transaction().execute(async trx => { const current = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirstOrThrow(); if (current.assembly?.reflow?.run_id !== run.run_id || current.assembly.reflow.state === "completed") throw new ActionRefusal("The oven run changed. Reload its station."); await trx.updateTable("builds_planned").set({ assembly: { ...current.assembly, reflow: { ...current.assembly.reflow, state: "interrupted", notes: "Operator stopped this run." } }, updated_at: new Date() }).where("id", "=", current.id).execute(); });
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
}
export const reflowRouter = Router({ mergeParams: true });
reflowRouter.get("/assembly-orders/:id/reflow-resources", asyncHandler(async (req, res) => { res.json(await reflowResources({ orgId: tenantContext(req).org.id, userId: sessionUser(req)?.id ?? null, event: { name: null, payload: {}, actor: { user_id: sessionUser(req)?.id ?? null, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" } }, String(req.params.id))); }));
