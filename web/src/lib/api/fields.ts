import type { FieldDefType, FieldRole } from "@cobblr/platform-contract/field-vocabulary";
import type { CatalogFieldRenderer } from "./catalogs";
import { request } from "./client";
import type { FieldValuesUsedBody } from "@cobblr/platform-web";

/** A named set of role-tagged fields a workspace can switch on in one click.
 *  See docs/design-decisions/field-presets.md. */
export interface FieldPresetState {
  key: string;
  label: string;
  hint: string;
  traits: string[];
  /** `partial` is real: some of the fields exist, and switching on adds the rest. */
  status: "on" | "off" | "partial";
  present: number;
  total: number;
  fields: Array<{ name: string; display_label: string; present: boolean }>;
}

export interface NativeFieldOverride {
  id: string;
  org_id: string;
  entity_kind: string;
  name: string;
  display_label: string | null;
  hidden: boolean;
  position: number;
  bundle_id: string | null;
  source_module: string | null;
  /** 1b — open-ended presentation overrides; `choices` overrides the dropdown. */
  overrides: { choices?: string[] };
  created_at: string;
  updated_at: string;
}

/** A field SCOPE — a class of entity kinds a field def can be attached to
 *  instead of one kind ("all physical items"). The vocabulary is closed and
 *  owned by the server (it matches on each kind's declared traits); the client
 *  only ever names a scope by `key`, never describes one. Served on the
 *  no-kind field-defs read. */
export interface FieldScope {
  /** The canonical sentinel, e.g. "@physical" / "@physical+unique". */
  key: string;
  label: string;
  hint: string;
  /** The trait words this preset selects — what the picker ticks. */
  traits?: string[];
  /** "broad" = a loose one/two-axis scope ("anything physical").
   *  "profile" = a full 6-axis fingerprint, the named shapes modules declare
   *  their own kinds as ("owned-thing"). Rendered as two separate groups. */
  group?: "broad" | "profile";
}

export interface PlatformFieldDef {
  /** Owning bundle's identity when bundle-shipped — powers the manage-the-bundle link. */
  bundle_external_id?: string | null;
  bundle_name?: string | null;
  /** On a bundle's field the workspace has renamed: the name a person gave it,
   *  while `display_label` stays the bundle's. Show THIS. */
  effective_label?: string | null;
  /** On a bundle's field the workspace has changed the choices of: the list it
   *  has now (`choices` stays the bundle's). An editor starts from THIS. */
  effective_choices?: string[] | null;
  id: string;
  org_id: string;
  /** The kind this def applies to. When it came from a SCOPE, the server has
   *  already normalized this onto the kind you asked for — see `scope`. */
  entity_kind: string;
  /** Set when this def isn't keyed to one kind but to a CLASS of them (the scope
   *  sentinel it was created under, e.g. "@physical+unique" — a field on every
   *  physical, individually-tracked thing). Null for an ordinary per-kind def.
   *  Editing or deleting it reaches every kind it applies to. */
  scope?: string | null;
  /** That scope in words ("Things tracked one by one"). Render THIS, never the
   *  raw sentinel. Null for a per-kind def. */
  scope_label?: string | null;
  /** Trait scope to create this def under — ANY combination of the 12 traits (OR
   *  within an axis, AND across axes). When set on create, the server derives
   *  `entity_kind` from it, so the two can't disagree. */
  applies_to?: { traits: string[] };
  /** What this field MEANS, so the pipeline can fill it. A receipt's parsed date
   *  lands on the field that CLAIMS that meaning, never on one whose name looks
   *  right. Null on a field nobody has told. See FIELD_ROLE_LABELS. */
  field_role?: FieldRole | null;
  /** A person's new value is remembered as a choice (platform-contract field-choices). */
  learns?: boolean | null;
  /** How it adds up in a group's summary (null: the default, sum). */
  aggregate?: "sum" | "per_unit" | "none" | null;
  /** Kept out of shares and public pages unless they show private notes. */
  private?: boolean;
  name: string;
  display_label: string;
  type: FieldDefType;
  required: boolean;
  position: number;
  bundle_id: string | null;
  source_module: string | null;
  choices: string[] | null;
  renderer: CatalogFieldRenderer | null;
  /** type='computed' only: the {{ }} template rendered read-only at
   *  resolve time. Null for stored value fields. */
  template: string | null;
  /** Plain-language one-line hint shown under the input. */
  help: string | null;
  /** The unit a type='number' value is measured in ("mm", "g") — free text,
   *  resolved against the units vocabulary at render time. Declares physical
   *  semantics; consumers never derive them from the field's name. */
  unit?: string | null;
  /** Form-builder section (field_sections.id) or null = ungrouped. */
  section_id?: string | null;
  /** Server-managed: the value is computed/stamped server-side and a client
   *  write is never accepted — render read-only, never as an input. */
  server_managed?: boolean | null;
  /** type='relation' only: the referenced entity-kind id (e.g.
   *  "core-locations:location"). Stored value = the target entity's id. */
  ref_kind?: string | null;
  /** Semantic DECODE role (P3): `identifier:<decoderId>` (holds a decodable
   *  code) or `decode:<key>` (a fill target for the decoder's <key> output).
   *  Lets the guarded-auto VIN fill target fields by declared role. */
  decode_role?: string | null;
  created_at: string;
}

/** A named form-builder section grouping a kind's fields under a heading. */
export interface FieldSection {
  id: string;
  entity_kind?: string;
  name: string;
  position: number;
}

export const fieldsApi = {

  // Pillar A — entities + kinds
  listBulkFieldOptions: (slug: string, kinds: string[]) => request<{ items: import("@cobblr/platform-web").BulkFieldOption[] }>("GET", `/orgs/${slug}/bulk-field-options?kinds=${encodeURIComponent(kinds.join(","))}`),
  listFieldDefs: (slug: string, kind?: string, effective?: boolean) => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (effective) params.set("effective", "1");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<{ items: PlatformFieldDef[]; sections?: FieldSection[]; scopes?: FieldScope[] }>(
      "GET",
      `/orgs/${slug}/field-defs${qs}`,
    );
  },
  /** The field presets this workspace can switch on, each with its state. */
  listFieldPresets: (slug: string) =>
    request<{ items: FieldPresetState[] }>("GET", `/orgs/${slug}/field-presets`),
  applyFieldPreset: (slug: string, key: string) =>
    request<FieldPresetState & { created: string[]; failed?: Array<{ name: string; message: string }> }>(
      "POST",
      `/orgs/${slug}/field-presets/${key}`,
    ),
  /** Switch one OFF. Values already recorded stay on the items. */
  removeFieldPreset: (slug: string, key: string) =>
    request<FieldPresetState & { removed: string[]; values_kept: boolean }>(
      "DELETE",
      `/orgs/${slug}/field-presets/${key}`,
    ),
  createFieldDef: (slug: string, body: Partial<PlatformFieldDef> & { without_meaning?: boolean }) =>
    request<PlatformFieldDef & { warning?: string }>("POST", `/orgs/${slug}/field-defs`, body),
  /** What a field about to be made would mean, read from its label, and the
   *  field the kind already has with that meaning (one field per meaning). */
  fieldMeaning: (slug: string, q: { kind: string; label: string; name?: string; role?: string | null }) => {
    const p = new URLSearchParams({ kind: q.kind, label: q.label, ...(q.name ? { name: q.name } : {}), ...(q.role ? { role: q.role } : {}) });
    return request<{ role: FieldRole | null; role_label: string | null; read_from_label?: boolean; same_as: { name: string; label: string; source: string } | null }>("GET", `/orgs/${slug}/field-defs/meaning?${p.toString()}`);
  },
  /** Kinds holding two fields that mean one thing, to settle once. */
  sameMeaningFields: (slug: string, kind?: string) =>
    request<{ items: Array<{ entity_kind: string; role: string; role_label: string; fields: Array<{ name: string; label: string; source: string }> }> }>(
      "GET",
      `/orgs/${slug}/field-defs/same-meaning${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),
  /** Whether a kind's sellers have earned a field of their own. */
  sellerOffer: (slug: string, kind: string) =>
    request<{ offer: { entity_kind: string; seller: string; places: string[]; times: number; host: { name: string; label: string } } | null }>(
      "GET",
      `/orgs/${slug}/field-defs/seller-offer?kind=${encodeURIComponent(kind)}`,
    ),
  updateFieldDef: (slug: string, id: string, body: Partial<PlatformFieldDef>) =>
    request<PlatformFieldDef>("PATCH", `/orgs/${slug}/field-defs/${id}`, body),
  deleteFieldDef: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/field-defs/${id}`),
  /** Put a deleted field back as it was (the def held at the moment of deleting). */
  restoreFieldDef: (slug: string, field: PlatformFieldDef) =>
    request<PlatformFieldDef>("POST", `/orgs/${slug}/field-defs/restore`, field),
  /** What changing a field's type would do to the values it holds. */
  retypePreview: (slug: string, id: string, to: string) =>
    request<{ from: string; to: string; checked: number; complete: boolean; wontFit: number; examples: Array<{ id: string; title: string; value: unknown }>; drops: string[] }>(
      "GET",
      `/orgs/${slug}/field-defs/${id}/retype-preview?to=${encodeURIComponent(to)}`,
    ),
  // Form-builder sections — group a kind's fields under headings.
  listFieldSections: (slug: string, kind: string) =>
    request<{ items: FieldSection[] }>("GET", `/orgs/${slug}/field-sections?kind=${encodeURIComponent(kind)}`),
  createFieldSection: (slug: string, body: { entity_kind: string; name: string }) =>
    request<FieldSection>("POST", `/orgs/${slug}/field-sections`, body),
  updateFieldSection: (slug: string, id: string, body: { name?: string; position?: number }) =>
    request<FieldSection>("PATCH", `/orgs/${slug}/field-sections/${id}`, body),
  deleteFieldSection: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/field-sections/${id}`),
  reorderFields: (
    slug: string,
    body: { entity_kind: string; sections?: Array<{ id: string; position: number }>; fields?: Array<{ name: string; section_id: string | null; position: number }> },
  ) => request<{ ok: boolean }>("POST", `/orgs/${slug}/field-defs/reorder`, body),
  // Native-field presentation overrides (relabel / show-hide of a module's
  // own fields). Read by the entity forms; written by Configuration → Presentation.
  listNativeFieldOverrides: (slug: string, kind?: string) => {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return request<{ items: NativeFieldOverride[] }>("GET", `/orgs/${slug}/native-field-overrides${qs}`);
  },
  putNativeFieldOverride: (
    slug: string,
    body: { entity_kind: string; name: string; display_label?: string | null; hidden?: boolean; position?: number; choices?: string[] | null },
  ) => request<NativeFieldOverride>("PUT", `/orgs/${slug}/native-field-overrides`, body),
  deleteNativeFieldOverride: (slug: string, entityKind: string, name: string) =>
    request<void>("DELETE", `/orgs/${slug}/native-field-overrides/${encodeURIComponent(entityKind)}/${encodeURIComponent(name)}`),
  fieldValues: (slug: string, kind: string, field: string, opts: { detail?: string | null; note?: boolean } = {}) => {
    const q = new URLSearchParams({ kind, field, ...(opts.detail ? { detail: opts.detail } : {}), ...(opts.note ? { note: "1" } : {}) });
    return request<FieldValuesUsedBody>("GET", `/orgs/${slug}/field-values?${q.toString()}`);
  },
  // H2 admin-configurable field read-scope (per-workspace gated fields).
  listFieldScopes: (slug: string) =>
    request<{ items: { kind: string; field: string; capability: string }[] }>(
      "GET",
      `/orgs/${slug}/field-scopes`,
    ),
  setFieldScope: (
    slug: string,
    body: { kind: string; field: string; capability: string },
  ) => request<void>("PUT", `/orgs/${slug}/field-scopes`, body),
  deleteFieldScope: (slug: string, kind: string, field: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/field-scopes?kind=${encodeURIComponent(
        kind,
      )}&field=${encodeURIComponent(field)}`,
    ),
};
