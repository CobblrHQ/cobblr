import type { GroupBy, GroupedResult, GroupPlan } from "./grouped-list.js";
import { arrivedEverywhere as arrivedEverywhereForView } from "@cobblr/platform-contract/day";
import { likeEscape } from "@cobblr/platform-contract/text-search";
import type { DeletionSnapshot } from "@cobblr/platform-contract/activity-and-events";
import type { Disposition } from "@cobblr/platform-contract/disposition";
import type { EntityKindRecord } from "@cobblr/platform-contract/platform-entities";
import type { TitleVariants } from "@cobblr/platform-contract/display-identity";

// ──────────────── Pillar A runtime — entities ──────────────────────

/** Generic entity data returned to other modules. Module-private
 *  columns aren't here — only fields declared on the kind's manifest
 *  with role: 'title' / 'subtitle' / etc., plus the raw field map.
 *  Callers should rely on roles to render generically. */
export interface ResolvedEntity {
  kind: string;
  id: string;
  /** The named collection this record lives in, when its module keeps
   *  several ("groceries" for an inventory:part filed as a grocery); absent or
   *  null in the module's own default one. Lets a surface name the record by
   *  its collection instead of its kind (a jar of Nutella read "Part" in the
   *  pantry, #4146) and route to its instance page. */
  instance?: string | null;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  /** All declared fields, key → value. Numbers come back as numbers,
   *  strings as strings — modules cast as needed. */
  fields: Record<string, unknown>;
  /**
   * The user has put this out of use: archived, retired, decommissioned —
   * whatever the owning module calls it. It still exists and still resolves,
   * because its history is worth keeping; what it must not do is generate work.
   *
   * This exists because "stop bothering me about this" had no cross-module
   * expression. A sweeper that wants to skip retired records could only find
   * out by reaching into the owning module's table, which module isolation
   * forbids — so core-cadence kept putting archived groceries on the shopping
   * list, ignoring the one explicit instruction the user had given it.
   *
   * Absent means not retired. A module with no such concept just omits it.
   */
  retired?: boolean;
  /** A titled work's other forms (the original, a translation, a
   *  transliteration), when the record carries them in its metadata. The
   *  kernel composes `title` from these for the request's actor (their
   *  title preference) on the way out, so a surface reads `title` as
   *  served and never formats; the forms ride beside it for anything that
   *  needs to say where a title came from (#3061). */
  title_variants?: TitleVariants;
  /** On a search result that matched inside the record's words rather than
   *  its name (a pattern's PDF, its notes): the line the searched word is on,
   *  so a surface can say why the record is here. Absent on a name match and
   *  outside a search. */
  snippet?: string;
}

/** Module-side resolver for an entity kind. Registered at module
 *  boot. The platform calls these in-process; no HTTP loopback. */
export type EntityResolver = (
  orgId: string,
  id: string,
) => Promise<ResolvedEntity | null>;

/** Comparison-operator predicate for the `where` field of
 *  EntityListQuery. Supports literal comparisons, column-to-column
 *  comparisons (`{ ref_col }`), and the `'now'` sentinel for date
 *  columns (resolver substitutes `now()`).
 *
 *  Examples (workshop demos):
 *    { col: 'qty', op: '<', ref_col: 'min_qty' }   // low-stock
 *    { col: 'due_date', op: '<=', value: 'now' }    // overdue tasks
 *    { col: 'created_at', op: '>=', value: '2026-01-01' }
 *
 *  A predicate a resolver cannot run is reported back in
 *  `EntityListResult.unapplied`, never dropped in silence. `contains` and
 *  `not_contains` (#6896) are case-insensitive text matches, run only by a
 *  resolver registered with `{ textOps: true }`; the platform reports them
 *  unapplied for any other. A resolver builds the pattern with
 *  `containsPattern`, so a `%` or `_` the person typed matches literally. */
export interface FilterPredicate {
  col: string;
  op: "<" | "<=" | ">" | ">=" | "=" | "!=" | "empty" | "not_empty" | "contains" | "not_contains";
  /** Literal value. Use the string `'now'` for current timestamp on
   *  date/timestamptz columns, and `'today'` for the READER's calendar day
   *  against a date field (`EntityListQuery.today`): "ready to drink" is
   *  `drink_from <= today AND drink_by >= today` on the day the person is
   *  living in, never the server's UTC one. A `YYYY-MM-DD` literal compares
   *  as a day too. Mutually exclusive with `ref_col`. */
  value?: string | number | boolean | null;
  /** Compare against another column on the same row (low-stock-style
   *  qty < min_qty). Mutually exclusive with `value`. */
  ref_col?: string;
}

/** The text where-ops (#6896): a case-insensitive "contains" and its
 *  negation. Only a resolver registered with `{ textOps: true }` runs them. */
export const TEXT_WHERE_OPS = ["contains", "not_contains"] as const;
export type TextWhereOp = (typeof TEXT_WHERE_OPS)[number];
export const isTextWhereOp = (op: string): op is TextWhereOp => (TEXT_WHERE_OPS as readonly string[]).includes(op);

/** The ILIKE pattern for "contains <text>" (run it with ESCAPE '\'), escaped
 *  by likeEscape so what a person types is matched literally, never read as a
 *  wildcard. Null for nothing to look for. */
export function containsPattern(text: unknown): string | null {
  if (text === null || text === undefined) return null;
  const s = String(text);
  if (!s.trim()) return null;
  return `%${likeEscape(s)}%`;
}

/** How a list resolver says what it can run. */
export interface ListResolverOptions {
  /** It runs `contains` / `not_contains` (TEXT_WHERE_OPS) itself. Without
   *  this the platform reports those predicates unapplied rather than let the
   *  resolver skip them and answer with everything. */
  textOps?: boolean;
}

/** Query passed to a list resolver — generic primitives so the
 *  resolver implementation can decide how to apply them. Modules
 *  may safely ignore filter keys they don't support; core-views
 *  surfaces the supported set to the user via the view config. */
/** Who is reading, for the per-field read scopes. A person's `userId` +
 *  `role`; `publicRead` for an anonymous public page; `system` only through
 *  SYSTEM_VIEWER. */
export interface EntityViewer {
  userId?: string;
  role?: string;
  publicRead?: boolean;
  system?: true;
  /** The person's own assistant reading on their behalf (Cobb, MCP as that
   *  member): it also sees the kind's assistantReadableFields on records of
   *  the person's own workspace. */
  assistant?: boolean;
  /** The person exporting their own workspace's collection to a file: they
   *  read every field their own table shows, not only the kind's exposable
   *  fields, and their field read scopes and secret masking still apply. Set
   *  only by the export, never for a linked workspace or an assistant. */
  export?: boolean;
}

/** The reader for internal logic that must decide from the truth: an undo
 *  asking whether a field still holds values, a matcher, a sweeper, a heal.
 *  It sees every field, gated ones included, so it is never passed by code
 *  that answers a client (lint:system-viewer-stays-internal); each use says
 *  why on a `SYSTEM-READ:` line above it. */
export const SYSTEM_VIEWER: EntityViewer = Object.freeze({ system: true as const });

export interface EntityListQuery {
  group_by?: string | GroupBy[];
  group_subtotals?: boolean;
  group_offset?: number;
  group_limit?: number;
  group_keys?: Array<string | null>;
  /** Kernel-prepared, request-local SQL aggregation plan, never accepted from HTTP. */
  group_plan?: GroupPlan;
  /** Hard cap. Resolvers default to a sensible limit when omitted. */
  limit?: number;
  /** Offset-based pagination. Cursor-based variants can be added
   *  later once a v0.1 view actually needs them. */
  offset?: number;
  /** Field-name → value(s). Resolver decides operator (typically
   *  equality for scalars, IN for arrays). Unknown keys are ignored.
   *  Conventions:
   *    filter._tag = '<name>'  → entities carrying that tag
   *    filter.<other key>      → equality on a native column OR a
   *                              metadata-JSON field if no native
   *                              match (resolver decides) */
  filter?: Record<string, unknown>;
  /** Comparison predicates beyond equality. Each predicate AND'd
   *  together. Resolvers may support a subset of (col, op) pairs;
   *  unsupported ones are ignored. See FilterPredicate for examples. */
  where?: FilterPredicate[];
  /** Free-text — full-text-ish search, scoped to the resolver's
   *  judgement of what's searchable on the kind. */
  q?: string;
  /** Sort spec: array of `field` or `-field` (prefix `-` for desc). */
  sort?: string[];
  /** Also return records the module marks retired (archived, out of use,
   *  a unit kept out of the way). A list, a view and the assistant's list
   *  hide them unless asked, as a module's own list does; SEARCH asks, since
   *  "where is my old drill" is a question about something retired, and a
   *  search that cannot find it lies by omission. The resolver decides what
   *  retired means for its kind; a kind with no such notion ignores this. */
  include_retired?: boolean;
  /** The reader's calendar day (YYYY-MM-DD), what a `'today'` predicate
   *  compares against: the client's day when it said one, else the person's
   *  (accounts.dayFor). Absent, a resolver uses the day that has arrived
   *  everywhere, which is late for somebody rather than early for anybody. */
  today?: string;
  /** A view's inputs as the viewer set them, already bounded by the view
   *  (`resolveViewInputs`, @cobblr/platform-contract/view-inputs): computed
   *  fields read them as {{ inputs.<name> }} (#6897). Read-only, never
   *  stored; a resolver passes them by, only the computed layer reads them. */
  inputs?: Record<string, string | number>;
}

/** The query a saved view asks for, read off its config the ONE way every
 *  surface must read it. A view's config carries `filter`, `where` and `sort`
 *  in the entity-list dialect; older bundles wrote `sort_by` + `sort_dir`
 *  instead, and the views installed from them still do, so both spellings
 *  are honoured here rather than at each reader. core-views' data route and
 *  the inventory list page both call this: for a long time the first applied
 *  the config and the second applied only group_by and visible_fields, so
 *  the same view sorted through one door and not the other (#2772, #2422). */
export function viewQuery(config: Record<string, unknown> | null | undefined, today = arrivedEverywhereForView(new Date())): Pick<EntityListQuery, "filter" | "where" | "sort"> {
  const cfg = config ?? {};
  const out: Pick<EntityListQuery, "filter" | "where" | "sort"> = {};
  if (cfg.filter && typeof cfg.filter === "object" && !Array.isArray(cfg.filter)) {
    out.filter = cfg.filter as Record<string, unknown>;
  }
  if (Array.isArray(cfg.where)) out.where = (cfg.where as FilterPredicate[]).map(p => {
    const value = p.value;
    if (typeof value !== "string") return p;
    const offset = /^today([+-][0-9]{1,4})?$/.exec(value);
    if (offset) {
      const date = new Date(today + "T12:00:00Z");
      date.setUTCDate(date.getUTCDate() + Number(offset[1] ?? 0));
      return { ...p, value: date.toISOString().slice(0, 10) };
    }
    if (value === "year-start" || value === "next-year-start") return { ...p, value: `${Number(today.slice(0, 4)) + (value === "next-year-start" ? 1 : 0)}-01-01` };
    return p;
  });
  const sort = normalizeSortSpec(cfg.sort);
  if (sort) out.sort = sort;
  else if (typeof cfg.sort_by === "string" && cfg.sort_by.trim()) {
    out.sort = [`${cfg.sort_dir === "desc" ? "-" : ""}${cfg.sort_by.trim()}`];
  }
  return out;
}

/** The sort grammar resolvers speak is the string form, `["name", "-qty"]`.
 *  View configs written by the view editor carry the object form,
 *  `[{ field, dir }]`, and for a while that passed through untouched and made
 *  resolvers return ZERO rows (D16). Both forms normalise here, to strings;
 *  anything unparseable degrades to `undefined` (unsorted), never an empty
 *  array, so a bad sort can never empty a result. */
export function normalizeSortSpec(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e === "string") {
      if (e.trim()) out.push(e.trim());
    } else if (e && typeof e === "object") {
      const field = (e as { field?: unknown }).field;
      const dir = (e as { dir?: unknown }).dir;
      if (typeof field === "string" && field.trim()) {
        out.push(dir === "desc" || dir === "-" ? `-${field.trim()}` : field.trim());
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Turn an `EntityListQuery.sort` spec (`["-excitement","name"]`) into an
 *  ordered list of `{ col, dir }` a list resolver can hand straight to its
 *  query builder. A leading `-` means descending; anything else ascending.
 *
 *  Only columns present in `sortable` survive — a resolver passes the set of
 *  columns it can actually order by (native cols it trusts), and unknown or
 *  unsafe fields are dropped rather than interpolated into SQL. Same
 *  degrade-don't-throw contract the `where`/`filter` paths follow: a sort the
 *  resolver can't honor becomes "no extra ordering", never an error. An empty
 *  or all-dropped spec returns `[]`, and the resolver falls back to its own
 *  default order.
 *
 *  Pure and dependency-free so both the api resolvers and the web client
 *  (which sorts already-fetched rows in the same order) share one definition
 *  of the grammar. */
export function parseSort(
  sort: string[] | undefined,
  sortable: ReadonlySet<string>,
): Array<{ col: string; dir: "asc" | "desc" }> {
  if (!sort || sort.length === 0) return [];
  const out: Array<{ col: string; dir: "asc" | "desc" }> = [];
  const seen = new Set<string>();
  for (const raw of sort) {
    if (typeof raw !== "string") continue;
    const token = raw.trim();
    if (!token) continue;
    const dir: "asc" | "desc" = token.startsWith("-") ? "desc" : "asc";
    const col = token.replace(/^-/, "").trim();
    if (!col || seen.has(col) || !sortable.has(col)) continue;
    seen.add(col);
    out.push({ col, dir });
  }
  return out;
}

export interface EntityListResult extends Partial<GroupedResult> {
  items: ResolvedEntity[];
  /** Total matching rows ignoring limit/offset — optional because
   *  count-queries on large tables can be expensive. */
  total?: number;
  /** The `where` predicates the resolver could not run. A predicate it
   *  cannot honour used to be dropped in silence, so a "Ready to drink" view
   *  whose date compare was unsupported showed EVERY bottle and said
   *  nothing. Reported here, and a view shows them. */
  unapplied?: FilterPredicate[];
  /** The resolver THREW, so `items` is not the answer, it is nothing. A failed
   *  list used to come back as `{ items: [] }`, indistinguishable from "no
   *  matches": a search whose SQL named a column the table does not have
   *  returned no orders and no projects on every surface for weeks, and only a
   *  server log said so. Set by the platform's list(), never by a resolver. */
  failed?: true;
  /** Why the list has nothing to say: the kind has no list here, or the
   *  module that keeps it is off. Both used to answer `{ items: [] }`, which a
   *  person's own picker reads well and an assistant read as "you have none"
   *  (#4199). Set by the platform's list(), never by a resolver. */
  unlisted?: "no-such-list" | "module-off";
}

/** Module-side list resolver for an entity kind. Optional — kinds
 *  without one return { items: [] } from list(). Same projection
 *  rules as single-hop lookup: each item is filtered through the
 *  kind's exposableFields when the caller is outside the owning
 *  module (the platform handles the projection — resolver returns
 *  the full row). */
export type EntityListResolver = (
  orgId: string,
  query: EntityListQuery,
) => Promise<EntityListResult>;

/** Module-side list resolver for the items of ANY instance of a multi-instance
 *  module. Registered once per module (not per instance); the platform calls it
 *  for `<instance_name>:item` kinds, resolving the instance→module via the
 *  workspace_module_instances table. Lets views/search/data/calendar see
 *  instance entities through the generic layer. Same projection rules as
 *  EntityListResolver. */
export type EntityInstanceListResolver = (
  orgId: string,
  instance: string,
  query: EntityListQuery,
) => Promise<EntityListResult>;

/** Single-entity resolver for the items of ANY of a module's instances. The
 *  platform calls it for a `<instance_name>:item` LOOKUP when no exact resolver
 *  is registered (resolving instance→module), so a detail/lookup of an instance
 *  item resolves + gets computed fields the same as the base kind. Modules
 *  register once (not per instance). The single-entity twin of
 *  EntityInstanceListResolver. */
export type EntityInstanceResolver = (
  orgId: string,
  instance: string,
  id: string,
) => Promise<ResolvedEntity | null>;

/** Tier-2 context provider for computed fields. Given an entity, returns
 *  a namespaced bag of related/aggregated data referenced in a computed
 *  template as {{<namespace>.<key>}}. Best-effort: a throw renders the
 *  namespace empty rather than failing the whole resolve. */
export type ComputedContextProvider = (
  orgId: string,
  kind: string,
  id: string,
) => Promise<Record<string, unknown>>;

/** Context for resolving create-time field defaults. The kernel passes who is
 *  creating + what kind; a provider returns a partial of that kind's OWN
 *  fields. See PlatformEntities.registerCreateDefaults. */
export interface CreateDefaultsContext {
  orgId: string;
  /** The user creating the entity — many defaults are per-user (e.g. presence
   *  defaults a location from where the user is). Undefined for system / token
   *  callers; a provider should no-op when it needs a user and there is none. */
  userId?: string;
  /** The kind being created, e.g. "core-scan:item" / "inventory:part". */
  kind: string;
  /** Field values the caller already has (client-supplied). Providers may read
   *  these; the kernel never overrides a supplied value — defaults only fill
   *  keys the caller left unset (see resolveCreateDefaults). */
  supplied?: Record<string, unknown>;
}

/** A module's contribution of create-time defaults for one kind. Returns a
 *  partial of the kind's fields (by the kind's OWN field names). Best-effort:
 *  a throw is swallowed and contributes nothing. Provider-agnostic — presence,
 *  a GPS source, a manual room-pin all register the same way; the create path
 *  never imports any of them. */
export type CreateDefaultsProvider = (
  ctx: CreateDefaultsContext,
) => Promise<Record<string, unknown>>;

/** A device reading to apply to a linked entity. core-devices resolves the
 *  (connection, device) → entity link + mode, then asks the entity-OWNING
 *  module how that mode maps to one of ITS OWN actions — so core-devices never
 *  hardcodes the entity side and the owner never hardcodes the device side.
 *  (Audit 2026-06-26 follow-up — replaces the hardcoded
 *  `if (kind === "inventory:part")` branch in core-devices.) */
export interface DeviceApplyContext {
  /** The link's mode, e.g. "set" | "add". The owning module decides support. */
  mode: string;
  /** The reading's numeric value (null when the payload had none). */
  value: number | null;
  /** The target entity id (within the owner's kind). */
  entityId: string;
  /** Reason string to thread into the action (e.g. "device:scale-1"). */
  reason: string;
}

/** Maps a device reading to ONE of the owning module's actions. Returns the
 *  action id + args for core-devices to invoke (with its device-event context),
 *  or null if the module doesn't support that mode. */
export type DeviceApplyProvider = (
  ctx: DeviceApplyContext,
) => { actionId: string; args: Record<string, unknown> } | null;

/** What the kernel hands a kind's updater: the record, the fields to change
 *  (already limited to what the member may see), and who is changing it. */
export interface EntityUpdateContext {
  orgId: string;
  userId: string | null;
  role: string;
  kind: string;
  id: string;
  fields: Record<string, unknown>;
}

/** The updater's answer. A refusal is a sentence the member can act on. */
export type EntityUpdateResult =
  | { ok: true; summary?: string; changed?: string[] }
  | { ok: false; error: string };

/** How one kind applies a member's edit: column-versus-metadata routing, type
 *  coercion, validation, its own `<noun>_updated` history line and event. The
 *  module owns all of it; the kernel never touches the module's tables. */
export type EntityUpdater = (ctx: EntityUpdateContext) => Promise<EntityUpdateResult>;

/** What an entity-owning module declares so core-scan can treat its kind as a
 *  scan target — WITHOUT core-scan hardcoding a per-kind allowlist / endpoint /
 *  field map. Registered at boot via platform().entities.registerScannable.
 *  (Audit 2026-06-26 follow-up — replaces the hardcoded SCANNABLE set +
 *  KIND_CREATE_ENDPOINTS + KIND_QTY_FIELD maps in core-scan.) */
/** One scannable kind a workspace has (listScannableForOrg). */
export interface ScannableKind extends ScannableInfo {
  /** The kind records live under: a module's own ("inventory:part") or an
   *  instance's ("groceries:item"). */
  kind: string;
  /** The owning module. */
  module: string;
  /** The named instance the kind lives in, or null for the module's own. */
  instance: string | null;
  /** The registry record the kind came from (its fields, routes, traits). */
  record: EntityKindRecord;
}

export interface ScannableInfo {
  /** Singular noun for the scan UI / routing ("part", "asset", "machine"). */
  noun: string;
  /** Module HTTP path a confirmed scan POSTs to (under
   *  /api/v1/orgs/:slug/modules/), e.g. "inventory/parts". */
  createEndpoint: string;
  /** The create body's quantity field name ("qty" | "quantity"). Absent for
   *  kinds without a native quantity (one row = one thing, e.g. a record):
   *  scan flows then skip the qty bump / adjust affordances for that kind. */
  qtyField?: string;
  /** The field holding the unit the quantity is kept in ("unit": "each",
   *  "m", "kg"). A picker that asks how much of a record to use reads it, so
   *  a measured record takes 0.25 and a counted one takes whole numbers
   *  (#5962). Absent: the quantity counts whole things. */
  unitField?: string;
  /** The qty field says how many identical things one record stands for, and
   *  the kind's list never also returns those things as records of their own
   *  (a unit named under its parent stays under it). Then a count answers in
   *  both records and things (`count_records`' `units`). Leave it off while
   *  the list can return a thing twice, or the count would add it twice. */
  qtyCountsThings?: boolean;
  /** Marks this the fallback scan target when no identify hint matches a noun
   *  (at most one should set it). Lets core-scan route an unhinted scan without
   *  hardcoding a default module. */
  default?: boolean;
  /** The action that moves this kind's quantity by a delta, invoked ON the
   *  record with args `{ delta, reason, restock?, sourceKind?, sourceId? }`
   *  and answering `{ ok, delta, newQty, clamped?, note?, error? }`: the
   *  module's own quantity door, where its floor, lots and ledger live. When
   *  declared, core-scan takes an undone bump back through it; without it,
   *  the quantity field is written through the module's own route. */
  adjustAction?: string;
  /** The action that keeps this thing at another place too: invoked ON the
   *  item with args `{ location_id, qty }` and answering `{ ok, id, card_id }`
   *  (the new place's record and the item it belongs to). When declared, a
   *  scan of a thing the workspace has, at a place it is not kept yet, files
   *  as that place's row under the same item instead of a count on another
   *  place or a second item. */
  holdAction?: string;
}

/** In-process create/update/delete for one kind, registered by the owning
 *  module. The WRITE counterpart to EntityResolver — used by cross-module
 *  writers (the sync engine) that have no HTTP request / user token. The
 *  writer resolves its own tenant db from orgId and runs the module's own
 *  validation + events. */
export interface EntityWriter {
  /** Owning row table, used for predicates that must run before paging. */
  table?: string;
  /** A kind that shows a loan in fields of its own (an asset's "Who has it")
   *  keeps them in step here; the kernel calls it after every lend and
   *  return (record-loans.md). `null` is "back". */
  onLoan?(orgId: string, id: string, loan: { holder_id: string | null; due_back: string | null } | null): Promise<void>;
  /** The kind keeps a loan's due day in this date field of its own, which
   *  already reaches the calendar and Needs you, so the kernel's loan rows
   *  leave it out rather than say it twice. */
  loanDueField?: string;
  /** Create an entity; returns the new entity's id. */
  create(orgId: string, fields: Record<string, unknown>): Promise<string>;
  update(orgId: string, id: string, fields: Record<string, unknown>): Promise<void>;
  /** Optional, with `updateIf`: the record's version now (`rowVersionOf`),
   *  null when there is no such record. */
  version?(orgId: string, id: string): Promise<string | null>;
  /** Optional: `update`, only if the record is still at `version`. Answers
   *  the record's new version, or null when it changed in between and
   *  nothing was written (`updateRowAt`). Kernel code that writes a record
   *  somebody else may be editing (a share's mirror) reads the version,
   *  then the record, decides, and writes with this, so an edit in between
   *  is never overwritten. */
  updateIf?(orgId: string, id: string, fields: Record<string, unknown>, version: string): Promise<string | null>;
  /** Optional: set these metadata keys on one record and leave every other
   *  key as the live row holds it, in one statement (`withMetadataMerged`).
   *  `update` writes metadata wholesale, which is right for a sync that owns
   *  the whole bag and wrong for anyone filling a few fields on a record they
   *  do not own: an order stamping where a printer came from must not drop
   *  the printer's other fields (#3856). */
  mergeMetadata?(orgId: string, id: string, fields: Record<string, unknown>): Promise<void>;
  /** Optional: the id of an existing record whose `field` (a column, or a key
   *  inside `metadata` when `metadata` is true) equals `value`, or null. A sync
   *  asks this before creating a record its id-map does not know, so a record
   *  somebody already made with the source's key is ADOPTED instead of
   *  duplicated: two copies of one printer with the same source id, one made by an
   *  assistant and one by the next sync, was the bug (#3836). */
  findByKey?(orgId: string, key: { field: string; metadata: boolean }, value: string): Promise<string | null>;
  snapshotDeletion?(orgId: string, id: string): Promise<DeletionSnapshot | null>;
  restoreDeletion?(orgId: string, snapshot: DeletionSnapshot): Promise<void>;
  delete(orgId: string, id: string): Promise<void>;
  /** Optional: this thing is no longer the person's (sold, given away, parted
   *  out, …; `@cobblr/platform-contract/disposition`). The module records it
   *  the way its kind already means "out of use" (a machine's lifecycle
   *  state, a part's archive flag), so the record reads back `retired: true`
   *  and keeps its history. A kind without it has no such notion, and a
   *  caller says so rather than pretending. */
  retire?(orgId: string, id: string, how: { disposition: Disposition }): Promise<void>;
  /** Optional: the way back from `retire`: it is the person's again, in the
   *  lists and the totals, as it was before it left. A kind with `retire`
   *  and no `unretire` makes "I got it back" impossible, so give both. */
  unretire?(orgId: string, id: string): Promise<void>;
  /** Optional: existing entities of this kind, for a natural-key match during
   *  an import preview — so a one-time import MERGES a source record into an
   *  already-present row (same name) instead of duplicating it. Without this,
   *  an importer treats every unmapped source record as a brand-new create. */
  listForMatch?(
    orgId: string,
  ): Promise<Array<{ id: string; name: string; parentId?: string | null; kind?: string | null; instance?: string | null }>>;
  /** Optional: move values held under a custom field into the module's own
   *  taxonomy column, for a kind that declares `categoryAxis`.
   *
   *  The platform's scan category axis grew a choice field before a module's
   *  own tree could answer for it (#3223), so a workspace can hold values in
   *  `metadata[field]` that the module's own category filter never sees. Only
   *  the module may read its table, so the module moves them; the platform
   *  only orders the move before it removes the field. For each record with a
   *  value under `field` and nothing in `column`: find or create the taxonomy
   *  entry by normalised key, in the record's own instance, set the column,
   *  drop the metadata key. A record that already has a `column` value keeps
   *  it (somebody chose it) and loses only the stale key.
   *
   *  Idempotent: a second call finds nothing to move. `remaining` is how many
   *  records still hold a value under `field`; the platform removes the field
   *  only at zero, so a crash half way leaves a consistent workspace that the
   *  next pass finishes. */
  adoptAxisValues?(
    orgId: string,
    args: { field: string; column: string },
  ): Promise<{ moved: number; remaining: number }>;
  /** Optional: read an entity's current fields, so an import preview can show the
   *  both-sides diff (what's there now vs what the source would write). */
  read?(orgId: string, id: string): Promise<Record<string, unknown> | null>;
  /** Optional: put this exact row back, ID AND ALL.
   *
   *  Undo means the workspace returns to the state it was in, not that an
   *  opposite operation is performed. Those differ in ways that matter: a
   *  delete undone by CREATING a lookalike gives the record a new id, so every
   *  shelf that was inside it, every label pointing at it and every part filed
   *  under it are still pointing at something that no longer exists. It also
   *  runs the forward-write rules again, so a restore can be REFUSED by a rule
   *  the original write predates.
   *
   *  A restore is not a create. It writes the stored row back as it was, id
   *  included, and skips the validation a new record would face — the state
   *  being restored is by definition one this workspace already held.
   *
   *  Without this, undoing a delete falls back to recreating a copy, and says
   *  so plainly rather than pretending. */
  restore?(orgId: string, image: Record<string, unknown>): Promise<void>;
  /** Optional: the record's WHOLE row, every column, for a change ledger to
   *  keep as the state to come back to.
   *
   *  A resolved record is a curated view — the fields a kind chooses to
   *  publish. Notes, descriptions and anything the resolver leaves out are
   *  therefore invisible to an undo built on it: not restored, and not even
   *  noticed as having changed. Restoring a view is not restoring the state. */
  snapshot?(orgId: string, id: string): Promise<Record<string, unknown> | null>;
  /** Optional: what would go WITH this record if it were deleted.
   *
   *  Undo needs this because a delete is not local. Locations cascade to their
   *  children, so an undo that carefully spares a shelf you had edited, and
   *  then removes the rack it was in, has deleted your shelf anyway — one step
   *  later and with no message. Returning the names of what depends on this
   *  record lets an undo stop and say which.
   *
   *  Names, not a count, so the refusal can say WHICH thing it protected. */
  dependents?(orgId: string, id: string): Promise<string[]>;
  /** Optional: the usage counters a record of this kind keeps (a printer's
   *  print hours and prints), and a read of one record's current values. A
   *  maintenance schedule "every 200 print hours" is due by these, and the
   *  record's own module is the only one allowed to read its table (#3876).
   *  A value is null when the record has not counted anything yet. */
  counters?: EntityCounters;
}

/** One counter a kind keeps: its key in the kind's own storage, and what it
 *  counts in words a person reads ("print hours"). */
export interface EntityCounterDef {
  key: string;
  label: string;
}

export interface EntityCounters {
  defs: readonly EntityCounterDef[];
  read(orgId: string, id: string): Promise<Record<string, number | null>>;
}

/** A writer's refusal to create a second record where one of that name
 *  already is (a shelf called "Top" on a rack that has one). Carries the one
 *  that is there, so a caller that mirrors another system can link to it
 *  instead of failing: a sync whose source had the same place as a room made
 *  by hand refused every run and left everything pointing at it unmapped
 *  (#3900). The message is the writer's own sentence, unchanged. */
export class DuplicateRecordError extends Error {
  readonly existingId: string;
  constructor(message: string, existingId: string) {
    super(message);
    this.name = "DuplicateRecordError";
    this.existingId = existingId;
  }
}

/** Rows a module keeps in a table of their own that belong to one record and
 *  say something the owner wrote about it: a pattern's needs, a recipe's
 *  ingredients. A shared record carries them (coordinator, 2026-10-13: shared
 *  records carry their child rows, #6252), scoped to that record, and they
 *  follow it like its files. `read` gives the rows as they can travel (no ids
 *  of the owner's other records, nothing of the owner's own use of them);
 *  `write` makes a record's set exactly those rows. */
export interface ShareChildren {
  /** The parent's module kind ("projects:project"); an instance kind's rows
   *  are its module kind's. */
  kind: string;
  /** This set's name, unique for the kind ("pattern-needs"). */
  name: string;
  /** The table the rows live in, for the guard that every parent-keyed table
   *  is declared or says why not (lint:share-children). */
  table: string;
  read(orgId: string, parentId: string): Promise<Array<Record<string, unknown>>>;
  write(orgId: string, parentId: string, rows: Array<Record<string, unknown>>): Promise<void>;
}
