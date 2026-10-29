import { platform, SYSTEM_VIEWER, type FieldDefType } from "@cobblr/platform-contract";
import { fieldValueProblem, fieldValueProblemsOf, InvalidFieldValueError } from "@cobblr/platform-contract/entity-metadata";
import { kindRecordForOrg, baseKindOf } from "./entities.js";
import { effectiveFieldDefsForKind } from "./field-defs.js";
import { meta } from "../db/meta.js";
import * as activity from "./activity.js";
import { bulkSettableNative } from "./bulk-settable.js";

export interface BulkField {
  name: string;
  display_label: string;
  type: FieldDefType;
  native: boolean;
  required: boolean;
  choices?: string[] | null;
  learns?: boolean | null;
  ref_kind?: string | null;
  unit?: string | null;
  field_role?: string | null;
  money?: "cents" | "amount";
}
export interface BulkRef { kind: string; id: string }
export interface BulkFieldChange extends BulkRef { title: string; before: unknown; after: unknown }
export interface BulkFieldFailure extends BulkRef { title: string; error: string }
export interface BulkFieldResult { done: BulkFieldChange[]; failed: BulkFieldFailure[] }

async function fieldsFor(orgId: string, kind: string): Promise<BulkField[]> {
  const [rec, custom, overrides] = await Promise.all([
    kindRecordForOrg(orgId, kind), effectiveFieldDefsForKind(orgId, kind),
    meta.selectFrom("native_field_overrides").select(["name", "display_label", "hidden", "overrides"]).where("org_id", "=", orgId).where("entity_kind", "=", kind).execute(),
  ]);
  const own = new Map(overrides.map((o) => [o.name, o]));
  if (!rec) return [];
  const native: BulkField[] = rec.fields
    .filter((f) => bulkSettableNative(f, !!own.get(f.name)?.hidden))
    .map((f) => ({ name: f.name, display_label: own.get(f.name)?.display_label ?? f.label ?? f.name.replace(/_/g, " "), type: f.type as FieldDefType, native: true, required: f.required === true || f.role === "title", choices: own.get(f.name)?.overrides?.choices ?? f.choices, money: f.money }));
  const names = new Set(rec.fields.map((f) => f.name));
  return [...native, ...custom.filter((f) => !names.has(f.name) && !own.get(f.name)?.hidden && f.type !== "computed" && !f.server_managed).map((f) => ({
    name: f.name, display_label: own.get(f.name)?.display_label ?? f.display_label, type: f.type, native: false, required: f.required,
    choices: f.choices, learns: f.learns, ref_kind: f.ref_kind, unit: f.unit, field_role: f.field_role,
  }))];
}

export async function commonBulkFields(orgId: string, kinds: readonly string[]): Promise<BulkField[]> {
  if (!kinds.length || kinds.length > 50) return [];
  const lists = await Promise.all([...new Set(kinds)].map((kind) => fieldsFor(orgId, kind)));
  return (lists[0] ?? []).filter((f) => lists.every((list) => list.some((other) => other.name === f.name && other.type === f.type && other.ref_kind === f.ref_kind && other.money === f.money)));
}

const valueOf = (fields: Record<string, unknown>, field: BulkField) => field.native
  ? fields[field.name] ?? null
  : (fields.metadata as Record<string, unknown> | null)?.[field.name] ?? null;
const patchOf = (field: BulkField, value: unknown) => field.native ? { [field.name]: value } : { metadata: { [field.name]: value } };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function change(orgId: string, userId: string | null, ref: BulkRef, field: BulkField, value: unknown, expected?: unknown): Promise<BulkFieldChange> {
  // SYSTEM-READ: the admin-only batch keeps the exact previous field for its undo, including gated native fields.
  const rec = await platform().entities.lookup(orgId, ref.kind, ref.id, SYSTEM_VIEWER);
  if (!rec) throw new Error("This record is no longer available.");
  if (rec.fields._source_workspace_slug) throw new Error("This record belongs to another workspace.");
  const writer = await platform().entities.getWriter(orgId, ref.kind);
  if (!writer) throw new Error("This kind of record cannot be changed here.");
  const stored = writer.snapshot ? await writer.snapshot(orgId, ref.id) : rec.fields;
  if (!stored) throw new Error("This record is no longer available.");
  if (field.native && !(field.name in stored)) throw new Error("This field cannot be changed on this record.");
  const before = valueOf(stored, field);
  if (expected !== undefined && !same(before, expected)) throw new Error("This field changed after the batch. Its newer value was kept.");
  if (field.native && field.type === "boolean" && value === null) value = false;
  const problems = fieldValueProblemsOf(patchOf(field, value), [field], stored);
  const fit = fieldValueProblem(field, value);
  if (expected === undefined && fit) throw new InvalidFieldValueError(ref.kind, [fit]);
  if (expected === undefined && problems.length) throw new InvalidFieldValueError(ref.kind, problems);
  if (field.native) await writer.update(orgId, ref.id, { [field.name]: value });
  else if (writer.mergeMetadata) await writer.mergeMetadata(orgId, ref.id, { [field.name]: value });
  else throw new Error("This kind of record cannot change custom fields here.");
  // SYSTEM-READ: check the writer kept the requested value before claiming this row changed, and keep its stored spelling for Undo.
  const saved = await platform().entities.lookup(orgId, ref.kind, ref.id, SYSTEM_VIEWER);
  const kept = writer.snapshot ? await writer.snapshot(orgId, ref.id) : saved?.fields;
  const after = kept ? valueOf(kept, field) : undefined;
  const matches = same(after, value) || (field.type === "date" && after != null && value != null && String(after instanceof Date ? after.toISOString() : after).slice(0, 10) === String(value instanceof Date ? value.toISOString() : value).slice(0, 10)) || (field.type === "number" && value != null && after != null && Number(after) === Number(value));
  if (!matches) {
    if (field.native) await writer.update(orgId, ref.id, { [field.name]: before });
    else await writer.mergeMetadata!(orgId, ref.id, { [field.name]: before });
    throw new Error("This record could not keep that value. Its previous value was restored.");
  }
  const [module, entityType] = (await baseKindOf(orgId, ref.kind)).split(":");
  await activity.log({ orgId, userId, action: "updated", ref: { module: module ?? null, entityType: entityType ?? ref.kind, entityId: ref.id }, before: patchOf(field, before), diff: patchOf(field, after) });
  return { ...ref, title: rec.title, before, after };
}

export async function setBulkField(orgId: string, userId: string | null, refs: readonly BulkRef[], name: string, value: unknown): Promise<BulkFieldResult> {
  if (!refs.length || refs.length > 500) throw new Error("Choose between 1 and 500 records.");
  const field = (await commonBulkFields(orgId, refs.map((r) => r.kind))).find((f) => f.name === name);
  if (!field) throw new Error("Choose a writable field that every selected kind has.");
  const result: BulkFieldResult = { done: [], failed: [] };
  const kinds = new Map<string, BulkField[]>();
  for (const ref of new Map(refs.map((r) => [`${r.kind}::${r.id}`, r])).values()) {
    if (!kinds.has(ref.kind)) kinds.set(ref.kind, await fieldsFor(orgId, ref.kind));
  }
  for (const ref of new Map(refs.map((r) => [`${r.kind}::${r.id}`, r])).values()) {
    try { result.done.push(await change(orgId, userId, ref, kinds.get(ref.kind)!.find((f) => f.name === name)!, value)); }
    catch (err) {
      const rec = await platform().entities.lookup(orgId, ref.kind, ref.id, userId ? { userId, role: "admin" } : {}).catch(() => null);
      result.failed.push({ ...ref, title: rec?.title ?? ref.id, error: (err as Error).message });
    }
  }
  return result;
}

export async function restoreBulkField(orgId: string, userId: string | null, name: string, changes: readonly BulkFieldChange[]): Promise<BulkFieldResult> {
  if (!changes.length || changes.length > 500) throw new Error("Choose between 1 and 500 records.");
  const result: BulkFieldResult = { done: [], failed: [] };
  for (const row of changes) {
    try {
      const field = (await fieldsFor(orgId, row.kind)).find((f) => f.name === name);
      if (!field) throw new Error("This field is no longer writable.");
      result.done.push(await change(orgId, userId, row, field, row.before, row.after));
    } catch (err) { result.failed.push({ kind: row.kind, id: row.id, title: row.title, error: (err as Error).message }); }
  }
  return result;
}
