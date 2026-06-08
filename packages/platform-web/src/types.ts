// Web-side types — mirror the API response shapes so the shared
// components can be strongly typed without depending on the host
// app's api client. Each host injects an api adapter (see api.ts).

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
  | "code";

export interface PlatformFieldDef {
  id: string;
  entity_kind: string;
  name: string;
  display_label: string;
  type: "text" | "number" | "boolean" | "date" | "url" | "computed";
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
  listFieldDefs(slug: string, kind: string): Promise<{ items: PlatformFieldDef[] }>;
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
