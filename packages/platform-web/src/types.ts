// Web-side types — mirror the API response shapes so the shared
// components can be strongly typed without depending on the host
// app's api client. Each host injects an api adapter (see api.ts).

import type { ContributedPanelSpec } from "./panels";

export interface PlatformAction {
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  applies_to: unknown;
  invoke_route: string | null;
  invoke_handler: string | null;
  /** False = wire-only; the actions bar skips it. */
  user_invokable?: boolean;
  version: string;
}

export interface PlatformActionBinding {
  binding_id: string;
  action_id: string;
  template: string | null;
  label: string;
  icon: string | null;
  invoke_route: string | null;
  invoke_handler: string | null;
}

export interface PlatformResolvedEntity {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  fields: Record<string, unknown>;
}

export type FieldRendererId =
  | "text"
  | "color-hex"
  | "image-url"
  | "url-link"
  | "year"
  | "boolean"
  | "code"
  | "markdown"
  | "qr";

/** The storage type of a field-def. Every renderer that turns a field into an
 *  input MUST handle each member — see `fieldControl()`, whose exhaustive switch
 *  makes a forgotten type a COMPILE error rather than a silent text-box (the bug
 *  where a `boolean` field rendered as a text input showing "false"). */
// The shared list, not a seventh copy. This one was written across nine lines,
// which is how it slipped past the first version of lint:field-type-enum: a
// per-line scan cannot see a union that spans a page.
import type { FieldDefType as FieldType } from "@cobblr/platform-contract";
export type { FieldType };

/** A person who can be picked into a `member` field. Deliberately the minimum:
 *  platform-web has no business knowing roles or join dates. */
export interface PlatformMember {
  user_id: string;
  display_name: string;
}

export interface PlatformFieldDef {
  id: string;
  entity_kind: string;
  name: string;
  display_label: string;
  type: FieldType;
  required: boolean;
  position: number;
  bundle_id: string | null;
  source_module?: string | null;
  /** When set on type='text' fields, renders as a dropdown. */
  choices?: string[] | null;
  /** Optional built-in renderer for displaying the value on
   *  list rows + detail pages. */
  renderer?: FieldRendererId | null;
  /** type='computed' only: the {{ }} template rendered read-only at
   *  resolve time. Null for stored value fields. */
  template?: string | null;
  /** Plain-language one-line hint shown under the input, so jargon fields
   *  (colorway, dye lot…) explain themselves to a novice. */
  help?: string | null;
  /** The unit a type='number' value is measured in ("mm", "g") — free text,
   *  resolved against the units vocabulary at render time. Declares physical
   *  semantics; consumers never derive them from the field's name. */
  unit?: string | null;
  /** Form-builder section this field belongs to (field_sections.id), or
   *  null/undefined for ungrouped. */
  section_id?: string | null;
  /** Server-managed: the value is computed/stamped server-side and a client
   *  write is never accepted — render read-only, never as an input. */
  server_managed?: boolean | null;
  /** type='relation' only: the entity-kind id this field references
   *  (e.g. "core-locations:location"). The stored value is the target's id;
   *  display resolves it to the target's title. */
  ref_kind?: string | null;
}

/** A named form-builder section grouping a kind's fields under a heading. */
export interface FieldSection {
  id: string;
  name: string;
  position: number;
}

/** The adapter the host (web app) injects. Every shared component
 *  takes one of these via a Provider so the components stay
 *  framework-agnostic and the host owns network + auth. */
export interface PlatformWebApi {
  listActions(slug: string, kind: string): Promise<{
    items: PlatformAction[];
    bindings: PlatformActionBinding[];
  }>;
  invokeAction(
    slug: string,
    body: {
      actionId: string;
      entityKind: string;
      entityId: string;
      bindingId?: string;
      args?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean; result: unknown }>;
  lookupEntity(slug: string, kind: string, id: string): Promise<PlatformResolvedEntity>;
  /** The workspace's printers. Needed only to honour a `ui.print` directive,
   *  which is how walk-up printing reaches a browser-driven printer. Optional:
   *  a host that doesn't wire it never walk-up prints, and the module's normal
   *  path (the labels queue) still holds the work. */
  listPrinters?(slug: string): Promise<{
    items: { id: string; name: string; driver: string; is_default: boolean; settings?: unknown }[];
  }>;
  /** POST to a module-owned path, so a module can be told what reached paper.
   *  The path comes from the module's own action result, never from user input. */
  postToModulePath?(slug: string, path: string, body: unknown): Promise<unknown>;
  /** Generic entity list (`GET /orgs/:slug/entities/:kind`) — the data source
   *  for relation-field pickers. Optional: hosts that don't wire it render the
   *  relation value read-only instead of a picker. */
  listEntities?(
    slug: string,
    kind: string,
    q?: string,
  ): Promise<{ items: PlatformResolvedEntity[] }>;
  /** The workspace's members — the data source for `member`-field pickers.
   *  Optional, exactly like listEntities: a host that does not wire it renders
   *  the value read-only rather than a picker it cannot populate. */
  listMembers?(slug: string): Promise<{ items: PlatformMember[] }>;
  listFieldDefs(slug: string, kind: string): Promise<{ items: PlatformFieldDef[]; sections?: FieldSection[] }>;
  /** Manifest-declared UI contributions from the workspace's ENABLED modules
   *  (`contributes.panels`). Optional: a host that doesn't wire it simply
   *  renders no contributed panels. See panels.tsx. */
  listContributedPanels?(slug: string): Promise<ContributedPanelSpec[]>;
  /** Append a new choice to a text field-def's `choices` array. The
   *  CustomFieldsPanel's "+ add new" affordance calls this. */
  appendFieldDefChoice?(slug: string, id: string, value: string): Promise<PlatformFieldDef>;
  /** core-units vocabulary: built-in + custom units + the workspace's
   *  display mode. Optional — the UnitInput / formatting helpers degrade
   *  to free-text when a host doesn't wire it. */
  listUnits?(slug: string): Promise<PlatformUnitVocabulary>;
  addUnit?(slug: string, unit: PlatformUnitInput): Promise<PlatformUnitDef>;
  deleteUnit?(slug: string, code: string): Promise<void>;
  setUnitDisplayMode?(
    slug: string,
    mode: UnitDisplayMode,
  ): Promise<{ display_mode: UnitDisplayMode }>;
}

export type UnitDisplayMode = "symbol" | "name" | "both";

export interface PlatformUnitDef {
  code: string;
  symbol: string;
  name: string;
  plural: string;
  category: string;
  /** Base-units-per-unit within the category (g for mass, m for length…). Two
   *  same-category units that both have a factor are interconvertible. */
  factor?: number;
}

export interface PlatformUnitInput {
  code: string;
  symbol: string;
  name: string;
  plural?: string;
  category?: string;
}

export interface PlatformUnitVocabulary {
  builtins: PlatformUnitDef[];
  custom: PlatformUnitDef[];
  display_mode: UnitDisplayMode;
}
