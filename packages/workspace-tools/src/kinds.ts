// Entity-kind plumbing shared by the tools: fetch the workspace's kinds and
// resolve which REST route creates/updates/deletes a given kind. Manifest
// declarations (createEndpoint / updateEndpoint / deleteEndpoint, stored in
// entity_kinds.endpoints by registry-sync) are the source of truth; the pinned
// map covers kinds that predate the declaration. NO guessing from getEndpoint —
// a kind with no declared route is honestly not writable this way, instead of
// being advertised and 404ing at execute time.

import type { WorkspaceApi } from "./api.js";

export interface KindRec {
  id: string;
  display_name?: string;
  display_name_plural?: string | null;
  module_name?: string;
  endpoints?: { get?: string; list?: string; create?: string; update?: string; delete?: string } | null;
  /** Set on registry records synthesized for a workspace's named instances
   *  (`<instance>:item`): endpoints are then relative to
   *  /instances/<instance_name>, not /modules/<module_name>. */
  instance_name?: string;
  fields?: Array<{ name: string; type?: string; role?: string; required?: boolean }>;
  /** This workspace's user-defined fields (module_field_defs). Values live in
   *  the record's metadata blob; the writers fold unknown body keys there, so
   *  these names are directly settable on create/update. */
  custom_fields?: Array<{
    name: string;
    label?: string;
    type?: string;
    required?: boolean;
    choices?: string[];
  }>;
}

/** Kinds whose create route predates the manifest `createEndpoint` declaration.
 *  Frozen — declare `createEndpoint` on the kind instead of adding rows.
 *  Values are ROOT-PREFIXED org-relative paths (like every resolver below):
 *  "modules/…" for manifest kinds, "instances/…" for synthesized ones. */
export const LEGACY_CREATE_PATHS: Record<string, string> = {
  "inventory:part": "modules/inventory/parts",
  "machines:machine": "modules/machines/machines",
  "assets:asset": "modules/assets/assets",
  "projects:project": "modules/projects/projects",
  "projects:task": "modules/projects/tasks",
  "lists:list": "modules/lists/lists",
  "lists:item": "modules/lists/items",
};

/** The org-relative ROOT for a kind's endpoints: a synthesized instance kind
 *  lives under /instances/<name>, everything else under /modules/<module>. */
function rootOf(rec: KindRec): string | null {
  if (rec.instance_name) return `instances/${rec.instance_name}`;
  return rec.module_name ? `modules/${rec.module_name}` : null;
}

export async function fetchKinds(api: WorkspaceApi): Promise<KindRec[]> {
  // include=custom_fields: older cores ignore the unknown param and return the
  // same payload without the extra key, so this degrades cleanly.
  const res = await api.request("GET", "/entity-kinds?include=custom_fields");
  return ((res.body.items as KindRec[] | undefined) ?? []).filter((k) => !!k.id);
}

/** Org-relative POST path ("modules/…" | "instances/…") that creates one
 *  record of `kind`, or null. */
export function resolveCreatePath(kind: string, kinds: KindRec[]): string | null {
  const rec = kinds.find((k) => k.id === kind);
  const create = rec?.endpoints?.create;
  const root = rec ? rootOf(rec) : null;
  if (root && create) return `${root}/${create.replace(/^\//, "")}`;
  return kind in LEGACY_CREATE_PATHS ? LEGACY_CREATE_PATHS[kind]! : null;
}

/** Org-relative PATCH path for one record ({id} substituted), or null when
 *  the kind declares no update route. */
export function resolveUpdatePath(kind: string, id: string, kinds: KindRec[]): string | null {
  return resolveIdPath(kind, id, kinds, "update");
}

/** Org-relative DELETE path for one record, or null. */
export function resolveDeletePath(kind: string, id: string, kinds: KindRec[]): string | null {
  return resolveIdPath(kind, id, kinds, "delete");
}

function resolveIdPath(kind: string, id: string, kinds: KindRec[], which: "update" | "delete"): string | null {
  const rec = kinds.find((k) => k.id === kind);
  const tmpl = rec?.endpoints?.[which];
  const root = rec ? rootOf(rec) : null;
  if (!root || !tmpl) return null;
  return `${root}/${tmpl.replace(/^\//, "").replace("{id}", encodeURIComponent(id))}`;
}

/** A compact, model-facing summary of one kind. */
export function summarizeKind(k: KindRec): Record<string, unknown> {
  return {
    id: k.id,
    name: k.display_name ?? k.id,
    module: k.module_name,
    fields: (k.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type ?? "text",
      ...(f.required || f.role === "title" ? { required: true } : {}),
      ...(f.role ? { role: f.role } : {}),
    })),
    // User-defined fields — settable like native ones (values land in the
    // record's metadata; the API folds unknown keys there on write).
    ...(k.custom_fields?.length
      ? {
          custom_fields: k.custom_fields.map((f) => ({
            name: f.name,
            ...(f.label && f.label !== f.name ? { label: f.label } : {}),
            type: f.type ?? "text",
            ...(f.required ? { required: true } : {}),
            ...(f.choices?.length ? { choices: f.choices } : {}),
          })),
        }
      : {}),
    can_create: null as boolean | null, // filled by the tool with full kind context
    can_update: !!k.endpoints?.update,
    can_delete: !!k.endpoints?.delete,
  };
}
