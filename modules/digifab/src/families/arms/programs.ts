// Program change control and backups (core spec #6883 §7). Each revision of
// an arm's program keeps its text, read from the controller when it is first
// seen, so two revisions can be compared line by line. A revision runs in
// production only once a person has released it. A copy to another arm is a
// re-teach checklist, never a silent copy: the copy is released on its arm
// when the person ticks its last item. A backup keeps every program and the
// installation they depend on, with a retention, and is proven by restoring
// it onto a spare arm and reading that arm's programs back.
import "./db.js";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { ArmBackupSchema, type ArmFile, type ArmProgramSource } from "@cobblr/platform-contract/robot-arm";
import { diffText, type TextDiff } from "@cobblr/platform-contract/text-diff";
import { countOf } from "@cobblr/platform-contract/plural";
import type { DigifabDB } from "../../db.js";
import { authorizeArm, ArmRefusal } from "./station.js";
import { armDriver, machineRef, refreshArm, requireUnit } from "./store.js";

type Program = Selectable<DigifabDB["digifab_arm_programs"]>;
export interface ChecklistItem { item: string; done_by: string | null; done_at: string | null }

/** What a person checks on the new arm before a copied program runs there. */
export const REATEACH_CHECKLIST = [
  "The tool centre point and payload are set for this arm's tooling",
  "Every waypoint has been re-taught or checked on this arm",
  "The program's inputs and outputs match this cell's wiring",
  "It has run once at reduced speed at the pendant, watched",
  "The cell's risk assessment covers this program on this arm",
] as const;

async function connected(db: Kysely<DigifabDB>, machineId: string) {
  const unit = await requireUnit(db, machineId);
  if (!unit.connection_id || !unit.device_id) throw new ArmRefusal("This arm has no controller connection. Do this at its pendant.");
  return unit as typeof unit & { connection_id: string; device_id: string };
}

/** Read the text of every revision first seen since the last read. A bridge
 *  that cannot read text leaves it unread, and the release says so. */
export async function readNewTexts(db: Kysely<DigifabDB>, orgId: string, machineId: string): Promise<number> {
  const unit = await requireUnit(db, machineId);
  if (!unit.connection_id || !unit.device_id) return 0;
  const rows = await db.selectFrom("digifab_arm_programs").selectAll().where("machine_id", "=", machineId).where("source", "=", "controller").where("text_read_at", "is", null).where("missing_since", "is", null).limit(50).execute();
  if (!rows.length) return 0;
  const driver = await armDriver(db, orgId, unit.connection_id);
  let read = 0;
  for (const row of rows) {
    const text = await driver.source(unit.device_id, row.name);
    if (!text) break;
    // The controller holds one revision of a name; text of another is not this row's.
    if (text.revision !== row.revision) continue;
    await db.updateTable("digifab_arm_programs").set({ text_files: JSON.stringify(text.files), text_read_at: new Date() }).where("id", "=", row.id).execute();
    read++;
  }
  return read;
}

const asText = (f: ArmFile) => (f.encoding === "utf8" ? f.content : null);
/** The last revision of the same program released on the same arm. */
async function lastReleased(db: Kysely<DigifabDB>, p: Program) {
  return db.selectFrom("digifab_arm_programs").selectAll().where("machine_id", "=", p.machine_id).where("name", "=", p.name).where("released_at", "is not", null).where("id", "<>", p.id).orderBy("released_at", "desc").executeTakeFirst();
}

/** What changed from the last released revision, file by file. */
export async function programChanges(db: Kysely<DigifabDB>, programId: string) {
  const p = await db.selectFrom("digifab_arm_programs").selectAll().where("id", "=", programId).executeTakeFirst();
  if (!p) throw new ArmRefusal("No such arm program.");
  const before = await lastReleased(db, p);
  const files: { path: string; status: "added" | "removed" | "changed" | "same" | "binary-changed"; diff: TextDiff | null }[] = [];
  const now = new Map((p.text_files ?? []).map((f) => [f.path, f])), was = new Map((before?.text_files ?? []).map((f) => [f.path, f]));
  for (const path of [...new Set([...now.keys(), ...was.keys()])].sort()) {
    const a = was.get(path), b = now.get(path);
    if (!a) { files.push({ path, status: "added", diff: b && asText(b) !== null ? diffText("", asText(b)!) : null }); continue; }
    if (!b) { files.push({ path, status: "removed", diff: asText(a) !== null ? diffText(asText(a)!, "") : null }); continue; }
    if (a.content === b.content && a.encoding === b.encoding) { files.push({ path, status: "same", diff: null }); continue; }
    const ta = asText(a), tb = asText(b);
    files.push(ta !== null && tb !== null ? { path, status: "changed", diff: diffText(ta, tb) } : { path, status: "binary-changed", diff: null });
  }
  return { program: { ...p, text_files: undefined }, released_before: before ? { id: before.id, revision: before.revision, released_at: before.released_at, released_by: before.released_by } : null, text: p.text_read_at ? "read" as const : "unread" as const, files };
}

async function openCopy(db: Kysely<DigifabDB>, machineId: string, name: string) {
  return db.selectFrom("digifab_arm_copies").select(["id"]).where("target_machine_id", "=", machineId).where("name", "=", name).where("status", "=", "open").executeTakeFirst();
}

/** A person's OK for this revision to run in production. */
export async function releaseProgram(db: Kysely<DigifabDB>, orgId: string, userId: string, programId: string) {
  const p = await db.selectFrom("digifab_arm_programs").selectAll().where("id", "=", programId).executeTakeFirst();
  if (!p) throw new ArmRefusal("No such arm program.");
  if (p.missing_since) throw new ArmRefusal("The controller no longer lists this revision.");
  if (p.released_at) return { ok: true, released: p };
  if (await openCopy(db, p.machine_id, p.name)) throw new ArmRefusal("This program was copied onto this arm. Finish its re-teach checklist; that releases it.");
  if (p.source === "controller" && !p.text_read_at) await readNewTexts(db, orgId, p.machine_id).catch(() => 0);
  const released = await db.updateTable("digifab_arm_programs").set({ released_at: new Date(), released_by: userId }).where("id", "=", programId).where("released_at", "is", null).returningAll().executeTakeFirstOrThrow();
  const changes = await programChanges(db, programId);
  await platform().activity.log({ orgId, userId, action: "arm_program_released", ref: machineRef(p.machine_id), diff: { name: p.name, revision: p.revision, before: changes.released_before?.revision ?? null, text: changes.text, files_changed: changes.files.filter((f) => f.status !== "same").map((f) => f.path) } });
  return { ok: true, released };
}

const CopySchema = z.object({ program_id: z.string().uuid(), target_machine_id: z.string().uuid() });
/** Copy one revision onto another arm as a re-teach checklist. The bridge
 *  puts it on the controller when it can; otherwise it is copied at the
 *  pendant and the checklist says so. Nothing runs until the list is done. */
export async function copyProgram(db: Kysely<DigifabDB>, orgId: string, userId: string, value: unknown) {
  const input = CopySchema.parse(value);
  const p = await db.selectFrom("digifab_arm_programs").selectAll().where("id", "=", input.program_id).executeTakeFirst();
  if (!p) throw new ArmRefusal("Choose a program to copy.");
  if (p.machine_id === input.target_machine_id) throw new ArmRefusal("Copy a program to another arm.");
  const target = await connected(db, input.target_machine_id);
  if (await openCopy(db, input.target_machine_id, p.name)) throw new ArmRefusal("That arm already has an open copy of this program. Finish or cancel it first.");
  if (p.source === "controller" && !p.text_read_at) await readNewTexts(db, orgId, p.machine_id).catch(() => 0);
  const fresh = await db.selectFrom("digifab_arm_programs").select(["text_files"]).where("id", "=", p.id).executeTakeFirstOrThrow();
  let uploaded = false, targetRevision: string | null = null, detail = "";
  if (fresh.text_files?.length) {
    const sent = await (await armDriver(db, orgId, target.connection_id)).upload(target.device_id, { name: p.name, revision: p.revision, files: fresh.text_files } satisfies ArmProgramSource);
    if (sent?.ok) { uploaded = true; targetRevision = sent.program?.revision ?? null; }
    else detail = sent?.detail ?? "This arm's bridge cannot put a program on its controller.";
  } else detail = "The program's text could not be read, so it is copied at the pendant.";
  const checklist: ChecklistItem[] = [...(uploaded ? [] : ["The program has been copied onto this arm at its pendant"]), ...REATEACH_CHECKLIST].map((item) => ({ item, done_by: null, done_at: null }));
  const copy = await db.insertInto("digifab_arm_copies").values({ source_program_id: p.id, target_machine_id: input.target_machine_id, name: p.name, uploaded, target_revision: targetRevision, checklist: JSON.stringify(checklist), created_by: userId, completed_by: null, completed_at: null }).returningAll().executeTakeFirstOrThrow();
  if (uploaded) await refreshArm(db, orgId, userId, input.target_machine_id).catch(() => null);
  await platform().activity.log({ orgId, userId, action: "arm_program_copied", ref: machineRef(input.target_machine_id), diff: { name: p.name, from_machine: p.machine_id, revision: p.revision, uploaded, target_revision: targetRevision, ...(detail ? { detail } : {}) } });
  return { ok: true, copy, uploaded, detail: detail || undefined };
}

const CheckSchema = z.object({ copy_id: z.string().uuid(), item: z.number().int().min(0).max(20), done: z.boolean() });
/** Tick one item of a copy's re-teach checklist. Ticking the last releases
 *  the copy on its arm: the checklist is the person's OK. */
export async function checkCopyItem(db: Kysely<DigifabDB>, orgId: string, userId: string, value: unknown) {
  const input = CheckSchema.parse(value);
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`digifab-arm-copy:${input.copy_id}`}))`.execute(trx);
    const copy = await trx.selectFrom("digifab_arm_copies").selectAll().where("id", "=", input.copy_id).executeTakeFirst();
    if (!copy || copy.status !== "open") throw new ArmRefusal("Choose an open copy.");
    if (!copy.checklist[input.item]) throw new ArmRefusal("No such checklist item.");
    const checklist = copy.checklist.map((c, i) => (i === input.item ? { ...c, done_by: input.done ? userId : null, done_at: input.done ? new Date().toISOString() : null } : c));
    const done = checklist.every((c) => c.done_by);
    let releasedRevision: string | null = null;
    if (done) {
      let q = trx.selectFrom("digifab_arm_programs").selectAll().where("machine_id", "=", copy.target_machine_id).where("name", "=", copy.name).where("missing_since", "is", null);
      if (copy.target_revision !== null) q = q.where("revision", "=", copy.target_revision);
      const target = await q.orderBy("first_seen_at", "desc").executeTakeFirst();
      if (!target) throw new ArmRefusal("The copied program is not on that arm's controller yet. Read the arm's programs again, then tick this.");
      await trx.updateTable("digifab_arm_programs").set({ released_at: new Date(), released_by: userId }).where("id", "=", target.id).where("released_at", "is", null).execute();
      releasedRevision = target.revision;
    }
    await trx.updateTable("digifab_arm_copies").set({ checklist: JSON.stringify(checklist), ...(done ? { status: "done" as const, completed_by: userId, completed_at: new Date() } : {}) }).where("id", "=", copy.id).execute();
    await platform().activity.log({ orgId, userId, action: done ? "arm_copy_reteach_done" : "arm_copy_reteach_checked", ref: machineRef(copy.target_machine_id), diff: { name: copy.name, item: checklist[input.item]!.item, done: input.done, ...(done ? { released_revision: releasedRevision } : {}) } });
    return { ok: true, done, checklist };
  });
}

export async function cancelCopy(db: Kysely<DigifabDB>, orgId: string, userId: string, copyId: string) {
  const row = await db.updateTable("digifab_arm_copies").set({ status: "cancelled", completed_by: userId, completed_at: new Date() }).where("id", "=", copyId).where("status", "=", "open").returning(["target_machine_id", "name"]).executeTakeFirst();
  if (!row) throw new ArmRefusal("Choose an open copy.");
  await platform().activity.log({ orgId, userId, action: "arm_copy_cancelled", ref: machineRef(row.target_machine_id), diff: { name: row.name } });
  return { ok: true };
}

/** Back the arm up now: every program and its installation, kept as a file.
 *  The oldest beyond the arm's retention are removed. */
export async function takeBackup(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string) {
  const unit = await connected(db, machineId);
  const backup = await (await armDriver(db, orgId, unit.connection_id)).backup(unit.device_id);
  if (!backup) throw new ArmRefusal("This arm's bridge cannot back up its controller. Take the controller's own backup at the pendant.");
  const bytes = Buffer.from(JSON.stringify(backup));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = await platform().files.write(orgId, bytes, { filename: `arm-backup-${backup.taken_at.replace(/[:.]/g, "-")}.json`, mimeType: "application/json" });
  if (!file) throw new ArmRefusal("Turn on Files to keep arm backups.");
  const row = await db.insertInto("digifab_arm_backups").values({ machine_id: machineId, taken_at: new Date(backup.taken_at), file_id: file.fileId, sha256, size_bytes: bytes.length, programs: JSON.stringify(backup.programs.map((p) => ({ name: p.name, revision: p.revision }))), installation_files: backup.installation.length, missing: JSON.stringify(backup.missing), taken_by: userId, restore_tested_at: null, restore_target_machine_id: null, restore_ok: null, restore_detail: null }).returningAll().executeTakeFirstOrThrow();
  await db.updateTable("digifab_arm_units").set({ last_backup_at: new Date() }).where("machine_id", "=", machineId).execute();
  const old = await db.selectFrom("digifab_arm_backups").select(["id", "file_id"]).where("machine_id", "=", machineId).orderBy("taken_at", "desc").offset(unit.backup_keep).limit(100).execute();
  for (const b of old) {
    await db.deleteFrom("digifab_arm_backups").where("id", "=", b.id).execute();
    if (!(await db.selectFrom("digifab_arm_backups").select("id").where("file_id", "=", b.file_id).executeTakeFirst())) await platform().files.removeForGood(orgId, b.file_id).catch(() => null);
  }
  await platform().activity.log({ orgId, userId, action: "arm_backed_up", ref: machineRef(machineId), diff: { programs: backup.programs.length, installation_files: backup.installation.length, missing: backup.missing, removed_old: old.length } });
  return row;
}

const ScheduleSchema = z.object({ every_hours: z.number().int().min(1).max(720).nullable(), keep: z.number().int().min(1).max(100) });
/** How often the arm is backed up on its own (off until someone sets it) and
 *  how many backups are kept. */
export async function setBackupSchedule(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
  const input = ScheduleSchema.parse(value);
  const unit = await requireUnit(db, machineId);
  await db.updateTable("digifab_arm_units").set({ backup_every_hours: input.every_hours, backup_keep: input.keep, updated_at: new Date() }).where("machine_id", "=", machineId).execute();
  await platform().activity.log({ orgId, userId, action: "arm_backup_schedule_set", ref: machineRef(machineId), diff: { every_hours: input.every_hours, keep: input.keep, before: { every_hours: unit.backup_every_hours, keep: unit.backup_keep } } });
  return { ok: true };
}

async function backupContents(db: Kysely<DigifabDB>, orgId: string, backupId: string) {
  const row = await db.selectFrom("digifab_arm_backups").selectAll().where("id", "=", backupId).executeTakeFirst();
  if (!row) throw new ArmRefusal("No such backup.");
  const stored = await platform().files.read(orgId, row.file_id);
  if (!stored) throw new ArmRefusal("This backup's file is gone. Take a new backup.");
  const bytes = Buffer.from(stored.bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new ArmRefusal("This backup's file does not match what was stored. Take a new backup.");
  return { row, backup: ArmBackupSchema.parse(JSON.parse(bytes.toString("utf8"))) };
}

/** Restore a backup onto a spare arm (a simulator or an arm out of
 *  production) and read that arm's programs back: the backup is proven when
 *  every program comes back at its revision. */
export async function testRestore(db: Kysely<DigifabDB>, orgId: string, userId: string, value: unknown) {
  const input = z.object({ backup_id: z.string().uuid(), target_machine_id: z.string().uuid() }).parse(value);
  const { row, backup } = await backupContents(db, orgId, input.backup_id);
  if (input.target_machine_id === row.machine_id) throw new ArmRefusal("Test a restore on a spare arm or a simulator, never on the arm it came from. Restore that one at its station.");
  const target = await connected(db, input.target_machine_id);
  const driver = await armDriver(db, orgId, target.connection_id);
  const result = await driver.restore(target.device_id, backup.programs);
  let ok = false, detail: string;
  if (!result) detail = "The spare arm's bridge cannot restore programs.";
  else {
    const list = await driver.programs(target.device_id);
    const have = new Set(list.supported ? list.programs.map((p) => `${p.name}@${p.revision}`) : []);
    const lost = backup.programs.filter((p) => !have.has(`${p.name}@${p.revision}`)).map((p) => p.name);
    ok = list.supported && lost.length === 0 && result.skipped.length === 0;
    detail = !list.supported ? "The spare arm cannot list its programs, so the restore could not be checked." : lost.length ? `Not back at their revision: ${lost.join(", ")}.` : result.skipped.length ? `Skipped: ${result.skipped.map((s) => `${s.name} (${s.detail})`).join("; ")}` : `All ${countOf(backup.programs.length, "program")} came back at their revisions.`;
  }
  const saved = await db.updateTable("digifab_arm_backups").set({ restore_tested_at: new Date(), restore_target_machine_id: input.target_machine_id, restore_ok: ok, restore_detail: detail.slice(0, 1000) }).where("id", "=", row.id).returningAll().executeTakeFirstOrThrow();
  await refreshArm(db, orgId, userId, input.target_machine_id).catch(() => null);
  await platform().activity.log({ orgId, userId, action: "arm_backup_restore_tested", ref: machineRef(row.machine_id), diff: { backup: row.id, target: input.target_machine_id, ok, detail } });
  return saved;
}

export const RestoreSchema = z.object({ station_token: z.string().min(32).max(128), backup_id: z.string().uuid(), arm_stopped: z.literal(true) });
/** Restore a backup onto the arm it came from, from its station. Programs
 *  only: the installation and its safety settings are restored at the
 *  pendant. A restored revision is released only if it was before. */
export async function restoreAtStation(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown, userId: string) {
  const input = RestoreSchema.parse(value);
  const unit = await connected(db, machineId);
  await authorizeArm(db, unit.connection_id, unit.device_id, input.station_token);
  const { row, backup } = await backupContents(db, orgId, input.backup_id);
  if (row.machine_id !== machineId) throw new ArmRefusal("This backup is another arm's. Test it on a spare instead.");
  const driver = await armDriver(db, orgId, unit.connection_id);
  const state = await driver.state(unit.device_id).catch(() => null);
  if (!state || state.execution === "running" || state.execution === "paused") throw new ArmRefusal("Stop the arm before restoring its programs.");
  const result = await driver.restore(unit.device_id, backup.programs);
  if (!result) throw new ArmRefusal("This arm's bridge cannot restore programs. Restore them at the pendant.");
  await refreshArm(db, orgId, userId, machineId).catch(() => null);
  await platform().activity.log({ orgId, userId, action: "arm_restored", ref: machineRef(machineId), diff: { backup: row.id, restored: result.restored.length, skipped: result.skipped } });
  return result;
}

/** Back up each arm whose schedule is due. */
export function registerArmBackups(): void {
  platform().sweeps.register({ name: "digifab.arm-backups", module: "digifab", everyMs: 15 * 60_000, firstAfterMs: 5 * 60_000,
    visit: async ({ orgId, db }) => {
      if (!(await platform().parts.isOn(orgId, "digifab", "arms"))) return;
      const tenant = db as Kysely<DigifabDB>;
      const due = await tenant.selectFrom("digifab_arm_units").select("machine_id").where("connection_id", "is not", null).where("backup_every_hours", "is not", null)
        .where((eb) => eb.or([eb("last_backup_at", "is", null), eb("last_backup_at", "<", sql<Date>`now() - make_interval(hours => backup_every_hours)`)])).execute();
      for (const u of due) {
        try { await takeBackup(tenant, orgId, null, u.machine_id); }
        catch (err) { platform().health.notePassFailure("digifab.arm-backups", `${orgId}:${u.machine_id}`, err); }
      }
    },
  });
}

export async function readProgramControl(db: Kysely<DigifabDB>, machineId: string) {
  const copies = await db.selectFrom("digifab_arm_copies").selectAll().where("target_machine_id", "=", machineId).where("status", "=", "open").orderBy("created_at", "desc").execute();
  const outgoing = await db.selectFrom("digifab_arm_copies as c").innerJoin("digifab_arm_programs as p", "p.id", "c.source_program_id").selectAll("c").where("p.machine_id", "=", machineId).where("c.status", "=", "open").orderBy("c.created_at", "desc").execute();
  const backups = await db.selectFrom("digifab_arm_backups").selectAll().where("machine_id", "=", machineId).orderBy("taken_at", "desc").limit(50).execute();
  return { copies, outgoing, backups };
}
