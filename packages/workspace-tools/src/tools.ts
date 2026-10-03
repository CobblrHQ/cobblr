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
  fieldsByRole,
  resolveDeletePath,
  summarizeKind,
} from "./kinds.js";
import { explainRecords } from "./field-meanings.js";
import { asMeasure, measureMatches, measureTokens, type Measure } from "@cobblr/platform-contract/measure";
import { CURSOR_PARAM, decodeCursor, pageEnd, type Paging } from "./paging.js";
import { pairingResultPresentation } from "@cobblr/platform-contract/pairing-presentation";

export type ToolMode = "read" | "write";

interface WorkspaceToolBase {
  /** Bare name — consumers prefix as needed (MCP: `cobblr_<name>`). */
  name: string;
  description: string;
  params: z.ZodRawShape;
  /** Who decides whether this write may go ahead. Absent: the door does (a
   *  chat proposal, the MCP Changes setting). "service-gate": the server's
   *  service gate does, from the capability's effect (service-consent.ts),
   *  and a job that needs a person waits on its own card. The door must not
   *  also hold it, or a print asks twice. */
  consentBy?: "service-gate";
  /** Sent only in a workspace that can use it, not on every turn. Absent:
   *  always sent. "services": only when at least one service capability is
   *  connected here, which on most turns in most workspaces it is not. */
  sentWhen?: "services" | "scan-stations";
  execute(api: WorkspaceApi, args: Record<string, unknown>): Promise<ToolResult>;
}

/** A read tool must say how a caller gets every row it can return (paging.ts):
 *  required here so a new list tool cannot ship capped with no way past it. */
export type WorkspaceTool =
  | (WorkspaceToolBase & { mode: "read"; paging: Paging })
  | (WorkspaceToolBase & { mode: "write"; paging?: never });

/** Clamp big reads so a tool result stays prompt-sized. */
const LIST_LIMIT_MAX = 50;
/** How many things records stand for: each record's count field, where it
 *  says; a record that does not say is one thing. */
export function unitsCounted(recs: Array<Record<string, unknown>>, countField: string): number {
  let n = 0;
  for (const r of recs) {
    const v = Number(fieldValue(r, countField));
    n += Number.isFinite(v) && v >= 0 ? v : 1;
  }
  return n;
}

/** count_records walks the whole kind in pages; the route caps a page at 200. */
const COUNT_PAGE = 200;
const COUNT_SCAN_MAX = 5000;
/** search_records: rows of EACH kind per page (the search route's own default). */
const SEARCH_PER_KIND = 10;
/** list_scan_inbox with a text filter reads up to this many 200-row pages. */
const SCAN_INBOX_TEXT_PAGES = 10;

/** Words that carry the sentence, not the thing: "how much of MY PLA offcuts
 *  do I have" names two things, PLA and offcuts. */
const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "my", "mine", "our", "your", "me", "i", "we", "of", "and", "or", "in", "on", "at", "to",
  "for", "with", "is", "are", "it", "its", "do", "does", "did", "have", "has", "got", "how", "much", "many",
  "what", "which", "where", "any", "some", "left", "there", "this", "that", "these", "those",
]);

/** The words of a query that name the thing, lower case, sentence words out. */
export function significantWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 0 && !QUERY_STOPWORDS.has(w));
}

/** Does this text contain what was asked: the phrase as typed, or, for a query
 *  of two or more words, every one of its words. A query is matched as a
 *  phrase by every list and search route, so "my PLA offcuts" found nothing
 *  under a name reading "Review measured stock - PLA offcuts", the model
 *  widened to "PLA", and answered about a PLA spool (#4038). Every word, never
 *  any word: "PLA offcuts" must not match the spool, which is PLA and is not
 *  offcuts. */
export function textMatches(text: string, q: string): boolean {
  const hay = text.toLowerCase();
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (hay.includes(needle)) return true;
  const words = significantWords(needle);
  return words.length >= 2 && words.every((w) => hay.includes(w));
}

/** Case-insensitive "does any text on this record contain q" — title, every
 *  field, nested bags. What a person means by "the Bambu" or "my deltas". */
export function recordMatchesText(rec: unknown, q: string): boolean {
  if (!q.trim()) return true;
  let text: string;
  try {
    text = JSON.stringify(rec) ?? "";
  } catch {
    text = String(rec);
  }
  const answered = answersValues(rec, text, q);
  return answered ?? textMatches(text, q);
}

/** The measured values anywhere on a record: a measure field's value, and
 *  each value named in its text ("Resistor 4k7"). */
function valuesIn(x: unknown, depth = 0): Measure[] {
  if (depth > 4 || x == null) return [];
  if (typeof x === "string") return (measureTokens(x)?.values ?? []).map((v) => v.measure);
  if (typeof x !== "object") return [];
  const m = typeof (x as { value?: unknown }).value === "number" ? asMeasure(x) : null;
  if (m) return [m];
  return Object.values(x as Record<string, unknown>).flatMap((v) => valuesIn(v, depth + 1));
}

/** For a query that names values ("10k", "100 nF ceramic"), whether the record
 *  answers it, by the search's own rule (valueSearchWhere): each value found
 *  by value, or as text unless the record holds that number in another unit;
 *  each word as text. Null when the query names no value. */
function answersValues(rec: unknown, text: string, q: string): boolean | null {
  const read = measureTokens(q);
  if (!read) return null;
  const held = valuesIn(rec);
  const hay = text.toLowerCase();
  return (
    read.words.every((w) => hay.includes(w.toLowerCase())) &&
    read.values.every(
      (v) =>
        held.some((h) => measureMatches(v.measure, h)) ||
        (hay.includes(v.text.toLowerCase()) && !held.some((h) => !!h.unit && !!v.measure.unit && h.unit !== v.measure.unit && measureMatches({ ...v.measure, unit: null }, h))),
    )
  );
}

/** When more than one record answers to what was asked BY NAME, the answer is
 *  a question, never a pick: the model must not report on one of several as if
 *  it were the one the person named. */
function severalMatch(items: unknown[], q: string): { several_match: string } | Record<string, never> {
  const named = items.filter((it) => matchedOn(it, q) === "name");
  if (named.length < 2) return {};
  const names = named.slice(0, 6).map((it) => {
    const r = it as Record<string, unknown>;
    const f = (r.fields && typeof r.fields === "object" ? r.fields : r) as Record<string, unknown>;
    return String(r.title ?? f.name ?? r.name ?? "");
  });
  return {
    several_match: `${named.length} records match "${q}" by name (${names.join("; ")}). Before stating a quantity, place or detail, ask which one the person means, or answer about each by name; never report on one as if it were the only one.`,
  };
}

/** What list_records' `q` does, said once: the parameter's description and
 *  the behaviour below come from here, so a model reading the description is
 *  told what the results actually are. The server's own `q` matches beyond the
 *  name for some kinds, so "name first, other fields only if no name match"
 *  was not true; each result now says which field matched instead (#3814). */
export const LIST_Q_MEANS = "Text filter over name and other text; each result's matched_on says which, name matches first. \"4k7\" finds 4.7 kΩ";

/** Which field of a record a text query matched: "name" when its name does,
 *  else the first other text field that does, else null. */
export function matchedOn(rec: unknown, q: string): string | null {
  const needle = q.trim().toLowerCase();
  if (!needle || !rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  const fields = (r.fields && typeof r.fields === "object" ? r.fields : r) as Record<string, unknown>;
  const values = measureTokens(needle)?.values ?? [];
  const has = (v: unknown) =>
    (typeof v === "string" && textMatches(v, needle)) ||
    (values.length > 0 && valuesIn(v).some((h) => values.some((q) => measureMatches(q.measure, h))));
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

/** A record's value for a key: top-level, or inside `fields` / `data`. A
 *  field that stores an id (a person, a linked record) reads as the name
 *  beside it (`<key>_label`), so counting by owner counts by "Alex", not by
 *  Alex's id. */
function fieldValue(rec: Record<string, unknown>, key: string): unknown {
  const label = fieldValueRaw(rec, `${key}_label`);
  if (typeof label === "string" && label.length > 0) return label;
  return fieldValueRaw(rec, key);
}

function fieldValueRaw(rec: Record<string, unknown>, key: string): unknown {
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
  // The route answers a total only when it knows one: a resolver that does
  // not count leaves it off every full page. A missing total is NOT "this
  // page is all there is"; only a short page is the end. Reading it as the
  // page length stopped every count at the first 200 and called it complete.
  let known: number | null = null;
  let ended = false;
  const retired = opts.includeRetired ? "&include_retired=1" : "";
  for (let offset = 0; offset < COUNT_SCAN_MAX; offset += COUNT_PAGE) {
    const res = await api.request("GET", `/entities/${encodeURIComponent(kind)}?limit=${COUNT_PAGE}&offset=${offset}${retired}`);
    if (res.status >= 400) return { ok: false, res };
    const body = res.body as { items?: unknown[]; total?: number };
    const page = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
    items.push(...page);
    if (typeof body.total === "number") known = body.total;
    if (page.length < COUNT_PAGE || (known !== null && items.length >= known)) {
      ended = true;
      break;
    }
  }
  const total = Math.max(known ?? items.length, items.length);
  return { ok: true, items, total, complete: ended && items.length >= total };
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
  restorable?: boolean;
  said?: unknown;
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
/** Where "file these into <list>" files: a list made from a module (an
 *  instance), by its name or short name, or a kind's own list by its label.
 *  The kind is the module's own scannable kind, which is what the inbox's
 *  confirm takes beside the instance. */
async function listTarget(
  api: WorkspaceApi,
  said: string,
): Promise<{ module: string; kind: string; instance: string | null; label: string } | { error: string }> {
  const want = said.trim().toLowerCase();
  const [instRes, kinds] = await Promise.all([api.request("GET", "/instances"), fetchKinds(api)]);
  const instances = ((instRes.body as { items?: Array<{ instance_name: string; display_name?: string | null; module_name: string; is_default?: boolean }> }).items ?? []);
  const inst = instances.find((i) => i.instance_name === want || (i.display_name ?? "").trim().toLowerCase() === want);
  if (inst) {
    const own = kinds.find((k) => k.module_name === inst.module_name && !k.instance_name);
    if (!own) return { error: `${inst.display_name ?? inst.instance_name} has no kind to file into` };
    return { module: inst.module_name, kind: own.id, instance: inst.is_default ? null : inst.instance_name, label: inst.display_name ?? inst.instance_name };
  }
  const kind = kinds.find((k) => !k.instance_name && [k.display_name, k.display_name_plural, k.id].some((n) => (n ?? "").trim().toLowerCase() === want));
  if (kind?.module_name) return { module: kind.module_name, kind: kind.id, instance: null, label: kind.display_name_plural ?? kind.display_name ?? kind.id };
  return { error: `no list called "${said}"; make it first (platform:create-instance) or name one the app shows` };
}

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
    why: "changing a field's type",
    covered_by: [
      "platform:add-field",
      "platform:edit-field",
      "platform:set-field-on-records",
      "platform:restore-batch-field",
      "platform:remove-field",
      "platform:group-fields",
      "platform:ungroup-fields",
      "platform:set-field-preset",
      // The seller upgrade's no (#4518); its yes and the settle of two
      // same-meaning fields are found by their own examples.
      "platform:decline-seller-field",
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

/** Read tools that POST to do their reading (replan_putaway recomputes a
 *  proposal and files nothing). A caller allowed only to look cannot send a
 *  POST, so these are not offered to one: a tool on the list that always
 *  refuses reads to the assistant as a broken tool. Every MCP door reads this
 *  one set; the hosted endpoint's test derives it by running every read tool,
 *  so a new one cannot be missed. */
export const READ_TOOLS_THAT_POST: ReadonlySet<string> = new Set(["replan_putaway"]);

/** Whether a caller that may only look can run this tool. */
export function lookOnlyCanRun(tool: Pick<WorkspaceTool, "name" | "mode">): boolean {
  return tool.mode !== "write" && !READ_TOOLS_THAT_POST.has(tool.name);
}

/** Values said by what they are, whatever a workspace calls the field
 *  (#4537): one wording for every tool that takes them. */
const ROLES_SAID = "By role: acquired-from, seller, acquired-on, acquired-for";

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
          `${d.id} (${d.why}${d.covered_by?.length ? `; but ${d.covered_by.join(", ")} are actions` : ""})`,
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
          return toolOk({
            ...(explainRecords(shownPage, await kinds()) as Record<string, unknown>),
            ...(qText && Array.isArray(page.items) ? severalMatch(page.items, qText) : {}),
            ...pageEnd("list_records", more ? state(end) : null),
          });
        }
      }
      // The kind's own search matched nothing by name. Before the model tells
      // the user "you have none", look at every text field ourselves.
      const scan = await scanByText(api, kind, qText, limit, { includeRetired }, st?.s ? offset : 0);
      if (!scan) return toolOk({ ...(explainRecords({ shown: 0, total: 0, partial: false, items: [] }, await kinds()) as Record<string, unknown>), ...pageEnd("list_records", null) });
      const scanned = Array.isArray(scan.body.items) ? { ...scan.body, items: labelMatches(scan.body.items as unknown[], qText) } : scan.body;
      return toolOk({
        ...(explainRecords(scanned, await kinds()) as Record<string, unknown>),
        ...(Array.isArray(scan.body.items) ? severalMatch(scan.body.items as unknown[], qText) : {}),
        ...pageEnd("list_records", scan.next === null ? null : state(scan.next, true)),
      });
    },
  },
  {
    name: "things_of_person",
    // By name as said: the route resolves it on the People list (members and
    // anyone added by name), "me" is the asker, and a name matching two people
    // comes back as a question rather than a guess.
    description: "What one person owns, across every collection (\"what does Alex own\", \"my things\").",
    mode: "read",
    paging: { by: "one-call", why: "one person's things across every collection; a person owns tens of things, not thousands" },
    params: {
      person: z.string().describe("Their name as said, or \"me\""),
    },
    execute: async (api, args) => {
      const person = String(args.person ?? "").trim();
      if (!person) return toolFail("say whose things: a name, or me");
      const res = await api.request("GET", `/people/things?person=${encodeURIComponent(person)}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, `couldn't find what belongs to ${person}`));
      return toolOk(res.body);
    },
  },
  {
    name: "count_records",
    description:
      "Count records of ONE kind, optionally grouped by a field (e.g. group_by \"model\"). Use for \"how many\", \"which do I have most of\", \"any X?\": it counts EVERY record in code, exact however long the list. `units`, if present, counts things: \"how many printers\" is units.",
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
      const countField = (await fetchKinds(api).catch(() => [])).find((k) => k.id === kind)?.count_field ?? null;
      const unitsOf = (recs: Array<Record<string, unknown>>) => (countField ? unitsCounted(recs, countField) : null);
      const units = unitsOf(all);
      const unitsPart = units !== null && units !== total ? { units, units_means: `how many things these records stand for (the sum of ${countField}); total is how many records` } : {};
      if (!groupBy) return toolOk({ kind, ...(qText ? { q: qText, matched_by: "any text field" } : {}), total, ...unitsPart, scanned, complete });
      const counts = new Map<string, { value: string; count: number; records: Array<Record<string, unknown>> }>();
      for (const rec of all) {
        const raw = fieldValue(rec, groupBy);
        const value = raw === undefined || raw === null || raw === "" ? "(blank)" : String(raw);
        const key = value.toLowerCase();
        const hit = counts.get(key);
        if (hit) {
          hit.count += 1;
          hit.records.push(rec);
        } else counts.set(key, { value, count: 1, records: [rec] });
      }
      const groups = [...counts.values()]
        .map(({ value, count, records }) => {
          const u = unitsOf(records);
          return { value, count, ...(u !== null && u !== count ? { units: u } : {}) };
        })
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      return toolOk({
        kind,
        group_by: groupBy,
        ...(qText ? { q: qText, matched_by: "any text field" } : {}),
        total,
        ...unitsPart,
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
      const found = Array.isArray(body.items) ? (body.items as unknown[]) : [];
      // The routes match a query as one phrase. When the phrase finds nothing
      // and it has two or more words, ask again by its longest word and keep
      // only what holds EVERY word, so "my PLA offcuts" finds the offcuts and
      // not the spool (#4038).
      const words = significantWords(q);
      if (found.length === 0 && offset === 0 && words.length >= 2) {
        const longest = [...words].sort((a, b) => b.length - a.length)[0]!;
        const again = await api.request(
          "GET",
          `/modules/core-search/search?q=${encodeURIComponent(longest)}${kinds}&per_kind=${perKind}&offset=0`,
        );
        if (again.status < 400) {
          const { has_more: _h2, ...wide } = again.body as Record<string, unknown>;
          const every = (Array.isArray(wide.items) ? (wide.items as unknown[]) : []).filter((it) => recordMatchesText(it, q));
          return toolOk({
            ...(explainRecords({ ...wide, q, items: every }, await fetchKinds(api).catch(() => [])) as Record<string, unknown>),
            matched_by: `every word of "${q}" (${words.join(", ")}); nothing held the words as one phrase`,
            ...severalMatch(every, q),
            ...pageEnd("search_records", null),
          });
        }
      }
      return toolOk({
        ...(explainRecords(body, await fetchKinds(api).catch(() => [])) as Record<string, unknown>),
        ...severalMatch(found, q),
        ...pageEnd("search_records", more ? { q, ...(kindList ? { k: kindList } : {}), o: offset + perKind } : null),
      });
    },
  },
  {
    name: "list_related",
    description:
      "List the records LINKED to one record: which project a part belongs to, what is inside a location, bin or box (placed_in), what a build consumed. A location's contents include its sub-locations (a garage holds its bins; ask a bin to see inside it). Kind + id alone lists every link.",
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
        metadata?: { result?: unknown } | null;
      };
      const fetchSide = async (side: "out" | "in") => {
        const who = side === "out" ? "source" : "target";
        const res = await api.request(
          "GET",
          `/pairings?${who}_kind=${encodeURIComponent(kind)}&${who}_id=${encodeURIComponent(id)}${rel}`,
        );
        if (res.status >= 400) throw new Error(apiErrorMessage(res, "couldn't list pairings"));
        return ((res.body.items as PairingRow[] | undefined) ?? []).map((p) => {
          const result = pairingResultPresentation(p.metadata?.result);
          return {
            relationship: p.relationship_kind,
            direction: side,
            kind: side === "out" ? p.target_kind : p.source_kind,
            id: side === "out" ? p.target_id : p.source_id,
            ...(p.notes ? { notes: p.notes } : {}),
            ...(result ? { title: result.label, href: result.href, ...(result.open_label ? { open_label: result.open_label } : {}) } : {}),
            pairing_id: p.id,
          };
        });
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
      "Discover the operations (actions) this workspace can run. scope 'entity': runs on one record (matched_kinds says which kinds); scope 'workspace': runs on the whole workspace, invoked WITHOUT a record. Each carries args_schema (pass as invoke_action's args) and undoable. Optionally filter to one kind. Run one with invoke_action.",
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
      "What needs the user now, the dashboard's 'needs you' feed: low stock, dates overdue or due within 30 days, captures to file, suggested edits. Call it FIRST on open-ended questions (\"what should I do today?\", \"anything need me?\").",
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
    name: "list_suggestions",
    description:
      "Edits and additions people you share with suggested, awaiting a decision, by record and person. Decide via invoke_action: platform:accept-suggestions, reject-suggestions, take-additions, leave-additions.",
    mode: "read",
    paging: { by: "one-call", why: "what waits for one person's decision, a review queue that is short by nature (capped at 500 by the route)" },
    params: {
      from: z.string().optional().describe("A person's name"),
      kind: z.string().optional().describe("A record's kind, with id"),
      id: z.string().optional(),
    },
    execute: async (api, args) => {
      const kind = typeof args.kind === "string" ? args.kind.trim() : "";
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const res = await api.request("GET", `/suggestions${kind && id ? `?${new URLSearchParams({ kind, id }).toString()}` : ""}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the suggested edits"));
      const body = res.body as {
        items?: Array<{ id: string; entity_kind: string; entity_id: string; title: string | null; label: string; was: string | null; now: string | null; yours: string | null; status: string; by_name: string | null; still_shared?: boolean }>;
        additions?: Array<{ id: string; entity_kind: string; title: string; by_name: string | null }>;
      };
      const from = typeof args.from === "string" ? args.from.trim().toLowerCase() : "";
      const byWho = (n: string | null) => !from || String(n ?? "").toLowerCase().includes(from);
      // One entry per record and person, the way the review page groups them,
      // so "accept Vince's on the CR-10" can name exactly that group.
      const groups = new Map<string, { kind: string; id: string; title: string | null; from: string | null; edits: Array<Record<string, unknown>> }>();
      for (const e of (body.items ?? []).filter((x) => byWho(x.by_name))) {
        const key = `${e.entity_kind}|${e.entity_id}|${e.by_name ?? ""}`;
        const g = groups.get(key) ?? { kind: e.entity_kind, id: e.entity_id, title: e.title, from: e.by_name, edits: [] };
        g.edits.push({
          id: e.id,
          field: e.label,
          suggested: e.now,
          was: e.was,
          ...(e.status === "conflict" ? { you_since_changed_it_to: e.yours } : {}),
          ...(e.still_shared === false ? { no_longer_shared: true } : {}),
        });
        groups.set(key, g);
      }
      const additions = (body.additions ?? []).filter((a) => byWho(a.by_name)).map((a) => ({ id: a.id, kind: a.entity_kind, title: a.title, from: a.by_name }));
      if (!groups.size && !additions.length) return toolOk({ records: [], additions: [], note: from ? `Nothing from ${args.from} is waiting.` : "No suggested edits or additions are waiting." });
      return toolOk({ records: [...groups.values()], additions });
    },
  },
  {
    name: "list_activity",
    description:
      "History, newest first: who changed what and when. Filter entity_kind and entity_id for one record; history_entry_id selects an edit for platform:restore-record-version.",

    mode: "read",
    paging: { by: "cursor" },
    params: {
      limit: z.number().optional().describe("Page size, at most 100"),
      actions: z
        .string()
        .optional()
        .describe("Comma-separated actions"),
      entity_type: z.string().optional().describe("Record type, e.g. part"),
      entity_kind: z.string().optional().describe("Record kind"),
      entity_id: z.string().optional().describe("Record id"),
      cursor: CURSOR_PARAM,
    },
    execute: async (api, args) => {
      const cur = decodeCursor<{ b: string; a?: string; e?: string; k?: string; i?: string; l: number }>("list_activity", args.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const st = cur.state;
      const limit = st?.l ?? Math.min(Number(args.limit) || 25, 100);
      const actions = st ? (st.a ?? "") : typeof args.actions === "string" ? args.actions.trim() : "";
      const entityType = st ? (st.e ?? "") : typeof args.entity_type === "string" ? args.entity_type.trim() : "";
      const q = [`limit=${limit}`];
      if (actions) q.push(`actions=${encodeURIComponent(actions)}`);
      if (entityType) q.push(`entity_type=${encodeURIComponent(entityType)}`);
      const entityKind = st ? st.k : args.entity_kind;
      const entityId = st ? st.i : args.entity_id;
      if (entityKind && entityId) { q.push(`entity_kind=${encodeURIComponent(String(entityKind))}`, `entity_id=${encodeURIComponent(String(entityId))}`); }
      if (st) q.push(`before=${encodeURIComponent(st.b)}`);
      const res = await api.request("GET", `/activity?${q.join("&")}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the activity log"));
      const rows = (res.body as { items?: ActivityRow[] }).items ?? [];
      const last = rows[rows.length - 1];
      const next = rows.length === limit && last?.id != null
        ? { b: String(last.id), ...(actions ? { a: actions } : {}), ...(entityType ? { e: entityType } : {}), ...(entityKind && entityId ? { k: String(entityKind), i: String(entityId) } : {}), l: limit }
        : null;
      const items = rows.map((a) => ({
        history_entry_id: a.id,
        restorable: a.restorable ?? false,
        ...(a.said ? { changes: a.said } : {}),
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
      "The workspace calendar in a date window: due dates, maintenance, chores, deadlines, anything on a date. For \"what's on this week?\", \"what's due before Friday?\", \"what did I have last month?\". Dates YYYY-MM-DD; default the next 30 days.",
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
    name: "list_scan_stations",
    sentWhen: "scan-stations",
    description: "Your scan stations and their IDs, modes and active places. Read their sessions with list_scan_station_sessions.",
    mode: "read",
    paging: { by: "one-call", why: "every station configured by this person in this workspace" },
    params: {},
    execute: async (api) => {
      const res = await api.request("GET", "/scan-stations");
      return res.status >= 400 ? toolFail(apiErrorMessage(res, "couldn't read the stations")) : toolOk(res.body);
    },
  },
  {
    name: "list_scan_station_sessions",
    sentWhen: "scan-stations",
    description: "What a scan station did, by session and time. Read a session's actions with get_scan_station_session.",
    mode: "read",
    paging: { by: "cursor" },
    params: { device_id: z.string().uuid(), cursor: CURSOR_PARAM },
    execute: async (api, args) => {
      const cur = decodeCursor<{ device: string; before: string }>("list_scan_station_sessions", args.cursor);
      if (!cur.ok) return toolFail(cur.error);
      const device = cur.state?.device || String(args.device_id);
      const before = cur.state?.before;
      const res = await api.request("GET", `/scan-stations/${encodeURIComponent(device)}/sessions${before ? `?before=${encodeURIComponent(before)}` : ""}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the sessions"));
      const body = res.body as { items: unknown[]; next_before: string | null };
      return toolOk({ items: body.items, ...pageEnd("list_scan_station_sessions", body.next_before ? { device, before: body.next_before } : null) });
    },
  },
  {
    name: "get_scan_station_session",
    sentWhen: "scan-stations",
    description: "A station session in full: each action, the thing, its place before and after, and whether it was undone.",
    mode: "read",
    paging: { by: "one-call", why: "one session in full; the station starts another after 500 actions" },
    params: { device_id: z.string().uuid(), session_id: z.string().uuid() },
    execute: async (api, args) => {
      const res = await api.request("GET", `/scan-stations/${encodeURIComponent(String(args.device_id))}/sessions/${encodeURIComponent(String(args.session_id))}`);
      return res.status >= 400 ? toolFail(apiErrorMessage(res, "couldn't read the session")) : toolOk(res.body);
    },
  },
  {
    name: "list_scan_inbox",
    description:
      "The ITEMS waiting in the scan inbox (barcodes, photos, notes, receipt lines) not yet filed; list_records cannot reach it. facet: needs_review (low confidence), waiting (over 2 days), unfiled (no destination), ready. One in full: get_scan_item.",

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
      "How the workspace is SET UP, not what it holds: instances (separate lists from one module), saved views, automations (wires: when X happens, do Y), the user's apps, entity templates, unit vocabulary. Use before proposing a change to any of them. `part` picks one area; omit it for a summary of all.",
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
      "The put-away situation: how many scanned items have no home, and the CURRENT organize plan (groups, destinations, evidence, unresolved). Use it when the user talks about putting things away, bins, or 'the plan'; places they describe become core-locations:location records (confirmed), which the plan routes to.",
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
      "Recompute the user's put-away plan against the CURRENT workspace. It only refreshes the proposal; nothing is filed. Call this ONCE after you finish creating or renaming locations for them, the open plan updates automatically. Optionally pass a hint of what you learned (e.g. 'camping gear; the hallway closet holds electronics').",
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
    name: "add_thing",
    description:
      "The way to add a THING the person has. Runs the scan inbox's intake: duplicate check, table, fields, picture, place. Returns what it found, fields_refused (tell your person) and hints (empty fields: ask). Lands in the inbox; file: true files it.",
    mode: "write",
    params: {
      name: z.string(),
      goes_to: z.string().optional().describe("List your person named"),
      roles: z.record(z.unknown()).optional().describe(ROLES_SAID),
      identifier: z.string().optional().describe("Barcode, ISBN or model number"),
      url: z.string().optional(),
      image_file_id: z.string().optional(),
      place: z.string().optional(),
      location_id: z.string().optional(),
      fields: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      quantity: z.number().optional(),
      file: z.boolean().optional(),
      allow_duplicate: z.boolean().optional(),
    },
    execute: async (api, args) => {
      const res = await api.request("POST", "/modules/core-scan/scan/assistant", args as Record<string, unknown>);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "the add did not go through"));
      return toolOk(res.body);
    },
  },
  {
    name: "file_inbox_items",
    description:
      "File scan inbox items into ONE list (\"file these in Mugs\": the ticked ones). The list may be one a create-instance call earlier in the same plan makes. Undo returns them to the inbox.",
    mode: "write",
    params: {
      ids: z.array(z.string()).min(1).max(200),
      list: z.string().describe("e.g. Mugs"),
    },
    execute: async (api, args) => {
      const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(String).filter(Boolean) : [];
      const said = String(args.list ?? "").trim();
      if (!ids.length || !said) return toolFail("ids and list are required");
      const target = await listTarget(api, said);
      if ("error" in target) return toolFail(target.error);
      const filed: Array<{ item_id: string; entity_id: string; entity_kind: string; name: string }> = [];
      const failed: Array<{ item_id: string; reason: string }> = [];
      for (const id of ids.slice(0, 200)) {
        const res = await api.request("POST", `/modules/core-scan/inbox/${encodeURIComponent(id)}/confirm`, {
          target_module: target.module,
          target_kind: target.kind,
          ...(target.instance ? { instance: target.instance } : {}),
        });
        if (res.status >= 400) {
          failed.push({ item_id: id, reason: apiErrorMessage(res, "it could not be filed") });
          continue;
        }
        const created = (res.body as { created?: { id?: string; name?: unknown; title?: unknown } }).created;
        filed.push({
          item_id: id,
          entity_id: String(created?.id ?? ""),
          entity_kind: target.instance ? `${target.instance}:item` : target.kind,
          name: String(created?.name ?? created?.title ?? ""),
        });
      }
      if (!filed.length) return toolFail(`Nothing was filed into ${target.label}: ${failed[0]?.reason ?? "no items"}`);
      return toolOk({ list: { name: target.instance ?? target.kind, label: target.label }, filed, failed });
    },
  },
  {
    name: "create_record",
    description:
      "Create ONE new record. A physical thing the person owns: use add_thing instead. Use the kind's EXACT field names from list_record_kinds (e.g. knowledge entries want \"title\", parts want \"name\"). Only kinds with can_create are accepted.",
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
      "Create MANY records of one kind in ONE call, for a SET (\"shelf 1 to 5 in every rack\", \"bins A through H\") instead of calling create_record for each. Same field names as create_record. Up to 200, each undoable; clashes are reported back, not forced: say so rather than retry.",
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
      fields: z.record(z.unknown()).optional().describe("The fields to change, using the kind's exact field names"),
      roles: z.record(z.unknown()).optional().describe(ROLES_SAID),
    },
    execute: async (api, args) => {
      const kind = String(args.kind ?? "");
      const kinds = await fetchKinds(api);
      const path = resolveUpdatePath(kind, String(args.id ?? ""), kinds);
      if (!path) return toolFail(`records of "${kind}" can't be updated this way (no update route declared)`);
      const byRole = fieldsByRole(kind, kinds, (args.roles as Record<string, unknown>) ?? {});
      const sent = { ...byRole.fields, ...((args.fields as Record<string, unknown>) ?? {}) };
      if (!Object.keys(sent).length) return toolFail(byRole.refused.length ? `nothing to change: ${byRole.refused.map((r) => `${r.name}: ${r.reason}`).join("; ")}` : "no fields or roles given");
      const { fields: patch } = withKindsTitleField(kind, kinds, sent);
      const res = await api.request("PATCH", `/${path}`, patch);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "update failed"));
      return toolOk(byRole.refused.length ? { ...(res.body as Record<string, unknown>), fields_refused: byRole.refused } : res.body);
    },
  },
  {
    name: "delete_record",
    description:
      "Delete ONE record (kinds with can_delete). Check it is the right one (get_record) first. From outside Cobblr it waits for the person's yes.",
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
      // Over a connection from outside Cobblr the delete waits for the person:
      // say so, or the assistant reports a deletion that has not happened.
      if (res.status === 202 && (res.body as { held?: unknown }).held === true) {
        return toolOk({ deleted: false, waiting_for_person: true, message: (res.body as { message?: string }).message });
      }
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
    name: "list_services",
    sentWhen: "services",
    description:
      "The outside services usable here, by capability (design.part, slice.model, ...): summary, effect, input schema, files. Pass capability for one service's options too (templates, printer models). Start one with invoke_service.",
    mode: "read",
    paging: { by: "one-call", why: "one row per connected capability; a workspace has a handful" },
    params: { capability: z.string().optional() },
    execute: async (api, args) => {
      const one = typeof args.capability === "string" && args.capability.trim() ? args.capability.trim() : null;
      if (one) {
        const r = await api.request("GET", `/services/capabilities/${encodeURIComponent(one)}`);
        if (r.status >= 400) return toolFail(apiErrorMessage(r, `couldn't read ${one}`));
        const c = r.body as { id?: string; title?: string; summary?: string; effect?: string; input_schema?: unknown; options?: unknown };
        return toolOk({ capability: c.id, title: c.title, summary: c.summary, effect: c.effect, input_schema: c.input_schema, options: c.options ?? null });
      }
      const res = await api.request("GET", "/services/capabilities");
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't list services"));
      const items = ((res.body.items ?? res.body) as Array<{
        id?: string;
        title?: string;
        summary?: string;
        effect?: string;
        input_schema?: unknown;
        files_in?: Array<{ name?: string; types?: string[]; required?: boolean }>;
        answered_by?: Array<{ label?: string }>;
      }>) ?? [];
      return toolOk(
        items.map((c) => ({
          capability: c.id,
          title: c.title,
          summary: c.summary,
          effect: c.effect,
          input_schema: c.input_schema,
          files: (c.files_in ?? []).map((f) => ({ name: f.name, types: f.types, required: !!f.required })),
          answered_by: c.answered_by?.[0]?.label ?? null,
        })),
      );
    },
  },
  {
    name: "invoke_service",
    sentWhen: "services",
    description:
      "Start a service job: capability, input per its schema, files by name as file ids. Returns at once. A physical or paid job waits for the person's confirm on its card: say it is waiting, never done. Follow with get_service_job.",
    mode: "write",
    consentBy: "service-gate",
    params: {
      capability: z.string().describe("e.g. slice.model"),
      input: z.record(z.unknown()),
      files: z.record(z.string()).optional().describe("{name: file id}"),
      attach_kind: z.string().optional().describe("Attach outputs to this record's kind"),
      attach_id: z.string().optional(),
      after: z.string().optional().describe("Run after job/print id"),
    },
    execute: async (api, args) => {
      const attach = typeof args.attach_kind === "string" && typeof args.attach_id === "string" ? { kind: args.attach_kind, id: args.attach_id } : undefined;
      const res = await api.request("POST", "/services/jobs", {
        capability: String(args.capability ?? ""),
        input: (args.input as Record<string, unknown> | undefined) ?? {},
        ...(args.files ? { files: args.files } : {}),
        ...(attach ? { attach_to: attach } : {}),
      });
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "the service job could not be started"));
      const job = (res.body.job ?? res.body) as { id?: string; status?: string; message?: string | null; capability?: string };
      // "Power off after this print": the job waits for a yes either way;
      // the trigger makes that yes arm it for when the other thing finishes.
      let when: string | null = null;
      if (typeof args.after === "string" && args.after.trim() && job.id && job.status === "awaiting_confirm") {
        const t = await api.request("POST", `/services/jobs/${encodeURIComponent(job.id)}/trigger`, { after: args.after.trim() });
        if (t.status >= 400) return toolFail(apiErrorMessage(t, "the job was started but cannot wait for that"));
        when = ((t.body.trigger as { label?: string } | null)?.label as string | undefined) ?? null;
      }
      return toolOk({
        job_id: job.id,
        capability: job.capability,
        status: job.status,
        ...(job.status === "awaiting_confirm" ? { waiting_for: when ? `the person's yes on its card, then ${when}` : "the person to confirm it on its card" } : {}),
        ...(job.message ? { message: job.message } : {}),
      });
    },
  },
  {
    name: "get_service_job",
    sentWhen: "services",
    description:
      "One service job: status, progress, what it asks when needs_input, and when done its output and files.",
    mode: "read",
    paging: { by: "one-call", why: "a job is one record, read whole" },
    params: { job_id: z.string() },
    execute: async (api, args) => {
      if (!args.job_id) return toolFail("which job? pass the job_id invoke_service returned");
      const res = await api.request("GET", `/services/jobs/${encodeURIComponent(String(args.job_id ?? ""))}`);
      if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the job"));
      const j = (res.body.job ?? res.body) as {
        id?: string;
        capability?: string;
        status?: string;
        progress?: number | null;
        message?: string | null;
        needs?: { prompt?: string } | null;
        output?: unknown;
        files?: Array<{ name?: string; direction?: string; file_id?: string | null }>;
        error?: { code?: string; message?: string } | null;
      };
      return toolOk({
        job_id: j.id,
        capability: j.capability,
        status: j.status,
        progress: j.progress ?? null,
        ...(j.message ? { message: j.message } : {}),
        ...(j.status === "needs_input" && j.needs?.prompt ? { asking: j.needs.prompt } : {}),
        ...(j.status === "done" ? { output: j.output, files: (j.files ?? []).filter((f) => f.direction !== "in").map((f) => ({ name: f.name, file_id: f.file_id ?? null })) } : {}),
        ...(j.error ? { error: j.error.message ?? j.error.code } : {}),
      });
    },
  },
  {
    name: "list_label_codes",
    description:
      "The workspace's label-code groups (one per kind + instance): prefix (the letters in p42), code count, frozen (a label was printed), whether the code shows in the QR, group_key. To change one, invoke labels:set-code with no entity: group_key plus prefix and/or code_in_qr.",
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
