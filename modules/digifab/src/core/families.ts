// The family seam (docs/modules/digifab-families.md). Digital Fabrication is
// a shared core (drivers, jobs and runs, stations and approvals, makes, the
// library, the floor) and families of machines on it: robot arms first, then
// lasers, printers, CNC and the rest as they move out of the flat folder. A
// family lives in src/families/<family>/ and declares itself to the core here:
// its module part, the station kinds its machines report, its routes, and the
// handlers and boot work it registers. The core never imports a family
// (lint:core-imports-no-family); a family imports only the core
// (lint:family-imports-only-core). src/families/index.ts and manifests.ts
// are the one place the module gathers them.
import type { Router } from "express";
import type { ModuleActionInput, ModulePanelInput, ModulePartInput } from "@cobblr/platform-contract";
import type { Kysely, Selectable } from "kysely";
import type { DigifabDB } from "../db.js";
import type { CompletedMaterialJob, FamilyPrinting, LoadedSpool, MaterialPlan, PrinterMaterial } from "./printing.js";
import { ReviewRequired } from "../drivers/job-review.js";
import type { DriverManifest } from "../drivers/manifest.js";
import type { CommandResult, DeviceTemps, JobApproval, JobReview, MachineDriver, ManagerConfig, RemoteDevice } from "../drivers/types.js";

/** A family's own Stop, Pause, Resume and Frame, for the machines whose driver it drives. */
export interface FamilyControl {
  /** What the person calls the machine in "Stopped the laser." */
  noun: string;
  operations: readonly string[];
  /** Whether the core's Stop may stop the machine with no job named (a laser mid-cut); otherwise Stop goes through its job. */
  stopsWithoutJob: boolean;
  /** Its machines take no control but its own: the fleet card's other controls are refused rather than sent through the driver (a resin printer). */
  exclusive?: boolean;
  drives(driver: MachineDriver): boolean | Promise<boolean>;
  run(db: Kysely<DigifabDB>, orgId: string, driver: MachineDriver, deviceId: string, operation: string, params: Record<string, unknown>, connectionId: string): Promise<CommandResult>;
}

/** What one of a family's machines is doing now, for utilisation: the
 *  family reads its own machines, the core counts the time. */
export interface MachineStateSample { machine_id: string; state: "run" | "idle" | "fault" | "unknown"; detail: string }

/** A reviewed Start of the family's machines, known by the station review's
 *  `project.kind`. The core authorizes the station, then asks the family to
 *  claim what the Start uses; before the machine is told and after it answers
 *  it asks again, so a change in between withdraws the Start (#7065); a Start
 *  that never reached the machine gives back what it claimed. */
export interface FamilyStart {
  reviewKinds: readonly string[];
  authorize(args: FamilyStartArgs): Promise<void>;
  recheck(args: FamilyStartArgs): Promise<void>;
  release(db: Kysely<DigifabDB>, jobId: string): Promise<void>;
}

export interface FamilyStartArgs {
  db: Kysely<DigifabDB>;
  orgId: string;
  job: Pick<Selectable<DigifabDB["digifab_jobs"]>, "id" | "file_id" | "connection_id" | "target_device">;
  approval: JobApproval;
  review: JobReview;
  /** The authorized station the Start was approved at. */
  stationId: string;
}

/** A print process a family runs, known by the driver's `printProcess` (a
 *  resin printer): the stock a print uses, from its review to its outcome.
 *  The core keeps the Start's order and asks the family at each step. */
export interface FamilyProcess {
  printProcess: string;
  /** At review: plan what the print uses from the stock loaded on the machine; throws to refuse the review. */
  prepare(args: { db: Kysely<DigifabDB>; orgId: string; jobId: string; connectionId: string; deviceId: string; reviewFileId: string; filename: string; bytes: Uint8Array; raw: Record<string, unknown> | null | undefined }): Promise<void>;
  /** Before the machine is told: reserve the reviewed plan; throws when it no longer holds. */
  reserve(db: Kysely<DigifabDB>, orgId: string, jobId: string, reviewFileId: string): Promise<void>;
  /** Before the machine is told and after it answers: throws when the reserved plan no longer holds. */
  check(db: Kysely<DigifabDB>, orgId: string, jobId: string): Promise<void>;
  /** The machine took the Start. */
  started(db: Kysely<DigifabDB>, jobId: string): Promise<void>;
  /** The Start never reached the machine: give back what was reserved. */
  release(db: Kysely<DigifabDB>, jobId: string): Promise<void>;
  /** A job's outcome: take what the print used from stock. `at` is the machine
   *  when a person answered at it, for the counters it reports. */
  settle(db: Kysely<DigifabDB>, orgId: string, jobId: string, verdict: "good" | "scrap", userId: string | null, at?: { connectionId: string; deviceId: string }): Promise<void>;
  /** What the machine's station screen carries for this process. */
  stationScreen(args: { db: Kysely<DigifabDB>; orgId: string; connectionId: string; deviceId: string; job: { id: string; status: string; send_token: string | null; remote_job_id: string | null } | null; metadata: Record<string, unknown> | null | undefined; attentionJobId: string | null }): Promise<Record<string, unknown>>;
}

/** A machine's live reading a family keeps fresher than its driver's device
 *  list (a Bambu account's cloud stream); the fleet card prefers it. */
export interface FleetLive {
  state: string | null;
  stage: string | null;
  temps: DeviceTemps;
  progress: number | null;
  remaining_min: number | null;
  layer_num: number | null;
  total_layers: number | null;
}

/** A device's LAN access, what the printer modal shows of it and the routes that set it. */
export interface FamilyDeviceLan {
  /** Host and mode, never the secret. */
  read(orgId: string, connectionId: string, deviceId: string): Promise<{ applicable: boolean; configured: boolean; host?: string; mode: string; camera: boolean }>;
  write(orgId: string, connectionId: string, deviceId: string, body: unknown): Promise<{ status: number; body: unknown }>;
  remove(orgId: string, connectionId: string, deviceId: string): Promise<{ status: number; body: unknown }>;
}

/** What a family declares in Digital Fabrication's manifest (families/manifests.ts). */
export interface FamilyManifest { part: ModulePartInput; panels: ModulePanelInput[]; actions: ModuleActionInput[]; notifications?: { eventType: string; label: string; description: string }[] }

export interface DigifabFamily {
  /** The module part this family is (manifest `parts`): off in a workspace,
   *  the kernel hides its actions, panels, tools and routes there. */
  part: string;
  /** The station kinds its machines report (`station_kind` on a device). */
  stationKinds: readonly string[];
  /** Its routes, each mounted at its path under the module's API. */
  routes: ReadonlyArray<{ path: string; router: Router }>;
  /** Action handlers, resolvers and panel presence, once when the api loads. */
  register(): void;
  /** Sweeps and heal passes, once at boot. */
  onBoot?(): Promise<void> | void;
  /** Its machines' states now, when it reads them itself (an arm's safety is
   *  not in a device list). Its machines are left out of the core's sampling. */
  machineStates?(db: Kysely<DigifabDB>, orgId: string): Promise<MachineStateSample[]>;
  /** Its machines start at a station though they report no station kind: a
   *  kiln is known by the telemetry its device reports. */
  startsAtStation?(raw: Record<string, unknown> | null | undefined): boolean;
  /** The operations it answers on digifab:station-run, `<prefix>_<op>`. */
  stationRun?: {
    prefix: string;
    run(db: Kysely<DigifabDB>, orgId: string, userId: string, operation: string, id: string, fields: unknown): Promise<unknown>;
  };
  /** Before the outcome of a job it runs is recorded: throws until the
   *  family's own record of the job is complete. */
  checkJobOutcome?(db: Kysely<DigifabDB>, jobId: string, outcome: string): Promise<void>;
  /** Its machines' own controls; the core's Stop, the fleet card and the CNC panel ask it first. */
  control?: FamilyControl;
  /** Controls only the core's Stop asks, for machines whose fleet card and panel keep their own path (a cutter). */
  stopControl?: FamilyControl;
  /** What the fleet card shows for a device beside the core's fields. */
  fleetFields?(device: RemoteDevice): Record<string, unknown>;
  /** The driver of an installed manifest that carries its section. */
  manifestDriver?: { section: FamilyManifestSection; build(manifest: DriverManifest, cfg: ManagerConfig): MachineDriver };
  /** Its reviewed Start, for the review kinds it names. */
  start?: FamilyStart;
  /** Each poll of a sent job, with the machine's raw report: what the family keeps of a job it runs. */
  recordPoll?(db: Kysely<DigifabDB>, job: Selectable<DigifabDB["digifab_jobs"]>, raw: unknown): Promise<void>;
  /** What its station screen carries beside the core's job and library. */
  stationScreen?(orgId: string, query: { q?: string }): Promise<Record<string, unknown>>;
  /** The machines something outside Cobblr runs for it ("<connectionId>:<deviceId>"): an external failure detector that owns a printer's camera and watch. Cobblr assigns them no work and pulls no camera for them. */
  managedDevices?(db: Kysely<DigifabDB>): Promise<ReadonlySet<string>>;
  /** A sent job the poll reads as printing on this machine. Best effort: the poll goes on whatever it throws. */
  onPrinting?(db: Kysely<DigifabDB>, orgId: string, connectionId: string, deviceId: string): Promise<void>;
  /** The driver of a connection of the type it owns (a Bambu Lab account). */
  connectionDriver?: { type: string; build(cfg: ManagerConfig, connectionId: string): MachineDriver };
  /** A connection's fresh live readings, by device, or null when it keeps none for it. */
  fleetLive?(db: Kysely<DigifabDB>, connection: { id: string; type: string }): Promise<ReadonlyMap<string, FleetLive> | null>;
  /** A device's own live telemetry for its detail view, or null to leave it to the core. */
  deviceTelemetry?(db: Kysely<DigifabDB>, connectionId: string, deviceId: string): Promise<{ updated_at: string; telemetry: Record<string, unknown> } | null>;
  /** A machine's driver to prefer over its connection's (a Bambu printer's LAN, for files, control and the camera), or null. */
  preferredDriver?(orgId: string, connectionId: string, deviceId: string): Promise<MachineDriver | null>;
  /** The devices on a connection whose camera is reachable over its LAN. */
  lanCameras?(orgId: string, connection: { id: string; type: string }): Promise<ReadonlySet<string>>;
  /** A device's LAN access stored with its connection (a Bambu printer's host and access code). */
  deviceLan?: FamilyDeviceLan;
  /** Its printers in the farm, their material and a Make's prints (core/printing.ts). */
  printing?: FamilyPrinting;
  /** The print processes it runs (`printProcess` on a driver). */
  process?: FamilyProcess;
  /** Records a finished job's outcome when the job is one of its kind; null leaves it to the core's good/scrap verdict. */
  outcome?(args: FamilyOutcomeArgs): Promise<{ status: number; body: unknown } | null>;
}

export interface FamilyOutcomeArgs {
  db: Kysely<DigifabDB>;
  orgId: string;
  connectionId: string;
  deviceId: string;
  /** The job the machine's bed-clear row names, if any. */
  attentionJobId: string | null;
  body: unknown;
  userId: string | null;
}

const families: DigifabFamily[] = [];

export function registerFamilies(list: readonly DigifabFamily[], opts: { handlers?: boolean } = {}): void {
  for (const f of list) if (!families.some((x) => x.part === f.part)) { families.push(f); if (opts.handlers !== false) f.register(); }
}

/** The family whose machines report this station kind, if any. */
export function familyOfStationKind(kind: string | null | undefined): DigifabFamily | null {
  return (kind && families.find((f) => f.stationKinds.includes(kind))) || null;
}

/** The family whose controls drive this machine, if any; families are asked in the order the api lists them. */
export async function familyControlling(driver: MachineDriver | null | undefined): Promise<FamilyControl | null> {
  if (!driver) return null;
  for (const f of families) if (f.control && (await f.control.drives(driver))) return f.control;
  return null;
}

/** The family control the core's Stop uses for this machine: its own control, else a stop-only one. */
export async function familyStopping(driver: MachineDriver | null | undefined): Promise<FamilyControl | null> {
  const own = await familyControlling(driver);
  if (own || !driver) return own;
  for (const f of families) if (f.stopControl && (await f.stopControl.drives(driver))) return f.stopControl;
  return null;
}

/** The family control a control of this machine goes to: one that answers the
 *  operation, or one whose machines take no control but its own (`exclusive`),
 *  which refuses the rest; null leaves it to the machine's own driver. */
export async function familyControlFor(driver: MachineDriver | null | undefined, operation: string): Promise<FamilyControl | null> {
  const own = await familyControlling(driver);
  return own && (own.exclusive || own.operations.includes(operation)) ? own : null;
}

/** The first family that records this outcome, or null for the core's own verdict. */
export async function familyOutcome(args: FamilyOutcomeArgs): Promise<{ status: number; body: unknown } | null> {
  for (const f of families) {
    const handled = await f.outcome?.(args);
    if (handled) return handled;
  }
  return null;
}

/** Every family's fleet fields for one device. */
export function familyFleetFields(device: RemoteDevice): Record<string, unknown> {
  return Object.assign({}, ...families.map((f) => f.fleetFields?.(device) ?? {}));
}

export function familyStationKinds(): ReadonlySet<string> {
  return new Set(families.flatMap((f) => f.stationKinds));
}

/** Every family's own machine states, and which machines those cover. */
export async function familyMachineStates(db: Kysely<DigifabDB>, orgId: string): Promise<MachineStateSample[]> {
  const out: MachineStateSample[] = [];
  for (const f of families) if (f.machineStates) out.push(...await f.machineStates(db, orgId).catch(() => []));
  return out;
}

/** The family whose machines start at a station by what this device reports. */
export function familyStartingAtStation(raw: Record<string, unknown> | null | undefined): DigifabFamily | null {
  return families.find((f) => f.startsAtStation?.(raw)) ?? null;
}

/** The family that answers this station-run operation, and the operation's
 *  own name within it. */
export function familyStationRun(operation: string): { family: DigifabFamily; operation: string } | null {
  for (const f of families) {
    const p = f.stationRun?.prefix;
    if (p && operation.startsWith(`${p}_`)) return { family: f, operation: operation.slice(p.length + 1) };
  }
  return null;
}

/** The check of the family that runs this job, before its outcome is
 *  recorded. Fails closed: a job a family runs is never judged without it. */
export async function checkFamilyJobOutcome(part: string, db: Kysely<DigifabDB>, jobId: string, outcome: string): Promise<void> {
  const family = families.find((f) => f.part === part);
  if (!family?.checkJobOutcome) throw new ReviewRequired("Record this job's outcome at its machine's station.");
  await family.checkJobOutcome(db, jobId, outcome);
}

/** The manifest sections only a family drives. */
export type FamilyManifestSection = "laser";

/** The driver of the family that drives this manifest section. Fails closed:
 *  a laser manifest is never driven as a generic machine without its family. */
export function requireFamilyDriver(section: FamilyManifestSection, manifest: DriverManifest, cfg: ManagerConfig): MachineDriver {
  const family = families.find((f) => f.manifestDriver?.section === section);
  if (!family?.manifestDriver) throw new Error(`This workspace cannot drive this ${section} driver: its machine family is not available.`);
  return family.manifestDriver.build(manifest, cfg);
}

/** The family whose reviewed Start this review kind is, if any. */
export function familyOfReviewKind(kind: unknown): DigifabFamily | null {
  return (typeof kind === "string" && families.find((f) => f.start?.reviewKinds.includes(kind))) || null;
}

/** The Start of the family this review kind belongs to. Fails closed: a
 *  reviewed Start whose family is missing is refused, never run unclaimed. */
export function requireFamilyStart(kind: string): FamilyStart {
  const start = familyOfReviewKind(kind)?.start;
  if (!start) throw new ReviewRequired(`This workspace cannot start this ${kind} job: its machine family is not available.`);
  return start;
}

/** Every family's record of one poll of a sent job. */
export async function familyRecordPoll(db: Kysely<DigifabDB>, job: Selectable<DigifabDB["digifab_jobs"]>, raw: unknown): Promise<void> {
  for (const f of families) await f.recordPoll?.(db, job, raw);
}

/** Every machine a family says something outside Cobblr runs ("<connectionId>:<deviceId>"). */
export async function familyManagedDevices(db: Kysely<DigifabDB>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const f of families) for (const ref of (await f.managedDevices?.(db)) ?? []) out.add(ref);
  return out;
}

/** Tells every family a sent job is printing on this machine. */
export async function familyOnPrinting(db: Kysely<DigifabDB>, orgId: string, connectionId: string, deviceId: string): Promise<void> {
  for (const f of families) await f.onPrinting?.(db, orgId, connectionId, deviceId);
}

/** The family running this print process. Fails closed: a print whose
 *  process's family is missing is neither started nor judged without it. */
export function requireFamilyProcess(printProcess: string): FamilyProcess {
  const process = families.find((f) => f.process?.printProcess === printProcess)?.process;
  if (!process) throw new ReviewRequired(`This workspace cannot run this ${printProcess} print: its machine family is not available.`);
  return process;
}

/** The driver of a connection type a family owns. Fails closed: a connection
 *  whose family is missing is not driven, never driven as something else. */
export function requireFamilyConnectionDriver(type: string, cfg: ManagerConfig, connectionId: string): MachineDriver {
  const family = families.find((f) => f.connectionDriver?.type === type);
  if (!family?.connectionDriver) throw new Error(`This workspace cannot drive this ${type} connection: its machine family is not available.`);
  return family.connectionDriver.build(cfg, connectionId);
}

/** A connection's live readings from the first family that keeps them. */
export async function familyFleetLive(db: Kysely<DigifabDB>, connection: { id: string; type: string }): Promise<ReadonlyMap<string, FleetLive> | null> {
  for (const f of families) {
    const live = await f.fleetLive?.(db, connection);
    if (live) return live;
  }
  return null;
}

/** A device's live telemetry from the first family that has it. */
export async function familyDeviceTelemetry(db: Kysely<DigifabDB>, connectionId: string, deviceId: string): Promise<{ updated_at: string; telemetry: Record<string, unknown> } | null> {
  for (const f of families) {
    const t = await f.deviceTelemetry?.(db, connectionId, deviceId);
    if (t) return t;
  }
  return null;
}

/** The driver a family prefers for this machine (its LAN), else null for the connection's own. */
export async function familyPreferredDriver(orgId: string, connectionId: string, deviceId: string): Promise<MachineDriver | null> {
  for (const f of families) {
    const d = await f.preferredDriver?.(orgId, connectionId, deviceId);
    if (d) return d;
  }
  return null;
}

/** The devices on a connection whose camera a family reaches over its LAN. */
export async function familyLanCameras(orgId: string, connection: { id: string; type: string }): Promise<Set<string>> {
  const out = new Set<string>();
  for (const f of families) for (const id of (await f.lanCameras?.(orgId, connection)) ?? []) out.add(id);
  return out;
}

/** The family that stores devices' LAN access, if one is registered. */
export function familyDeviceLan(): FamilyDeviceLan | null {
  return families.find((f) => f.deviceLan)?.deviceLan ?? null;
}

/** The family that runs printers. Fails closed: the farm gives no printer a
 *  job, and no print's material is judged, without it. */
export function requireFamilyPrinting(): FamilyPrinting {
  const printing = families.find((f) => f.printing)?.printing;
  if (!printing) throw new ReviewRequired("This workspace cannot run prints: its printers family is not available.");
  return printing;
}

/** The family that runs printers, or null where a print is only one possibility. */
export function familyPrinting(): FamilyPrinting | null {
  return families.find((f) => f.printing)?.printing ?? null;
}

/** Whether a job asks for material at all: a material, a chosen spool, grams, or a filament per tool. */
function asksForMaterial(job: PrinterMaterial): boolean {
  return !!(job.material_type?.trim() || job.material_part_id || Number(job.material_grams) > 0 || job.material_grams_by_tool || job.material_by_tool?.some(Boolean) || job.color_by_tool?.some(Boolean));
}

/** Why this loaded material refuses this job, or null. With no printers family
 *  a job that asks for material is refused, and any other job is not. */
export function familyMaterialRefusal(job: PrinterMaterial, loaded: LoadedSpool[]): string | null {
  const printing = familyPrinting();
  if (printing) return printing.materialRefusal(job, loaded);
  return asksForMaterial(job) ? "This workspace cannot run prints: its printers family is not available." : null;
}

/** What a finished job takes from which spool. With no printers family a job
 *  that asked for material is not judged; any other job takes nothing. */
export async function planJobMaterial(db: Kysely<DigifabDB>, orgId: string, job: CompletedMaterialJob): Promise<MaterialPlan> {
  const printing = familyPrinting();
  if (printing) return printing.planCompleted(db, orgId, job);
  if (asksForMaterial(job)) throw new ReviewRequired("This workspace cannot run prints: its printers family is not available.");
  return { draws: [], unfed: [] };
}
