// The one place that knows where a kind's grouping axis is stored.
//
// Two owners of one question (#3223): the platform's scan routing grows a
// choice field with `field_role: "category"` on the table a scan lands in,
// while inventory keeps its own tree in `inventory_categories` that the parts
// list filters by. A part filed from a scan carried "Electrical" in the field
// and nothing in `category_id`, so the thing was categorised and unfindable by
// category. Neither store is wrong; having two of them is.
//
// So a kind may DECLARE that its axis is a native taxonomy
// (`inventory:part` -> `categoryAxis: "inventory:category"` in its manifest,
// #3225) and this seam answers for both shapes behind one type: rank against
// `values`, press `commit`, apply what comes back with `applyAxisValue`. No
// caller asks which storage it got.
//
// STEP 1 of three (#3223): the seam and its tests, with every kind still
// field-def backed, so it changes nothing observable. Step 2 moves the
// matchmaker and the scan confirm onto it (scan pipeline). Step 3 flips
// `inventory:part` to native, migrates the values that are already in the
// placeholder def, and drops the second Category from the create form.

import type { CategoryAxis, CategoryAxisAssignment, CategoryAxisSlot } from "@cobblr/platform-contract";
import { normaliseCategory } from "@cobblr/platform-contract/category-reconcile";
import { chooseAxisBacking, dedupeByKey } from "@cobblr/platform-contract/category-axis";
import { meta } from "../db/meta.js";
import { resolveFieldDefsForKind } from "./field-defs.js";
import { getEntityWriterFor, listAll as listAllEntities } from "./entities.js";
import { listEntries } from "../modules/registry.js";
import { ttlCache } from "../lib/ttl-cache.js";

/** How long an answer is reused. One menu assembly asks per kind per row, and
 *  a native read is a taxonomy listing; a few seconds turns that into one read
 *  without holding a stale vocabulary long enough for anyone to notice. A
 *  commit invalidates its own key, so a value confirmed a moment ago is in the
 *  next caller's `values` whatever this number is. */
const MEMO_MS = 3_000;
const memo = ttlCache<CategoryAxis | null>(MEMO_MS);
const keyOf = (orgId: string, kind: string, instance?: string | null) => `${orgId}|${kind}|${instance ?? ""}`;

/** Which entity kind holds this kind's taxonomy, when it declares one. Read
 *  from the MANIFEST (eager) rather than a runtime registry, the same reason
 *  the boot reconcile does: a lazy `api()` bundle has not run when this is
 *  first asked. */
export function nativeAxisKindFor(kind: string): string | null {
  for (const e of listEntries()) {
    const k = e.manifest.provides?.entityKinds?.find((x) => x.id === kind);
    if (k?.categoryAxis) return k.categoryAxis;
  }
  return null;
}

/** The native field that IS a kind's category (`categoryField`), when it
 *  declares one. Manifest-read for the same reason as nativeAxisKindFor. */
export function nativeAxisFieldFor(kind: string): string | null {
  for (const e of listEntries()) {
    const k = e.manifest.provides?.entityKinds?.find((x) => x.id === kind);
    if (k?.categoryField) return k.categoryField;
  }
  return null;
}

/** How many records a field-backed axis reads to learn its values. A
 *  category vocabulary is small; this bounds a workspace with many records. */
const FIELD_AXIS_SCAN = 2000;

/** The axis for a kind: the RULE decides which store answers (chooseAxisBacking,
 *  where the reasoning lives), and this fetches whatever that store holds. */
async function readAxis(orgId: string, kind: string): Promise<CategoryAxis | null> {
  const defs = await resolveFieldDefsForKind(orgId, kind);
  const backing = chooseAxisBacking(defs, nativeAxisKindFor(kind), nativeAxisFieldFor(kind));
  if (!backing) return null;
  if (backing.kind === "extras") return { label: backing.label, values: backing.values, slot: backing.slot };
  if (backing.kind === "field") {
    // The values are what the records already say, one per normalised key.
    const { items } = await listAllEntities(orgId, kind, { include_retired: true }, undefined, { cap: FIELD_AXIS_SCAN });
    const byKey = new Map<string, string>();
    for (const it of items) {
      const v = (it.fields as Record<string, unknown>)[backing.column];
      if (typeof v !== "string" || !v.trim()) continue;
      const key = normaliseCategory(v);
      if (key && !byKey.has(key)) byKey.set(key, v.trim());
    }
    return { label: "Category", values: [...byKey.values()].sort((a, b) => a.localeCompare(b)), slot: { kind: "field", column: backing.column } };
  }
  const writer = await getEntityWriterFor(orgId, backing.entityKind);
  const rows = (await writer?.listForMatch?.(orgId)) ?? [];
  const slot: CategoryAxisSlot = { kind: "native", column: "category_id", entityKind: backing.entityKind };
  return { label: "Category", values: dedupeByKey(rows).map((v) => v.name), slot };
}

export async function axisFor(args: { orgId: string; kind: string; instance?: string | null }): Promise<CategoryAxis | null> {
  const key = keyOf(args.orgId, args.kind, args.instance);
  try {
    return await memo.get(key, () => readAxis(args.orgId, args.kind));
  } catch (err) {
    // A workspace whose defs or taxonomy cannot be read ranks against nothing
    // rather than failing the scan that asked. Not memoised (a rejected load is
    // never kept): the next caller tries again rather than inheriting a
    // transient failure for 3s.
    console.error("[category-axis] read failed:", (err as Error).message);
    return null;
  }
}

export function forgetAxis(orgId: string, kind: string, instance?: string | null): void {
  memo.delete(keyOf(orgId, kind, instance));
}

export async function commitAxisValue(args: {
  orgId: string;
  kind: string;
  value: string;
  instance?: string | null;
}): Promise<CategoryAxisAssignment | null> {
  try {
    const value = args.value.trim();
    const key = normaliseCategory(value);
    if (!value || !key) return null;
    const axis = await axisFor(args);
    if (!axis) return null;
    if (axis.slot.kind === "field") {
      // Snap onto a spelling the records already use; a new one is simply
      // written, the field is its own vocabulary.
      const existing = axis.values.find((v) => normaliseCategory(v) === key);
      if (!existing) forgetAxis(args.orgId, args.kind, args.instance);
      return { slot: axis.slot, value: existing ?? value };
    }
    if (axis.slot.kind === "native") {
      const writer = await getEntityWriterFor(args.orgId, axis.slot.entityKind);
      if (!writer) return null;
      const rows = (await writer.listForMatch?.(args.orgId)) ?? [];
      const existing = dedupeByKey(rows).find((r) => normaliseCategory(r.name) === key);
      if (existing) return { slot: axis.slot, value: existing.id };
      // A value that was in no store is the normal case, not an error: the
      // caller ranked against proposals from its own batch.
      const id = await writer.create(args.orgId, { name: value, ...(args.instance ? { instance: args.instance } : {}) });
      forgetAxis(args.orgId, args.kind, args.instance);
      return { slot: axis.slot, value: id };
    }
    if (!axis.values.some((v) => normaliseCategory(v) === key)) {
      await meta
        .updateTable("module_field_defs")
        .set({ choices: JSON.stringify([...axis.values, value].sort((a, b) => a.localeCompare(b))) })
        .where("id", "=", axis.slot.defId)
        .execute();
      forgetAxis(args.orgId, args.kind, args.instance);
    }
    return { slot: axis.slot, value };
  } catch (err) {
    // Never fail the confirm that called this. A field-def PATCH that came
    // back non-ok has always been ignored here; a taxonomy that refuses a
    // create is the same situation and gets the same answer.
    console.error("[category-axis] commit failed, value dropped:", (err as Error).message);
    return null;
  }
}

/** The seam's `keep`: what to write for the value a record's slot already
 *  holds. Provenance is the slot's, so nothing here guesses whether a string
 *  is an id or a name from what it looks like: a taxonomy keyed by slugs has
 *  ids that read like names, and a format check cannot tell them apart. */
export async function keepAxisValue(args: {
  orgId: string;
  kind: string;
  value: string;
  instance?: string | null;
}): Promise<CategoryAxisAssignment | null> {
  try {
    const value = args.value.trim();
    if (!value) return null;
    const axis = await axisFor(args);
    if (!axis) return null;
    if (axis.slot.kind === "extras") {
      // A name somebody typed into the field. Grown into the vocabulary when
      // it can be; kept as typed when it cannot, as it always was.
      return (await commitAxisValue({ ...args, value })) ?? { slot: axis.slot, value };
    }
    if (axis.slot.kind === "field") return { slot: axis.slot, value };
    const writer = await getEntityWriterFor(args.orgId, axis.slot.entityKind);
    if (!writer) return null;
    const rows = (await writer.listForMatch?.(args.orgId)) ?? [];
    if (rows.some((r) => r.id === value)) return { slot: axis.slot, value };
    console.error(
      `[category-axis] ${args.kind}: the picked ${axis.slot.entityKind} ${value} is in no store (deleted since it was picked, or read off another kind); filing without it`,
    );
    return null;
  } catch (err) {
    console.error("[category-axis] keep failed, value dropped:", (err as Error).message);
    return null;
  }
}

/** The seam's `withdraw`: the inverse of `commit`, for an undo. A value goes
 *  only when no record of the kind files under it, checked in the store the
 *  records use: the category column on a native axis, the field's own key on
 *  a choice-backed one. Whatever a person filed under it since keeps it. */
export async function withdrawAxisValue(args: {
  orgId: string;
  kind: string;
  value: string;
  instance?: string | null;
}): Promise<"withdrawn" | "in-use" | "absent" | "unsupported"> {
  try {
    const key = normaliseCategory(args.value.trim());
    if (!key) return "absent";
    forgetAxis(args.orgId, args.kind, args.instance);
    const axis = await axisFor(args);
    if (!axis) return "unsupported";
    // A field-backed axis keeps no vocabulary apart from the records, so there
    // is nothing to take back: the value leaves with the last record using it.
    if (axis.slot.kind === "field") return "absent";
    if (axis.slot.kind === "native") {
      const writer = await getEntityWriterFor(args.orgId, axis.slot.entityKind);
      if (!writer) return "unsupported";
      const rows = (await writer.listForMatch?.(args.orgId)) ?? [];
      const found = rows.filter((r) => normaliseCategory(r.name) === key);
      if (!found.length) return "absent";
      for (const row of found) {
        const using = await listAllEntities(args.orgId, args.kind, { filter: { [axis.slot.column]: row.id }, include_retired: true }, undefined, { cap: 1 });
        if (using.items.length) return "in-use";
        // A category with categories under it is somebody's tree, not a leftover.
        if (rows.some((r) => r.parentId === row.id)) return "in-use";
      }
      for (const row of found) await writer.delete(args.orgId, row.id);
      forgetAxis(args.orgId, args.kind, args.instance);
      return "withdrawn";
    }
    const holds = axis.values.filter((v) => normaliseCategory(v) === key);
    if (!holds.length) return "absent";
    for (const v of holds) {
      const using = await listAllEntities(args.orgId, args.kind, { filter: { [axis.slot.name]: v }, include_retired: true }, undefined, { cap: 1 });
      if (using.items.length) return "in-use";
    }
    await meta
      .updateTable("module_field_defs")
      .set({ choices: JSON.stringify(axis.values.filter((v) => normaliseCategory(v) !== key)) })
      .where("id", "=", axis.slot.defId)
      .execute();
    forgetAxis(args.orgId, args.kind, args.instance);
    return "withdrawn";
  } catch (err) {
    console.error("[category-axis] withdraw failed, value kept:", (err as Error).message);
    return "in-use";
  }
}
