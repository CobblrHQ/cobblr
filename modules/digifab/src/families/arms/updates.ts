// Guided software updates for robot arms (core spec #6883 §2). Cobblr does
// not install software on a controller: it keeps the right file in Files with
// its checksum, shows the vendor's own steps for a person to follow at the
// arm and tick, then reads the controller's versions back and says whether
// the update took. Each vendor's remote route and rollback are recorded here
// as the vendor documents them. Campaigns (many arms in rings) are not built:
// no vendor here documents a remote install and recovery Cobblr could drive.
import "./db.js";
import { createHash } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { ArmInfo } from "@cobblr/platform-contract/robot-arm";
import type { DigifabDB } from "../../db.js";
import { ArmRefusal } from "./station.js";
import { machineRef, refreshArm, requireUnit } from "./store.js";

export interface UpdateStep { step: string; done_by: string | null; done_at: string | null }
export interface VendorGuide { vendor: string; label: string; steps: string[]; remote: string; rollback: string }

/** What each vendor documents for an update, in its own terms. */
export const VENDOR_GUIDES: Record<string, VendorGuide> = {
  ur: {
    vendor: "ur", label: "Universal Robots",
    steps: [
      "Take a backup of the robot first (Settings, System, Backup), and check a Cobblr backup of its programs is restore tested",
      "Copy the update file onto a USB drive and plug it into the teach pendant",
      "On the pendant: Settings, System, Update, then search and choose the file",
      "Follow the pendant until the robot restarts, then check the robot's installation and safety checksum at the pendant",
      "Run each program once at reduced speed, watched, before it goes back into production",
    ],
    remote: "UR Connect (part of UR Care service plans, through myUR, for PolyScope 5.17 or later) can deploy updates remotely and keeps backups and revisions; use it where the arm has a plan. Cobblr does not install updates itself.",
    rollback: "Universal Robots does not support downgrading PolyScope. Going back to an earlier version is done by restoring a backup taken on it (PolyScope 5.5.0 or later). Before 5.5.0, updates go one minor version at a time.",
  },
  abb: {
    vendor: "abb", label: "ABB",
    steps: [
      "Take a controller backup (FlexPendant or RobotStudio) and check a Cobblr backup of its programs is restore tested",
      "Install the new RobotWare into a new system with RobotStudio's Installation Manager, keeping the system's options",
      "Restore the backup into the new system and restart the controller",
      "Check the safety configuration's checksum at the FlexPendant against the one approved for this cell",
      "Run each program once in manual reduced speed, watched, before it goes back into production",
    ],
    remote: "No remote install is documented for Cobblr to drive; updates are made with RobotStudio.",
    rollback: "Keep the previous system on the controller: switching back to it, or restoring the earlier backup, returns the earlier RobotWare.",
  },
  other: {
    vendor: "other", label: "This arm's maker",
    steps: [
      "Take the controller's own backup and check a Cobblr backup of its programs is restore tested",
      "Follow the maker's update instructions for this controller and version",
      "Check the safety configuration at the pendant against the one approved for this cell",
      "Run each program once at reduced speed, watched, before it goes back into production",
    ],
    remote: "No remote install is documented for Cobblr to drive.",
    rollback: "As the maker documents for this version; record it in the update's note.",
  },
};

/** Which vendor's guide an arm takes, from what its controller reports. */
export function vendorOf(info: ArmInfo | null): VendorGuide {
  const words = `${info?.model ?? ""} ${(info?.software_versions ?? []).map((v) => v.name).join(" ")}`;
  if (/\bUR\d|PolyScope|Universal Robots/i.test(words)) return VENDOR_GUIDES.ur!;
  if (/\bIRB|RobotWare|ABB/i.test(words)) return VENDOR_GUIDES.abb!;
  return VENDOR_GUIDES.other!;
}

/** Whether the versions read back carry the target version. */
export function updateTook(readBack: { name: string; version: string }[], target: string): boolean {
  const want = target.trim().toLowerCase();
  return !!want && readBack.some((v) => v.version.trim().toLowerCase() === want || v.version.trim().toLowerCase().startsWith(`${want}.`) || v.version.trim().toLowerCase().startsWith(`${want} `));
}

type Update = Selectable<DigifabDB["digifab_arm_updates"]>;
const StartSchema = z.object({ file_id: z.string().uuid().nullable().default(null), target_version: z.string().trim().min(1).max(100) });

/** Start a guided update: the file's checksum is taken from its bytes, the
 *  versions now are kept to compare, and the vendor's steps are listed. */
export async function startUpdate(db: Kysely<DigifabDB>, orgId: string, userId: string, machineId: string, value: unknown) {
  const input = StartSchema.parse(value);
  const unit = await requireUnit(db, machineId);
  if (await db.selectFrom("digifab_arm_updates").select("id").where("machine_id", "=", machineId).where("status", "=", "open").executeTakeFirst()) throw new ArmRefusal("This arm already has an update open. Finish or cancel it first.");
  let sha: string | null = null;
  if (input.file_id) {
    const file = await platform().files.read(orgId, input.file_id);
    if (!file) throw new ArmRefusal("Choose the update file from Files.");
    sha = createHash("sha256").update(Buffer.from(file.bytes)).digest("hex");
  }
  const guide = vendorOf(unit.last_info);
  // The partial unique index holds one open update per arm; a second start at once loses here.
  const row = await db.insertInto("digifab_arm_updates").values({ machine_id: machineId, vendor: guide.vendor, file_id: input.file_id, file_sha256: sha, target_version: input.target_version, from_versions: JSON.stringify(unit.last_info?.software_versions ?? []), steps: JSON.stringify(guide.steps.map((step) => ({ step, done_by: null, done_at: null }))), read_back: null, created_by: userId, ended_by: null, ended_at: null }).returningAll().executeTakeFirstOrThrow()
    .catch((e: { code?: string }) => { if (e?.code === "23505") throw new ArmRefusal("This arm already has an update open. Finish or cancel it first."); throw e; });
  await platform().activity.log({ orgId, userId, action: "arm_update_started", ref: machineRef(machineId), diff: { target_version: input.target_version, vendor: guide.vendor, file_sha256: sha, from: unit.last_info?.software_versions ?? [] } });
  return row;
}

async function openUpdate(db: Kysely<DigifabDB>, updateId: string): Promise<Update> {
  const row = await db.selectFrom("digifab_arm_updates").selectAll().where("id", "=", updateId).executeTakeFirst();
  if (!row || row.status !== "open") throw new ArmRefusal("Choose an open update.");
  return row;
}

export async function checkUpdateStep(db: Kysely<DigifabDB>, orgId: string, userId: string, value: unknown) {
  const input = z.object({ update_id: z.string().uuid(), item: z.number().int().min(0).max(20), done: z.boolean() }).parse(value);
  const row = await openUpdate(db, input.update_id);
  if (!row.steps[input.item]) throw new ArmRefusal("No such step.");
  const steps = row.steps.map((s, i) => (i === input.item ? { ...s, done_by: input.done ? userId : null, done_at: input.done ? new Date().toISOString() : null } : s));
  await db.updateTable("digifab_arm_updates").set({ steps: JSON.stringify(steps) }).where("id", "=", row.id).where("status", "=", "open").execute();
  await platform().activity.log({ orgId, userId, action: "arm_update_step_checked", ref: machineRef(row.machine_id), diff: { step: steps[input.item]!.step, done: input.done } });
  return { ok: true, steps };
}

/** Read the controller's versions back: the update is verified only when the
 *  controller reports the target, after every step was ticked. */
export async function verifyUpdate(db: Kysely<DigifabDB>, orgId: string, userId: string, updateId: string) {
  const row = await openUpdate(db, updateId);
  if (row.steps.some((s) => !s.done_by)) throw new ArmRefusal("Tick every step at the arm first.");
  await refreshArm(db, orgId, userId, row.machine_id);
  const unit = await requireUnit(db, row.machine_id);
  const readBack = unit.last_info?.software_versions ?? [];
  const took = updateTook(readBack, row.target_version);
  const detail = took ? `The controller reports ${row.target_version}.` : `The controller reports ${readBack.map((v) => `${v.name} ${v.version}`).join(", ") || "no version"}, not ${row.target_version}.`;
  const saved = await db.updateTable("digifab_arm_updates").set({ status: took ? "verified" : "failed", read_back: JSON.stringify(readBack), detail, ended_by: userId, ended_at: new Date() }).where("id", "=", row.id).where("status", "=", "open").returningAll().executeTakeFirstOrThrow();
  await platform().activity.log({ orgId, userId, action: took ? "arm_update_verified" : "arm_update_failed", ref: machineRef(row.machine_id), diff: { target_version: row.target_version, read_back: readBack } });
  return saved;
}

export async function cancelUpdate(db: Kysely<DigifabDB>, orgId: string, userId: string, updateId: string) {
  const row = await openUpdate(db, updateId);
  await db.updateTable("digifab_arm_updates").set({ status: "cancelled", ended_by: userId, ended_at: new Date() }).where("id", "=", row.id).execute();
  await platform().activity.log({ orgId, userId, action: "arm_update_cancelled", ref: machineRef(row.machine_id), diff: { target_version: row.target_version } });
  return { ok: true };
}

export async function readUpdates(db: Kysely<DigifabDB>, machineId: string) {
  const unit = await db.selectFrom("digifab_arm_units").select("last_info").where("machine_id", "=", machineId).executeTakeFirst();
  const updates = await db.selectFrom("digifab_arm_updates").selectAll().where("machine_id", "=", machineId).orderBy("created_at", "desc").limit(20).execute();
  return { guide: vendorOf(unit?.last_info ?? null), updates };
}
