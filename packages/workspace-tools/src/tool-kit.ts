// What the tools in ./tools/ share: the tool type, text matching, paging over
// a kind, the scan inbox's row shapes. A tool file imports from here; nothing
// here imports a tool, so ./tools.ts can find the tools without a cycle (#7388).

import { HUMAN_ONLY_ACTIONS } from "@cobblr/platform-contract/human-only";
import { z } from "zod";
import { type WorkspaceApi, type WorkspaceApiResponse, type ToolResult } from "./api.js";
import { fetchKinds } from "./kinds.js";
import { asMeasure, measureMatches, measureTokens, type Measure } from "@cobblr/platform-contract/measure";
import { type Paging } from "./paging.js";

import { countOf } from "@cobblr/platform-contract/plural";
import { scanHistoryLines, type ScanHistoryEntryStored } from "@cobblr/platform-contract/scan-history-words";

/** An action's description down to its first sentence: what it does, for a
 *  list; the rest is for when the model picks it. */
export function firstSentence(text: string | undefined): string | undefined {
  if (!text) return text;
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  return m ? m[1] : text.trim();
}

export type ToolMode = "read" | "write";

export interface WorkspaceToolBase {
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
  /** The module this tool belongs to: sent only where that module is on. A
   *  workspace without a laser never pays for the laser's tools, so the
   *  every-turn budget holds the kernel's tools and each module's own set
   *  grows apart from it (lint:tool-descriptions). Absent: a kernel tool. */
  module?: string;
  /** The module part this tool belongs to (manifest `parts`): sent only
   *  where `<module>/<part>` is on, and its route answers 409 where it is off. */
  part?: string;
  /** Why this result must reach the model whole: a caller that trims tool
   *  results to a budget (the chat loop's clampJson) leaves this one entire.
   *  For a menu the model chooses from, where a trimmed tail is not "less
   *  detail" but options that silently stop existing. Absent: trimmed as usual. */
  wholeResult?: string;
  execute(api: WorkspaceApi, args: Record<string, unknown>): Promise<ToolResult>;
}

/** A read tool must say how a caller gets every row it can return (paging.ts):
 *  required here so a new list tool cannot ship capped with no way past it. */
export type WorkspaceTool =
  | (WorkspaceToolBase & { mode: "read"; paging: Paging })
  | (WorkspaceToolBase & { mode: "write"; paging?: never });

/** Clamp big reads so a tool result stays prompt-sized. */
export const LIST_LIMIT_MAX = 50;
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
export const COUNT_PAGE = 200;
export const COUNT_SCAN_MAX = 5000;
/** search_records: rows of EACH kind per page (the search route's own default). */
export const SEARCH_PER_KIND = 10;
/** How many pages of a multiword search's one-word results are read in one
 *  call while none of them holds every word; past that the cursor carries on. */
export const SEARCH_FALLBACK_PAGES = 4;
/** list_scan_inbox with a text filter reads up to this many 200-row pages. */
export const SCAN_INBOX_TEXT_PAGES = 10;

/** Words that carry the sentence, not the thing: "how much of MY PLA offcuts
 *  do I have" names two things, PLA and offcuts. */
export const QUERY_STOPWORDS = new Set([
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
export function valuesIn(x: unknown, depth = 0): Measure[] {
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
export function answersValues(rec: unknown, text: string, q: string): boolean | null {
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
export function severalMatch(items: unknown[], q: string): { several_match: string } | Record<string, never> {
  const named = items.filter((it) => matchedOn(it, q) === "name");
  if (named.length < 2) return {};
  const names = named.slice(0, 6).map((it) => {
    const r = it as Record<string, unknown>;
    const f = (r.fields && typeof r.fields === "object" ? r.fields : r) as Record<string, unknown>;
    return String(r.title ?? f.name ?? r.name ?? "");
  });
  return {
    several_match: `${countOf(named.length, "record")} match "${q}" by name (${names.join("; ")}). Before stating a quantity, place or detail, ask which one the person means, or answer about each by name; never report on one as if it were the only one.`,
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
export function labelMatches<T>(items: T[], q: string): Array<T & { matched_on?: string }> {
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
export function fieldValue(rec: Record<string, unknown>, key: string): unknown {
  const label = fieldValueRaw(rec, `${key}_label`);
  if (typeof label === "string" && label.length > 0) return label;
  return fieldValueRaw(rec, key);
}

export function fieldValueRaw(rec: Record<string, unknown>, key: string): unknown {
  if (key in rec) return rec[key];
  for (const bag of ["fields", "data", "custom_fields"]) {
    const inner = rec[bag];
    if (inner && typeof inner === "object" && key in (inner as Record<string, unknown>)) {
      return (inner as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

/** A list answer that is not "none": the list could not be read, the kind
 *  has no list here, or its module is off. Each used to reach the assistant
 *  as an empty page, which it said as "you have none" (#4199). */
export function listRefusal(body: unknown, kind: string): string | null {
  const b = (body ?? {}) as { failed?: unknown; unlisted?: unknown };
  if (b.failed === true) return `The ${kind} list could not be read just now. That is not the same as none; try again.`;
  if (b.unlisted === "no-such-list") return `There is no list of "${kind}" here. list_record_kinds gives the kinds this workspace can list.`;
  if (b.unlisted === "module-off") return `The feature that keeps "${kind}" is turned off in this workspace, so there is nothing of it to read.`;
  return null;
}

/** Every record of a kind, page by page (the route caps a page at 200). */
export async function walkKind(
  api: WorkspaceApi,
  kind: string,
  opts: { includeRetired?: boolean; maxRecords?: number } = {},
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
  const seenPages = new Set<string>();
  for (let offset = 0; offset < (opts.maxRecords ?? COUNT_SCAN_MAX); offset += COUNT_PAGE) {
    const res = await api.request("GET", `/entities/${encodeURIComponent(kind)}?limit=${COUNT_PAGE}&offset=${offset}${retired}`);
    if (res.status >= 400) return { ok: false, res };
    const refused = listRefusal(res.body, kind);
    if (refused) return { ok: false, res: { status: 409, body: { error: { message: refused } } } };
    const body = res.body as { items?: unknown[]; total?: number };
    const page = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
    if (page.length && page.every((r) => typeof r.id === "string")) {
      const signature = JSON.stringify(page.map((r) => [r.id, r.fields && (r.fields as Record<string, unknown>)._source_workspace_slug]));
      if (seenPages.has(signature)) {
        return { ok: false, res: { status: 502, body: { error: { message: "The record list repeated a page, so an exact count is unavailable." } } } };
      }
      seenPages.add(signature);
    }
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
export async function scanByText(
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
  if (!walked.complete) notes.push(`scanned the first ${walked.items.length} of ${countOf(walked.total, "record")} only`);
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
    ? offset > 0 ? `${range} of ${total}` : `${shown} of ${countOf(total ?? 0, "record")}`
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
export interface AttentionRow {
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
export function nameFromDiff(diff: unknown): string | null {
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
export interface ActivityRow {
  summary?: string;
  subject?: import("@cobblr/platform-contract/activity-summary").ActivitySubject;
  hidden?: boolean;
  entity_title?: string | null;
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

export interface NotificationRow {
  message: string;
  event_type: string;
  created_at: string;
  read_at?: string | null;
  link_url?: string | null;
}

export interface MaintenanceRow {
  id: string;
  name: string;
  entity_module?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  scheduled_at?: string | null;
  performed_at?: string | null;
  recurrence_rule?: string | null;
  notes?: string | null;
  address?: unknown;
}

export interface CalendarRow {
  date: string;
  title: string;
  source: string;
  category?: string;
  location?: string;
  entityModule?: string;
  entityType?: string;
  entityId?: string;
}

/** The workspace's own shape — one row type per area of get_workspace_setup. */
export interface InstanceRow {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default?: boolean;
  item_count?: number | null;
}

export interface ViewRow {
  name: string;
  entity_kind: string;
  view_type: string;
  is_default?: boolean;
  pinned?: boolean;
}

export interface BindingRow {
  id: string;
  source_kind: string;
  action_id: string;
  trigger_type: string;
  trigger_event?: string | null;
  trigger_schedule?: string | null;
  enabled?: boolean;
}

export interface AppRow {
  name: string;
  slug: string;
}

export interface TemplateRow {
  name: string;
  target_kind: string;
  description?: string | null;
  defaults?: Record<string, unknown>;
  default_tags?: string[];
}

export interface UnitVocabularyRow {
  builtins?: Array<{ name: string; symbol: string }>;
  custom?: Array<{ name: string; symbol: string }>;
  display_mode?: string;
}

/** A scan-inbox row, as the core-scan list route returns it. Only the fields
 *  worth telling a model about — `needs_review`, `review_reason` and
 *  `waiting_days` are derived server-side from the shared triage predicate,
 *  so the model is told the same thing the Scan page shows the user. */
export interface ScanInboxRow {
  id?: string;
  /** Where it came from: a part of a split line carries split_from (#6067). */
  suggested_metadata?: unknown;
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
export async function listTarget(
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

/** The line an inbox part was split from, as the inbox shows it (#6067). */
export type SplitParentWords = { name?: string | null; how_words?: string | null; check?: string | null; headline?: string | null };

export function summarizeScanItem(
  it: ScanInboxRow,
  batches: Record<string, { label?: string | null }>,
  splitParents: Record<string, SplitParentWords> = {},
): Record<string, unknown> {
  const meta = (it.suggested_metadata ?? {}) as { split_from?: unknown; split_off_from?: unknown };
  const parentId = typeof meta.split_from === "string" ? meta.split_from : typeof meta.split_off_from === "string" ? meta.split_off_from : null;
  const parent = parentId ? splitParents[parentId] : undefined;
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
    // One part of a line that came apart: which line, how, and whether the
    // parts add up, as the inbox shows it over its parts.
    ...(parent ? { part_of: { line: parent.name ?? null, split: parent.headline ?? null, how: parent.how_words ?? null, check: parent.check ?? null } } : {}),
  };
}

export interface ScanItemRow extends ScanInboxRow {
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
export const SCAN_BOOKKEEPING = new Set([
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
    // The same lines the card's History shows; a step's revision is what
    // put_back_scan_item takes.
    history_words: scanHistoryLines(meta.history as ScanHistoryEntryStored[] | undefined, {
      name: (it.suggested_name as string | null) ?? null,
      brand: (it.suggested_manufacturer as string | null) ?? null,
      confidence: (it.ai_confidence as string | null) ?? null,
    }).map((l) => ({
      at: l.at,
      said: l.words,
      ...(l.times > 1 ? { times: l.times } : {}),
      ...(l.revision ? { revision: l.revision } : {}),
    })),
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


/** The workspace does not have this module, or this part of it, turned on
 *  (mount.ts answers 409 with one of these codes): an absence, unlike any
 *  other failed read. */
export function moduleIsOff(res: { status: number; body?: Record<string, unknown> | null }): boolean {
  const code = (res.body?.error as { code?: unknown } | undefined)?.code;
  return res.status === 409 && (code === "module_not_enabled" || code === "part_not_enabled");
}

/** The relationship list_related reports a placement under: a thing points at the container it is in. */
export const PLACED_IN = "placed_in";
/** The kind whose records nest through their own parent_id (core-locations),
 *  read into a location's contents beside what placement holds. */
export const LOCATION_KIND = "core-locations:location";
/** A relationship filter that means placement, in the words a model reaches
 *  for ("location", "stored_in", "contains", "inside"): the exact name is not
 *  what a model asks with. */
export const PLACEMENT_WORDS = /placed|placement|locat|stored|contain|inside|within|holds/i;
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
export const ROLES_SAID = "By role: acquired-from, seller, acquired-on, acquired-for";

/** list_records' `contains` (#6896): a value led by "-" is does-not-contain,
 *  the search-box idiom, so one parameter carries both and the every-turn
 *  schema stays inside its budget. */
export function splitContains(raw: unknown): { contains: Record<string, string>; notContains: Record<string, string> } {
  const contains: Record<string, string> = {};
  const notContains: Record<string, string> = {};
  for (const [field, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    const v = String(value ?? "").trim();
    if (v.startsWith("-") && v.length > 1) notContains[field] = v.slice(1).trim();
    else if (v) contains[field] = v;
  }
  return { contains, notContains };
}

/** A search that found nothing says what it looked through, so "nothing" is
 *  an answer about the workspace and never a search that did not run: the
 *  route's kinds_searched names only the kinds that found something, and on
 *  a miss it was [] (the assistant audit, #6686). */
export function noneFound(body: Record<string, unknown>, q: string): { none_found?: string } {
  const asked = Array.isArray(body.kinds_asked) ? (body.kinds_asked as string[]) : null;
  if (!asked) return {};
  const failed = Array.isArray(body.kinds_failed) ? (body.kinds_failed as string[]) : [];
  if (asked.length === 0 && failed.length === 0) return { none_found: "this workspace has nothing a search can look through yet: no list is turned on" };
  const gap = failed.length ? `; ${failed.length} could not be searched, so this is not the whole workspace` : "";
  return { none_found: `nothing in the ${asked.length} kind${asked.length === 1 ? "" : "s"} of record searched mentions "${q}"${gap}` };
}

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
export function offerableToAssistant(a: { id?: string; wire_only?: boolean; internal?: boolean }): boolean {
  // What only a person does is never offered, whatever its declaration says.
  if (a.id && HUMAN_ONLY_ACTIONS[a.id]) return false;
  return a.wire_only !== true && a.internal !== true;
}
