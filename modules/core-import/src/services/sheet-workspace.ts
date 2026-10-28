// The workspace as the spreadsheet planner needs to see it: every collection a
// sheet could land in (the ones it has, the ones it could install, a new one
// named after the sheet), each with its fields, plus the places and the
// records already there. Reads only.
//
// Collections come through the platform (instances, kinds, fields, the
// category axis) so the same picture can be built inside a background job
// that has no person's session. The install menu is the one thing only a
// route answers, so it is asked over the loopback with the caller's bearer
// and simply absent when there is none.

import { platform } from "@cobblr/platform-contract";
import { columnLabel, isWritableCustomField, isWritableNativeField } from "@cobblr/platform-contract/record-columns";
import type { ExistingRecord, KnownLocation, Target, TargetField } from "./sheet-plan.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";

interface KindField {
  name: string;
  type?: string;
  readOnly?: boolean;
  fieldRole?: string | null;
  money?: "cents" | "amount" | null;
}

interface KindRecordLike {
  id: string;
  module_name: string;
  instance_name?: string | null;
  display_name?: string;
  fields?: KindField[];
}

interface MenuEntry {
  module: string;
  instance: string;
  kind: string;
  noun: string;
  label: string;
  fields: Array<{ name: string; label: string; type: string; choices?: string[]; field_role?: string | null }>;
  scan_keywords?: string[];
  category_field?: { name?: string; label: string; values: string[] } | null;
  bundle_external_id: string;
}

function nativeFields(kind: KindRecordLike | undefined): TargetField[] {
  return (kind?.fields ?? [])
    .filter((f) => f.type !== "object" && f.type !== "image-path")
    .map((f) => ({ name: f.name, label: columnLabel(f.name), type: f.type === "url" ? "url" : (f.type ?? "text"), native: true, readOnly: !isWritableNativeField(f), field_role: f.fieldRole ?? null, money: f.money ?? null }));
}

export function instanceSlug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z0-9]/.test(s) ? s : `list-${s || "sheet"}`;
}

export interface LoopbackAuth {
  base: string;
  slug: string;
  token: string;
}

async function bundleMenu(auth: LoopbackAuth | null): Promise<MenuEntry[]> {
  if (!auth?.token) return [];
  const res = await apiFetch(`${auth.base}/api/v1/orgs/${auth.slug}/quickstart/bundle-menu`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  // A member-less or app-mode workspace has no menu; that is an empty list,
  // not a failure of the import.
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: MenuEntry[] };
  return body.items ?? [];
}

async function moduleLabel(auth: LoopbackAuth | null, name: string): Promise<string | null> {
  if (!auth?.token) return null;
  const res = await apiFetch(`${auth.base}/api/v1/orgs/${auth.slug}/modules`, { headers: { Authorization: `Bearer ${auth.token}` } });
  if (!res.ok) return null;
  const body = (await res.json()) as { items?: Array<{ name: string; displayName?: string }> };
  return body.items?.find((m) => m.name === name)?.displayName ?? null;
}

export interface WorkspacePicture {
  targets: Target[];
  locations: KnownLocation[];
}

export async function workspacePicture(orgId: string, auth: LoopbackAuth | null): Promise<WorkspacePicture> {
  const p = platform();
  const [instances, kinds, menu, locs] = await Promise.all([
    p.instances.list(orgId),
    p.entities.listKindsForOrg(orgId) as Promise<KindRecordLike[]>,
    bundleMenu(auth),
    p.entities.listAll(orgId, "core-locations:location", {}, undefined, { cap: 20_000 }).catch(() => ({ items: [] as never[] })),
  ]);

  // Every registered kind, not only those of modules already on: a collection
  // to install, or the general module to turn on, belongs to a module this
  // workspace may not have switched on yet.
  const registered = (await p.entities.listKinds()) as Array<KindRecordLike & { module_instanceability?: string }>;
  const baseKindOf = (module: string) =>
    kinds.find((k) => k.module_name === module && !k.instance_name) ?? registered.find((k) => k.module_name === module && !k.instance_name);
  const targets: Target[] = [];

  for (const inst of instances) {
    // Platform capabilities (places, files, tags) hold the workspace's
    // scaffolding, not its things; a list of things never lands there.
    if (inst.module_name.startsWith("core-")) continue;
    const base = baseKindOf(inst.module_name);
    if (!base) continue;
    const kind = inst.is_default ? base.id : `${inst.instance_name}:item`;
    // Only a collection something can write into is a place a sheet can go.
    if (!(await p.entities.getWriter(orgId, kind))) continue;
    const custom = await p.entities.fieldsFor(orgId, kind).catch(() => []);
    // import-swallow-ok: a read for the preview; a collection whose category
    // list cannot be read is offered without one, and nothing is written here.
    const axis = await p.categoryAxis.for({ orgId, kind, instance: inst.is_default ? null : inst.instance_name }).catch(() => null);
    const natives = nativeFields(base);
    targets.push({
      id: kind,
      kind,
      module: inst.module_name,
      instance: inst.instance_name,
      label: inst.display_name,
      noun: (inst as { config?: { item_noun?: string } }).config?.item_noun ?? inst.display_name,
      status: "existing",
      fields: [
        ...natives,
        ...custom
          .filter((f) => !natives.some((n) => n.name === f.name) && isWritableCustomField(f))
          .map((f) => ({ name: f.name, label: f.display_label, type: f.type, native: false, choices: f.choices ?? null, field_role: f.field_role ?? null, unit: f.unit ?? null })),
      ],
      counts: (base.fields ?? []).some((f) => f.name === "qty"),
      category: axis ? { label: axis.label, values: axis.values, ...(axis.slot.kind === "extras" ? { field: axis.slot.name } : {}) } : null,
    });
  }

  // The general table, where a list lands when nothing more specific fits:
  // the default collection of a module that keeps counts of things, found by
  // what the kind carries rather than by what the module is called.
  const general = targets.find((t) => t.counts && instances.some((i) => i.is_default && i.instance_name === t.instance));
  if (general) general.general = true;

  // A new workspace has no general table yet. The module that would be it
  // (instanceable, keeps counts: found by what its kind carries) is offered
  // to turn on, so a list that fits no collection still has a place to go.
  if (!targets.some((t) => t.general)) {
    const on = new Set(instances.map((i) => i.module_name));
    const candidate = registered.find(
      (k) => !k.instance_name && !on.has(k.module_name) && !k.module_name.startsWith("core-") && k.module_instanceability === "multi" && (k.fields ?? []).some((f) => f.name === "qty"),
    );
    if (candidate) {
      const label = (await moduleLabel(auth, candidate.module_name)) ?? columnLabel(candidate.module_name);
      targets.push({
        id: `enable:${candidate.module_name}`,
        kind: candidate.id,
        module: candidate.module_name,
        instance: candidate.module_name,
        label,
        noun: candidate.display_name ?? label,
        status: "enable",
        enable_module: { name: candidate.module_name, label },
        fields: nativeFields(candidate),
        general: true,
        counts: true,
        category: null,
      });
    }
  }

  const have = new Set(instances.map((i) => i.instance_name));
  for (const e of menu) {
    if (have.has(e.instance)) continue;
    const base = baseKindOf(e.module);
    if (!base) continue;
    const natives = nativeFields(base);
    targets.push({
      id: `install:${e.bundle_external_id}:${e.instance}`,
      kind: e.kind,
      module: e.module,
      instance: e.instance,
      label: e.label,
      noun: e.noun,
      status: "install",
      bundle_external_id: e.bundle_external_id,
      fields: [
        ...natives,
        ...e.fields.filter((f) => !natives.some((n) => n.name === f.name)).map((f) => ({ name: f.name, label: f.label, type: f.type, native: false, choices: f.choices ?? null, field_role: f.field_role ?? null })),
      ],
      ...(e.scan_keywords ? { scan_keywords: e.scan_keywords } : {}),
      counts: (base.fields ?? []).some((f) => f.name === "qty"),
      // Only a collection that declares a category field has somewhere to
      // file a category once installed; for the rest, the column brings its
      // own field (sheet-plan's new category field).
      category: e.category_field
        ? { label: e.category_field.label, values: e.category_field.values, ...(e.category_field.name ? { field: e.category_field.name } : {}) }
        : null,
    });
  }

  // Whether a collection can mark a thing as no longer yours (a sheet's Fate
  // column), asked of the module that would hold it.
  for (const t of targets) {
    const base = baseKindOf(t.module);
    // import-swallow-ok: a read for the preview; a collection whose writer
    // cannot be asked is offered as one that keeps the words only.
    const w = base ? await p.entities.getWriter(orgId, base.id).catch(() => null) : null;
    t.retires = typeof w?.retire === "function";
  }

  const locations: KnownLocation[] = (locs.items as Array<{ id: string; title: string; fields: Record<string, unknown> }>).map((l) => ({
    id: l.id,
    name: String(l.fields?.name ?? l.title),
    parent_id: (l.fields?.parent_id as string | null | undefined) ?? null,
  }));
  return { targets, locations };
}

/** A new collection named after the sheet, in the general module, for a list
 *  that is its own thing ("Tools", "Board games"). */
export function newCollectionTarget(sheetName: string, targets: Target[]): Target | null {
  const general = targets.find((t) => t.general);
  if (!general || /^sheet\s*\d*$/i.test(sheetName.trim())) return null;
  const label = sheetName.trim().slice(0, 80);
  let instance = instanceSlug(label);
  const taken = new Set(targets.map((t) => t.instance));
  for (let n = 2; taken.has(instance); n++) instance = `${instanceSlug(label)}-${n}`;
  return {
    id: `new:${instance}`,
    kind: `${instance}:item`,
    module: general.module,
    instance,
    label,
    noun: label,
    status: "new",
    ...(general.enable_module ? { enable_module: general.enable_module } : {}),
    fields: general.fields.filter((f) => f.native),
    counts: general.counts ?? false,
    ...(general.retires ? { retires: true } : {}),
    // A collection made a moment ago has no category field of its own yet.
    category: null,
  };
}

/** The records already in a collection, for matching rows to them, read as
 *  the person importing: a read with no reader leaves out every field a
 *  workspace hides from some role, so an owner's re-import of their own export
 *  saw those fields as empty and planned to "change" every row that had one.
 *  The export reading also includes native fields such as serial numbers;
 *  the person's field read scopes and secret masking still apply. */
export async function existingRecords(orgId: string, kind: string, viewer: { userId?: string; role?: string }): Promise<ExistingRecord[]> {
  const all = await platform().entities.listAll(orgId, kind, { include_retired: true }, { ...viewer, export: true }, { cap: 50_000 });
  return (all.items as Array<{ id: string; title: string; fields: Record<string, unknown> }>).map((r) => {
    const f = r.fields ?? {};
    const meta = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
    return { id: r.id, name: String(f.name ?? r.title ?? ""), values: { ...meta, ...f } };
  });
}
