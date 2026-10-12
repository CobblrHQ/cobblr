import { platform, readJsonArg, ActionRefusal } from "@cobblr/platform-contract";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import type { CoreMaintenanceDB } from "../db.js";
import { renewalDocumentTypes } from "../renewal-documents.js";
import { MaintenanceRefusal } from "../refusal.js";
import { createSchedule, renewSchedule } from "./schedules.js";
import { renewalState, rolledFromOf, unroll } from "../schedules-store.js";
import { moneyForStorage } from "@cobblr/platform-contract/money";
import { instantOnDay } from "@cobblr/platform-contract/day";
import { optionalUuid } from "@cobblr/platform-contract/optional-fields";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => instantOnDay(value) !== null, "Choose a real date.");
export const RenewalDocumentArgs = z.object({
  document_type: z.string().default("registration"), record_kind: z.string().min(1).max(160), record_id: z.string().uuid(),
  previous_expiry: Day, new_expiry: Day, cost: z.union([z.string().refine(value => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), "Check the fee."), z.number().finite().nonnegative()]).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), reference: z.string().trim().max(200).optional(),
  folder: z.string().trim().min(1).max(200).default("Car documents"), schedule_id: optionalUuid(),
});

export function registerRenewDocumentAction(): void {
  platform().actions.registerPlanner("core-maintenance.renew-document", async ctx => {
    const parsed = RenewalDocumentArgs.safeParse(ctx.args);
    if (!parsed.success) return { error: "Choose the car, previous expiry and new expiry before filing this document." };
    const d = parsed.data;
    const record = await platform().entities.lookup(ctx.orgId, d.record_kind, d.record_id, { userId: ctx.userId ?? undefined });
    const type = renewalDocumentTypes.find(t => t.id === d.document_type);
    if (!record || !type) return { error: "Choose a record and renewal type in this workspace." };
    return { title: `${type.label} renewal for ${record.title}`, lines: [
      `New expiry ${d.new_expiry} (was ${d.previous_expiry}).`,
      ...(d.cost != null ? [`Fee ${d.cost}.`] : []), ...(d.reference ? [`Confirmation ${d.reference}.`] : []),
      `File the original in your Vault folder: ${d.folder}.`,
    ] };
  });
  platform().actions.registerHandler("core-maintenance.renew-document", async ctx => {
    const parsed = RenewalDocumentArgs.safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the renewal values." };
    if (!ctx.userId || !ctx.document?.bytes.length) return { ok: false, error: "Attach the original document to the renewal card, then confirm it." };
    const d = parsed.data;
    const type = renewalDocumentTypes.find(t => t.id === d.document_type);
    if (!type) return { ok: false, error: "Choose a renewal document type." };
    if (d.new_expiry <= d.previous_expiry) return { ok: false, error: "The new expiry must be after the previous expiry." };
    const viewer = { userId: ctx.userId };
    const record = await platform().entities.lookup(ctx.orgId, d.record_kind, d.record_id, viewer);
    const defs = await platform().entities.fieldsFor(ctx.orgId, d.record_kind);
    const hidden = await platform().entities.hiddenFields(ctx.orgId, d.record_kind, viewer);
    if (!record || hidden.has(type.expiryField) || !defs.some(f => f.name === type.expiryField && f.type === "date")) return { ok: false, error: "Choose a record whose renewal expiry you may read." };
    const metadata = record.fields.metadata as Record<string, unknown> | undefined;
    const previous = record.fields[type.expiryField] ?? metadata?.[type.expiryField] ?? null;
    if (previous != null && String(previous).slice(0, 10) !== d.previous_expiry) return { ok: false, error: "This record's expiry changed. Check the renewal again." };
    const baseKind = await platform().entities.baseKindOf(ctx.orgId, d.record_kind);
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const [entity_module, entity_type] = d.record_kind.split(":");
    if (!entity_module || !entity_type) return { ok: false, error: "Choose a record kind." };
    const cost_cents = d.cost == null || d.cost === "" ? undefined : moneyForStorage(d.cost, "cents");
    let filed: Awaited<ReturnType<ReturnType<typeof platform>["vault"]["file"]>> | undefined;
    let created = false;
    let expiryTouched = false;
    try {
      const result = await db.transaction().execute(async tx => {
        // A car without a schedule has no row to lock yet. Both uploads must
        // take the same lock before deciding to create its first schedule.
        await sql`select pg_advisory_xact_lock(hashtext(${`${baseKind}:${d.record_id}:${type.expiryField}`}))`.execute(tx);
        const schedules = await tx.selectFrom("core_maintenance_schedules").selectAll().where("entity_id", "=", d.record_id).where("ended_at", "is", null).execute();
        const candidates: typeof schedules = [];
        for (const s of schedules) {
          if (!s.anchor || !(s.expiry_field === type.expiryField || (!s.expiry_field && s.name.toLowerCase() === type.label.toLowerCase()))) continue;
          if (await platform().entities.baseKindOf(ctx.orgId, `${s.entity_module}:${s.entity_type}`) === baseKind) candidates.push(s);
        }
        let schedule = d.schedule_id ? candidates.find(s => s.id === d.schedule_id) : candidates.length === 1 ? candidates[0] : undefined;
        if (candidates.length > 1 && !schedule) throw new ActionRefusal("Choose the renewal schedule for this document.");
        if (d.schedule_id && !schedule) throw new ActionRefusal("That schedule does not renew this record.");
        const oldBinding = schedule ? { expiry_field: schedule.expiry_field, current_expiry: schedule.current_expiry?.toISOString() ?? null } : null;
        if (schedule) {
          const state = await renewalState(ctx.orgId, schedule);
          if (state.current_expiry?.toISOString().slice(0, 10) !== d.previous_expiry) throw new ActionRefusal("This expiry changed while you checked the document. Check it again.");
          if (!schedule.expiry_field) schedule = await tx.updateTable("core_maintenance_schedules").set({ expiry_field: type.expiryField, current_expiry: null }).where("id", "=", schedule.id).returningAll().executeTakeFirstOrThrow();
        } else {
          const current = await platform().entities.lookup(ctx.orgId, d.record_kind, d.record_id, viewer);
          const values = { ...current?.fields, ...(current?.fields.metadata as Record<string, unknown> | undefined) };
          if (values[type.expiryField] != null && String(values[type.expiryField]).slice(0, 10) !== d.previous_expiry) throw new ActionRefusal("This expiry changed while you checked the document. Check it again.");
          created = true;
          expiryTouched = true;
          schedule = await createSchedule(tx, ctx.orgId, { entity_module, entity_type, entity_id: d.record_id, name: type.label,
            current_expiry: d.previous_expiry, expiry_field: type.expiryField, anchor: d.previous_expiry.slice(5), every_n: 1, every_unit: "year", remind: { on: "month_start" } });
        }
        await sql`select pg_advisory_xact_lock(hashtext(${`vault:${ctx.userId}:${d.folder}`}))`.execute(tx);
        filed = await platform().vault.file(ctx.orgId, ctx.userId!, { name: ctx.document!.name, mimeType: ctx.document!.mimeType, bytes: ctx.document!.bytes, folder: d.folder });
        expiryTouched = true;
        const renewal = await renewSchedule(tx, ctx.orgId, ctx.userId, schedule, { new_expiry: d.new_expiry, expected_expiry: d.previous_expiry, cost_cents, currency: d.currency, reference: d.reference });
        await platform().vault.link(ctx.orgId, ctx.userId!, filed.fileId, { kind: "core-maintenance:term", id: renewal.entry.id });
        return { ...renewal, original_expiry: previous, created_schedule: created, old_binding: oldBinding };
      });
      return { ok: true, summary: `${type.label} renewed to ${d.new_expiry}. The original is in your Vault.`, result: { entry_id: result.entry.id, schedule_id: result.entry.schedule_id, vault_file_id: filed!.fileId, folder_id: filed!.folderId, folder_name: filed!.folderName, new_expiry: d.new_expiry }, before: {
        record_kind: d.record_kind, record_id: d.record_id, expiry_field: type.expiryField, original_expiry: previous,
        created_schedule: result.created_schedule, schedule_was: result.was, occurrence: result.occurrence, old_binding: result.old_binding,
      } };
    } catch (error) {
      try {
        if (filed) await platform().vault.remove(ctx.orgId, ctx.userId, filed.fileId);
      } finally {
        if (expiryTouched) {
          const current = await platform().entities.lookup(ctx.orgId, d.record_kind, d.record_id, viewer);
          const fields = { ...current?.fields, ...(current?.fields.metadata as Record<string, unknown> | undefined) };
          const expiry = String(fields[type.expiryField] ?? "").slice(0, 10);
          if (expiry === d.new_expiry || (created && expiry === d.previous_expiry)) await platform().entities.mergeMetadata(ctx.orgId, d.record_kind, d.record_id, { [type.expiryField]: previous });
        }
      }
      if (error instanceof MaintenanceRefusal) throw new ActionRefusal(error.message);
      throw error;
    }
  });
  platform().actions.registerUndo("core-maintenance.renew-document", value => {
    const result = value as { ok?: boolean; result?: Record<string, unknown>; before?: Record<string, unknown> };
    return result.ok && result.result && result.before ? { action_id: "core-maintenance:undo-document-renewal", args: { ...result.result, before: result.before } } : null;
  });
  platform().actions.registerHandler("core-maintenance.undo-document-renewal", async ctx => {
    if (!ctx.userId) return { ok: false, error: "Sign in to undo this renewal." };
    const args = ctx.args ?? {};
    const before = readJsonArg<Record<string, unknown>>(args, "before");
    const was = rolledFromOf(before?.schedule_was);
    if (!before || !was) return { ok: false, error: "The earlier renewal state is missing." };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const entryId = String(args.entry_id ?? "");
    const scheduleId = String(args.schedule_id ?? "");
    const fileId = String(args.vault_file_id ?? "");
    await db.transaction().execute(async tx => {
      const schedule = await tx.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", scheduleId).forUpdate().executeTakeFirst();
      const entry = await tx.selectFrom("core_maintenance_entries").selectAll().where("id", "=", entryId).where("schedule_id", "=", scheduleId).executeTakeFirst();
      if (!entry) return;
      if (!schedule || was.schedule_id !== scheduleId || await platform().entities.baseKindOf(ctx.orgId, String(before.record_kind)) !== await platform().entities.baseKindOf(ctx.orgId, `${schedule.entity_module}:${schedule.entity_type}`) || before.record_id !== schedule.entity_id || before.expiry_field !== schedule.expiry_field) throw new ActionRefusal("This Undo does not belong to this renewal.");
      if ((await renewalState(ctx.orgId, schedule)).current_expiry?.toISOString().slice(0, 10) !== args.new_expiry) throw new ActionRefusal("Another renewal or expiry edit came after this one. Keep those changes and edit the term instead.");
      await tx.deleteFrom("core_maintenance_entries").where("id", "=", entryId).execute();
      if (before.created_schedule) {
        await tx.deleteFrom("core_maintenance_entries").where("schedule_id", "=", scheduleId).where("performed_at", "is", null).execute();
        await tx.deleteFrom("core_maintenance_schedules").where("id", "=", scheduleId).execute();
        await platform().entities.mergeMetadata(ctx.orgId, String(before.record_kind), String(before.record_id), { [String(before.expiry_field)]: before.original_expiry ?? null });
      } else {
        await unroll(tx, ctx.orgId, was);
        const binding = before.old_binding as { expiry_field: string | null; current_expiry: string | null } | null;
        if (binding && !binding.expiry_field) {
          await tx.updateTable("core_maintenance_schedules").set({ expiry_field: null, current_expiry: binding.current_expiry ? new Date(binding.current_expiry) : null }).where("id", "=", scheduleId).execute();
          await platform().entities.mergeMetadata(ctx.orgId, String(before.record_kind), String(before.record_id), { [String(before.expiry_field)]: before.original_expiry ?? null });
        }
        const occurrence = before.occurrence as { nag_stopped_at?: string | null; nag_snoozed_until?: string | null; last_notified_at?: string | null } | null;
        if (occurrence) await tx.updateTable("core_maintenance_entries").set({ nag_stopped_at: occurrence.nag_stopped_at ? new Date(occurrence.nag_stopped_at) : null, nag_snoozed_until: occurrence.nag_snoozed_until ? new Date(occurrence.nag_snoozed_until) : null, last_notified_at: occurrence.last_notified_at ? new Date(occurrence.last_notified_at) : null }).where("schedule_id", "=", scheduleId).where("performed_at", "is", null).execute();
      }
    });
    await platform().vault.remove(ctx.orgId, ctx.userId, fileId);
    return { ok: true, summary: "The renewal and Vault filing were undone." };
  });
}
