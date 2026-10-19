// A cell's records: its own Machines record, the cell runner on the bridge,
// its members, its job definition, who operates it and where its parts go.
// Nothing here runs the cell; run.ts starts and stops its jobs.
import "./db.js";
import { sql, type Kysely, type Selectable } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CellJob, CellMachine, CellState } from "@cobblr/platform-contract/robot-cell";
import type { DigifabDB } from "../../../db.js";
import { buildDriverById } from "../../../jobs-core.js";
import { EdgeAdapterDriver } from "../../../drivers/edge-adapter.js";
import { ArmRefusal } from "../station.js";
import { machineRef } from "../store.js";
import { EdgeCell } from "./edge-cell.js";
import { bridgeAddressOf, CellDefinitionSchema, CellSetupSchema, cellJob, definitionHash, OperatorsSchema, OutputSchema, type CellDefinition, type Member } from "./model.js";

type Cell = Selectable<DigifabDB["digifab_cells"]>;
type MemberRow = Selectable<DigifabDB["digifab_cell_members"]>;

export async function cellDriver(db: Kysely<DigifabDB>, orgId: string, connectionId: string): Promise<EdgeCell> {
  const driver = await buildDriverById(db, orgId, connectionId);
  if (!(driver instanceof EdgeAdapterDriver)) throw new ArmRefusal("A cell runs on your shop's bridge.");
  return new EdgeCell(driver);
}
export async function requireCell(db: Kysely<DigifabDB>, machineId: string): Promise<Cell> {
  const cell = await db.selectFrom("digifab_cells").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
  if (!cell) throw new ArmRefusal("Set this machine up as a cell first.");
  return cell;
}

/** The bridge a connection reaches and the instance it is served at. */
export async function bridgeAddress(orgId: string, connectionId: string): Promise<{ bridge: string; instance: string | null }> {
  const conn = await platform().devices.connections().getInternal(orgId, connectionId);
  if (!conn || conn.type !== "edge_adapter") throw new ArmRefusal("A cell's machines connect through your shop's bridge.");
  const creds = conn.credentials_enc ? await platform().integrations.decryptCredentials(orgId, conn.credentials_enc) : {};
  const edge = creds.edge as { bridge?: unknown } | undefined;
  return bridgeAddressOf(conn.base_url, typeof edge?.bridge === "string" ? edge.bridge : null);
}

/** The cell's machines as the bridge names them, from its members. */
export async function bridgeMachines(orgId: string, members: MemberRow[]): Promise<CellMachine[]> {
  return Promise.all(members.map(async (m) => {
    const { instance } = await bridgeAddress(orgId, m.connection_id);
    if (!instance) throw new ArmRefusal(`${m.role}'s connection does not name its bridge instance. Give its address with the instance, like http://bridge:8077/cnc-3.`);
    return { role: m.role, kind: m.kind, instance, device_id: m.device_id };
  }));
}

async function requireMachine(orgId: string, machineId: string, what: string) {
  const machine = await platform().entities.lookup(orgId, "machines:machine", machineId);
  if (!machine || machine.retired) throw new ArmRefusal(`Choose an existing machine for ${what}.`);
  return machine;
}

async function openJob(db: Kysely<DigifabDB>, cellId: string) {
  return db.selectFrom("digifab_cell_jobs").selectAll().where("cell_id", "=", cellId).where("status", "<>", "ended").executeTakeFirst();
}
async function refuseWhileRunning(db: Kysely<DigifabDB>, cellId: string) {
  if (await openJob(db, cellId)) throw new ArmRefusal("This cell has a job open. Stop it before changing the cell.");
}

/** Set a Machines record up as a cell: the cell runner on the bridge and the
 *  machines it works with, all on one bridge. */
export async function setupCell(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
  const setup = CellSetupSchema.parse(value);
  await requireMachine(orgId, machineId, "this cell");
  if (await db.selectFrom("digifab_cells").select("machine_id").where("machine_id", "=", machineId).executeTakeFirst()) await refuseWhileRunning(db, machineId);
  const roles = new Set<string>();
  const members: MemberRow[] = [];
  for (const m of setup.members as Member[]) {
    if (roles.has(m.role)) throw new ArmRefusal(`Two machines are both "${m.role}".`);
    roles.add(m.role);
    if (m.machine_id === machineId) throw new ArmRefusal("A cell cannot be one of its own machines.");
    if (m.kind !== "sensor") await requireMachine(orgId, m.machine_id!, m.role);
    if (m.kind === "arm") {
      const unit = await db.selectFrom("digifab_arm_units").select(["connection_id", "device_id"]).where("machine_id", "=", m.machine_id!).executeTakeFirst();
      if (!unit?.connection_id || !unit.device_id) throw new ArmRefusal(`${m.role} is not a robot arm on your bridge. Set it up as a robot arm first.`);
      members.push({ cell_id: machineId, role: m.role, kind: "arm", machine_id: m.machine_id, connection_id: unit.connection_id, device_id: unit.device_id });
    } else members.push({ cell_id: machineId, role: m.role, kind: m.kind, machine_id: m.machine_id, connection_id: m.connection_id!, device_id: m.device_id! });
  }
  if (setup.connection_id && setup.device_id) {
    const here = await bridgeAddress(orgId, setup.connection_id);
    for (const m of members) if ((await bridgeAddress(orgId, m.connection_id)).bridge !== here.bridge) throw new ArmRefusal(`${m.role} is on a different bridge from the cell. A cell runs the machines of one bridge.`);
    await bridgeMachines(orgId, members);
    try { await (await cellDriver(db, orgId, setup.connection_id)).state(); }
    catch { throw new ArmRefusal("Choose the cell on your bridge. That connection did not answer as a cell."); }
  }
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`digifab-cell-setup:${machineId}`}))`.execute(trx);
    await trx.insertInto("digifab_cells").values({ machine_id: machineId, connection_id: setup.connection_id, device_id: setup.device_id }).onConflict((oc) => oc.column("machine_id").doUpdateSet({ connection_id: setup.connection_id, device_id: setup.device_id, updated_at: new Date() })).execute();
    await trx.deleteFrom("digifab_cell_members").where("cell_id", "=", machineId).execute();
    if (members.length) await trx.insertInto("digifab_cell_members").values(members).execute();
  });
  await platform().activity.log({ orgId, userId, action: "cell_set_up", ref: machineRef(machineId), diff: { connection_id: setup.connection_id, members: members.map((m) => ({ role: m.role, kind: m.kind, machine_id: m.machine_id })) } });
  return { ok: true };
}

/** The steps a cell runs, checked against its machines: each step uses one
 *  of them for what it is, and an arm's program is one recorded on that arm. */
export async function saveDefinition(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
  const definition = CellDefinitionSchema.parse(value);
  const cell = await requireCell(db, machineId);
  await refuseWhileRunning(db, machineId);
  const members = await db.selectFrom("digifab_cell_members").selectAll().where("cell_id", "=", machineId).execute();
  if (definition.steps.length) cellJob(definition, members.map((m) => ({ role: m.role, kind: m.kind, instance: "check", device_id: m.device_id })));
  for (const step of definition.steps) {
    if (step.kind !== "arm-program") continue;
    const arm = members.find((m) => m.role === step.role)!;
    const program = await db.selectFrom("digifab_arm_programs").select("missing_since").where("machine_id", "=", arm.machine_id!).where("name", "=", step.program.name).where((eb) => step.program.revision === null ? eb("revision", "is", null) : eb("revision", "=", step.program.revision)).executeTakeFirst();
    if (!program) throw new ArmRefusal(`${step.program.name}${step.program.revision ? ` revision ${step.program.revision}` : ""} is not recorded on ${step.role}. Read its programs again or add it.`);
    if (program.missing_since) throw new ArmRefusal(`${step.role}'s controller no longer lists ${step.program.name}.`);
  }
  await db.updateTable("digifab_cells").set({ definition: JSON.stringify(definition), updated_at: new Date() }).where("machine_id", "=", machineId).execute();
  await platform().activity.log({ orgId, userId, action: "cell_job_defined", ref: machineRef(machineId), diff: { before: cell.definition, after: definition } });
  return { ok: true, definition };
}

/** Who runs the cell (beyond the owners and admins) and is told when it
 *  pauses. Empty: any operator, and the person who started the job. */
export async function setOperators(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
  const { operators } = OperatorsSchema.parse(value);
  const cell = await requireCell(db, machineId);
  for (const id of operators) if (!await platform().auth.userHasRole({ orgId, userId: id, minRole: "member" })) throw new ArmRefusal("Choose people in this workspace as the cell's operators.");
  await db.updateTable("digifab_cells").set({ operators: JSON.stringify([...new Set(operators)]), updated_at: new Date() }).where("machine_id", "=", machineId).execute();
  await platform().activity.log({ orgId, userId, action: "cell_operators_set", ref: machineRef(machineId), diff: { before: cell.operators, after: operators } });
  return { ok: true };
}

/** The stock record a cell's parts are added to, one cycle at a time. */
export async function setOutput(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
  const { output_part_id } = OutputSchema.parse(value);
  const cell = await requireCell(db, machineId);
  if (output_part_id && !(await platform().entities.lookup(orgId, "inventory:part", output_part_id))) throw new ArmRefusal("Choose a part in your inventory for the cell's output.");
  await db.updateTable("digifab_cells").set({ output_part_id, updated_at: new Date() }).where("machine_id", "=", machineId).execute();
  await platform().activity.log({ orgId, userId, action: "cell_output_set", ref: machineRef(machineId), diff: { before: cell.output_part_id, after: output_part_id } });
  return { ok: true };
}

export async function cellMembers(db: Kysely<DigifabDB>, cellId: string) {
  return db.selectFrom("digifab_cell_members").selectAll().where("cell_id", "=", cellId).orderBy("role").execute();
}

/** Everything the cell's page and station show, with its state read live. */
export async function readCell(db: Kysely<DigifabDB>, orgId: string, machineId: string, page: { limit: number; offset: number }) {
  const cell = await db.selectFrom("digifab_cells").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
  if (!cell) return { cell: null, members: [], state: null, connection_error: null, open_job: null, jobs: [], steps: [], hash: null, items: [], total: 0 };
  const members = await Promise.all((await cellMembers(db, machineId)).map(async (m) => ({ ...m, title: m.machine_id ? (await platform().entities.lookup(orgId, "machines:machine", m.machine_id))?.title ?? null : null })));
  let state: CellState | null = null, connection_error: string | null = null;
  if (cell.connection_id) {
    try { state = await (await cellDriver(db, orgId, cell.connection_id)).state(); }
    catch { connection_error = "The cell's bridge did not answer. Its state is unknown; check the cell."; }
  }
  const jobs = await db.selectFrom("digifab_cell_jobs").select(["id", "label", "status", "outcome", "paused_on", "paused_reason", "cycles", "parts", "last_cycle_ms", "detail", "started_by", "started_at", "ended_at"]).where("cell_id", "=", machineId).orderBy("started_at", "desc").limit(20).execute();
  const latest = jobs[0];
  const steps = latest ? await db.selectFrom("digifab_cell_steps").selectAll().where("job_id", "=", latest.id).orderBy("cycle", "desc").orderBy("step", "desc").limit(50).execute() : [];
  const commands = await db.selectFrom("digifab_cell_commands").selectAll().where("cell_id", "=", machineId).orderBy("created_at", "desc").orderBy("id", "desc").limit(page.limit).offset(page.offset).execute();
  const total = Number((await db.selectFrom("digifab_cell_commands").select((eb) => eb.fn.countAll().as("n")).where("cell_id", "=", machineId).executeTakeFirst())?.n ?? 0);
  const hash = await startPlan(db, orgId, cell, members).then((p) => p.hash, () => null);
  return { cell, members, state, connection_error, open_job: jobs.find((j) => j.status !== "ended") ?? null, jobs, steps, hash, items: commands, total };
}

/** The job the cell would run now and the hash a person checks at the cell
 *  before starting it: its steps over its machines and each arm's tooling. */
export async function startPlan(db: Kysely<DigifabDB>, orgId: string, cell: Cell, members: MemberRow[]): Promise<{ job: CellJob; hash: string }> {
  const job = cellJob(CellDefinitionSchema.parse(cell.definition), await bridgeMachines(orgId, members));
  const tooling: Record<string, string> = {};
  for (const m of members) if (m.kind === "arm") tooling[m.role] = (await db.selectFrom("digifab_arm_units").select("tooling").where("machine_id", "=", m.machine_id!).executeTakeFirst())?.tooling ?? "";
  return { job, hash: definitionHash(job, tooling) };
}

export type { CellDefinition };
