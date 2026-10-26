// The end of a recount (#6302): seen, new and not seen, previewed before
// anything changes, then applied in one step with one Undo.
//
// "The scan is the truth" (the owner's "overwrite") is a switch on the
// screen. On: what was not seen is gone, and places and amounts come from the
// scans. Off: what was not seen is kept, and seen records stay as recorded.
// Either way every not-seen record can be decided one by one (mark gone, keep,
// or still out, check later) and every new thing added or skipped, and the
// preview shows exactly what Apply writes.
//
// Every write goes through the door that owns it, the same doors a person's
// own presses use: gone through the disposition door ("gone, not recorded
// how", which never feeds shelf-life learning), a move through placement, an
// amount as a correction on the lots, a new thing through inventory's own
// create. A recount never deletes: Undo brings gone things back, moves and
// amounts back, and marks what it added gone, each with its history.
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { ActionRefusal, platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { actionActed } from "@cobblr/platform-contract/action-result";
import { countOf } from "@cobblr/platform-contract/plural";
import type { InventoryDB } from "./db.js";
import { bringAllBack, markAllGone, refuseOverLaterChange, setCount, unsetCount } from "./reconcile-engine.js";
import { withRecountLock } from "./recount-lock.js";
import { expectedOf, familyOfCollection } from "./recount.js";

const PART = "inventory:part";
const LOCATION = "core-locations:location";
const db = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;

export type NotSeenChoice = "gone" | "keep" | "later";
export type NewChoice = "add" | "skip";

export interface ReconcileInput {
  preview?: unknown;
  truth?: unknown;
  /** Per not-seen record: gone, keep or later. */
  not_seen?: unknown;
  /** One choice for every not-seen record not decided one by one. */
  not_seen_all?: unknown;
  /** Per new scan: add or skip. */
  new?: unknown;
}

export interface ReconcilePlan {
  preview: string;
  id: string;
  label: string;
  truth: boolean;
  seen: Array<{ id: string; kind: string; title: string; move: { from: string | null; to: string; to_name: string | null } | null; amount: { before: number; after: number; unit: string } | null }>;
  new: Array<{ scan_id: string; title: string; like_id: string | null; like_type_id: string | null; place_id: string | null; amount: number | null; choice: NewChoice }>;
  not_seen: Array<{ id: string; kind: string; title: string; place: string | null; choice: NotSeenChoice }>;
  counts: { seen: number; moved: number; counted: number; added: number; gone: number; kept: number; later: number };
}

/** What an apply wrote, kept on the recount for its Undo. */
export interface RecountApplied {
  gone: Array<{ id: string; kind: string; title: string }>;
  moved: Array<{ id: string; title: string; from: { kind: string; id: string } | null; to: string }>;
  counted: Array<{ id: string; title: string; before: number; after: number; unit: string }>;
  added: Array<{ id: string; kind: string; title: string }>;
  later: Array<{ id: string; title: string }>;
}

const choiceMap = <T extends string>(raw: unknown, allowed: readonly T[]): Map<string, T> => {
  const out = new Map<string, T>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" && (allowed as readonly string[]).includes(v)) out.set(k, v as T);
  }
  return out;
};

export async function planReconcile(orgId: string, id: string, input: ReconcileInput): Promise<ReconcilePlan> {
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_recounts").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new ActionRefusal("That recount no longer exists.");
  if (row.status !== "open") throw new ActionRefusal(`The recount of ${row.scope_label} is already finished.`);
  const truth = input.truth === true || input.truth === "true";
  const all = typeof input.not_seen_all === "string" && ["gone", "keep", "later"].includes(input.not_seen_all) ? (input.not_seen_all as NotSeenChoice) : null;
  const perRecord = choiceMap<NotSeenChoice>(input.not_seen, ["gone", "keep", "later"]);
  const perNew = choiceMap<NewChoice>(input.new, ["add", "skip"]);

  const expected = await expectedOf(orgId, row.scope);
  const scans = await t.selectFrom("inventory_recount_scans").selectAll().where("recount_id", "=", id).orderBy("created_at").orderBy("id").execute();
  const byRecord = new Map(scans.filter((s) => s.record_id).map((s) => [s.record_id!, s]));
  const ids = expected.map((e) => e.id);
  const located = new Map(ids.length ? (await t.selectFrom("inventory_parts").select(["id", "location_id"]).where("id", "in", ids).execute()).map((r) => [r.id, r.location_id]) : []);
  const placeIds = [...new Set(scans.map((s) => s.place_id).filter((p): p is string => !!p))];
  const placeNames = new Map((await platform().entities.lookupMany(orgId, placeIds.map((p) => ({ kind: LOCATION, id: p })))).map((e) => [e.id, e.title]));

  const seen: ReconcilePlan["seen"] = [];
  const notSeen: ReconcilePlan["not_seen"] = [];
  for (const e of expected) {
    const s = byRecord.get(e.id);
    if (!s) {
      notSeen.push({ id: e.id, kind: e.kind, title: e.title, place: e.place, choice: perRecord.get(e.id) ?? all ?? (truth ? "gone" : "keep") });
      continue;
    }
    const to = truth && s.place_id && s.place_id !== located.get(e.id) ? s.place_id : null;
    const after = s.amount == null ? null : Number(s.amount);
    seen.push({
      id: e.id,
      kind: e.kind,
      title: e.title,
      move: to ? { from: located.get(e.id) ?? null, to, to_name: placeNames.get(to) ?? null } : null,
      amount: truth && after != null && after !== e.qty ? { before: e.qty, after, unit: e.unit } : null,
    });
  }
  const fresh = scans
    .filter((s) => !s.record_id)
    .map((s) => ({ scan_id: s.id, title: s.title, like_id: s.like_id, like_type_id: s.like_type_id ?? null, place_id: s.place_id, amount: s.amount == null ? null : Number(s.amount), choice: perNew.get(s.id) ?? ("add" as NewChoice) }));
  const plan: Omit<ReconcilePlan, "preview"> = {
    id,
    label: row.scope_label,
    truth,
    seen,
    new: fresh,
    not_seen: notSeen,
    counts: {
      seen: seen.length,
      moved: seen.filter((s) => s.move).length,
      counted: seen.filter((s) => s.amount).length,
      added: fresh.filter((n) => n.choice === "add").length,
      gone: notSeen.filter((n) => n.choice === "gone").length,
      kept: notSeen.filter((n) => n.choice === "keep").length,
      later: notSeen.filter((n) => n.choice === "later").length,
    },
  };
  return { ...plan, preview: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

/** The preview's one line: what Apply does. */
export function planLine(p: ReconcilePlan): string {
  const parts = [
    `${p.counts.seen} seen`,
    p.counts.moved ? `${p.counts.moved} moved` : null,
    p.counts.counted ? `${p.counts.counted} recounted` : null,
    p.counts.added ? `${p.counts.added} added` : null,
    p.counts.gone ? `${countOf(p.counts.gone, "thing")} marked gone` : null,
    p.counts.later ? `${p.counts.later} to check later` : null,
  ].filter(Boolean);
  return parts.join(", ");
}


/** Run from the apply action, whose context the new things are added under. */
export async function applyRecount(ctx: ActionInvokeContext, id: string, input: ReconcileInput): Promise<{ label: string; applied: RecountApplied; line: string }> {
  const { orgId } = ctx;
  const userId = ctx.userId ?? null;
  const t = await db(orgId);
  const plan = await withRecountLock(orgId, id, async trx => {
    const next = await planReconcile(orgId, id, input);
    if (input.preview != null && input.preview !== next.preview) throw new ActionRefusal("This recount changed. Review the new preview before applying it.");
    const claimed = await trx.updateTable("inventory_recounts").set({ status: "applied", truth: next.truth, applied_at: new Date(), applied_by: userId }).where("id", "=", id).where("status", "=", "open").executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) throw new ActionRefusal(`The recount of ${next.label} is already finished.`);
    return next;
  });
  const applied: RecountApplied = { gone: [], moved: [], counted: [], added: [], later: plan.not_seen.filter((n) => n.choice === "later").map((n) => ({ id: n.id, title: n.title })) };
  try {
    // Gone and counted through the one engine What's still here? ends
    // through too (reconcile-engine.ts): never a second idea of either.
    const gone = plan.not_seen.filter((n) => n.choice === "gone").map((g) => ({ id: g.id, kind: g.kind, title: g.title }));
    await markAllGone(orgId, userId, gone, `Recount of ${plan.label}`);
    applied.gone.push(...gone);
    for (const s of plan.seen.filter((x) => x.move)) {
      const from = await platform().placement.containerOf({ orgId, containee: { kind: PART, id: s.id } });
      await platform().placement.place({ orgId, containee: { kind: PART, id: s.id }, container: { kind: LOCATION, id: s.move!.to }, placedBy: userId, via: "recount" });
      applied.moved.push({ id: s.id, title: s.title, from: from ? { kind: from.kind, id: from.id } : null, to: s.move!.to });
    }
    for (const s of plan.seen.filter((x) => x.amount)) {
      const { before, after, unit } = s.amount!;
      await setCount(orgId, userId, { id: s.id, title: s.title, before, after }, { kind: "recount", id }, "recount");
      applied.counted.push({ id: s.id, title: s.title, before, after, unit });
    }
    const instance = (await t.selectFrom("inventory_recounts").select("scope").where("id", "=", id).executeTakeFirstOrThrow()).scope.collection;
    // Things of a type collection (Spools of Filament Types) are added under
    // their type: from a thing like them, or from the type they read as, with
    // the type's key and copied fields, then lifted to it the way a scanned
    // spool is (inventory:lift-to-type).
    const family = await familyOfCollection(orgId, instance);
    const childUnit = family ? ((await platform().instances.configOf(orgId, instance)) ?? {}).qty_unit : null;
    for (const n of plan.new.filter((x) => x.choice === "add")) {
      const like = n.like_id ? await t.selectFrom("inventory_parts").select(["name", "manufacturer", "metadata", "unit", "image_path"]).where("id", "=", n.like_id).executeTakeFirst() : null;
      const type = !like && n.like_type_id && family ? await t.selectFrom("inventory_parts").select(["name", "manufacturer", "metadata", "image_path"]).where("id", "=", n.like_type_id).executeTakeFirst() : null;
      const meta: Record<string, unknown> = { ...((like?.metadata ?? {}) as Record<string, unknown>) };
      if (type && family) {
        const typeMeta = (type.metadata ?? {}) as Record<string, unknown>;
        for (const key of [...family.keyFields, ...family.copyFields]) if (typeMeta[key] != null && key !== "manufacturer") meta[key] = typeMeta[key];
      }
      for (const key of ["barcode", "upc", "ean"]) delete meta[key];
      const made = (await platform().actions.invoke("inventory:create-item", {
        ...ctx,
        entity: undefined,
        scope: "workspace",
        args: {
          name: like?.name ?? type?.name ?? n.title,
          instance: instance === "inventory" ? undefined : instance,
          ...((like?.manufacturer ?? type?.manufacturer) ? { manufacturer: like?.manufacturer ?? type?.manufacturer } : {}),
          ...(like?.unit ? { unit: like.unit } : typeof childUnit === "string" && childUnit ? { unit: childUnit } : {}),
          ...((like?.image_path ?? type?.image_path) ? { image_path: like?.image_path ?? type?.image_path } : {}),
          fields: meta,
          qty: n.amount ?? 1,
          ...(n.place_id ? { location_id: n.place_id } : {}),
        },
      })) as { ok?: boolean; item_id?: string; error?: string };
      if (!made?.ok || !made.item_id) throw new ActionRefusal(made?.error ?? `${n.title} could not be added.`);
      applied.added.push({ id: made.item_id, kind: instance === "inventory" ? PART : `${instance}:item`, title: like?.name ?? type?.name ?? n.title });
    }
    if (family && applied.added.length && family.keyFields.length) {
      const lifted = await platform().actions.invoke("inventory:lift-to-type", {
        ...ctx,
        entity: undefined,
        scope: "workspace",
        args: {
          source_instance: instance,
          type_instance: family.parent,
          key_fields: family.keyFields,
          copy_fields: family.copyFields,
          relationship_kind: family.rel,
          source_ids: applied.added.map((a) => a.id),
        },
      });
      // Added but not under its type is the flat row this exists to prevent.
      if (!actionActed(lifted)) throw new ActionRefusal("The new things could not be put under their kinds, so nothing was changed. Try again.");
    }
  } catch (err) {
    // Put back what this apply already wrote, then say why it stopped.
    await reverse(orgId, userId, applied).catch(() => {});
    await t.updateTable("inventory_recounts").set({ status: "open", applied_at: null, applied_by: null }).where("id", "=", id).execute();
    throw err;
  }
  await t.updateTable("inventory_recounts").set({ applied: JSON.stringify(applied) as never, updated_at: new Date() }).where("id", "=", id).execute();
  const line = planLine(plan);
  await platform().activity.log({
    orgId,
    userId,
    action: "recount_applied",
    ref: { module: "inventory", entityType: "recount", entityId: id },
    diff: { name: plan.label, collection: (await t.selectFrom("inventory_recounts").select("scope").where("id", "=", id).executeTakeFirstOrThrow()).scope.collection, seen: plan.counts.seen, moved: applied.moved.length, counted: applied.counted.length, added: applied.added.length, gone: applied.gone.length, later: applied.later.length },
  });
  return { label: plan.label, applied, line };
}

/** Everything an apply wrote, put back: gone things listed again, moves and
 *  amounts back, things it added marked gone. Records deleted since are left alone. */
async function reverse(orgId: string, userId: string | null, applied: RecountApplied): Promise<number> {
  const t = await db(orgId);
  const ids = [...applied.gone.map((g) => g.id), ...applied.moved.map((m) => m.id), ...applied.counted.map((c) => c.id), ...applied.added.map((a) => a.id)];
  const present = new Set(ids.length ? (await t.selectFrom("inventory_parts").select("id").where("id", "in", ids).execute()).map((r) => r.id) : []);
  let back = 0;
  back += await bringAllBack(orgId, userId, applied.gone.filter((g) => present.has(g.id)));
  for (const m of applied.moved.filter((x) => present.has(x.id))) {
    if (m.from) await platform().placement.place({ orgId, containee: { kind: PART, id: m.id }, container: m.from, placedBy: userId, via: "recount undone" });
    else await platform().placement.remove({ orgId, containee: { kind: PART, id: m.id } });
    back += 1;
  }
  for (const c of applied.counted.filter((x) => present.has(x.id))) {
    await unsetCount(orgId, userId, c, { kind: "recount", id: null }, "recount undone");
    back += 1;
  }
  const added = applied.added.filter((a) => present.has(a.id));
  await markAllGone(orgId, userId, added, "Recount undone");
  back += added.length;
  return back;
}

const touchedBy = (a: RecountApplied): string[] => [...a.gone, ...a.moved, ...a.counted, ...a.added].map((r) => r.id);

export async function undoRecount(orgId: string, userId: string | null, id: string): Promise<{ label: string; back: number }> {
  const t = await db(orgId);
  const row = await t.selectFrom("inventory_recounts").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new ActionRefusal("That recount no longer exists.");
  if (row.status !== "applied" || !row.applied) throw new ActionRefusal(row.status === "undone" ? `The recount of ${row.scope_label} is already undone.` : `The recount of ${row.scope_label} has not been applied.`);
  await refuseOverLaterChange(orgId, userId, { entityId: id, action: "recount_applied" }, touchedBy(row.applied));
  const claimed = await t.updateTable("inventory_recounts").set({ status: "undone", undone_at: new Date(), undone_by: userId }).where("id", "=", id).where("status", "=", "applied").executeTakeFirst();
  if (!Number(claimed.numUpdatedRows)) throw new ActionRefusal(`The recount of ${row.scope_label} is already undone.`);
  let back: number;
  try {
    back = await reverse(orgId, userId, row.applied);
  } catch (err) {
    await t.updateTable("inventory_recounts").set({ status: "applied", undone_at: null, undone_by: null }).where("id", "=", id).execute();
    throw err;
  }
  await platform().activity.log({ orgId, userId, action: "recount_undone", ref: { module: "inventory", entityType: "recount", entityId: id }, diff: { name: row.scope_label, collection: row.scope.collection, back } });
  return { label: row.scope_label, back };
}
