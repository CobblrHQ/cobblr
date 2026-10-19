// Keep a robot arm's records (digifab:arm-record): the handler its manifest entry names. Wired in ./index.ts.
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import { releaseControl } from "../runs.js";
import { countOf } from "@cobblr/platform-contract/plural";
import type { DigifabDB } from "../../../db.js";
import { ArmRefusal } from "../station.js";
import { addTypedProgram, editProgram, refreshArm, saveCompatibility, setMaintenance, setTooling, setupArm } from "../store.js";
import { cancelUpdate, checkUpdateStep, startUpdate, verifyUpdate } from "../updates.js";
import { cancelCopy, checkCopyItem, copyProgram, releaseProgram, setBackupSchedule, takeBackup, testRestore } from "../programs.js";

export function registerArmRecordAction(): void {
  platform().actions.registerHandler("digifab.arm-record", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Keeping a robot arm's records needs an owner or admin." };
    try {
      const args = ctx.args ?? {}, fields = readJsonArg(args, "fields") ?? {}, db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
      const id = z.string().uuid().parse(args.id);
      if (args.operation === "setup") return { ...await setupArm(db, ctx.orgId, ctx.userId, id, fields), summary: "Set up as a robot arm." };
      if (args.operation === "refresh") return { ok: true, ...await refreshArm(db, ctx.orgId, ctx.userId, id), summary: "Read the arm's controller." };
      if (args.operation === "add_program") return { ok: true, program: await addTypedProgram(db, ctx.orgId, ctx.userId, id, fields), summary: "Added the program." };
      if (args.operation === "edit_program") return { ok: true, program: await editProgram(db, ctx.orgId, ctx.userId, id, fields), summary: "Updated the program." };
      if (args.operation === "compatibility") return { ...await saveCompatibility(db, ctx.orgId, ctx.userId, id, fields), summary: "Recorded what works on this arm." };
      if (args.operation === "maintenance") return { ...await setMaintenance(db, ctx.orgId, ctx.userId, id, fields), summary: "Changed the arm's service state." };
      if (args.operation === "tooling") return { ...await setTooling(db, ctx.orgId, ctx.userId, id, fields), summary: "Recorded the arm's tooling. Earlier approvals no longer hold." };
      if (args.operation === "release_control") return { ...await releaseControl(db, ctx.orgId, id, "revoked", ctx.userId), summary: "Took control of the arm away from its station." };
      if (args.operation === "release_program") return { ...await releaseProgram(db, ctx.orgId, ctx.userId, id), summary: "Released this revision for production." };
      if (args.operation === "copy_program") { const r = await copyProgram(db, ctx.orgId, ctx.userId, { ...fields, program_id: id }); return { ...r, summary: r.uploaded ? "Copied the program onto the other arm. Its re-teach checklist releases it there." : "Opened a re-teach checklist: copy the program at the other arm's pendant." }; }
      if (args.operation === "check_copy") { const r = await checkCopyItem(db, ctx.orgId, ctx.userId, { ...fields, copy_id: id }); return { ...r, summary: r.done ? "The re-teach checklist is done; the copy is released on its arm." : "Ticked the checklist item." }; }
      if (args.operation === "cancel_copy") return { ...await cancelCopy(db, ctx.orgId, ctx.userId, id), summary: "Cancelled the copy." };
      if (args.operation === "backup") { const b = await takeBackup(db, ctx.orgId, ctx.userId, id); return { ok: true, backup: b, summary: `Backed up ${countOf(b.programs.length, "program")}.` }; }
      if (args.operation === "backup_schedule") return { ...await setBackupSchedule(db, ctx.orgId, ctx.userId, id, fields), summary: "Saved the arm's backup schedule." };
      if (args.operation === "test_restore") { const b = await testRestore(db, ctx.orgId, ctx.userId, { ...fields, backup_id: id }); return { ok: true, backup: b, summary: b.restore_ok ? `The backup restored: ${b.restore_detail}` : `The restore test failed: ${b.restore_detail}` }; }
      if (args.operation === "start_update") { const u = await startUpdate(db, ctx.orgId, ctx.userId, id, fields); return { ok: true, update: u, summary: `Started a guided update to ${u.target_version}: follow its steps at the arm.` }; }
      if (args.operation === "check_update") return { ...await checkUpdateStep(db, ctx.orgId, ctx.userId, { ...fields, update_id: id }), summary: "Ticked the update step." };
      if (args.operation === "verify_update") { const u = await verifyUpdate(db, ctx.orgId, ctx.userId, id); return { ok: u.status === "verified", update: u, summary: u.detail, ...(u.status === "verified" ? {} : { error: u.detail }) }; }
      if (args.operation === "cancel_update") return { ...await cancelUpdate(db, ctx.orgId, ctx.userId, id), summary: "Cancelled the update." };
      return { ok: false, error: "Choose setup, refresh, add_program, edit_program, compatibility, maintenance, tooling, release_control, release_program, copy_program, check_copy, cancel_copy, backup, backup_schedule, test_restore, start_update, check_update, verify_update or cancel_update. Running and restoring the arm is at its station." };
    } catch (e) { if (e instanceof z.ZodError || e instanceof ArmRefusal) return { ok: false, error: e.message }; throw e; }
  });
}
