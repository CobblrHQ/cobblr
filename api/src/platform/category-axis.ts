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
import { getEntityWriterFor } from "./entities.js";
import { listEntries } from "../modules/registry.js";

/** How long an answer is reused. One menu assembly asks per kind per row, and
 *  a native read is a taxonomy listing; a few seconds turns that into one read
 *  without holding a stale vocabulary long enough for anyone to notice. A
 *  commit invalidates its own key, so a value confirmed a moment ago is in the
 *  next caller's `values` whatever this number is. */
const MEMO_MS = 3_000;
const memo = new Map<string, { at: number; axis: CategoryAxis | null }>();
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

/** The axis for a kind: the RULE decides which store answers (chooseAxisBacking,
 *  where the reasoning lives), and this fetches whatever that store holds. */
async function readAxis(orgId: string, kind: string): Promise<CategoryAxis | null> {
  const defs = await resolveFieldDefsForKind(orgId, kind);
  const backing = chooseAxisBacking(defs, nativeAxisKindFor(kind));
  if (!backing) return null;
  if (backing.kind === "extras") return { label: backing.label, values: backing.values, slot: backing.slot };
  const writer = await getEntityWriterFor(orgId, backing.entityKind);
  const rows = (await writer?.listForMatch?.(orgId)) ?? [];
  const slot: CategoryAxisSlot = { kind: "native", column: "category_id", entityKind: backing.entityKind };
  return { label: "Category", values: dedupeByKey(rows).map((v) => v.name), slot };
}

export async function axisFor(args: { orgId: string; kind: string; instance?: string | null }): Promise<CategoryAxis | null> {
  const key = keyOf(args.orgId, args.kind, args.instance);
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.axis;
  let axis: CategoryAxis | null = null;
  try {
    axis = await readAxis(args.orgId, args.kind);
  } catch (err) {
    // A workspace whose defs or taxonomy cannot be read ranks against nothing
    // rather than failing the scan that asked. Not memoised: the next caller
    // tries again rather than inheriting a transient failure for 3s.
    console.error("[category-axis] read failed:", (err as Error).message);
    return null;
  }
  memo.set(key, { at: Date.now(), axis });
  return axis;
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
