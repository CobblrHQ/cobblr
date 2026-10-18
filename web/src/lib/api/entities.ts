import { fetchCsv, request } from "./client";
import { entityEndpointPath } from "@cobblr/platform-contract/entity-endpoints";
import type { PlatformResolvedEntity } from "./placement";
import type { ResolveOutcome as RegistryResolveOutcome } from "@cobblr/platform-contract/resolvables";

export interface ModuleInstance {
  id: string;
  org_id: string;
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
  config: Record<string, unknown>;
  created_at: string;
  /** Primary-item count for this instance; null if the module reports none. */
  item_count?: number | null;
  /** Whether this module registered an instance mover (records can be moved
   *  between its tables). The server has sent this since the mover shipped;
   *  the type just never caught up. */
  movable?: boolean;
  is_scan_fallback?: boolean;
}

export interface NavHeadingMember {
  target_kind: "module" | "instance";
  target_id: string;
  position: number;
}
export interface NavHeading {
  id: string;
  name: string;
  icon: string | null;
  position: number;
  members: NavHeadingMember[];
}

export interface EntityKindOverride {
  id: string;
  org_id: string;
  target_kind: "entity_kind" | "instance" | "bundle";
  target_id: string;
  display_label: string | null;
  display_label_plural: string | null;
  icon: string | null;
  hidden: boolean;
  nav_order: number | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ──────────── platform types (consumed by shared web components) ───

export interface PlatformEntityKind {
  id: string;
  module_name: string;
  display_name: string;
  display_name_plural: string | null;
  icon: string | null;
  fields: { name: string; type: string; label?: string; role?: string; choices?: string[] }[];
  /** Only on a ?readable_by=me read: the fields the asker may not read. */
  hidden_fields?: string[];
  detail_route: string | null;
  endpoints: { get?: string; list?: string; create?: string; update?: string; delete?: string } | null;
  /** Set on registry records synthesized for a workspace's named instances
   *  (`<instance>:item`): endpoints are then relative to
   *  /instances/<instance_name>, not /modules/<module_name>. */
  instance_name?: string;
  version: string;
  /** Resolved 6-axis trait fingerprint (null if the kind declared none). */
  traits: Record<string, string | null | { trait: string; uncertain: true }> | null;
  /** Preset name if declared via shorthand. */
  profile: string | null;
}

export const entitiesApi = {

  /** Escape hatch for ad-hoc reads from pages that don't deserve a
   *  dedicated method (e.g. dashboard snapshot widgets that hit a
   *  module's own routes). Avoid in module code — modules go through
   *  the platform contract. */
  /** Where a record lives, decided by its own collection (the open door). */
  recordAddress: (slug: string, kind: string, id: string) =>
    request<{ path: string }>("GET", `/orgs/${slug}/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/address`),

  listEntityKinds: (slug: string) =>
    request<{ items: PlatformEntityKind[] }>("GET", `/orgs/${slug}/entity-kinds`),
  /** The kinds as the asker may read them: fields behind a read scope they lack are left out and named in hidden_fields. */
  listEntityKindsReadable: (slug: string) =>
    request<{ items: PlatformEntityKind[] }>("GET", `/orgs/${slug}/entity-kinds?readable_by=me`),
  createKindRecord: async (slug: string, kind: string, fields: Record<string, unknown>): Promise<{ id: string }> => {
    const kinds = await request<{ items: PlatformEntityKind[] }>("GET", `/orgs/${slug}/entity-kinds`);
    const path = entityEndpointPath(kinds.items.find(item => item.id === kind), "create");
    if (!path) throw new Error("This collection does not offer adding a record here.");
    return request<{ id: string }>("POST", `/orgs/${slug}/${path}`, fields);
  },
  /** The fields an edit form for a kind may offer this member (GET
   *  /:slug/editable-fields): none when the kind cannot be edited from an
   *  app or the member lacks its grant. */
  listEditableFields: (slug: string, kind: string) =>
    request<{ updatable: boolean; can_edit: boolean; fields: import("@cobblr/platform-web").BulkFieldOption[] }>("GET", `/orgs/${slug}/editable-fields?kind=${encodeURIComponent(kind)}`),
  lookupEntity: (slug: string, kind: string, id: string) =>
    request<PlatformResolvedEntity>("GET", `/orgs/${slug}/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`),
  /** Generic entity list — the data source for relation-field pickers and any
   *  cross-module chooser. Projected through exposableFields like lookup. */
  /** A collection as a spreadsheet, read as the viewer. */
  exportEntitiesCsv: (slug: string, kind: string, q?: string, includeSecrets = false) => {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (includeSecrets) query.set("include_secrets", "true");
    return fetchCsv(`/orgs/${slug}/entities/${encodeURIComponent(kind)}/export.csv${query.size ? `?${query}` : ""}`);
  },
  listEntities: (slug: string, kind: string, q?: string) =>
    request<{ items: PlatformResolvedEntity[] }>(
      "GET",
      `/orgs/${slug}/entities/${encodeURIComponent(kind)}${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    ),

  /** Which faces a collection wears: what a record shows beyond the base. */
  listFaces: (slug: string, kind: string) =>
    request<{ kind: string; traits: Record<string, string>; faces: string[]; explicit: string[]; offers?: string[] }>(
      "GET",
      `/orgs/${slug}/faces?kind=${encodeURIComponent(kind)}`,
    ),
  setRecordActionPin: (slug: string, kind: string, action: string, pinned: boolean) => request<void>("PUT", `/orgs/${slug}/record-action-pins`, { kind, action, pinned }),
  recordPanelLayout: (slug: string, kind: string) => request<{ layout: import("@cobblr/platform-contract/record-panel-layout").RecordPanelLayout; revision: number }>("GET", `/orgs/${slug}/record-panel-layout?kind=${encodeURIComponent(kind)}`),
  recordActionLayout: (slug: string, kind: string) => request<{ layout: import("@cobblr/platform-contract/action-groups").RecordActionLayout; revision: number; pins: Record<string, boolean> }>("GET", `/orgs/${slug}/record-action-layout?kind=${encodeURIComponent(kind)}`),
  /** The relationship kinds in use here, most used first; with a kind, those
   *  touching it and which way. */
  listRelationshipKinds: (slug: string, kind?: string) =>
    request<{ items: { relationship: string; count: number; out: number; in: number }[] }>(
      "GET",
      `/orgs/${slug}/relationship-kinds${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),

  // Field defs (Pillar D-lite)
  // `effective` applies the user override layer (relabel / hide / reorder) — forms
  // + lists pass it; config surfaces (Fields, composer) read the raw defs.
  revealSecretField: (slug: string, kind: string, id: string, field: string, operation: "reveal" | "copy") =>
    request<{ value: string }>("POST", `/orgs/${slug}/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/fields/${encodeURIComponent(field)}/reveal`, { operation }),
  /** The presence-declared record panels that have something to show on one
   *  record (#6337). */
  panelPresence: (slug: string, kind: string, id: string, collection?: string | null) =>
    request<{ present: string[] }>("GET", `/orgs/${slug}/panel-presence?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}${collection ? `&collection=${encodeURIComponent(collection)}` : ""}`),

  // Instances (workspace_module_instances) — multi-instance modules.
  // A workspace can install one module multiple times under different
  // names. See docs/architecture/instances.md.
  setScanFallback: (slug: string, instance: string) =>
    request<ModuleInstance>("POST", `/orgs/${slug}/instances/${instance}/scan-fallback`, {}),

  listInstances: (slug: string, moduleName?: string) =>
    request<{ items: ModuleInstance[] }>(
      "GET",
      `/orgs/${slug}/instances${moduleName ? `?module=${encodeURIComponent(moduleName)}` : ""}`,
    ),
  createInstance: (
    slug: string,
    body: { module_name: string; instance_name: string; display_name: string },
  ) =>
    request<ModuleInstance>("POST", `/orgs/${slug}/instances`, body),
  deleteInstance: (slug: string, instanceName: string) =>
    request<void>("DELETE", `/orgs/${slug}/instances/${instanceName}`),

  // Nav-builder #2 — user-defined navbar headings (org-wide). Group nav
  // entries (modules + instances) under custom headings, cross-module.
  // See docs/architecture/nav-builder.md.
  listNavHeadings: (slug: string) =>
    request<{ items: NavHeading[] }>("GET", `/orgs/${slug}/nav-headings`),
  createNavHeading: (slug: string, body: { name: string; icon?: string | null }) =>
    request<{ id: string }>("POST", `/orgs/${slug}/nav-headings`, body),
  updateNavHeading: (
    slug: string,
    id: string,
    body: { name?: string; icon?: string | null; position?: number },
  ) => request<void>("PATCH", `/orgs/${slug}/nav-headings/${id}`, body),
  deleteNavHeading: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/nav-headings/${id}`),
  addNavHeadingMember: (
    slug: string,
    headingId: string,
    body: { target_kind: "module" | "instance"; target_id: string },
  ) => request<void>("POST", `/orgs/${slug}/nav-headings/${headingId}/members`, body),
  removeNavHeadingMember: (slug: string, targetKind: string, targetId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/nav-headings/members/${encodeURIComponent(targetKind)}/${encodeURIComponent(targetId)}`,
    ),

  // Workspace presentation overrides — rename / hide / re-icon / reorder
  // for any nav entry (entity kind, instance, bundle).
  listOverrides: (slug: string) =>
    request<{ items: EntityKindOverride[] }>(
      "GET",
      `/orgs/${slug}/entity-kind-overrides`,
    ),
  upsertOverride: (
    slug: string,
    body: {
      target_kind: "entity_kind" | "instance" | "bundle";
      target_id: string;
      display_label?: string | null;
      display_label_plural?: string | null;
      icon?: string | null;
      hidden?: boolean;
      nav_order?: number | null;
      config?: Record<string, unknown>;
    },
  ) =>
    request<EntityKindOverride>("PUT", `/orgs/${slug}/entity-kind-overrides`, body),
  deleteOverride: (slug: string, targetKind: string, targetId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/entity-kind-overrides/${encodeURIComponent(targetKind)}/${encodeURIComponent(targetId)}`,
    ),
  // core-scan — barcode + photo identification, generalized. See
  // docs/modules/core-scan.md.
  /** File a scanned code as a UNIT (serial) of a model, from the scanner's
   *  ?unitOf flow — the mint endpoint on inventory's parts router. Instance vs
   *  default picks the path (parts vs instance items). Does not touch the
   *  model's qty; see docs/design-decisions/within-instance-units.md. */
  mintScannedUnit: (
    slug: string,
    args: { modelId: string; instance?: string | null; serial: string },
  ) =>
    request<{ id: string; name: string; serial_number: string | null }>(
      "POST",
      args.instance
        ? `/orgs/${slug}/instances/${args.instance}/items/${args.modelId}/units`
        : `/orgs/${slug}/modules/inventory/parts/${args.modelId}/units`,
      { serial_number: args.serial },
    ),
  /** The resolvable registry (docs/design-decisions/resolvable-registry.md): what
   *  a value could mean on a surface. The palette uses surface:"palette" to rank
   *  an exact identifier hit above fuzzy text results. */
  resolveOnSurface: (slug: string, value: string, surface: "scan" | "palette" | "search") =>
    request<RegistryResolveOutcome>("POST", `/orgs/${slug}/resolve`, { value, surface }),
};
