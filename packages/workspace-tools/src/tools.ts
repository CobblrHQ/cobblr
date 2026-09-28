// THE workspace tool registry — every read/write an AI surface can perform on
// a workspace, defined ONCE. Consumers:
//   - the in-app Ask Cobb chat: read tools auto-run inside the agent loop
//     (through the caller's own permissions); WRITE tools become PROPOSALS the
//     user confirms — the chat never mutates inline;
//   - the MCP server: registers each tool 1:1 for an external Claude (writes
//     execute directly there — the external client owns its own confirm UX).
// Tool `mode` is what encodes that difference; descriptions are written for
// the MODEL (guidance on when to reach for each tool lives here, not in
// per-consumer prompts).
//
// Adding a capability = one entry here → both surfaces get it. Never add a
// tool to a consumer directly.

import { z } from "zod";
import { type WorkspaceApi, type WorkspaceApiResponse, type ToolResult, toolOk, toolFail, apiErrorMessage } from "./api.js";
import {
  withKindsTitleField,
  fetchKinds,
  resolveCreatePath,
  resolveUpdatePath,
  resolveDeletePath,
  summarizeKind,
} from "./kinds.js";
import { explainRecords } from "./field-meanings.js";
import { CURSOR_PARAM, decodeCursor, pageEnd, type Paging } from "./paging.js";

export type ToolMode = "read" | "write";

interface WorkspaceToolBase {
  /** Bare name — consumers prefix as needed (MCP: `cobblr_<name>`). */
  name: string;
  description: string;
  params: z.ZodRawShape;
  execute(api: WorkspaceApi, args: Record<string, unknown>): Promise<ToolResult>;
}

/** A read tool must say how a caller gets every row it can return (paging.ts):
 *  required here so a new list tool cannot ship capped with no way past it. */
export type WorkspaceTool =
  | (WorkspaceToolBase & { mode: "read"; paging: Paging })
  | (WorkspaceToolBase & { mode: "write"; paging?: never });

/** Clamp big reads so a tool result stays prompt-sized. */
const LIST_LIMIT_MAX = 50;
/** count_records walks the whole kind in pages; the route caps a page at 200. */
const COUNT_PAGE = 200;
const COUNT_SCAN_MAX = 5000;
/** search_records: rows of EACH kind per page (the search route's own default). */
const SEARCH_PER_KIND = 10;
/** list_scan_inbox with a text filter reads up to this many 200-row pages. */
const SCAN_INBOX_TEXT_PAGES = 10;

/** Case-insensitive "does any text on this record contain q" — title, every
 *  field, nested bags. What a person means by "the Bambu" or "my deltas". */
export function recordMatchesText(rec: unknown, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  let text: string;
  try {
    text = JSON.stringify(rec) ?? "";
  } catch {
    text = String(rec);
  }
  return text.toLowerCase().includes(needle);
}

/** What list_records' `q` does, said once: the parameter's description and
 *  the behaviour below come from here, so a model reading the description is
 *  told what the results actually are. The server's own `q` matches beyond the
 *  name for some kinds, so "name first, other fields only if no name match"
 *  was not true; each result now says which field matched instead (#3814). */
export const LIST_Q_MEANS = "Text filter over name and other text; each result's matched_on says which, name matches first";

/** Which field of a record a text query matched: "name" when its name does,
 *  else the first other text field that does, else null. */
export function matchedOn(rec: unknown, q: string): string | null {
  const needle = q.trim().toLowerCase();
  if (!needle || !rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  const fields = (r.fields && typeof r.fields === "object" ? r.fields : r) as Record<string, unknown>;
  const has = (v: unknown) => typeof v === "string" && v.toLowerCase().includes(needle);
  if (has(r.title) || has(fields.name) || has(r.name)) return "name";
  const bags: Array<Record<string, unknown>> = [fields];
  if (fields.metadata && typeof fields.metadata === "object") bags.push(fields.metadata as Record<string, unknown>);
  for (const bag of bags) {
    for (const [k, v] of Object.entries(bag)) {
      if (k === "name" || k === "title" || k === "metadata") continue;
      if (has(v)) return k;
    }
  }
  return null;
}

/** A page's items labelled with what matched, name matches first. */
function labelMatches<T>(items: T[], q: string): Array<T & { matched_on?: string }> {
  const labelled = items.map((it) => {
    const on = matchedOn(it, q);
    return (on ? { ...it, matched_on: on } : it) as T & { matched_on?: string };
  });
  return [...labelled.filter((i) => i.matched_on === "name"), ...labelled.filter((i) => i.matched_on !== "name")];
}

/** A record's value for a key: top-level, or inside `fields` / `data`. */
function fieldValue(rec: Record<string, unknown>, key: string): unknown {
  if (key in rec) return rec[key];
  for (const bag of ["fields", "data", "custom_fields"]) {
    const inner = rec[bag];
    if (inner && typeof inner === "object" && key in (inner as Record<string, unknown>)) {
      return (inner as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

/** Every record of a kind, page by page (the route caps a page at 200). */
async function walkKind(
  api: WorkspaceApi,
  kind: string,
  opts: { includeRetired?: boolean } = {},
): Promise<
  | { ok: true; items: Array<Record<string, unknown>>; total: number; complete: boolean }
  | { ok: false; res: WorkspaceApiResponse }
> {
  const items: Array<Record<string, unknown>> = [];
  let total = 0;
  const retired = opts.includeRetired ? "&include_retired=1" : "";
  for (let offset = 0; offset < COUNT_SCAN_MAX; offset += COUNT_PAGE) {
    const res = await api.request("GET", `/entities/${encodeURIComponent(kind)}?limit=${COUNT_PAGE}&offset=${offset}${retired}`);
    if (res.status >= 400) return { ok: false, res };
    const body = res.body as { items?: unknown[]; total?: number };
    const page = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
    items.push(...page);
    total = typeof body.total === "number" ? body.total : items.length;
    if (page.length < COUNT_PAGE || items.length >= total) break;
  }
  return { ok: true, items, total: Math.max(total, items.length), complete: items.length >= total };
}

/** list_records' fallback when the kind's own search found nothing: the same
 *  page shape, matched over every text field, and labelled as such. */
async function scanByText(
  api: WorkspaceApi,
  kind: string,
  q: string,
  limit: number,
  opts: { includeRetired?: boolean } = {},
  offset = 0,
): Promise<{ body: Record<string, unknown>; next: number | null } | null> {
  const walked = await walkKind(api, kind, opts);
  if (!walked.ok) return null;
  const hits = walked.items.filter((r) => recordMatchesText(r, q));
  const items = hits.slice(offset, offset + limit);
  const end = offset + items.length;
  const notes: string[] = [];
  if (end < hits.length) notes.push(`PARTIAL: records ${offset + 1}-${end} of ${hits.length}. Do not count, rank, or say "none" from this page; call again with cursor = next_cursor for the rest, or use count_records for exact totals.`);
  if (!walked.complete) notes.push(`scanned the first ${walked.items.length} of ${walked.total} records only`);
  const body = {
    shown: items.length,
    total: hits.length,
    partial: end < hits.length,
    matched_by: `any text field (the kind's own search found no NAME containing "${q}")`,
    // Nothing here is not nothing anywhere. "how much do I have of the black
    // yarn" was searched in the Yarn list, found nothing, and answered "you
    // don't have any black yarn" while four sat in Inventory (#3085): a
    // thing filed in one list is not in another, and the cross-kind search
    // is the tool that looks everywhere.
    ...(hits.length === 0
      ? { hint: `nothing in ${kind} matched "${q}". A thing filed in another list is not here: search_records looks across every list and kind before you say there is none.` }
      : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
    items,
  };
  return { body, next: end < hits.length ? end : null };
}

/**
 * A list page that tells the truth about itself FIRST. The route returns
 * `{items, total}`; the model used to get the items with a "there may be
 * more" note at the very end, which is the part the agent loop's clamp cut
 * off. So the count leads: `shown` / `total` / `partial`, and the note comes
 * before the items, where a model reads it.
 */
export function pageWithTruth(body: unknown, limit: number, offset = 0): unknown {
  const b = (body ?? {}) as { items?: unknown[]; total?: number };
  if (!Array.isArray(b.items)) return body;
  const shown = b.items.length;
  const known = typeof b.total === "number";
  const total = known ? (b.total as number) : undefined;
  // A later page is part of a list even when it is the last one.
  const partial = offset > 0 || (known ? shown < (total as number) : shown === limit);
  const range = `records ${offset + 1}-${offset + shown}`;
  const extent = known
    ? offset > 0 ? `${range} of ${total}` : `${shown} of ${total} records`
    : offset > 0 ? `${range}, there may be more` : `the first ${shown} records, there may be more`;
  return {
    shown,
    ...(known ? { total } : {}),
    partial,
    ...(partial
      ? {
          note: `PARTIAL: ${extent}. Do not count, rank, or say "none" from this page. Call again with cursor = next_cursor for the next page, or use count_records for exact totals.`,
        }
      : {}),
    ...b,
  };
}

/** The dashboard's "needs you" rows (api/src/routes/attention.ts). */
interface AttentionRow {
  kind: string;
  label: string;
  count: number;
  sample?: string[];
  entries?: Array<{
    id: string;
    title: string;
    /** The record the entry is about, by the kind the registry names it (so a
     *  chip can open it) and its bare name. Absent for a capture or a device. */
    record?: { kind: string; id: string; name: string };
  }>;
}

/** The record's name as the CHANGE recorded it. The activity route treats a
 *  diff that carries a name as already answering "which one", and only resolves
 *  a live title for the entries that don't — so both halves have to be read to
 *  name every entry. */
function nameFromDiff(diff: unknown): string | null {
  if (!diff || typeof diff !== "object") return null;
  const d = diff as Record<string, unknown>;
  for (const key of ["name", "title", "label"]) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** One activity-log entry, already enriched server-side with the actor's name
 *  and (where the diff doesn't carry one) the record's live title. */
interface ActivityRow {
  /** The log's own sequence (bigserial, so a string over JSON): where the next page starts. */
  id?: string | number;
  action: string;
  entity_type: string;
  entity_id: string;
  module_name?: string | null;
  occurred_at: string;
  title?: string | null;
  diff?: unknown;
  auth_method?: string;
  actor?: { display_name?: string | null; email?: string | null } | null;
  token?: { name?: string } | null;
}

interface NotificationRow {
  message: string;
  event_type: string;
  created_at: string;
  read_at?: string | null;
  link_url?: string | null;
}

interface MaintenanceRow {
  id: string;
  name: string;
  entity_module?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  scheduled_at?: string | null;
  performed_at?: string | null;
  recurrence_rule?: string | null;
  notes?: string | null;
}

interface CalendarRow {
  date: string;
  title: string;
  source: string;
  category?: string;
  entityModule?: string;
  entityType?: string;
  entityId?: string;
}

/** The workspace's own shape — one row type per area of get_workspace_setup. */
interface InstanceRow {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default?: boolean;
  item_count?: number | null;
}

interface ViewRow {
  name: string;
  entity_kind: string;
  view_type: string;
  is_default?: boolean;
  pinned?: boolean;
}

interface BindingRow {
  id: string;
  source_kind: string;
  action_id: string;
  trigger_type: string;
  trigger_event?: string | null;
  trigger_schedule?: string | null;
  enabled?: boolean;
}

interface AppRow {
  name: string;
  slug: string;
}

interface TemplateRow {
  name: string;
  target_kind: string;
  description?: string | null;
  defaults?: Record<string, unknown>;
}

interface UnitVocabularyRow {
  builtins?: Array<{ name: string; symbol: string }>;
  custom?: Array<{ name: string; symbol: string }>;
  display_mode?: string;
}

/** A scan-inbox row, as the core-scan list route returns it. Only the fields
 *  worth telling a model about — `needs_review`, `review_reason` and
 *  `waiting_days` are derived server-side from the shared triage predicate,
 *  so the model is told the same thing the Scan page shows the user. */
interface ScanInboxRow {
  id?: string;
  suggested_name?: string | null;
  suggested_manufacturer?: string | null;
  barcode_text?: string | null;
  source_kind?: string | null;
  quantity?: number | null;
  ai_notes?: string | null;
  scan_area?: string | null;
  scan_batch_id?: string | null;
  needs_review?: boolean;
  review_reason?: string | null;
  waiting_days?: number | null;
  target_kind?: string | null;
  target_location_id?: string | null;
  target_container_id?: string | null;
  suggested_candidates?: unknown;
}

/** One queue row, flattened to what a person would say about it. Drops the
 *  identification internals (candidate arrays, scores, image ids) — a chat
 *  answer needs what it is, how long it has waited and what it still needs. */
function summarizeScanItem(
  it: ScanInboxRow,
  batches: Record<string, { label?: string | null }>,
): Record<string, unknown> {
  // Where it is headed: the route already chosen, else the matchmaker's top
  // candidate (what filing it would create, and under which category).
  const top = Array.isArray(it.suggested_candidates)
    ? (it.suggested_candidates as Array<{ kind?: string; label?: string; category?: string }>)[0]
    : null;
  const target = it.target_kind ?? top?.kind ?? null;
  const session = it.scan_batch_id ? batches[it.scan_batch_id]?.label : null;
  return {
    id: it.id,
    // An unidentified capture is the honest answer, not a blank name.
    name: it.suggested_name ?? "(not identified yet)",
    ...(it.suggested_manufacturer ? { brand: it.suggested_manufacturer } : {}),
    ...(top?.category ? { category: top.category } : {}),
    ...(it.quantity && it.quantity !== 1 ? { quantity: it.quantity } : {}),
    captured_as: it.source_kind ?? "scan",
    ...(it.barcode_text ? { barcode: it.barcode_text } : {}),
    ...(typeof it.waiting_days === "number" ? { waiting_days: it.waiting_days } : {}),
    // The reason rides with the flag: "needs review" alone sends the user
    // back to the page to find out why, and the card already says.
    ...(it.needs_review ? { needs_review: true, ...(it.review_reason ? { review_reason: it.review_reason } : {}) } : {}),
    ...(it.ai_notes ? { notes: it.ai_notes } : {}),
    ...(target ? { would_become: target } : {}),
    has_destination: !!(it.target_location_id || it.target_container_id),
    ...(it.scan_area ? { scanned_in: it.scan_area } : {}),
    ...(session ? { session } : {}),
  };
}

interface ScanItemRow extends ScanInboxRow {
  status?: string | null;
  suggested_sku?: string | null;
  source_url?: string | null;
  ai_confidence?: string | null;
  ai_suggested_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  resolved_at?: string | null;
  image_file_id?: string | null;
  catalog_image_file_id?: string | null;
  catalog_image_url?: string | null;
  group_image_file_id?: string | null;
  suggested_location_id?: string | null;
  suggested_location_note?: string | null;
  target_container_kind?: string | null;
  suggested_metadata?: Record<string, unknown> | null;
  source_conflict?: unknown;
  resolved_destination?: { module: string; instance: string | null; kind: string | null; label: string | null } | null;
}

/** Metadata the pipeline keeps for itself: how it got there, not what it
 *  found. Everything else in `suggested_metadata` is a finding and is shown;
 *  a key added tomorrow is shown until someone decides it is bookkeeping,
 *  which is the safe way round for "every extracted field". */
const SCAN_BOOKKEEPING = new Set([
  "history",
  "pre_rerun",
  "field_provenance",
  "extra_photos",
  "matched_at",
  "label_words",
  "trim",
  "trim_box",
  "crop",
  "crop_box",
  "catalog_history",
  "user_hint",
]);

/** One inbox item, whole, as the scan card knows it (#3854). The list stays
 *  compact because 144 items at ~5 KB each would flood a context; the detail
 *  is where review happens, so nothing a person could see on the card is
 *  left out here. */
export function scanItemDetail(it: ScanItemRow, api: Pick<WorkspaceApi, "link">): Record<string, unknown> {
  const meta = (it.suggested_metadata ?? {}) as Record<string, unknown>;
  const link = (to: { api: string } | { app: string }) => api.link?.(to) ?? null;
  const fileLink = (fileId: string) => link({ api: `/modules/core-files/files/${encodeURIComponent(fileId)}/raw` });
  const pictures: Array<Record<string, unknown>> = [];
  const addFile = (role: string, fileId: unknown) => {
    if (typeof fileId !== "string" || !fileId || pictures.some((p) => p.file_id === fileId)) return;
    pictures.push({ role, file_id: fileId, link: fileLink(fileId) });
  };
  addFile("your photo", it.image_file_id);
  for (const extra of Array.isArray(meta.extra_photos) ? meta.extra_photos : []) addFile("another photo", extra);
  addFile("the group shot it was split from", it.group_image_file_id);
  addFile("catalog picture", it.catalog_image_file_id);
  if (!it.catalog_image_file_id && typeof it.catalog_image_url === "string" && it.catalog_image_url) {
    pictures.push({ role: "catalog picture", link: it.catalog_image_url });
  }
  const findings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SCAN_BOOKKEEPING.has(k) || k.startsWith("_") || v === null || v === undefined || v === "") continue;
    findings[k] = v;
  }
  const candidates = (Array.isArray(it.suggested_candidates) ? it.suggested_candidates : []) as Array<Record<string, unknown>>;
  const history = Array.isArray(meta.history) ? [...(meta.history as unknown[])].reverse() : [];
  const appLink = link({ app: `/scan?item=${encodeURIComponent(String(it.id ?? ""))}` });
  return {
    id: it.id,
    status: it.status ?? "pending",
    name: it.suggested_name ?? "(not identified yet)",
    ...(it.suggested_manufacturer ? { brand: it.suggested_manufacturer } : {}),
    ...(it.suggested_sku ? { sku: it.suggested_sku } : {}),
    captured_as: it.source_kind ?? "scan",
    ...(it.barcode_text ? { barcode: it.barcode_text } : {}),
    ...(it.source_url ? { source_url: it.source_url } : {}),
    ...(it.quantity && it.quantity !== 1 ? { quantity: it.quantity } : {}),
    confidence: it.ai_confidence ?? null,
    ...(it.ai_suggested_at ? { identified_at: it.ai_suggested_at } : {}),
    needs_review: !!it.needs_review,
    ...(it.review_reason ? { review_reason: it.review_reason } : {}),
    ...(it.source_conflict ? { source_conflict: it.source_conflict } : {}),
    ...(it.ai_notes ? { notes: it.ai_notes } : {}),
    // Where it goes, in the order the card decides it: the destination it
    // resolved, then the ranked candidates each with the fields it would
    // file with.
    destination: it.resolved_destination ?? null,
    candidates: candidates.map((c) => ({
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.label ? { label: c.label } : {}),
      ...(c.name ? { name: c.name } : {}),
      ...(typeof c.confidence === "number" ? { confidence: c.confidence } : {}),
      ...(c.category ? { category: c.category, ...(c.category_is_new ? { category_is_new: true } : {}) } : {}),
      ...(typeof c.quantity === "number" ? { quantity: c.quantity } : {}),
      ...(c.fields && typeof c.fields === "object" ? { fields: c.fields } : {}),
      // Values the model completed from what it knows rather than read off
      // the item: named, so a wrong guess stays visible.
      ...(Array.isArray(c.inferred) && c.inferred.length ? { inferred_fields: c.inferred } : {}),
      ...(c.place_fields && typeof c.place_fields === "object" ? { place_fields: c.place_fields } : {}),
      ...(c.notes ? { notes: c.notes } : {}),
      ...(c.ai_fallback ? { routed_without_ai: c.ai_fallback } : {}),
    })),
    ...(it.suggested_location_id || it.suggested_location_note
      ? { suggested_location: { id: it.suggested_location_id ?? null, why: it.suggested_location_note ?? null } }
      : {}),
    has_destination: !!(it.target_location_id || it.target_container_id),
    ...(it.target_location_id ? { going_to_location: it.target_location_id } : {}),
    ...(it.target_container_id ? { going_into: { kind: it.target_container_kind ?? null, id: it.target_container_id } } : {}),
    findings,
    provenance: (meta.field_provenance as Record<string, unknown> | undefined) ?? {},
    pictures,
    ...(pictures.some((p) => p.link === null) ? { pictures_note: "no public address is configured here, so pictures are file ids only" } : {}),
    history,
    ...(it.scan_area ? { scanned_in: it.scan_area } : {}),
    ...(it.created_at ? { captured_at: it.created_at } : {}),
    ...(typeof it.waiting_days === "number" ? { waiting_days: it.waiting_days } : {}),
    ...(it.resolved_at ? { resolved_at: it.resolved_at } : {}),
    ...(appLink ? { open_in_app: appLink } : {}),
  };
}

// ─────────────────────── escort destinations (tier 1.5) ───────────────────
//
// The surfaces the assistant may WALK THE USER TO but never operate: each is a
// tier-1 "no door" surface (docs/design-decisions/platform-actions.md — the
// consent tiers), where a Confirm card cannot carry the decision's weight, so
// the page itself is the consent surface. The escort is inert by construction:
// navigation + prefilled form fields, and the page's own submit — under the
// page's own role checks, showing the full blast radius — is the only thing
// that mutates. Prefill params are only read by pages that opt in via
// usePrefill(); nothing ever auto-submits.
//
// This list IS the tier-1 catalogue. Adding a row here must not add a write
// path — if a surface deserves operating, it becomes an action (tier 2), not
// a bigger escort.

export interface EscortDestination {
  id: string;
  path: string;
  label: string;
  /** Prefill keys the destination's page reads (via usePrefill) — the contract
   *  between this registry and the page. Empty = navigation only. */
  prefill: Record<string, string>;
  /** Why this surface is escort-only — surfaced to the model so it can say so. */
  why: string;
  /** Actions that ALREADY do part of what this screen is for, listed so the
   *  model is told to run them instead of escorting.
   *
   *  This exists because the `fields` entry went stale the day field editing
   *  got actions: its `why` still read "editing or deleting a field touches the
   *  data under it", and a local model duly answered "I've taken you to the
   *  Fields & forms screen" to four separate requests it could have just done
   *  (measured, 2026-08-25). An escort is the least useful answer there is when
   *  a door exists, so the doors are named here and lint:escort-claims fails
   *  when a surface gains an action and this list does not. */
  covered_by?: string[];
}

export const ESCORT_DESTINATIONS: EscortDestination[] = [
  {
    id: "members",
    path: "/configuration/members",
    label: "Members & invites",
    prefill: {
      email: "email address to prefill on the invite form",
      role: "role to preselect: member, editor, admin or guest",
    },
    why: "membership is a human decision",
  },
  {
    id: "api-tokens",
    path: "/configuration/tokens",
    label: "API tokens",
    prefill: {},
    why: "the assistant never mints or revokes credentials",
  },
  {
    id: "backup",
    path: "/configuration/backup",
    label: "Backup & restore",
    prefill: {},
    why: "a restore replaces data wholesale",
  },
  {
    id: "ai-config",
    path: "/configuration/ai",
    label: "AI providers",
    prefill: {},
    why: "the assistant does not configure its own keys",
  },
  {
    id: "wires",
    path: "/wires",
    label: "Automations (wires)",
    prefill: {},
    why: "building an automation is consented in the composer, not a card; switching one on or off is an action",
    covered_by: ["platform:set-wire-enabled"],
  },
  {
    id: "fields",
    path: "/fields",
    label: "Fields & forms",
    prefill: {},
    // The covered_by list below names what an action does instead, so the
    // why says only what the screen is still FOR (#3378 added two sweeps to
    // the list and the description hit its cap).
    why: "only a field's TYPE and the data behind it need the screen",
    covered_by: [
      "platform:add-field",
      "platform:edit-field",
      "platform:remove-field",
      "platform:group-fields",
      "platform:ungroup-fields",
      "platform:set-field-preset",
      // Kind-wide sweeps over a field, workspace-scoped since #3378: the
      // screen shows the field, these retire it into the real Location.
      "inventory:field-to-location",
      "assets:field-to-location",
    ],
  },
];

/** The relationship list_related reports a placement under: a thing points at the container it is in. */
export const PLACED_IN = "placed_in";
/** The kind whose records nest through their own parent_id (core-locations),
 *  read into a location's contents beside what placement holds. */
const LOCATION_KIND = "core-locations:location";
/** A relationship filter that means placement, in the words a model reaches
 *  for ("location", "stored_in", "contains", "inside"): the exact name is not
 *  what a model asks with. */
const PLACEMENT_WORDS = /placed|placement|locat|stored|contain|inside|within|holds/i;
/** Whether a list_related call asked about placement: no relationship filter,
 *  the placement relationship itself, or a word that means it. Exported so a
 *  reader of the tool's result can tell "it looked and found no container"
 *  from "it did not look" by the same rule the tool decides by. */
export function placementAsked(relationship: unknown): boolean {
  const rel = typeof relationship === "string" ? relationship.trim() : "";
  return !rel || rel === PLACED_IN || PLACEMENT_WORDS.test(rel);
}

export const WORKSPACE_TOOLS: WorkspaceTool[] = [
  {
    name: "take_user_to",
    // Why each destination is an escort and not an action lives on the
    // destination (ESCORT_DESTINATIONS.why); lint:escort-claims keeps the
    // covered_by list honest. The sentences here are only what a model needs
    // to choose this tool and to NOT choose it over an action - the longer
    // rationale that used to sit here cost 900 chars on every turn.
    description:
      "ESCORT the user to a configuration screen you cannot operate. In the app this MOVES their screen there and can PREFILL the form; nothing is submitted. " +
      "NEVER escort for something an action covers: check list_actions and RUN it. Destinations: " +
      ESCORT_DESTINATIONS.map(
        (d) =>
          `${d.id} (${d.why}${d.covered_by?.length ? `; but ${d.covered_by.join(", ")} do those — run them, don't escort` : ""})`,
      ).join("; ") +
      ".",
    mode: "read",
    paging: { by: "one-call", why: "moves the screen; returns no rows" },
    params: {
      destination: z
        .string()
        .describe(`One of: ${ESCORT_DESTINATIONS.map((d) => d.id).join(", ")}`),
      email: z.string().optional().describe("members only: email to prefill on the invite form"),
      role: z.string().optional().describe("members only: member, editor, admin or guest"),
    },
    execute: async (_api, args) => {
      const id = typeof args.destination === "string" ? args.destination.trim().toLowerCase() : "";
      const dest = ESCORT_DESTINATIONS.find((d) => d.id === id);
      if (!dest) {
        return toolFail(
          `no such destination — use one of: ${ESCORT_DESTINATIONS.map((d) => d.id).join(", ")}`,
        );
      }
      // Only the keys the destination DECLARES ride along; anything else is
      // dropped, so a page can trust that every prefill.* param it reads was
      // meant for it.
      const params = new URLSearchParams();
      for (const key of Object.keys(dest.prefill)) {
        const v = args[key];
        if (typeof v === "string" && v.trim()) params.set(`prefill.${key}`, v.trim());
      }
      const qs = params.toString();
      return toolOk({
        escort: { path: qs ? `${dest.path}?${qs}` : dest.path, label: dest.label },
        note:
          "The user's screen is moving there now (in-app). Nothing was submitted — tell them what to press to finish, and why this one is theirs to press.",
      });
    },
  },
  {
    name: "list_record_kinds",
    description:
      "List every kind of record this workspace holds (its modules + user-built apps), with each kind's fields and whether records of it can be created/updated/deleted. Call this before creating or querying records of an unfamiliar kind.",
    mode: "read",
    paging: { by: "one-call", why: "every kind this workspace has; a workspace has tens, not thousands" },
    params: {},
    execute: async (api) => {
      const kinds = await fetchKinds(api);
      return toolOk(
        kinds.map((k) => ({
          ...summarizeKind(k),
          can_create: resolveCreatePath(k.id, kinds) !== null,
        })),
      );
    },
  },
  {
    name: "list_records",
    description:
      "List records of ONE kind, optionally filtered by a text query. Use this to see what the user actually has (their stock, their projects, their entries) BEFORE answering questions about their data.",
    mode: "read",
    paging: { by: "cursor" },
    params: {
      kind: z.string().describe("Entity kind id, e.g. inventory:part (see list_record_kinds)"),
      q: z.string().optional().describe(LIST_Q_MEANS),
      limit: z.number().optional().describe(`Max results (default 20, max ${LIST_LIMIT_MAX})`),
      include_retired: z.boolean().optional().describe("Also list archived/retired records (off by default). Set it when asked about something old or retired: \"where is my old drill\""),
      cursor: CURSOR_PARAM,
    },
    execute: async (api, args) => {
      // The cursor carries the query it was made for, so the next page is the
      // next page of THAT list even if a later call words its arguments
      // differently. `o` is the position; `s` marks the any-field scan.
      const cur = decodeCursor<{ k: string; o: number; q?: string; r?: boolean; s?: boolean }>("list_records", args.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const st = cur.state;
      const kind = st?.k ?? String(args.kind ?? "");
      if (st && typeof args.kind === "string" && args.kind && args.kind !== st.k) {
        return toolFail(`that cursor is for ${st.k}, not ${args.kind}. Leave cursor out to start ${args.kind} from the top.`);
      }
      const limit = Math.min(Number(args.limit) || 20, LIST_LIMIT_MAX);
      const qText = st ? (st.q ?? "") : typeof args.q === "string" ? args.q.trim() : "";
      const includeRetired = st ? st.r === true : args.include_retired === true;
      const offset = st?.o ?? 0;
      const state = (o: number, s?: boolean) => ({ k: kind, o, ...(qText ? { q: qText } : {}), ...(includeRetired ? { r: true } : {}), ...(s ? { s: true } : {}) });
      const kinds = () => fetchKinds(api).catch(() => []);
      if (!st?.s) {
        const q = qText ? `&q=${encodeURIComponent(qText)}` : "";
        const retired = includeRetired ? "&include_retired=1" : "";
        const res = await api.request("GET", `/entities/${encodeURIComponent(kind)}?limit=${limit}&offset=${offset}${q}${retired}`);
        if (res.status >= 400) return toolFail(apiErrorMessage(res, `couldn't list ${kind}`));
        const page = pageWithTruth(res.body, limit, offset) as { items?: unknown[]; total?: number };
        const shown = Array.isArray(page.items) ? page.items.length : 0;
        if (!(qText && offset === 0 && shown === 0)) {
          const end = offset + shown;
          const more = typeof page.total === "number" ? end < page.total : shown === limit;
          const shownPage = qText && Array.isArray(page.items) ? { ...page, items: labelMatches(page.items, qText) } : page;
          return toolOk({ ...(explainRecords(shownPage, await kinds()) as Record<string, unknown>), ...pageEnd("list_records", more ? state(end) : null) });
        }
      }
      // The kind's own search matched nothing by name. Before the model tells
      // the user "you have none", look at every text field ourselves.
      const scan = await scanByText(api, kind, qText, limit, { includeRetired }, st?.s ? offset : 0);
      if (!scan) return toolOk({ ...(explainRecords({ shown: 0, total: 0, partial: false, items: [] }, await kinds()) as Record<string, unknown>), ...pageEnd("list_records", null) });
      const scanned = Array.isArray(scan.body.items) ? { ...scan.body, items: labelMatches(scan.body.items as unknown[], qText) } : scan.body;
      return toolOk({ ...(explainRecords(scanned, await kinds()) as Record<string, unknown>), ...pageEnd("list_records", scan.next === null ? null : state(scan.next, true)) });
    },
  },
  {
    name: "count_records",
    description:
      "Count records of ONE kind, optionally grouped by a field (e.g. group_by \"model\" or \"kinematics\"). Use this for \"how many\", \"which do I have the most of\", \"do I have any X\" — it counts EVERY record in code, so the answer is exact even when the list is too long to read. Group values are compared case-insensitively.",
    mode: "read",
    paging: { by: "one-call", why: "counts in code over every record (walks the kind itself); returns numbers, not rows" },
    params: {
      kind: z.string().describe("Entity kind id, e.g. inventory:part (see list_record_kinds)"),
      group_by: z.string().optional().describe("Field key to group by (title, or any field key from the kind's fields)"),
      q: z.string().optional().describe("Text filter, matched against EVERY text field of each record (name, brand, notes, custom fields), case-insensitive"),
      include_retired: z.boolean().optional().describe("Also count archived/retired records (off by default)"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const groupBy = typeof args.group_by === "string" ? args.group_by.trim() : "";
      const qText = typeof args.q === "string" ? args.q.trim() : "";
      // The text filter is applied HERE, over every field of every record, not
      // by the kind's own search (which may look at the name only).
      const walked = await walkKind(api, kind, { includeRetired: args.include_retired === true });
      if (!walked.ok) return toolFail(apiErrorMessage(walked.res, `couldn't count ${kind}`));
      const all = qText ? walked.items.filter((r) => recordMatchesText(r, qText)) : walked.items;
      const total = qText ? all.length : walked.total;
      const scanned = walked.items.length;
      const complete = walked.complete;
      if (!groupBy) return toolOk({ kind, ...(qText ? { q: qText, matched_by: "any text field" } : {}), total, scanned, complete });
      const counts = new Map<string, { value: string; count: number }>();
      for (const rec of all) {
        const raw = fieldValue(rec, groupBy);
        const value = raw === undefined || raw === null || raw === "" ? "(blank)" : String(raw);
        const key = value.toLowerCase();
        const hit = counts.get(key);
        if (hit) hit.count += 1;
        else counts.set(key, { value, count: 1 });
      }
      const groups = [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      return toolOk({
        kind,
        group_by: groupBy,
        ...(qText ? { q: qText, matched_by: "any text field" } : {}),
        total,
        scanned,
        complete,
        groups,
        ...(groups.length === 1 && groups[0]?.value === "(blank)"
          ? { note: `no record has a value for "${groupBy}"; check the field key with list_record_kinds` }
          : {}),
      });
    },
  },
  {
    name: "get_record",
    description: "Fetch one record by kind + id (fields are projected by the caller's read permissions).",
    mode: "read",
    paging: { by: "one-call", why: "one record by its id, with all its fields" },
    params: {
      kind: z.string().describe("Entity kind id"),
      id: z.string().describe("Record id"),
    },
    execute: async (api, args) => {
      const res = await api.request(
        "GET",
        `/entities/${encodeURIComponent(String(args.kind))}/${encodeURIComponent(String(args.id))}`,
      );
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "record not found"));
      return toolOk(explainRecords(res.body, await fetchKinds(api).catch(() => [])));
    },
  },
  {
    name: "search_records",
    description:
      "Search ACROSS every kind at once by text. Use when you don't know which kind holds the thing (\"citron\" might be a yarn, a part, or a note). For one known kind, prefer list_records with q.",
    mode: "read",
    paging: { by: "cursor" },
    params: {
      q: z.string().describe("Search text"),
      kinds: z.string().optional().describe("Comma-separated kind ids to restrict to"),
      cursor: CURSOR_PARAM,
    },
    execute: async (api, args) => {
      const cur = decodeCursor<{ q: string; k?: string; o: number }>("search_records", args.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const q = cur.state?.q ?? String(args.q ?? "").trim();
      if (!q) return toolFail("q is required");
      const kindList = cur.state ? (cur.state.k ?? "") : typeof args.kinds === "string" ? args.kinds.trim() : "";
      const offset = cur.state?.o ?? 0;
      const perKind = SEARCH_PER_KIND;
      const kinds = kindList ? `&kinds=${encodeURIComponent(kindList)}` : "";
      const res = await api.request(
        "GET",
        `/modules/core-search/search?q=${encodeURIComponent(q)}${kinds}&per_kind=${perKind}&offset=${offset}`,
      );
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "search failed"));
      const more = (res.body as { has_more?: unknown }).has_more === true;
      const { has_more: _h, ...body } = res.body as Record<string, unknown>;
      return toolOk({
        ...(explainRecords(body, await fetchKinds(api).catch(() => [])) as Record<string, unknown>),
        ...pageEnd("search_records", more ? { q, ...(kindList ? { k: kindList } : {}), o: offset + perKind } : null),
      });
    },
  },
  {
    name: "list_related",
    description:
      "List the records LINKED to one record: which project a part belongs to, what is inside a location, bin or box (placed_in), what a build consumed. A location's contents include its sub-locations (a garage holds its bins; ask a bin to see inside it). Returns each link's relationship, direction, and the other record's kind + id + title. Kind + id alone lists every link.",
    mode: "read",
    paging: { by: "one-call", why: "every link of ONE record, both directions, in one call" },
    params: {
      kind: z.string().describe("The record's entity kind id"),
      id: z.string().describe("The record's id"),
      relationship: z.string().optional().describe("Only links of this relationship kind"),
      direction: z
        .enum(["out", "in", "both"])
        .optional()
        .describe("out = links this record points at, in = links pointing at it (default both)"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const id = String(args.id ?? "");
      if (!kind || !id) return toolFail("kind and id are required");
      const rel =
        typeof args.relationship === "string" && args.relationship.trim()
          ? `&relationship_kind=${encodeURIComponent(args.relationship.trim())}`
          : "";
      const dir = args.direction === "out" || args.direction === "in" ? args.direction : "both";
      type PairingRow = {
        id: string;
        source_kind: string;
        source_id: string;
        target_kind: string;
        target_id: string;
        relationship_kind: string;
        notes?: string | null;
      };
      const fetchSide = async (side: "out" | "in") => {
        const who = side === "out" ? "source" : "target";
        const res = await api.request(
          "GET",
          `/pairings?${who}_kind=${encodeURIComponent(kind)}&${who}_id=${encodeURIComponent(id)}${rel}`,
        );
        if (res.status >= 400) throw new Error(apiErrorMessage(res, "couldn't list pairings"));
        return ((res.body.items as PairingRow[] | undefined) ?? []).map((p) => ({
          relationship: p.relationship_kind,
          direction: side,
          kind: side === "out" ? p.target_kind : p.source_kind,
          id: side === "out" ? p.target_id : p.source_id,
          ...(p.notes ? { notes: p.notes } : {}),
          pairing_id: p.id,
        }));
      };
      // Placement is the platform's "what is inside what", its own table and
      // not a pairing. A tool that promises what is stored in a location and
      // reads pairings alone answers "empty" for every bin a person filled by
      // placing things in it, which is how they fill bins.
      const wantsPlacement = placementAsked(args.relationship);
      type Placed = { kind: string; id: string; title?: string };
      const placedRow = (side: "out" | "in", e: Placed) => ({
        relationship: PLACED_IN,
        direction: side,
        kind: e.kind,
        id: e.id,
        ...(typeof e.title === "string" && e.title ? { title: e.title } : {}),
      });
      const contents = async () => {
        const res = await api.request(
          "GET",
          `/modules/core-placement/contents?container_kind=${encodeURIComponent(kind)}&container_id=${encodeURIComponent(id)}`,
        );
        // A workspace without placement has nothing inside anything.
        if (res.status >= 400) return [];
        return ((res.body?.items as Placed[] | undefined) ?? []).map((e) => placedRow("in", e));
      };
      const containerOf = async () => {
        const res = await api.request(
          "GET",
          `/modules/core-placement/of?containee_kind=${encodeURIComponent(kind)}&containee_id=${encodeURIComponent(id)}`,
        );
        if (res.status >= 400) return [];
        const c = res.body?.container as Placed | null | undefined;
        return c ? [placedRow("out", c)] : [];
      };
      // Locations nest through core-locations' own parent_id, which placement
      // does not carry, so a garage's contents were only what was placed
      // straight into it and never its shelves and bins: "what's in the
      // garage?" read "The Garage is empty" over a shelf and two full bins
      // (2026-09-20). The tree is one read of the locations list.
      const tree = async (): Promise<Array<ReturnType<typeof placedRow>>> => {
        if (kind !== LOCATION_KIND) return [];
        const res = await api.request("GET", "/modules/core-locations/locations");
        if (res.status >= 400) return [];
        type Loc = { id: string; name?: string; parent_id?: string | null };
        const rows = (res.body?.items as Loc[] | undefined) ?? [];
        const me = rows.find((r) => r.id === id);
        const parent = me?.parent_id ? rows.find((r) => r.id === me.parent_id) : undefined;
        const asPlaced = (r: Loc): Placed => ({ kind: LOCATION_KIND, id: r.id, ...(r.name ? { title: r.name } : {}) });
        return [
          ...(dir !== "out" ? rows.filter((r) => r.parent_id === id).map((r) => placedRow("in", asPlaced(r))) : []),
          ...(dir !== "in" && parent ? [placedRow("out", asPlaced(parent))] : []),
        ];
      };
      try {
        const items = (
          await Promise.all([
            dir !== "in" ? fetchSide("out") : Promise.resolve([]),
            dir !== "out" ? fetchSide("in") : Promise.resolve([]),
            // Whatever direction was asked for. A pairing's direction is
            // arbitrary and worth narrowing; a placement has one meaning,
            // and a model asks a thing for its links pointing IN when it
            // means "what is it in" (the live bench, 2026-09-16: the CubePro
            // asked IN, the Garage asked OUT, both told "nothing").
            wantsPlacement ? containerOf() : Promise.resolve([]),
            wantsPlacement ? contents() : Promise.resolve([]),
            wantsPlacement ? tree() : Promise.resolve([]),
          ])
        ).flat();
        return toolOk({ items });
      } catch (err) {
        return toolFail(err instanceof Error ? err.message : "couldn't list pairings");
      }
    },
  },
  {
    name: "list_actions",
    description:
      "Discover the operations (actions) this workspace can run. scope 'entity': runs on one record, matched_kinds says which kinds. scope 'workspace': a config/admin operation on the whole workspace, invoked WITHOUT a record. Each carries args_schema (pass as invoke_action's args) and undoable; on a connection with no confirmation prompt only undoable ones run, and the rest refuse and say so - tell the user rather than claiming you cannot act. Optionally filter to one kind; workspace actions always included. Run one with invoke_action.",
    mode: "read",
    paging: { by: "one-call", why: "every action the workspace registers; the registry is small and whole" },
    params: {
      kind: z.string().optional().describe("Only entity actions applicable to this kind id (workspace actions still included)"),
    },
    execute: async (api, args) => {
      const res = await api.request("GET", "/registered-actions");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list actions"));
      const items =
        (res.body.items as
          | Array<{
              id?: string;
              label?: string;
              description?: string;
              module_name?: string;
              matched_kinds?: string[];
              scope?: string;
              args_schema?: Record<string, { label?: string; type?: string; required?: boolean; oneOf?: string }> | null;
              undoable?: boolean;
              user_invokable?: boolean;
              internal?: boolean;
              wire_only?: boolean;
              record_optional?: boolean;
              examples?: string[];
            }>
          | undefined) ?? [];
      const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : null;
      // When filtering by a record's kind, still surface workspace-level config
      // actions — they're not record-scoped but the user may want one from here.
      // A wire-only action is never offered (offerableToAssistant).
      const picked = items.filter(offerableToAssistant).filter((a) => !kind || a.scope === "workspace" || (a.matched_kinds ?? []).includes(kind));
      // Project to what a caller needs to actually RUN one. `args` is the
      // decisive field: an action listed without its arguments is an action
      // that cannot be invoked, and the honest-looking conclusion is "I have no
      // way to run this" — which is what happened with core-locations:reorder
      // and its `ids` (2026-08-19).
      return toolOk(
        picked.map((a) => ({
          id: a.id,
          label: a.label,
          description: a.description,
          // Which module it came from: dropped once in the projection below and
          // caught only by a test that pins it, so it stays named here.
          module_name: a.module_name,
          scope: a.scope ?? "entity",
          // Whether running it by mistake can be put right here. A connection
          // with no way to show a confirmation may run only the undoable ones,
          // so this is the difference between "I will do that" and a refusal
          // the user can act on.
          undoable: a.undoable === true,
          // How a person asks for it, so a sentence can be matched to an action
          // rather than guessed at from the id.
          ...(a.examples?.length ? { said_like: a.examples } : {}),
          ...(a.scope === "workspace" ? {} : { matched_kinds: a.matched_kinds ?? [] }),
          // Runs on one of those records, OR with no record at all: "put milk
          // on the shopping list" names no record, and without this said the
          // model created an empty list instead (#3255).
          ...(a.record_optional ? { runs_without_a_record: true } : {}),
          args: a.args_schema && Object.keys(a.args_schema).length
            ? Object.fromEntries(
                Object.entries(a.args_schema).map(([name, spec]) => {
                  const type = spec?.type ?? "text";
                  return [
                    name,
                    {
                      type,
                      ...(spec?.label ? { describes: spec.label } : {}),
                      // What the door will refuse the call for. #3137 gave
                      // every argument these markers and four readers use
                      // them (the plan door, the invoke door, the chat guard,
                      // the bench); the model saw them only in a hand-back,
                      // one round late, so it learned what an action needs by
                      // being refused (#3142).
                      ...(spec?.required ? { required: true } : {}),
                      ...(spec?.oneOf ? { one_of: spec.oneOf } : {}),
                      // Spelling out the JSON shape for a list: "type: list"
                      // alone was read as "a comma-separated string" often
                      // enough to matter, and the order inside a list is
                      // frequently the whole point of the call.
                      ...(type === "list" ? { pass_as: 'a JSON array, in order — ["…", "…"]' } : {}),
                    },
                  ];
                }),
              )
            : undefined,
        })),
      );
    },
  },
  {
    name: "get_attention",
    description:
      "What needs the user RIGHT NOW: the same 'needs you' feed their dashboard shows — stock that has run low, dates that are overdue or coming up in the next 30 days, and captures still waiting to be filed. Derived from the workspace's own field semantics, so it covers every tracker they have, including ones they built themselves. Reach for this FIRST on any open-ended question about their situation (\"what should I do today?\", \"anything need me?\", \"am I behind on anything?\") — it is one call and it is what they are looking at.",
    mode: "read",
    paging: { by: "one-call", why: "the dashboard needs-you feed: one row per kind of thing with its count and a few examples; the count is the whole answer" },
    params: {},
    execute: async (api) => {
      const res = await api.request("GET", "/attention");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read what needs attention"));
      // Each example is the RECORD where the feed knows one (kind, id, its
      // name, the feed's detail beside it), so an answer built from this can
      // name it as something to open; the reply's names are matched against
      // the records the turn read, and a bare title is not a record. Where the
      // feed names no record (a capture, a printer) the title stands alone.
      const rows = ((res.body as { items?: AttentionRow[] }).items ?? []).map((r) => ({
        kind: r.kind,
        what: r.label,
        count: r.count,
        examples: (r.entries?.length
          ? r.entries.map((e) => (e.record ? { kind: e.record.kind, id: e.record.id, title: e.record.name, detail: e.title } : e.title))
          : (r.sample ?? [])
        ).slice(0, 8),
      }));
      if (rows.length === 0) return toolOk({ items: [], note: "Nothing needs them right now." });
      return toolOk({ items: rows });
    },
  },
  {
    name: "list_activity",
    description:
      "The workspace's history, newest first: who created, updated or deleted what, and when. Use for any question about the PAST (\"what changed this week?\", \"who edited this part?\"). Records answer what the user HAS; this answers what HAPPENED to it. entity_type follows one kind of thing.",

    mode: "read",
    paging: { by: "cursor" },
    params: {
      limit: z.number().optional().describe("Max entries (default 25, max 100)"),
      actions: z
        .string()
        .optional()
        .describe("Comma-separated action filter, e.g. delete,update (omit for everything)"),
      entity_type: z.string().optional().describe("Only entries about this entity type, e.g. part"),
      cursor: CURSOR_PARAM,
    },
    execute: async (api, args) => {
      const cur = decodeCursor<{ b: string; a?: string; e?: string; l: number }>("list_activity", args.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const st = cur.state;
      const limit = st?.l ?? Math.min(Number(args.limit) || 25, 100);
      const actions = st ? (st.a ?? "") : typeof args.actions === "string" ? args.actions.trim() : "";
      const entityType = st ? (st.e ?? "") : typeof args.entity_type === "string" ? args.entity_type.trim() : "";
      const q = [`limit=${limit}`];
      if (actions) q.push(`actions=${encodeURIComponent(actions)}`);
      if (entityType) q.push(`entity_type=${encodeURIComponent(entityType)}`);
      if (st) q.push(`before=${encodeURIComponent(st.b)}`);
      const res = await api.request("GET", `/activity?${q.join("&")}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the activity log"));
      const rows = (res.body as { items?: ActivityRow[] }).items ?? [];
      const last = rows[rows.length - 1];
      const next = rows.length === limit && last?.id != null
        ? { b: String(last.id), ...(actions ? { a: actions } : {}), ...(entityType ? { e: entityType } : {}), l: limit }
        : null;
      const items = rows.map((a) => ({
        when: a.occurred_at,
        action: a.action,
        // The route resolves `title` from the live record ONLY when the diff
        // doesn't already carry a name — so a create, whose diff always does,
        // arrives with title null. Reading just `title` therefore reported every
        // creation as its bare type ("created vendor"), which is the exact
        // failure the route's own title-resolution exists to prevent.
        what: a.title ?? nameFromDiff(a.diff) ?? a.entity_type,
        kind: a.module_name ? `${a.module_name}:${a.entity_type}` : a.entity_type,
        id: a.entity_id,
        // "system" and "api_token" are as much a part of the answer as a person:
        // "who changed this" is often "a wire did" or "your own script did".
        by: a.actor?.display_name ?? a.actor?.email ?? (a.auth_method === "system" ? "the system" : null),
        ...(a.token?.name ? { via_token: a.token.name } : {}),
      }));
      return toolOk({ items, ...pageEnd("list_activity", next) });
    },
  },
  {
    name: "list_notifications",
    description:
      "The user's notifications in this workspace — what the system has been telling them (a job finished, stock ran out, something needs review), newest first. Use for \"what did I miss?\", \"anything new?\", \"what happened while I was away?\".",
    mode: "read",
    paging: { by: "cursor" },
    params: {
      unread_only: z.boolean().optional().describe("Only notifications they have not read"),
      limit: z.number().optional().describe("Max notifications (default 25, max 100)"),
      cursor: CURSOR_PARAM,
    },
    execute: async (api, args) => {
      const cur = decodeCursor<{ b: string; u?: boolean; l: number }>("list_notifications", args.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const st = cur.state;
      const limit = st?.l ?? Math.min(Number(args.limit) || 25, 100);
      const unreadOnly = st ? st.u === true : args.unread_only === true;
      const unread = unreadOnly ? "&unread=1" : "";
      const before = st ? `&before=${encodeURIComponent(st.b)}` : "";
      const [res, count] = await Promise.all([
        api.request("GET", `/notifications?limit=${limit}${unread}${before}`),
        api.request("GET", "/notifications/unread-count"),
      ]);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read notifications"));
      const body = res.body as { items?: NotificationRow[]; next_before?: string | null };
      const items = (body.items ?? []).map((n) => ({
        when: n.created_at,
        message: n.message,
        about: n.event_type,
        unread: !n.read_at,
        ...(n.link_url ? { link: n.link_url } : {}),
      }));
      const next = typeof body.next_before === "string" && body.next_before ? { b: body.next_before, ...(unreadOnly ? { u: true } : {}), l: limit } : null;
      // How many are unread in all, not on this page: "you have 3 unread" off
      // the first page of a longer list is the wrong number.
      const total = (count.body as { count?: unknown }).count;
      return toolOk({
        items,
        unread_count: typeof total === "number" ? total : items.filter((i) => i.unread).length,
        ...pageEnd("list_notifications", next),
      });
    },
  },
  {
    name: "list_maintenance",
    description:
      "Scheduled and completed maintenance across the workspace — services, inspections, filter changes, anything logged against a machine, vehicle, asset or tool. Use for \"what is due for service?\", \"when did I last change that?\", \"what is overdue?\".",
    mode: "read",
    paging: { by: "cursor" },
    params: {
      due: z.boolean().optional().describe("Only scheduled, not yet done"),
      history: z.boolean().optional().describe("Only work already done"),
      within_days: z.number().optional().describe("With due: only what falls due inside this many days"),
      entity_id: z.string().optional().describe("Only maintenance for this record"),
      limit: z.number().optional().describe(`Max entries (default 25, max ${LIST_LIMIT_MAX})`),
      cursor: CURSOR_PARAM,
    },
    execute: async (api, rawArgs) => {
      // The cursor carries the filters it was made for, so page two is page
      // two of the same question.
      const cur = decodeCursor<{ o: number; f: Record<string, unknown> }>("list_maintenance", rawArgs.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const args: Record<string, unknown> = cur.state?.f ?? rawArgs;
      const offset = cur.state?.o ?? 0;
      const limit = Math.min(Number(args.limit) || 25, LIST_LIMIT_MAX);
      // Filter at the source: the route already understands scheduled-vs-history
      // and a due window, so a page of 25 is 25 of the RIGHT rows rather than 25
      // of everything, sifted here.
      // One past the page, to know without a count whether there is another.
      const q: string[] = [`limit=${limit + 1}`, `offset=${offset}`];
      if (args.due === true) q.push("kind=scheduled");
      else if (args.history === true) q.push("kind=history");
      const within = Number(args.within_days);
      if (args.due === true && Number.isFinite(within) && within > 0)
        q.push(`due_within_days=${Math.floor(within)}`);
      if (typeof args.entity_id === "string" && args.entity_id.trim())
        q.push(`entity_id=${encodeURIComponent(args.entity_id.trim())}`);
      const res = await api.request("GET", `/modules/core-maintenance/entries?${q.join("&")}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read maintenance"));
      const rows = ((res.body as { items?: MaintenanceRow[] }).items ?? []).map((e) => ({
        id: e.id,
        what: e.name,
        on: e.entity_type ? `${e.entity_module}:${e.entity_type}` : null,
        entity_id: e.entity_id,
        ...(e.scheduled_at ? { scheduled: e.scheduled_at } : {}),
        ...(e.performed_at ? { done: e.performed_at } : { outstanding: true }),
        ...(e.recurrence_rule ? { repeats: e.recurrence_rule } : {}),
        ...(e.notes ? { notes: e.notes } : {}),
      }));
      const { cursor: _c, ...filters } = args;
      return toolOk({
        items: rows.slice(0, limit),
        ...pageEnd("list_maintenance", rows.length > limit ? { o: offset + limit, f: filters } : null),
      });
    },
  },
  {
    name: "list_calendar",
    description:
      "What is coming up (or what was on) the workspace calendar in a date window — due dates, scheduled maintenance, recurring chores, project deadlines, anything the workspace puts on a date. Use for \"what's on this week?\", \"what's due before Friday?\", \"what did I have on last month?\". Dates are YYYY-MM-DD; the default window is the next 30 days.",
    mode: "read",
    paging: { by: "one-call", why: "everything in one date window; to see more, ask for another window" },
    params: {
      from: z.string().optional().describe("Window start, YYYY-MM-DD (default: today)"),
      to: z.string().optional().describe("Window end, YYYY-MM-DD (default: 30 days out)"),
    },
    execute: async (api, args) => {
      // The window has to be resolved to real dates, because the endpoint takes
      // an explicit range — a model asking "what's coming up" should not have to
      // know today's date to get an answer.
      const day = 24 * 60 * 60 * 1000;
      const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : iso(now);
      const to = typeof args.to === "string" && args.to.trim() ? args.to.trim() : iso(now + 30 * day);
      const res = await api.request(
        "GET",
        `/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the calendar"));
      const items = ((res.body as { items?: CalendarRow[] }).items ?? []).map((e) => ({
        date: e.date,
        title: e.title,
        from: e.source,
        ...(e.category ? { category: e.category } : {}),
        ...(e.entityType ? { about: `${e.entityModule}:${e.entityType}`, entity_id: e.entityId } : {}),
      }));
      return toolOk({ window: { from, to }, items });
    },
  },
  {
    name: "list_scan_inbox",
    description:
      "The ITEMS waiting in the scan inbox: captures (barcodes, photos, notes, receipt lines) not yet filed. Not a record kind, so list_records cannot reach it. Each item says what it is, how long it waited, if it needs a human, and where it goes. facet: needs_review (no clean name, low confidence), waiting (over 2 days), unfiled (no destination), ready. One item in full: get_scan_item.",

    mode: "read",
    paging: { by: "cursor" },
    params: {
      facet: z
        .enum(["all", "needs_review", "waiting", "unfiled", "ready"])
        .optional()
        .describe("Default: all pending"),
      q: z.string().optional().describe("Text filter over name, brand, barcode, notes and scan area"),
      limit: z.number().optional().describe(`Max items (default 20, max ${LIST_LIMIT_MAX})`),
      cursor: CURSOR_PARAM,
    },
    execute: async (api, args) => {
      const cur = decodeCursor<{ f: string; l: number; c?: string; q?: string; o?: number }>("list_scan_inbox", args.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const st = cur.state;
      const facet = st?.f ?? (typeof args.facet === "string" && args.facet ? args.facet : "all");
      const limit = st?.l ?? Math.min(Number(args.limit) || 20, LIST_LIMIT_MAX);
      const q = st ? (st.q ?? "") : typeof args.q === "string" ? args.q.trim().toLowerCase() : "";
      type InboxBody = {
        items?: ScanInboxRow[];
        batches?: Record<string, { label?: string | null }>;
        total?: number;
        partial?: string;
        next_cursor?: string | null;
      };
      const fetchPage = (n: number, cursor?: string) =>
        api.request(
          "GET",
          `/modules/core-scan/inbox?status=pending&triage=${encodeURIComponent(facet)}&limit=${n}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
      if (!q) {
        // The queue pages itself; its cursor rides inside ours.
        const res = await fetchPage(limit, st?.c);
        if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the scan inbox"));
        const body = res.body as InboxBody;
        const items = (body.items ?? []).map((it) => summarizeScanItem(it, body.batches ?? {}));
        const next = typeof body.next_cursor === "string" && body.next_cursor ? { f: facet, l: limit, c: body.next_cursor } : null;
        return toolOk({
          items,
          // The QUEUE's total, not the page's length — answering "you have 6" off a
          // page of 6 out of 148 is the failure worth spending a field on.
          ...(typeof body.total === "number" ? { total_in_facet: body.total } : {}),
          ...(body.partial ? { partial: body.partial } : {}),
          ...pageEnd("list_scan_inbox", next),
        });
      }
      // A text filter reads the whole queue, not the first page of it: the
      // queue is ordered newest-first, not by relevance, so filtering one page
      // would answer "you don't have one" about an item further down.
      const all: ScanInboxRow[] = [];
      const batches: Record<string, { label?: string | null }> = {};
      let total: number | undefined;
      let cursor: string | undefined;
      let scannedAll = false;
      for (let round = 0; round < SCAN_INBOX_TEXT_PAGES; round++) {
        const res = await fetchPage(200, cursor);
        if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the scan inbox"));
        const body = res.body as InboxBody;
        all.push(...(body.items ?? []));
        Object.assign(batches, body.batches ?? {});
        if (typeof body.total === "number") total = body.total;
        cursor = typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : undefined;
        if (!cursor) {
          scannedAll = true;
          break;
        }
      }
      const matched = all.filter((it) =>
        [it.suggested_name, it.suggested_manufacturer, it.barcode_text, it.ai_notes, it.scan_area].some(
          (v) => typeof v === "string" && v.toLowerCase().includes(q),
        ),
      );
      const offset = st?.o ?? 0;
      const page = matched.slice(offset, offset + limit);
      const end = offset + page.length;
      return toolOk({
        items: page.map((it) => summarizeScanItem(it, batches)),
        ...(typeof total === "number" ? { total_in_facet: total } : {}),
        matched: matched.length,
        ...(scannedAll ? {} : { note: `searched the newest ${all.length} captures only; narrow the facet to reach older ones` }),
        ...pageEnd("list_scan_inbox", end < matched.length ? { f: facet, l: limit, q, o: end } : null),
      });
    },
  },
  {
    name: "get_scan_item",
    description:
      "All the scan found on ONE inbox item: each field and its source, confidence, why flagged, where it goes, pictures as links, history.",
    mode: "read",
    paging: { by: "one-call", why: "one item, whole; its history is capped at the last few steps" },
    params: {
      id: z.string().describe("An id from list_scan_inbox"),
    },
    execute: async (api, args) => {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return toolFail("id is required: take one from list_scan_inbox");
      const res = await api.request("GET", `/modules/core-scan/inbox/${encodeURIComponent(id)}`);
      if (res.status === 404) return toolFail(`no scan inbox item ${id}: list_scan_inbox gives the ids that exist`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read that scan item"));
      return toolOk(scanItemDetail(res.body as ScanItemRow, api));
    },
  },
  {
    name: "get_workspace_setup",
    description:
      "How this workspace is SET UP, as opposed to what it holds: its instances (the separate lists one module runs, e.g. 3D Printers and CNC both from Machines), its saved views, its automations (wires: when X happens, do Y), the apps the user built, their entity templates, and their unit vocabulary. Use for \"how is my workspace set up?\", \"what automations do I have?\", \"why did that happen by itself?\", \"what views/apps/templates do I have?\", or before proposing a change to any of them. `part` picks one area; omit it for a summary of every area at once.",
    mode: "read",
    paging: { by: "one-call", why: "a description of the setup, one area or a summary of all" },
    params: {
      part: z
        .enum(["all", "instances", "views", "automations", "apps", "templates", "units"])
        .optional()
        .describe("Which area of the setup (default: a summary of all of them)"),
    },
    execute: async (api, args) => {
      const part = typeof args.part === "string" && args.part ? args.part : "all";
      const want = (p: string) => part === "all" || part === p;
      // Each area is optional: a workspace that has not enabled a module 404s
      // that one, and the honest answer is "that area is not set up here" — not
      // a failed tool call that loses the six areas that DID answer.
      const grab = async <T>(path: string, pick: (body: Record<string, unknown>) => T): Promise<T | null> => {
        const res = await api.request("GET", path);
        if (res.status >= 400) return null;
        try {
          return pick(res.body);
        } catch {
          return null;
        }
      };
      const out: Record<string, unknown> = {};

      if (want("instances")) {
        const rows = await grab("/instances", (b) => (b.items as InstanceRow[] | undefined) ?? []);
        if (rows) {
          out.instances = rows.map((i) => ({
            name: i.display_name,
            instance: i.instance_name,
            from_module: i.module_name,
            ...(i.is_default ? { is_default: true } : {}),
            ...(typeof i.item_count === "number" ? { items: i.item_count } : {}),
            // The kind id is what every OTHER tool needs to act on this list.
            kind: `${i.instance_name}:item`,
          }));
        }
      }
      if (want("views")) {
        const rows = await grab("/modules/core-views/views", (b) => (b.items as ViewRow[] | undefined) ?? []);
        if (rows) {
          out.views = rows.map((v) => ({
            name: v.name,
            of: v.entity_kind,
            shown_as: v.view_type,
            ...(v.is_default ? { is_default: true } : {}),
            ...(v.pinned ? { pinned_to_dashboard: true } : {}),
          }));
        }
      }
      if (want("automations")) {
        const rows = await grab("/bindings", (b) => (b.items as BindingRow[] | undefined) ?? []);
        if (rows) {
          out.automations = rows.map((w) => ({
            does: w.action_id,
            on: w.source_kind,
            when:
              w.trigger_type === "schedule"
                ? `on a schedule (${w.trigger_schedule ?? "unspecified"})`
                : w.trigger_type === "event"
                  ? `the event ${w.trigger_event ?? "?"}`
                  : w.trigger_type,
            // A disabled wire explains a "why didn't that happen" as surely as an
            // enabled one explains a "why did that happen".
            ...(w.enabled === false ? { enabled: false } : {}),
            id: w.id,
          }));
        }
      }
      if (want("apps")) {
        const rows = await grab("/modules/core-apps/apps", (b) => (b.items as AppRow[] | undefined) ?? []);
        if (rows) out.apps = rows.map((a) => ({ name: a.name, slug: a.slug }));
      }
      if (want("templates")) {
        const rows = await grab(
          "/modules/core-templates/templates",
          (b) => (b.items as TemplateRow[] | undefined) ?? [],
        );
        if (rows) {
          out.templates = rows.map((t) => ({
            name: t.name,
            creates: t.target_kind,
            ...(t.description ? { description: t.description } : {}),
            prefills: Object.keys(t.defaults ?? {}),
          }));
        }
      }
      if (want("units")) {
        const vocab = await grab("/modules/core-units/units", (b) => b as unknown as UnitVocabularyRow);
        if (vocab) {
          out.units = {
            // Only the CUSTOM ones are a fact about this workspace; the builtins
            // are the same everywhere and would be noise in every answer.
            custom: (vocab.custom ?? []).map((u) => `${u.name} (${u.symbol})`),
            builtin_count: (vocab.builtins ?? []).length,
            ...(vocab.display_mode ? { display_mode: vocab.display_mode } : {}),
          };
        }
      }

      const areas = Object.keys(out);
      if (areas.length === 0) {
        return toolOk({
          note:
            part === "all"
              ? "None of these areas are set up in this workspace yet."
              : `The ${part} area is not available in this workspace (its module may not be enabled).`,
        });
      }
      return toolOk(out);
    },
  },
  {
    name: "get_putaway_plan",
    description:
      "The user's live put-away situation: how many scanned items still have no home, and the CURRENT organize plan (groups, destinations, evidence, unresolved items). Use this whenever the user talks about putting things away, organizing scanned items, bins, or 'the plan': it is always fresher than anything pasted into chat. To help further, create core-locations:location records for places they describe (with their confirmation); the plan routes to real locations by evidence.",
    mode: "read",
    paging: { by: "one-call", why: "a summary of the standing plan (first 20 groups, 15 names each); the whole plan opens in the app" },
    params: {},
    execute: async (api) => {
      const [stats, latest] = await Promise.all([
        api.request("GET", "/modules/core-scan/inbox/stats"),
        api.request("GET", "/modules/core-scan/organize/plan/latest"),
      ]);
      if (stats.status >= 400) return toolFail(apiErrorMessage(stats, "couldn't read scan stats"));
      const planBody = (latest.body as { plan?: Record<string, unknown> | null }).plan ?? null;
      const groups = Array.isArray((planBody as { groups?: unknown[] } | null)?.groups)
        ? ((planBody as { groups: Array<Record<string, unknown>> }).groups ?? [])
        : [];
      const names = ((planBody as { item_names?: Record<string, string> } | null)?.item_names ??
        {}) as Record<string, string>;
      return toolOk({
        backlog: stats.body,
        plan: planBody
          ? {
              plan_id: (planBody as { plan_id?: unknown }).plan_id,
              hinted: !!(planBody as { draft_hinted?: unknown }).draft_hinted,
              applied_group_ids: (planBody as { applied_group_ids?: unknown }).applied_group_ids,
              groups: groups.slice(0, 20).map((g) => ({
                label: g.label,
                rationale: g.rationale,
                destination: g.destination,
                ai_guess: g.ai_guess ?? false,
                items: (Array.isArray(g.item_ids) ? (g.item_ids as string[]) : [])
                  .slice(0, 15)
                  .map((id) => names[id] ?? id),
              })),
            }
          : null,
        note: planBody
          ? "This is the standing plan the user sees. After you create/rename locations for them, call replan_putaway once — the open plan refreshes itself."
          : "No current plan — the user can open 'Put them away' to make one.",
      });
    },
  },
  {
    name: "replan_putaway",
    description:
      "Recompute the user's put-away plan against the CURRENT workspace. Non-destructive: it only refreshes the proposal (nothing files, the user still accepts groups). Call this ONCE after you finish creating or renaming locations for them, the open plan updates automatically. Optionally pass a hint distilling what you learned in this conversation (e.g. 'the user is organizing camping gear; the hallway closet holds electronics').",
    mode: "read",
    paging: { by: "one-call", why: "recomputes the plan; returns a status, not rows" },
    params: {
      hint: z
        .string()
        .optional()
        .describe("Optional ground truth for the planner, distilled from the conversation (max 500 chars)"),
    },
    execute: async (api, args) => {
      const hint = typeof args.hint === "string" && args.hint.trim() ? args.hint.trim().slice(0, 500) : undefined;
      const res = await api.request("POST", "/modules/core-scan/organize/plan", {
        scope: "pending",
        fresh: true,
        ...(hint ? { hint } : {}),
      });
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't re-plan"));
      const body = res.body as {
        plan_id?: unknown;
        groups?: Array<Record<string, unknown>>;
        item_names?: Record<string, string>;
      };
      const names = body.item_names ?? {};
      return toolOk({
        plan_id: body.plan_id,
        groups: (body.groups ?? []).slice(0, 20).map((g) => ({
          label: g.label,
          destination: g.destination,
          items: (Array.isArray(g.item_ids) ? (g.item_ids as string[]) : [])
            .slice(0, 15)
            .map((id) => names[id] ?? id),
        })),
        note: "The user's open plan refreshes itself, summarize what changed instead of pasting the whole plan.",
      });
    },
  },
  {
    name: "create_record",
    description:
      "Create ONE new record. Use the kind's EXACT field names from list_record_kinds (e.g. knowledge entries want \"title\", parts want \"name\"). Only kinds with can_create are accepted.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_create true"),
      fields: z.record(z.unknown()).describe("The record's fields, using the kind's exact field names"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const kinds = await fetchKinds(api);
      const path = resolveCreatePath(kind, kinds);
      if (!path) return toolFail(`records of "${kind}" can't be created this way (no create route declared)`);
      // "title" when the kind says "name" is the same value under a different
      // word, and refusing it taught nobody anything (see withKindsTitleField).
      const { fields } = withKindsTitleField(kind, kinds, (args.fields as Record<string, unknown>) ?? {});
      const res = await api.request("POST", `/${path}`, fields);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "create failed"));
      return toolOk(res.body);
    },
  },
  {
    name: "create_records",
    description:
      "Create MANY records of one kind in ONE call. Use this whenever the user asks for a SET rather than a thing - \"shelf 1 to 5 in every rack\", \"bins A through H\" - instead of calling create_record over and over: it is one round trip instead of one per record, and the person watching sees one line instead of sixty. Same field names as create_record. Up to 200 at a time. Each record is created, tracked and undoable individually, and any that clash with something already there are REPORTED back to you, not forced - say so rather than trying again.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_create true"),
      records: z
        .array(z.record(z.unknown()))
        .min(1)
        .max(200)
        .describe("One object per record, each using the kind's exact field names"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const rows = Array.isArray(args.records) ? (args.records as Array<Record<string, unknown>>) : [];
      if (rows.length === 0) return toolFail("no records given");
      const kinds = await fetchKinds(api);
      const path = resolveCreatePath(kind, kinds);
      if (!path) return toolFail(`records of "${kind}" can't be created this way (no create route declared)`);
      const created: unknown[] = [];
      const failed: Array<{ index: number; error: string }> = [];
      for (const [i, row] of rows.entries()) {
        const { fields } = withKindsTitleField(kind, kinds, row);
        const res = await api.request("POST", `/${path}`, fields);
        if (res.status >= 400) failed.push({ index: i, error: apiErrorMessage(res, "create failed") });
        else created.push(res.body);
      }
      // Partial success is the NORMAL outcome here ("each rack should have
      // Shelf 1-5" against a rack that already has two of them), so it is
      // reported rather than thrown: the model needs to tell the person what
      // was already there instead of retrying into the same refusals.
      return toolOk({ created: created.length, failed, records: created });
    },
  },
  {
    name: "update_record",
    description:
      "Update fields on ONE existing record (partial update, only the fields you pass change). Only kinds with can_update are accepted.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_update true"),
      id: z.string().describe("Record id"),
      fields: z.record(z.unknown()).describe("The fields to change, using the kind's exact field names"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const kinds = await fetchKinds(api);
      const path = resolveUpdatePath(kind, String(args.id ?? ""), kinds);
      if (!path) return toolFail(`records of "${kind}" can't be updated this way (no update route declared)`);
      const { fields: patch } = withKindsTitleField(kind, kinds, (args.fields as Record<string, unknown>) ?? {});
      const res = await api.request("PATCH", `/${path}`, patch);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "update failed"));
      return toolOk(res.body);
    },
  },
  {
    name: "delete_record",
    description:
      "Delete ONE record. Only kinds with can_delete are accepted. Destructive, double-check you have the right record (get_record) before deleting.",
    mode: "write",
    params: {
      kind: z.string().describe("Entity kind id with can_delete true"),
      id: z.string().describe("Record id"),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const kinds = await fetchKinds(api);
      const path = resolveDeletePath(kind, String(args.id ?? ""), kinds);
      if (!path) return toolFail(`records of "${kind}" can't be deleted this way (no delete route declared)`);
      const res = await api.request("DELETE", `/${path}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "delete failed"));
      return toolOk(res.status === 204 ? { deleted: true } : res.body);
    },
  },
  {
    name: "invoke_action",
    description:
      "Run a registered action (see list_actions). An ENTITY action runs on a record: pass entity_kind + entity_id (adjust stock, mark done, print a label). A WORKSPACE action (scope 'workspace') changes the workspace's setup: omit both and pass its args.",
    mode: "write",
    params: {
      action_id: z.string().describe("Action id, e.g. inventory:adjust-stock or labels:set-code"),
      entity_kind: z
        .string()
        .optional()
        .describe("The record's kind id — required for an entity action, omit for a workspace action"),
      entity_id: z
        .string()
        .optional()
        .describe("The record's id — required for an entity action, omit for a workspace action"),
      args: z.record(z.unknown()).optional().describe("Action arguments, by name, from the action's `args` in list_actions. Values may be any JSON — a string, a number, or a LIST (e.g. reorder takes ids: [\"…\",\"…\"])."),
    },
    execute: async (api, args) => {
      const entityKind = typeof args.entity_kind === "string" && args.entity_kind.trim() ? args.entity_kind.trim() : undefined;
      const entityId = typeof args.entity_id === "string" && args.entity_id.trim() ? args.entity_id.trim() : undefined;
      const res = await api.request("POST", "/actions/invoke", {
        actionId: String(args.action_id ?? ""),
        // Omitted entirely for a workspace action — the server skips entity
        // resolution when the action's scope is 'workspace'.
        ...(entityKind ? { entityKind } : {}),
        ...(entityId ? { entityId } : {}),
        args: (args.args as Record<string, unknown> | undefined) ?? undefined,
      });
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "action failed"));
      // The route answers 200 when the action was INVOKED; whether the operation
      // went ahead is the handler's own `result.ok`, and a handler that refuses
      // (a frozen label group, a unit that already ships built in, an argument
      // that doesn't resolve) says so there. Reading only the HTTP status
      // reported every one of those refusals to the model as a success — so it
      // told the user the change was made. 136 refusal paths across ~20 modules
      // are reachable through this one tool; unwrapping the envelope is what
      // makes "it wouldn't let me, because…" sayable at all.
      const body = res.body as { result?: unknown };
      const inner = body.result;
      if (inner && typeof inner === "object" && (inner as { ok?: unknown }).ok === false) {
        const reason = (inner as { error?: unknown }).error;
        return toolFail(
          typeof reason === "string" && reason.trim() ? reason : "the action declined to run",
        );
      }
      return toolOk(res.body);
    },
  },
  {
    name: "list_label_codes",
    description:
      "List the workspace's label-code groups (one per kind + instance, e.g. 3D Printers under Machines). Each entry has its code prefix (the letters before the number, e.g. 'p' in p42), how many codes exist, whether it is frozen (a label was printed, so existing codes are fixed), whether its code shows inside the QR, and its group_key. Call this to find the group_key, then change it by invoking the labels:set-code action (invoke_action with no entity): pass group_key plus prefix and/or code_in_qr (the QR toggle is per group, so 3d printers can differ from cnc).",
    mode: "read",
    paging: { by: "one-call", why: "one row per label-code group; a workspace has a handful" },
    params: {},
    execute: async (api) => {
      const res = await api.request("GET", "/modules/labels/codes/groups");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list label codes"));
      return toolOk((res.body as { groups?: unknown[] }).groups ?? []);
    },
  },
];

/** Whether the assistant may OFFER an action: a person could ask for it.
 *  A wire-only action (`wireOnly: true` in its manifest: fired by an event,
 *  its record named by the event, "asked without one there is no task to
 *  mark") is not one, and listing it had the model reaching for
 *  projects:mark-task-done on "mark the birdhouse task done" with no task
 *  to name, three runs out of three (2026-09-14). Neither is an internal
 *  action, the way back for another. The prompt's rail and list_actions
 *  both go through here, so they cannot disagree.
 *
 *  The button flag (`user_invokable`, "no button on the record's page") is
 *  deliberately NOT a field this function accepts. It is false on plenty of
 *  actions the assistant runs every day (placing a thing in a bin, tagging
 *  it, adjusting stock), and reading it as wire-only took twelve of those
 *  off the rail for one build (#2995, 2026-09-14). It was then declared in
 *  this signature and never read, which reads as an invitation to wire it
 *  (#3195); now the type refuses it, so the mistake cannot be written here.
 *  A whole action still passes (structural typing), and the test beside
 *  this holds a `@ts-expect-error` on the flag that fails the typecheck the
 *  day it is added back. */
export function offerableToAssistant(a: { wire_only?: boolean; internal?: boolean }): boolean {
  return a.wire_only !== true && a.internal !== true;
}

export function getTool(name: string): WorkspaceTool | undefined {
  return WORKSPACE_TOOLS.find((t) => t.name === name);
}

export const READ_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "read");
export const WRITE_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "write");

// ─────────────────────── the MCP naming policy, once ──────────────────────
//
// Three surfaces read this registry: the in-app chat (bare names), and TWO MCP
// faces — the stdio server (packages/mcp-server) and the HTTP endpoint
// (api/src/platform/hosted-mcp.ts). Both MCP faces prefix every tool the same
// way, and both used to hardcode that prefix themselves. Two copies of a naming
// policy is how one face ends up exposing a different set from the other, which
// is precisely what happened: the HTTP face carried a hand-kept SIX while this
// registry held twenty-one, and nothing noticed because a model with fewer
// tools does not error, it just answers (2026-08-15).
//
// The per-transport parts stay per-transport: each face describes its own
// `workspace` argument in its own terms (an env var for stdio, a query param
// for HTTP), because those genuinely differ.

/** The prefix both MCP faces put on every workspace tool. */
export const MCP_TOOL_PREFIX = "cobblr_";

/** A registry tool's name as MCP clients see it. */
export function mcpToolName(bareName: string): string {
  return `${MCP_TOOL_PREFIX}${bareName}`;
}

/** MCP name → the registry tool it addresses (null when it isn't one of ours). */
export function toolFromMcpName(mcpName: string): WorkspaceTool | undefined {
  return mcpName.startsWith(MCP_TOOL_PREFIX)
    ? getTool(mcpName.slice(MCP_TOOL_PREFIX.length))
    : undefined;
}
