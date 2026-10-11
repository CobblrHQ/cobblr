// Web-side types — mirror the API response shapes so the shared
// components can be strongly typed without depending on the host
// app's api client. Each host injects an api adapter (see api.ts).

import type { ContributedPanelSpec } from "./panels";
import type { BindingAskEntry } from "@cobblr/platform-contract/binding-ask";
import type { ActionArgSpec } from "@cobblr/platform-contract/action-args";

/** An action this record would have if a module that is off here were on:
 *  shown as a door to that module, never as a button that runs (#3883). */
export interface PlatformDormantAction {
  group?: string | null;
  primary?: boolean;
  id: string;
  label: string;
  description: string | null;
  icon: string | null;
  module_name: string;
  module_label: string;
}

export interface PlatformAction {
  group?: string | null;
  primary?: boolean;
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
  /** Can a mistaken run be put back? */
  undoable?: boolean;
  /** Its arguments; a required one is asked for before a press runs it. */
  args_schema?: Record<string, ActionArgSpec> | null;
  version: string;
}

export interface PlatformActionBinding {
  group?: string | null;
  primary?: boolean;
  binding_id: string;
  action_id: string;
  template: string | null;
  label: string;
  /** What it does, in the module's words — the row's tooltip, since a label
   *  alone does not say WHEN ("Print label" vs "Queue a printable label"). */
  description?: string | null;
  icon: string | null;
  invoke_route: string | null;
  invoke_handler: string | null;
  /** False (the default) = a mistaken run cannot be put right, so a surface
   *  that fires it from a list row asks first. */
  undoable?: boolean;
  /** What it asks before it runs (a collection's shortcut: "Open a bottle"
   *  asks for a tasting note). Empty or absent asks nothing. */
  ask?: BindingAskEntry[];
  /** The arguments the button fixes, and the action's argument shape: a
   *  required argument neither fixes is asked for before it runs. */
  args?: unknown;
  args_schema?: Record<string, ActionArgSpec> | null;
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
import type { FieldDefType as FieldType } from "@cobblr/platform-contract/field-vocabulary";
import type { AddressValue } from "@cobblr/platform-contract/address";
export type { FieldType };

/** A person who can be picked into a `member` field. Deliberately the minimum:
 *  platform-web has no business knowing roles or join dates. */
export interface PlatformMember {
  user_id: string;
  display_name: string;
}

/** Someone on the workspace's People list: a member, or anyone else by name.
 *  A `person` field stores `id`. */
export interface PlatformPerson {
  id: string;
  name: string;
  member: boolean;
  /** A member who has left; their things are still theirs. */
  left: boolean;
}

export interface UsedValueBody {
  value: string;
  uses: number;
  lastUsed: string | null;
}

/** GET /addresses: the places already used here, and a map lookup's when one is set. */
export interface AddressSuggestionsBody {
  used: Array<{ address: AddressValue; usedOn: { kind: string; id: string; name: string }; uses: number; lastUsed: string | null }>;
  found: AddressValue[];
  lookup: { name: string } | null;
  lookup_failed?: true;
}

export interface FieldValuesUsedBody {
  values: UsedValueBody[];
  details?: Record<string, UsedValueBody[]>;
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
  /** What the field MEANS (a record role such as "acquired-from"). */
  decode_role?: string | null;
  field_role?: string | null;
  /** Whether what a person types becomes a choice (field-choices.ts). */
  learns?: boolean | null;
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
export type BulkFieldOption = Pick<PlatformFieldDef, "name" | "display_label" | "type" | "required" | "choices" | "learns" | "ref_kind" | "unit" | "field_role"> & { native: boolean; money?: "cents" | "amount" };

export interface PlatformWebApi {
  lookupBarcode?(slug: string, code: string): Promise<import("./barcode-fill").BarcodeLookup>;
  /** How a collection presents its native fields: relabels and hides
   *  (GET /:slug/native-field-overrides?kind=). Read through
   *  useFieldPresentation; a host without it shows the presentation as
   *  unreadable rather than as "nothing configured". */
  listNativeFieldOverrides?(slug: string, kind: string): Promise<{ items: Array<{ name: string; display_label: string | null; hidden: boolean }> }>;
  /** Which faces a collection wears (GET /:slug/faces). Optional so a host
   *  without it shows every face, as before. */
  listFaces?(slug: string, kind: string): Promise<{ kind: string; traits?: Record<string, string>; faces: string[]; explicit: string[]; offers?: string[] }>;
  /** Write a collection's override config (PUT /:slug/entity-kind-overrides);
   *  the faces row uses it to turn a face on. */
  upsertOverride?(slug: string, body: { target_kind: "instance" | "entity_kind" | "bundle"; target_id: string; config?: Record<string, unknown> }): Promise<unknown>;
  listActions(slug: string, kind: string): Promise<{
    layout?: import("@cobblr/platform-contract/action-groups").RecordActionLayout;
    pins?: import("@cobblr/platform-contract/action-groups").RecordActionPins;
    items: PlatformAction[];
    bindings: PlatformActionBinding[];
    /** What an off module would add here; a host that omits it shows none. */
    dormant?: PlatformDormantAction[];
    /** The kind's records can be marked as sold or given away and brought
     *  back (its writer retires and unretires). */
    lifecycle?: boolean;
  }>;
  setRecordActionPin?(slug: string, kind: string, action: string, pinned: boolean): Promise<unknown>;
  /** Turn a module on for the workspace (an owner's or admin's act). Optional:
   *  a host without it offers the ask instead. */
  enableModule?(slug: string, module: string): Promise<unknown>;
  /** Ask the workspace's admins to turn a module on, through the host's one
   *  request surface. */
  askForModule?(slug: string, module: string, label: string): Promise<void>;
  invokeAction(
    slug: string,
    body: {
      actionId: string;
      entityKind?: string;
      entityId?: string;
      bindingId?: string;
      args?: Record<string, unknown>;
      /** A scanned action label's code (#3897). */
      label?: string;
    },
  ): Promise<{ ok: boolean; result: unknown; undo?: unknown; affected?: { kinds: string[]; entity?: { kind: string; id: string } } }>;
  lookupEntity(slug: string, kind: string, id: string): Promise<PlatformResolvedEntity>;
  requestLight?(slug: string, ref: { kind: string; id: string }, reason?: "shown" | "found" | "picked" | "put-away" | "label-scanned"): Promise<{ requested: boolean; place: string | null; note: string }>;
  /** Who this workspace can hand things to (its shares), and what it has
   *  handed over. Optional: a host without sharing offers no Give to. */
  previewSendFile?(slug: string, p: {entity_kind: string;ids: string[];mode: "copy" | "move"}): Promise<import("./SendRecords").SendFileExportPreview>;
  exportSendFile?(slug: string, p: {entity_kind: string;ids: string[];mode: "copy" | "move";request_id?: string}): Promise<{id: string;download_path: string;summary: string}>;
  downloadSendFile?(slug: string, id: string): Promise<void>;
  sendTargets?(slug: string): Promise<import("./SendRecords").WorkspaceSendTargets>;
  previewSend?(slug: string, p: import("./SendRecords").WorkspaceSendRequest): Promise<import("./SendRecords").WorkspaceSendPreview>;
  sendRecords?(slug: string, p: import("./SendRecords").WorkspaceSendRequest): Promise<{ summary: string; offer_ids: string[] }>;
  undoSend?(slug: string, id: string): Promise<unknown>;
  listShareOffers?(slug: string): Promise<{ items: Array<{ id: string; direction: "out" | "in"; status: string; can_withdraw: boolean }>; targets: Array<{ link_id: string; to: string }> }>;
  withdrawShareOffer?(slug: string, id: string): Promise<unknown>;
  /** The shares of this workspace's own things, and which of them hold this
   *  record now ("Shared with Vince"). */
  /** Edits suggested through shares on one record, waiting for a decision. */
  listSuggestions?(slug: string, q: { kind: string; id: string }): Promise<{ items: SuggestedEdit[] }>;
  /** On a copy in a share space: what the owner changed since you edited it. */
  copyNotes?(slug: string, kind: string, id: string): Promise<{ from: string | null; notes: Array<{ field: string; label: string; theirs: string | null }> }>;
  recordShares?(slug: string, kind?: string, id?: string): Promise<{ can_share?: boolean; targets: Array<{ link_id: string; to: string }>; shared_with: Array<{ link_id: string; to: string }> }>;
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
  /** A collection as a spreadsheet, read as the viewer (`GET
   *  /orgs/:slug/entities/:kind/export.csv`). Optional: a host without it
   *  shows no Export on a collection's header. */
  exportEntitiesCsv?(slug: string, kind: string, q?: string, includeSecrets?: boolean): Promise<{ blob: Blob; filename: string; complete: boolean; secretsOmitted?: boolean }>;
  /** The workspace's members — the data source for `member`-field pickers.
   *  Optional, exactly like listEntities: a host that does not wire it renders
   *  the value read-only rather than a picker it cannot populate. */
  listMembers?(slug: string): Promise<{ items: PlatformMember[] }>;
  /** The People list — the data source for `person`-field pickers. Optional
   *  like listMembers: without it the value renders read-only. */
  listPeople?(slug: string): Promise<{ items: PlatformPerson[] }>;
  /** Add someone by name from a person picker ("+ Someone else…"). */
  addPerson?(slug: string, name: string): Promise<PlatformPerson>;
  listBulkFieldOptions?(slug: string, kinds: string[]): Promise<{ items: BulkFieldOption[] }>;
  revealSecretField?(slug: string, kind: string, id: string, field: string, operation: "reveal" | "copy"): Promise<{ value: string }>;
  listFieldDefs(slug: string, kind: string): Promise<{
    items: PlatformFieldDef[];
    sections?: FieldSection[];
    /** The kind's own columns that carry a meaning (a vehicle's Bought from
     *  is its seller), so a form does not offer that meaning twice. */
    native_roles?: Array<{ name: string; label: string; field_role: string | null }>;
  }>;
  /** The workspace's wires, and the door to make or remove one: the same one
   *  the Wires page uses. A module offers a wire here only on a person's
   *  say-so (an update never opts anyone in). Optional: a host without them
   *  shows no such offer. */
  listWires?(slug: string): Promise<{ items: PlatformWire[] }>;
  createWire?(slug: string, wire: PlatformWireInput): Promise<PlatformWire>;
  deleteWire?(slug: string, id: string): Promise<void>;
  /** The events this workspace's enabled modules can raise, so an offer to
   *  wire one is shown only where it can fire. */
  listWireEvents?(slug: string): Promise<{ items: Array<{ event: string; module: string }> }>;
  /** Manifest-declared UI contributions from the workspace's ENABLED modules
   *  (`contributes.panels`). Optional: a host that doesn't wire it simply
   *  renders no contributed panels. See panels.tsx. */
  listContributedPanels?(slug: string): Promise<ContributedPanelSpec[]>;
  /** Pictures suggested for records made without one (#3818), by kind, or by
   *  record id alone (kind null). Optional: a host without it shows none. */
  listPhotoSuggestions?(slug: string, kind: string | null, ids?: string[]): Promise<{ items: PhotoSuggestionRow[] }>;
  /** Search again for a record whose picture was not found. */
  searchPhotoFor?(slug: string, kind: string, id: string): Promise<{ ok: true }>;
  /** What a field already holds across a kind's records (GET /field-values),
   *  for the choice picker's list; `detail` / `note` also return what rode
   *  beside each value. A host without it offers the field's choices alone. */
  fieldValues?(
    slug: string,
    kind: string,
    field: string,
    opts?: { detail?: string | null; note?: boolean },
  ): Promise<FieldValuesUsedBody>;
  /** The addresses this workspace already used, matching what is typed
   *  (GET /addresses), for the address picker; `lookup` is null when no map
   *  lookup is set. A host without it offers free text and the parts form. */
  addresses?(slug: string, q: string): Promise<AddressSuggestionsBody>;
  /** Whether a kind's sellers, noted beside where things came from, have
   *  earned a field of their own (GET /field-defs/seller-offer). */
  sellerOffer?(slug: string, kind: string): Promise<{ offer: { entity_kind: string; seller: string; places: string[]; times: number; host: { name: string; label: string } } | null }>;
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
  /** Scan inbox rows headed for one table (an instance's name, or a module's
   *  for its default table) whose name, code or maker contains `q`. A thing
   *  scanned but not yet filed is in no table, so a collection's search could
   *  not find it. Optional: a host without it shows no waiting strip. */
  waitingScans?(slug: string, q: string, destination: string): Promise<{ items: PlatformWaitingScan[]; total: number }>;
  /** File one waiting row where it is headed, in one tap (installing its
   *  table first when needed), the way the inbox's Add does. */
  fileWaitingScan?(slug: string, id: string): Promise<{ label: string; record: { kind: string; id: string } | null }>;
  /** Show a refusal the server explained (error.blocked) in the app's one
   *  refusal sheet. Optional: a host without it shows the sentence as a toast. */
  raiseBlocked?(blocked: import("@cobblr/platform-contract/blocked-action").BlockedAction): void;
  /** The public pages a record can be seen through right now (#4502), for
   *  the "Public" chip on its header. Optional: a host without it shows none. */
  recordPublicPages?(slug: string, id: string): Promise<{ pages: Array<{ name: string; public_until: string | null; label_door: boolean; links: number }> }>;
  /** The hand-over a record was taken from, while it can still be sent back
   *  (#4684). Optional: a host without it offers no Send back on the record. */
  receivedFrom?(slug: string, kind: string, id: string): Promise<{ received: { offer_id: string; from: string | null; until: string } | null }>;
  sendBackShareOffer?(slug: string, offerId: string): Promise<unknown>;
}

/** One scan inbox row waiting to be filed, as a collection's search shows it. */
export interface PlatformWaitingScan {
  id: string;
  /** The name the inbox card shows, else its code. */
  name: string;
  image: string | null;
  /** Where filing sends it, in the table's own words. */
  destinationLabel: string | null;
  /** One tap can file it now; otherwise the inbox card is where it is finished. */
  canFile: boolean;
  /** Why it cannot be filed yet, when it cannot. */
  reason: string | null;
  /** The inbox, opened on this row. */
  href: string;
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

/** A picture suggested for a record made without one (#3818). */
export interface PhotoSuggestionRow {
  entity_kind: string;
  entity_id: string;
  /** "queued" while it is still being looked for; "none" when it was looked
   *  for and nothing was found. */
  status: "queued" | "suggested" | "none";
  image_path: string | null;
  query: string | null;
}

/** A wire, as a module's offer reads it. */
export interface PlatformWire {
  id: string;
  source_kind: string;
  action_id: string;
  trigger_type: string;
  trigger_event: string | null;
  args: unknown;
  enabled: boolean;
  bundle_id: string | null;
}

export interface PlatformWireInput {
  source_kind: string;
  action_id: string;
  trigger_type: "event";
  trigger_event: string;
  args?: Record<string, unknown>;
}

/** One field someone you share with changed on a record of yours, said in
 *  words (share-spaces.md §8). */
export interface SuggestedEdit {
  id: string;
  field: string;
  label: string;
  /** What it said when they changed it. */
  was: string | null;
  /** What they made it. */
  now: string | null;
  /** On a conflict: what the record says now. */
  yours: string | null;
  status: "pending" | "conflict" | "applied" | "undone" | "accepted" | "rejected";
  still_shared: boolean;
  by_name: string | null;
}
