// What more than one group of the scan inbox's routes uses.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { applyModelFacts } from "../../services/model-facts.js";
import { linkInVault } from "../../services/vault-original.js";
import { createMatchQueue } from "../../services/match-queue.js";
import { withSellersApart } from "../../services/seller-split.js";
import { onCatchAll, routeByGivenFields, routeByIdentity, routeBySameMaker, routeWhereKept, tablesForGiven, type KeptTable, type TableFieldNames } from "../../services/kept-route.js";
import { type AgentField } from "../../services/agent-fields.js";
import { LOOKUP_GAVE_UP, retryHasRunOut } from "../../services/retry-lookup.js";
import { asTitleFormat, formatTitleVariants, titleVariantsOf, type TitleFormat } from "@cobblr/platform-contract/display-identity";
import { candidatesWithUserFields, userFieldsAfterMatch, userFieldsOf } from "../../services/user-fields.js";
import { resolveRequirement } from "../../services/storage-requirement.js";
import { applyReceiptFacts, receiptPackAsks } from "../../services/receipt-candidate-facts.js";
import { alignStorageFields } from "../../services/align-storage-fields.js";
import { enrichmentPollDelays } from "../../services/match-poll.js";
import { withGroupImages as groupImagesFor } from "../../services/group-image.js";
import { retargetByCategory, retargetIsbnToBookList } from "../../services/retarget-by-category.js";
import { type Request } from "express";
import { sql } from "kysely";
import { attachPaperwork, type AttachPaperworkResult } from "../../services/attach-paperwork.js";
import { z } from "zod";
import { reportReceived } from "../../services/receipt-order.js";
import { planDecodeFill, platform, traitAxisValue, type DecodeFillTarget } from "@cobblr/platform-contract";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { displayed as displayedNote, cardNote, withoutRoutingSentences } from "../../services/routing-note.js";
import { needsScanReview, scanHeldForReview, scanRowState, scanReviewReason, scanWaitingDays, type ScanTriageRow, type ScanRowStateContext, type ScanResolverTable, type FiledInto, filedIntoOf, scanFitItem } from "@cobblr/platform-contract/scan-triage";
import { scanToolRelevance, type ScanToolHints } from "@cobblr/platform-contract/scan-tools";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { liveTablesOf, withResolvedOffers, type LiveTable } from "../../services/resolve-offers.js";
import { asyncHandler } from "../util.js";
import { classifiedCodeOf } from "@cobblr/platform-contract/scan-copy";
import { pictureSearchAfterMatch, registerMatchRunners, rowShape } from "../../services/intake.js";
import { extractSerial, observeScanPhoto, refreshCatalogImageByName } from "../../services/enrich-photo.js";
import { mergeMeta } from "../../services/metadata.js";
import { type CatalogSource, type CatalogStep, pushStep, seedHistory } from "../../services/catalog-history.js";
import { matchQuery, scanPlaceOf, trackedMatchStampAt } from "../../services/tracked-stamp.js";
import { candidateTableOf, destinationTables, filingDestination, type DestinationRow } from "../../services/destination.js";
import { colouredTitleFor } from "../../services/auto-rank.js";
import { assembleScanMenu, assembleMergedMenu, withProposedCategories, categoriesFromCandidateRows, runMatchmaker, heuristicMatch, reconcileSeriesSecondaries, type MatchCandidate, type ScanMenuEntry, perceiveRow } from "../../services/matchmaker.js";
import { candidatesForNamelessRow, isCuratedBarcodeIdentification, shouldAdoptCandidateName } from "../../services/adopt-name.js";
import { guardReplayCandidates } from "../../services/replay-guard.js";
import { catalogTitleCorroborated, decodedIsbnOf, lookupBookByTitle } from "../../services/book-lookup.js";
import { CATALOG_TITLE_MATCHED, photoReadOf } from "@cobblr/platform-contract/scan-evidence";
import { resolvePaintColorFromText } from "../../services/paint-code.js";
import { resolvePaintCodeViaWeb } from "../../services/paint-code-websearch.js";
import { orderLinePass } from "../../services/order-line-offer.js";
import { type ParsedReceipt } from "../../services/receipt-shared.js";
import { findTracked } from "../../services/entity-match.js";
import { unreadableObservation, applySplitInheritance, splitReviewWords, type SplitInherited } from "../../services/split-inherit.js";
import { stripUnsupportedPurchaseFields, siblingDisagreements, blankFields, siblingReviewWords, provenanceStamps } from "../../services/field-provenance.js";
import { FIELD_PROVENANCE_KEY, scanSourceConflict, type SourceConflict } from "@cobblr/platform-contract/acquisition-source";
import { applyNameFacts, nameFactWords } from "../../services/name-facts.js";
import { withPersonName } from "../../services/user-name.js";
import { suggestLocationForItem } from "../../services/suggest-location.js";
import { doubtedChecks } from "../../services/receipt-facts.js";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

/** A table's own category word for a row ("Dairy" on Groceries), which says
 *  how a thing keeps when the catalog's word is in another language. */
/** A table's own category word for a row ("Dairy" on Groceries): its
 *  choice-backed category axis, or a field it names as a category. It says
 *  how a thing keeps when the catalog's word is in another language
 *  ("Fromages de vache"). Null when the row has none. */
export async function tableCategoryWord(
  orgId: string,
  kind: string | null,
  instance: string | null,
  fields: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!kind || !fields) return null;
  const axis = await platform().categoryAxis.for({ orgId, kind, instance }).catch(() => null);
  const name = axis?.slot.kind === "extras" ? axis.slot.name : axis?.slot.kind === "field" ? axis.slot.column : undefined;
  const v = name ? fields[name] : undefined;
  if (typeof v === "string" && v.trim()) return v;
  // A table whose axis is the module's own (hidden) category can still keep
  // its kind of thing in a field it names as one: Groceries' Food category.
  for (const [k, val] of Object.entries(fields)) {
    if (/(^|_)categor/i.test(k) && typeof val === "string" && val.trim()) return val;
  }
  return null;
}

// The intake plan's match passes (services/intake.ts) live here, beside the
// matchmaker's request-side half; registered at load so every door's plan
// can reach them without an import cycle. A fresh row is matched with force
// (nothing to skip yet); the barcode race and the photo wire are matched
// once their identify has landed.
registerMatchRunners({
  match: (o) => matchItem({ ...o, force: true }),
  matchWhenEnriched: (o) => autoMatchWhenEnriched(o),
});

// Internal self-call base for the create/enrich loopbacks below. These calls
// re-issue through our OWN api (to inherit requireAuth + withTenant + role
// gating) carrying the user's bearer token — so the base MUST be loopback to
// this process, never a caller-influenced value. `req.headers.host` is the
// BROWSER's origin (nginx forwards `Host: $host`); fetching it from inside the
// api container is unreachable (ECONNREFUSED → confirm 500) and would leak the
// token to whatever host the caller named. Mirrors services/enrich.ts. The
// `x-cobblr-base-url` override stays for isolated-stack e2e (home-life maps
// :4055→:4000); it's an explicit opt-in, not the default.
/** Exported so the import path reaches the api by THIS url rather than its own
 *  copy. A second spelling of a base url does not fail loudly - the caller still
 *  runs, just against nothing. */
export const INTERNAL_API = selfOrigin();

/** Run tasks at most `width` at a time, in order. For work that talks to an
 *  outside service with opinions about bursts. */
export async function runBounded(tasks: Array<() => Promise<void>>, width: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const t = tasks[next++]!;
      await t();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, worker));
}

/** Every field an agent may set on `kind`: the module's own (manufacturer,
 *  notes) and the workspace's, each with its type, choices and role. The scan
 *  menu carries only the workspace's, and refusing "notes" on a table that has
 *  notes would be the silent loss told the other way round. */
export async function agentFieldsFor(orgId: string, kind: string, fallback: readonly AgentField[]): Promise<AgentField[]> {
  const out = new Map<string, AgentField>();
  const rec = (await platform().entities.listKindsForOrg(orgId).catch(() => [])).find((k) => k.id === kind);
  for (const f of rec?.fields ?? []) {
    if (f.readOnly || f.type === "image-path" || f.type === "object") continue;
    out.set(f.name, { name: f.name, ...(f.label ? { label: f.label } : {}), type: f.type, ...(f.choices ? { choices: [...f.choices] } : {}), ...(f.fieldRole ? { field_role: f.fieldRole } : {}) });
  }
  for (const f of fallback) if (!out.has(f.name)) out.set(f.name, f);
  for (const f of await platform().entities.fieldsFor(orgId, kind).catch(() => [])) {
    if (f.type === "computed") continue;
    out.set(f.name, {
      name: f.name,
      label: f.display_label,
      type: f.type,
      ...(f.choices?.length ? { choices: [...f.choices] } : {}),
      ...(f.field_role ? { field_role: f.field_role } : {}),
      ...(f.learns ? { learns: true } : {}),
    });
  }
  return [...out.values()];
}

/** The tables other inbox rows with the same name are headed to or were
 *  filed into: a person's choice first, then where one was filed, then its
 *  route. Newest first, a handful, never this row. */
export async function twinTables(db: ReturnType<typeof tenantDb>, itemId: string, name: string | null | undefined, tables: ScanResolverTable[]): Promise<KeptTable[]> {
  const said = (name ?? "").trim();
  if (said.length < 3) return [];
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .selectAll()
    .where("id", "!=", itemId)
    .where("status", "in", ["pending", "resolved"])
    .where(sql<string>`lower(suggested_name)`, "=", said.toLowerCase())
    .orderBy("created_at", "desc")
    .limit(12)
    .execute();
  const out: KeptTable[] = [];
  for (const r of rows) {
    // Where it went, when it was filed; else where it is going, by the same
    // one destination the card shows (a person's choice first).
    const filed = filedIntoOf(r.suggested_metadata);
    if (filed) {
      out.push({ module: filed.module, instance: filed.instance, kind: filed.kind });
      continue;
    }
    const d = filingDestination(r as never, tables);
    if (d?.module) out.push({ module: d.module, instance: d.instance ?? null, kind: typeof d.kind === "string" ? d.kind : null });
  }
  return out;
}

// ── Paperwork put on a record (#4523) ───────────────────────────────────
// A document dropped or pasted on a record's Files is read, its purchase kept
// and claimed for the record, and the record's empty fields filled from it
// (services/attach-paperwork.ts). Conflicts come back to be decided; what was
// written comes back so it can be undone.
export const RecordRef = z.object({ kind: z.string().min(3).max(120), id: z.string().min(1).max(120) });

export function paperworkHttp(req: Parameters<Parameters<typeof asyncHandler>[0]>[0], slug: string) {
  return {
    baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
    slug,
    headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" },
  };
}

/** The one paperwork door, whichever route found the record ("It's this
 *  one", a name match, "Is this the same one?", the attach door): the paper
 *  goes on that record, fills its empty fields by meaning, never one whose
 *  check failed (those come back as `held`), its purchase line is claimed for
 *  it, and the card is done. It never counts the paper as another unit
 *  (#4523, #4633). */
export async function putPaperworkOn(req: Request, itemId: string, record: { kind: string; id: string }): Promise<AttachPaperworkResult | { status: number; error: { code: string; message: string } }> {
  const db = tenantDb(req);
  const ctx = tenantContext(req);
  const session = sessionUser(req);
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "scan_batch_id", "suggested_metadata"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row) return { status: 404, error: { code: "not_found", message: "inbox item not found" } };
  const batch = row.scan_batch_id
    ? await db.selectFrom("core_scan_batches").select(["source_file_id", "read_receipt", "vault_file_id"]).where("id", "=", row.scan_batch_id).executeTakeFirst()
    : null;
  if (!batch?.source_file_id && !batch?.read_receipt) return { status: 409, error: { code: "no_document", message: "This card did not come from a document." } };
  const meta = (row.suggested_metadata ?? {}) as { receipt_order_id?: unknown; receipt_order_item_id?: unknown; check_fields?: unknown };
  const existingLine =
    typeof meta.receipt_order_id === "string" && typeof meta.receipt_order_item_id === "string"
      ? { orderId: meta.receipt_order_id, lineId: meta.receipt_order_item_id }
      : null;
  const result = await attachPaperwork({
    orgId: ctx.org.id,
    userId: session.id,
    fileId: batch.source_file_id,
    // A personal document's values, read when it came in; it was never kept.
    ...(batch.source_file_id ? {} : { receipt: batch.read_receipt as ParsedReceipt }),
    kind: record.kind,
    id: record.id,
    http: paperworkHttp(req, ctx.org.slug),
    existingLine,
    // What the card already doubted stays doubted, whatever this read says.
    doubted: [...doubtedChecks(meta)],
  });
  // The original, kept in the Vault when it was read, now listed on the
  // record it is the paper for (#5331).
  if (result.read && batch.vault_file_id) {
    const linked = await linkInVault(ctx.org.id, session.id, batch.vault_file_id, record);
    Object.assign(result, { vault: { kept: true, linked } });
  }
  if (result.read) {
    const [module, kindName] = record.kind.split(":");
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        target_module: module ?? null,
        target_kind: kindName ?? null,
        target_entity_id: record.id,
        resolved_at: new Date(),
        updated_at: new Date(),
      } as never)
      .where("id", "=", row.id)
      .execute();
  }
  return result;
}

/** How many pending rows a facet query will look at. The facets read jsonb
 *  metadata and a confidence score, so they are decided in JS from the shared
 *  predicate rather than re-expressed as SQL — one definition, no drift between
 *  what the page counts and what this route returns. The cap keeps that honest
 *  for a queue of any size; a caller that hits it is told so. */
export const TRIAGE_SCAN_CAP = 1000;

// ──────────── POST /inbox/:id/confirm-into-location ───────────────
// The paired-scan flow: the active bin's QR said WHICH record ("Bin 17");
// this scanned UPC says WHAT it is ("Sterilite 6qt"). Instead of creating a
// new entity filed INTO the bin, the product identity lands on the bin's own
// core-locations record — structured container_* keys merged into its
// metadata, the catalog photo as its image, the product name as its
// description when none is set. The location's NAME is the user's own label
// ("Bin 17") and is never overwritten. All writes ride core-locations' HTTP
// surface with the caller's bearer, so role gating + isolation hold.

export const NEW_BIN = "new-bin";
export const INTO_BIN = "into-bin";

/** Append a triage-action entry to an item's per-item history
 *  (suggested_metadata.history, last 8) — the user-visible "what you did"
 *  timeline shown in the source panel. Best-effort; history is cosmetic. */

/** A scan row as the API returns it, with the colour composed into the title.
 *
 *  DERIVED, not stored. NINE different passes write `suggested_name` - the
 *  barcode paths, the photo identify, the decoder, the thin-hit enrich, the
 *  cross-check - and the last two run DETACHED, after the response. Storing a
 *  composed title meant whichever pass finished last silently dropped it: the
 *  title gained the colour and then lost it "at the end of the AI run" (reported
 *  2026-07-30), twice, because patching write sites always misses the next one.
 *
 *  So the stored name stays the honest answer from whatever identified it, the
 *  colour stays in metadata, and the two are composed on the way out. No pass
 *  can clobber a value that is computed. */
/** A row as the API returns it: composed (withTitle) and with any install
 *  offer on its candidates judged against the workspace's tables NOW
 *  (services/resolve-offers.ts). The tables are read once per request. */
export async function served<T extends ScanTriageRow & {
  suggested_name: string | null;
  suggested_manufacturer?: string | null;
  suggested_candidates?: unknown;
  suggested_metadata?: unknown;
}>(req: Request, row: T): Promise<T & { needs_review: boolean; waiting_days: number | null; group_image_file_id: string | null }> {
  const [withGroup] = await withGroupImages(req, [row]);
  const tables = await destinationTablesFor(req);
  const live = await liveTablesFor(req);
  return withHeld(withDestination(withTitle(withResolvedOffers(withGroup!, live), await containerKindsFor(req), titleFormatFor(req)), row, tables, live), await scanViewerFor(req));
}

/** A stored row as the card reads it: the person's own field values over the
 *  candidates' and the person's name over the model's. Every judgement of
 *  "does this need review" (the served flag, the To review filter, its
 *  count) is made on this, never the raw row, whose candidate still carries
 *  a value the person corrected (#3722). */
export function asTheCardReadsIt<T extends ScanTriageRow>(row: T): T {
  const r = row as T & { suggested_name: string | null; suggested_candidates?: unknown; suggested_metadata?: unknown };
  return withPersonName({ ...r, suggested_name: r.suggested_name ?? null, suggested_candidates: candidatesWithUserFields(storedCandidateList(r.suggested_candidates), r.suggested_metadata) }) as T;
}

/** The served row's `needs_review` and `review_reason` from the one held
 *  predicate, with the viewer's tables, so the field, the filter, the count
 *  and the card agree on every row (#3722). */
export function withHeld<T extends { needs_review: boolean }>(served: T, viewer: ScanRowStateContext): T {
  // Judged on the SERVED row, the one the card reads: the person's own field
  // values are applied there (candidatesWithUserFields). The raw row still
  // carries the value the person corrected, so it read a conflict the card
  // had already seen resolved.
  const row = served as unknown as ScanTriageRow;
  const held = scanHeldForReview(row, viewer);
  return { ...served, needs_review: held, review_reason: held ? (scanRowState(row, viewer).sentence ?? null) : null };
}

/** The row's ONE destination on the answer itself (services/destination.ts),
 *  for a reader that cannot run the resolver: the kernel's quickstart
 *  groups and files by it, so "these look like X" and "file all N" agree
 *  with the card and the scanner queue (#3618). */
export function withDestination<T>(served: T, raw: DestinationRow, tables: ScanResolverTable[], live: LiveTable[]): T & { resolved_destination: { module: string; instance: string | null; kind: string | null; label: string | null; bundle_external_id: string | null } | null } {
  const d = filingDestination(raw, tables, live);
  return {
    ...served,
    resolved_destination: d
      ? { module: d.module, instance: d.instance ?? null, kind: typeof d.kind === "string" ? d.kind : null, label: typeof d.label === "string" ? d.label : null, bundle_external_id: typeof d.bundle_external_id === "string" ? d.bundle_external_id : null }
      : null,
  };
}

/** A split child's group shot, served on the child as `group_image_file_id`
 *  (services/group-image.ts is the one place that says which file it is). */
export async function withGroupImages<T extends { suggested_metadata?: unknown }>(
  req: Request,
  rows: T[],
): Promise<Array<T & { group_image_file_id: string | null }>> {
  return groupImagesFor(tenantDb(req), rows);
}

/** The workspace's tables, read once per request however many rows it serves. */
/** The person asking, as the row resolver reads them, for a server count
 *  that must agree with the card: whether they may turn an app on, and
 *  whether each module is on, available or absent here (#3610). Read once
 *  per request; a list that cannot be read leaves module state unknown,
 *  which never excludes a row. */
export async function scanViewerFor(req: Request): Promise<ScanRowStateContext> {
  const holder = req as Request & { __scanViewer?: Promise<ScanRowStateContext> };
  holder.__scanViewer ??= (async () => {
    const role = (req as unknown as { tenant?: { role: string } }).tenant?.role ?? "member";
    const canInstall = roleSatisfies(role as "owner", ["owner", "admin"]);
    const token = bearer(req);
    let modules: Array<{ name: string; enabled?: boolean }> | null = null;
    if (token) {
      try {
        const r = await apiFetch(`${INTERNAL_API}/api/v1/orgs/${tenantContext(req).org.slug}/modules`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) modules = ((await r.json()) as { items: Array<{ name: string; enabled?: boolean }> }).items;
      } catch {
        /* unknown: nothing is excluded on its account */
      }
    }
    return {
      canInstall,
      // The tables the card resolves destinations against, so the server
      // holds a row for review exactly when the card says Review (#3722).
      tables: await destinationTablesFor(req),
      ...(modules && modules.length > 0
        ? { moduleState: (m: string) => { const x = modules!.find((y) => y.name === m); return !x ? "absent" : x.enabled ? "enabled" : "available"; } }
        : {}),
    } as ScanRowStateContext;
  })();
  return holder.__scanViewer;
}

/** The workspace's tables as the destination resolver reads them, from the
 *  same scan menu the card is handed (GET /menu), read once per request.
 *  Empty when the menu cannot be read (a guest, a hiccup): the resolver then
 *  answers from the row alone, the person's choice first. */
export async function destinationTablesFor(req: Request): Promise<ScanResolverTable[]> {
  const holder = req as Request & { __destTables?: Promise<ScanResolverTable[]> };
  holder.__destTables ??= (async () => {
    const token = bearer(req);
    if (!token) return [];
    const ctx = tenantContext(req);
    // The menu changes only on an install or a table edit, and the dashboard
    // polls the queue every few seconds per tab: held per workspace briefly.
    // A new table can reach the queue's grouping up to that late; filing
    // resolves again on confirm.
    const hit = DEST_TABLES_CACHE.get(ctx.org.id);
    if (hit && Date.now() - hit.at < DEST_TABLES_TTL_MS) return hit.tables;
    try {
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      const tables = destinationTables(await assembleScanMenu(baseUrl, ctx.org.slug, token, ctx.org.id));
      DEST_TABLES_CACHE.set(ctx.org.id, { at: Date.now(), tables });
      return tables;
    } catch {
      return hit?.tables ?? [];
    }
  })();
  return holder.__destTables;
}
export const DEST_TABLES_TTL_MS = 30_000;
export const DEST_TABLES_CACHE = new Map<string, { at: number; tables: ScanResolverTable[] }>();

/** Where a row was filed, as the commit records it (#3620): the table by
 *  module and instance and its name at that moment, read from the
 *  workspace's tables. A committed row is shown by this, never re-derived. */
export async function filedIntoFor(
  req: Request,
  module: string,
  instance: string | null,
  kind: string | null,
  extra: { name?: string; noun?: unknown; under?: FiledInto["under"]; shownAs?: unknown } = {},
): Promise<FiledInto> {
  const live = await liveTablesFor(req);
  const t = live.find((x) => x.module === module && (x.instance ?? null) === instance) ?? (instance ? live.find((x) => x.instance === instance) : undefined);
  const shown = typeof extra.shownAs === "string" && extra.shownAs.trim() ? extra.shownAs.trim() : null;
  const label = shown ?? t?.label ?? live.find((x) => x.module === module && x.instance === null)?.label ?? module;
  const noun = typeof extra.noun === "string" && extra.noun.trim() ? extra.noun.trim() : undefined;
  const name = extra.name?.trim() || undefined;
  return { module, instance, kind, label, ...(name ? { name } : {}), ...(noun ? { noun } : {}), ...(extra.under ? { under: extra.under } : {}) };
}

export async function liveTablesFor(req: Request): Promise<LiveTable[]> {
  const holder = req as Request & { __liveTables?: Promise<LiveTable[]> };
  holder.__liveTables ??= liveTablesOf(tenantContext(req).org.id);
  return holder.__liveTables;
}

/** The kinds this workspace declares as containers (the containment trait),
 *  read once per request: what makes "Turn into a bin" likely for a row
 *  routed to one of them (#3006). Best-effort; a registry that cannot be
 *  read leaves the name rule to decide. */
export async function containerKindsFor(req: Request): Promise<Set<string>> {
  const holder = req as Request & { __containerKinds?: Promise<Set<string>> };
  holder.__containerKinds ??= (async () => {
    const out = new Set<string>();
    try {
      const recs = await platform().entities.listKindsForOrg(tenantContext(req).org.id);
      for (const rec of recs) {
        if (traitAxisValue(rec.traits as Record<string, unknown> | null, "containment") !== "container") continue;
        out.add(rec.id.includes(":") ? rec.id : `${rec.module_name}:${rec.id}`);
      }
    } catch {
      /* the name rule still answers */
    }
    return out;
  })();
  return holder.__containerKinds;
}

export function withTitle<T extends ScanTriageRow & {
  suggested_name: string | null;
  suggested_manufacturer?: string | null;
  suggested_candidates?: unknown;
  suggested_metadata?: unknown;
}>(row: T, containerKinds: ReadonlySet<string> = new Set(), titleFormat: TitleFormat | null = null): T & { needs_review: boolean; waiting_days: number | null } {
  // A titled work with its variants on the row reads in the person's
  // format, composed here like the colour is: derived, never stored, one
  // format on every surface (#3061). The stored name is what the source said.
  const variants = formatTitleVariants(titleVariantsOf(row.suggested_metadata), titleFormat);
  const titled = colouredTitleFor({
    suggested_name: variants ?? row.suggested_name,
    suggested_manufacturer: row.suggested_manufacturer ?? null,
    suggested_candidates: row.suggested_candidates,
    suggested_metadata: (row.suggested_metadata ?? {}) as Record<string, unknown>,
  }) ?? variants;
  const withUser = { ...row, suggested_candidates: candidatesWithUserFields(storedCandidateList(row.suggested_candidates), row.suggested_metadata) };
  // A name a person gave is theirs, whole: no colour suffix, and the
  // column a re-run wrote sits beside it as `replaced` (#2982).
  const named = withPersonName(withUser);
  const base = named !== withUser ? named : titled ? { ...withUser, suggested_name: titled } : withUser;
  return withTriage(withDisplayCategory(withRetryState(base)), containerKinds);
}

/** A row still claiming a barcode retry that cannot be coming (its chain is
 *  past its window: a lost job, a restart mid-chain) reads as the retries
 *  having run out: the flags gone, the last word said, and the card's photo
 *  and Name it on offer. Derived on the way out, so no row can promise a
 *  retry for longer than the chain can take, whatever happened to its job
 *  (#3710). */
export function withRetryState<T extends { status?: string | null; suggested_name?: string | null; suggested_metadata?: unknown; updated_at?: string | Date | null; ai_notes?: string | null; ai_suggested_at?: string | Date | null }>(row: T): T {
  if (!retryHasRunOut({ ...row, suggested_metadata: (row.suggested_metadata ?? null) as Record<string, unknown> | null })) return row;
  const { rate_limited: _r, retry_queued: _q, lookup_unreachable: _u, ...meta } = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  return { ...row, suggested_metadata: meta, ai_notes: LOOKUP_GAVE_UP, ai_suggested_at: row.ai_suggested_at ?? row.updated_at ?? null };
}

export function titleFormatFor(req: Request): TitleFormat | null {
  return asTitleFormat((req as unknown as { session?: { title_pref?: string | null } }).session?.title_pref);
}

/** The queue facets, composed onto the row on the way out (same reason as the
 *  title above: derived, never stored). Without them every caller re-derives
 *  "does this need me" from raw metadata — which is how the flags ended up
 *  existing only inside the Scan page, invisible to the API and to Cobb. */
export function withTriage<T extends ScanTriageRow>(
  row: T,
  containerKinds: ReadonlySet<string> = new Set(),
): T & { needs_review: boolean; review_reason: string | null; source_conflict: SourceConflict | null; waiting_days: number | null; tool_hints: ScanToolHints } {
  const r = row as T & { source_kind?: string | null; barcode_text?: string | null; image_file_id?: string | null; ai_suggested_at?: string | Date | null; target_container_id?: string | null };
  return {
    ...row,
    needs_review: needsScanReview(row),
    // The words behind the flag, so whoever reads the row (the assistant, a
    // test) sees the same reason the card and the File preview show.
    review_reason: scanReviewReason(row),
    // Where the row says it was acquired against what its purchase evidence
    // says, when the two disagree: the value, the evidence and the seller,
    // beside the reason (acquisition-source.ts, #3008). Never resolved here.
    source_conflict: scanSourceConflict(row),
    waiting_days: scanWaitingDays(row),
    // Which item tools this row could need, with the reason each is folded:
    // one rule (scan-tools.ts) the desktop rail and the phone screen read.
    tool_hints: scanToolRelevance(r, { containerKinds, openBox: !!r.target_container_id }),
  };
}

/**
 * The routing note quotes the category the item was filed as - and that quote
 * is STORED, so it kept saying “apparel” under a chip that read “Clothing”
 * (reported 2026-07-30). Same class as the title: a value other passes rewrite must
 * not be frozen into prose. Composing it on the way out heals every row already
 * in the inbox, with no re-run and no migration.
 *
 * Deliberately narrow - it rewrites the quoted label inside the one generated
 * sentence, and leaves a note a person typed alone.
 */
export function withDisplayCategory<T extends { suggested_candidates?: unknown }>(row: T): T {
  const cands = row.suggested_candidates;
  if (!Array.isArray(cands) || cands.length === 0) return row;
  let touched = false;
  const next = cands.map((c) => {
    if (!c || typeof c !== "object") return c;
    const cand = c as { notes?: unknown };
    if (typeof cand.notes !== "string") return c;
    const fixed = displayedNote(cand.notes);
    if (fixed === cand.notes) return c;
    touched = true;
    return { ...cand, notes: fixed };
  });
  return touched ? { ...row, suggested_candidates: next } : row;
}

/** Stamp a finished run's OUTCOME onto the history entry that RECORDED it.
 *
 *  The entry is written when a re-run starts, so it can only ever say what was
 *  asked for. The outcome was first carried as a single row-level flag, which
 *  meant the "the AI didn't answer" qualifier described the LATEST run and so
 *  HOPPED to whatever entry was newest - detaching from the run it was actually
 *  about (reported 2026-08-10). An outcome belongs to one run, so it is written
 *  on that run's own entry: older entries keep their own verdict and nothing
 *  moves. Targets the newest AI-asking entry that has no verdict yet.
 *  Best-effort; history is cosmetic. */
export const AI_ASKING_ACTIONS = new Set(["rerun", "rerun-hint", "wrong", "enrich"]);

export async function stampScanHistoryOutcome(
  db: ReturnType<typeof tenantDb>,
  id: string,
  aiAnswered: boolean,
): Promise<void> {
  try {
    const cur = await db
      .selectFrom("core_scan_inbox_items")
      .select("suggested_metadata")
      .where("id", "=", id)
      .executeTakeFirst();
    const meta = (cur?.suggested_metadata ?? {}) as Record<string, unknown>;
    const hist = Array.isArray((meta as { history?: unknown }).history)
      ? ([...(meta as { history: Array<Record<string, unknown>> }).history])
      : [];
    if (!hist.length) return;
    for (let i = hist.length - 1; i >= 0; i--) {
      const e = hist[i];
      if (!e || typeof e !== "object") continue;
      if (!AI_ASKING_ACTIONS.has(String(e.action))) continue;
      if ("ai_answered" in e) return; // already settled - don't re-stamp an older run
      hist[i] = { ...e, ai_answered: aiAnswered };
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: mergeMeta({ history: hist }) as never })
        .where("id", "=", id)
        .execute();
      return;
    }
  } catch {
    /* best-effort */
  }
}

/** The undo + lock bookkeeping every catalog-image change shares.
 *
 * Returns ONLY the suggested_metadata keys the catalog image owns: the user-set
 * lock, the step pushed onto the undo stack, and what the new image came from.
 *
 * It deliberately returns no COLUMNS. Which column a caller writes differs
 * legitimately (a stored file nulls the url; a picked web result records it),
 * but what must never differ is that the slots an apply moves are the slots
 * revert can put back. /photos/primary also wrote image_file_id and shuffled
 * extra_photos, so one tap moved three things and revert restored one.
 */
export function catalogMetaSet(
  row: {
    catalog_image_url: string | null;
    catalog_image_file_id: string | null;
    suggested_metadata: unknown;
  },
  source: CatalogSource,
) {
  const meta = (row.suggested_metadata ?? {}) as {
    catalog_history?: CatalogStep[];
    orig_catalog?: OrigCatalog;
    catalog_source?: CatalogSource;
  };
  return {
    catalog_image_user_set: true as const,
    catalog_history: pushStep(
      seedHistory(meta.catalog_history, meta.orig_catalog),
      { url: row.catalog_image_url, file_id: row.catalog_image_file_id },
      meta.catalog_source,
    ),
    catalog_source: source,
  };
}

export interface OrigCatalog {
  url: string | null;
  file_id: string | null;
}

// ──────────────────── the matchmaker, server-owned ──────────────────
// Routing + field-fill runs ONCE, at intake, server-side (the author: "it should
// not require the phone or computer webapp to be open, and it should not
// re-run when a webpage connects"). The web never auto-triggers it.

/** Background duplicates are suppressed; explicit corrections wait for older writes. */
export const runMatch = createMatchQueue();

export interface MatchItemOpts {
  orgId: string;
  orgSlug: string;
  token: string;
  baseUrl: string;
  itemId: string;
  /** Scanning user (null for a background/cron match) — routes AI to their
   *  personal connection. */
  userId?: string | null;
  /** true = explicit re-rank (rerun / POST /match); false = intake
   *  auto-match, which SKIPS items already matched (matched_at stamp). */
  force: boolean;
  /** REPLAY: every AI stage served from cache, a miss degrades instead of paying
   *  (see RerunBody.no_ai). The deterministic tail — heuristic routing, decoder
   *  role-fill, field mapping — re-runs against today's code either way. */
  replay?: boolean;
  /** The caller waits for the whole plan (an assistant's add): the picture
   *  search after the match is awaited too, so its answer says the picture
   *  the item really has (#4591). */
  settle?: boolean;
}

/** For a book candidate whose table has an ISBN field the match left BLANK, look
 *  the ISBN up from Open Library by title + author (+ publisher) and fill it. The
 *  ISBN is almost never printed on a cover, so vision can't read it — a title
 *  lookup backfills it authoritatively (preferring the edition whose publisher
 *  matches the item's brand). Best-effort, never throws; only BACKFILLS (never
 *  overrides an ISBN the match already produced); writes back only on a change.
 *
 *  A row that already KNOWS its ISBN (the code scanned was one, and the decode
 *  carries it) fills the blank with that and asks nobody: a title search finds
 *  an edition, not this one. "JavaScript: The Good Parts" scanned as its 2008
 *  O'Reilly ISBN was filed under a 2015 reprint's, and "The Martian" paperback
 *  under its ebook's (#3543). */
export async function backfillBookIsbn(
  orgId: string,
  itemId: string,
  candidates: MatchCandidate[],
  menu: ScanMenuEntry[],
  brand: string | null,
  knownIsbn: string | null,
  readTitle: string | null,
): Promise<void> {
  try {
    const byKey = new Map(menu.map((m) => [`${m.module}::${m.instance ?? ""}`, m]));
    let changed = false;
    const stamps: Record<string, { by: "evidence"; from: string; at: string }> = {};
    for (const c of candidates) {
      const entry = byKey.get(`${c.module}::${c.instance ?? ""}`);
      const isbnField = entry?.fields.find((f) => /^isbn$/i.test(f.name));
      if (!isbnField) continue; // table has no ISBN field → not a book table
      const cur = c.fields[isbnField.name];
      if (cur != null && String(cur).replace(/[^0-9Xx]/g, "").length >= 10) continue; // already has one
      const author = (Object.entries(c.fields).find(([k]) => /^author$/i.test(k))?.[1] as string | undefined) ?? null;
      // A title search answers with whatever work its words find first, so
      // its ISBN is only this book's when the catalog's title is the title
      // READ off the item. A blank notebook named "Blank softcover book" by
      // its looks matched another book's listing and wore its ISBN as fact
      // (#3613); with no title read there is nothing to corroborate.
      let isbn = knownIsbn;
      if (!isbn && readTitle) {
        const hit = await lookupBookByTitle(readTitle, author, brand);
        if (hit && catalogTitleCorroborated(readTitle, hit.title)) {
          isbn = hit.isbn;
          stamps[isbnField.name] = { by: "evidence", from: CATALOG_TITLE_MATCHED, at: new Date().toISOString() };
        }
      }
      if (isbn) {
        c.fields[isbnField.name] = isbn;
        changed = true;
      }
    }
    if (!changed) return;
    const db = (await platform().tenants.getDb(orgId)) as unknown as ReturnType<typeof tenantDb>;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        // jsonb-replace-ok: candidates are a LIST; this writes the same list back with its ISBN filled in place
        suggested_candidates: JSON.stringify(candidates) as never,
        ...(Object.keys(stamps).length
          ? {
              suggested_metadata: sql`jsonb_set(coalesce(suggested_metadata, '{}'::jsonb), ${`{${FIELD_PROVENANCE_KEY}}`}::text[], coalesce(suggested_metadata->${FIELD_PROVENANCE_KEY}, '{}'::jsonb) || ${JSON.stringify(stamps)}::jsonb)` as never,
            }
          : {}),
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .where("status", "=", "pending")
      .execute();
    console.log(`[core-scan] backfilled ISBN for ${itemId} from Open Library`);
  } catch (e) {
    console.error(`[core-scan] ISBN backfill for ${itemId} failed:`, (e as Error).message);
  }
}

/** After an item matches, normalise the SECONDARY routing across every pending
 *  item of the SAME series in the SAME scan session, so a shelf of one series
 *  routes uniformly (all offer a given secondary table, or none) instead of the
 *  model's per-item coin-flip. Deterministic (no model call), idempotent, and
 *  guarded to only touch items whose candidates actually change — so running it
 *  after each item in the batch simply converges. Only fires for an item that
 *  HAS a series + a batch; a lone or series-less item is a no-op. Best-effort. */
export async function reconcileSeriesRouting(orgId: string, batchId: string | null, series: string | null): Promise<void> {
  if (!batchId || !series || !series.trim()) return;
  try {
    const db = (await platform().tenants.getDb(orgId)) as unknown as ReturnType<typeof tenantDb>;
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "suggested_candidates", "suggested_metadata"])
      .where("scan_batch_id", "=", batchId)
      .where("status", "=", "pending")
      .execute();
    const want = series.trim().toLowerCase();
    const group = rows
      .filter((r) => {
        const s = (r.suggested_metadata as { series?: unknown } | null)?.series;
        return typeof s === "string" && s.trim().toLowerCase() === want;
      })
      .map((r) => ({ id: r.id, candidates: (r.suggested_candidates ?? []) as MatchCandidate[] }));
    if (group.length < 2) return;
    const changes = reconcileSeriesSecondaries(group);
    for (const [id, cands] of changes) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_candidates: JSON.stringify(cands) as never, updated_at: new Date() })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .execute();
    }
    if (changes.size > 0) {
      console.log(`[core-scan] series-reconciled ${changes.size}/${group.length} "${series}" items in batch ${batchId}`);
    }
  } catch (e) {
    console.error(`[core-scan] series reconcile (batch ${batchId}) failed:`, (e as Error).message);
  }
}

/** Merge an identifier decode (a scanned VIN) onto the matchmaker candidates by
 *  ROLE. For each candidate we take the routed table's declared fields (carrying
 *  their `decode_role`), plan the fill from the decoded semantic bag with the
 *  shared platform planner (prefers `decode:<key>`, falls back to name), and set
 *  each fill's field — EMPTY-ONLY, so the model's own extraction is never
 *  clobbered. Mutates `candidates` in place. A no-op when the item wasn't
 *  decoder-resolved. Generic: it never names a vehicle or a domain. */
export function applyDecoderFill(
  suggestedMetadata: unknown,
  candidates: MatchCandidate[],
  menu: ScanMenuEntry[],
  /** The identifier that was decoded (the item's code). A field declaring
   *  `identifier:<decoderId>` is the field that HOLDS it — the VIN box on a
   *  vehicle — so it gets the code itself. Without this the role was parsed and
   *  then ignored: after a VIN scan the VIN field sat EMPTY while the VIN was
   *  printed in the title right above it. */
  identifierCode?: string | null,
): void {
  const meta = suggestedMetadata as {
    decoded?: { decoder_id?: string; fields?: Record<string, string | number> };
  } | null;
  const decoded = meta?.decoded?.fields;
  const decoderId = meta?.decoded?.decoder_id;
  if (!decoded || Object.keys(decoded).length === 0) return;
  const identifier =
    decoderId && identifierCode ? { decoderId, code: identifierCode } : undefined;
  const menuByKey = new Map(menu.map((m) => [`${m.module}::${m.instance ?? ""}`, m] as const));
  for (const cand of candidates) {
    const entry = menuByKey.get(`${cand.module}::${cand.instance ?? ""}`);
    if (!entry) continue;
    const targets: DecodeFillTarget[] = entry.fields.map((f) => ({
      id: f.name,
      name: f.name,
      label: f.label,
      // Only a field the model DID NOT already fill is eligible — role-fill is
      // the floor, the model's read wins.
      empty: cand.fields[f.name] === undefined || cand.fields[f.name] === "" || cand.fields[f.name] === null,
      role: f.decode_role ?? null,
    }));
    for (const fill of planDecodeFill(decoded, targets, identifier)) {
      cand.fields[fill.target.name] = fill.value;
    }
  }
}

export const PAINT_CACHE_NS = "vehicle-paint";

/** Resolve a vehicle's paint color from the code the photo pass ALREADY read
 *  onto the item — Tier 0 (extract) + Tier 1 (curated table), then Tier 2
 *  (web-search) on a table miss. Vehicle-scoped (only runs when the item was
 *  VIN-decoded, i.e. `make` is present), deterministic + web-search only (NO
 *  LLM, so it never touches the shared scan-inbox prompt), and best-effort:
 *  Tier 2 is bounded so it can't stall the match, its hits cache once (make|
 *  code), and an unresolved code just leaves the field blank (never a guess).
 *  See docs/design-decisions/vehicle-color-resolution.md. */
export async function resolveVehicleColor(suggestedMetadata: unknown, text: string): Promise<string | null> {
  const decoded = (suggestedMetadata as { decoded?: { fields?: Record<string, string | number> } } | null)
    ?.decoded?.fields;
  const make = typeof decoded?.make === "string" ? decoded.make : "";
  if (!make) return null; // only VIN-decoded vehicles carry a make here
  const r = resolvePaintColorFromText(make, text); // Tier 0 (extract) + Tier 1 (table)
  if (!r) return null; // no paint code in the item's text
  if (r.name) return r.name; // table hit — zero network
  // Tier 2: web-search a code not in the table. Cached once; bounded so a slow
  // DDG can't hold up the match; a miss/timeout is simply not cached.
  const cacheKey = `${make.toLowerCase()}|${r.code}`;
  const cached = await platform().sharedCache.get<{ name: string }>(PAINT_CACHE_NS, cacheKey).catch(() => null);
  if (cached?.name) return cached.name;
  const web = await Promise.race([
    resolvePaintCodeViaWeb(make, r.code),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
  ]).catch(() => null);
  if (web?.name) {
    await platform().sharedCache.put(PAINT_CACHE_NS, cacheKey, { name: web.name }).catch(() => {});
    return web.name;
  }
  return null;
}

/** Land a resolved color onto every candidate whose table DECLARES a `color`
 *  field — mirrors applyDecoderFill's field-scoped fill, so only the vehicle
 *  tables (incl. the not-yet-installed Vehicles bundle candidate) receive it;
 *  nothing else is touched.
 *
 *  Deliberately NOT empty-only, unlike the decoder fill. A color resolved FROM A
 *  CODE is a fact: the paint code stamped on the vehicle's own compliance label,
 *  run through a lookup. What it displaces is the model's guess from the photo,
 *  which is a guess wearing a fact's clothes. A real silver 2002 Odyssey came back
 *  as `#6F8FAF` (a blue-grey) because vision was asked what color the car was and
 *  duly invented six hex digits: precision it does not have.
 *
 *  So the code wins. It only ever displaces the AI's OWN extraction (this runs at
 *  intake, before anyone has touched the form), never something a human typed. */
export function applyPaintColorFill(color: string, candidates: MatchCandidate[], menu: ScanMenuEntry[]): void {
  const menuByKey = new Map(menu.map((m) => [`${m.module}::${m.instance ?? ""}`, m] as const));
  for (const cand of candidates) {
    const entry = menuByKey.get(`${cand.module}::${cand.instance ?? ""}`);
    if (!entry || !entry.fields.some((f) => f.name === "color")) continue;
    cand.fields.color = color;
  }
}

/** The kind of thing the top route calls the scan: its category, when the
 *  table declared one. */
export function topCandidateCategory(raw: unknown): string | null {
  const top = storedCandidateList(raw)[0] as { category?: unknown } | undefined;
  return typeof top?.category === "string" && top.category.trim() ? top.category : null;
}

export function storedCandidateList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Categories already proposed by OTHER items in the same scan batch.
 *
 *  A proposal lives on the sibling row until the user confirms it, so this is
 *  the only place the current run can learn that "Monitors" has just been
 *  offered for the monitor two rows up. Scoped to the batch on purpose: items
 *  scanned together are the ones a person expects to agree, and a workspace-wide
 *  sweep of every pending row would drag in unrelated sessions.
 *
 *  Best-effort — a batch that cannot be read is not a reason to fail the match,
 *  it just means this item invents like it always did. */
export async function batchProposedCategories(
  db: ReturnType<typeof tenantDb>,
  batchId: string | null,
  excludeItemId: string,
): Promise<string[]> {
  if (!batchId) return [];
  try {
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_candidates"])
      .where("scan_batch_id", "=", batchId)
      .where("id", "!=", excludeItemId)
      .where("status", "=", "pending")
      .limit(200)
      .execute();
    return categoriesFromCandidateRows(rows);
  } catch {
    return [];
  }
}

/** What the LOOKUP said about a scanned code, for the card's note to lead
 *  with. A store's own label is a fact in metadata (code_type), never re-read
 *  from prose; any other barcode row's note is the lookup's own words unless
 *  it is only a routing sentence from an earlier match. Null for a row no
 *  lookup ever judged (a typed note, a photo). */
export function lookupVerdictOf(row: { barcode_text: string | null; suggested_name: string | null; ai_notes: string | null; suggested_metadata: unknown }): string | null {
  // "Name it and it files like a typed item" is the verdict until the person
  // does; a named store item is routed like any typed item, and its card says
  // where it went. An Amazon label (#4933) is the same: one shared reader.
  const classified = classifiedCodeOf(row.suggested_metadata);
  if (classified && !row.suggested_name) return classified.note;
  if (!row.barcode_text) return null;
  return withoutRoutingSentences(row.ai_notes) || null;
}

/**
 * Siblings agree or nobody does (field-provenance.ts). Reads this child's
 * same-named siblings from the split, finds the identity fields the router
 * answered differently across them, blanks those on this child's candidates
 * (in place) and on each sibling's stored candidates, and marks every one of
 * them for review with the reason. Returns the disagreed field names.
 */
export async function reconcileSplitSiblings(
  db: ReturnType<typeof tenantDb>,
  itemId: string,
  splitFrom: string,
  name: string | null,
  meta: Record<string, unknown>,
  candidates: Array<{ fields?: Record<string, unknown> }>,
): Promise<string[]> {
  const sibs = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "suggested_candidates", "suggested_metadata", "ai_notes"])
    .where(sql`suggested_metadata->>'split_from'`, "=", splitFrom)
    .where("id", "!=", itemId)
    .where("status", "!=", "discarded")
    .execute();
  const disagreed = siblingDisagreements(
    { suggested_name: name, candidates, suggested_metadata: meta },
    sibs.map((s) => ({ id: s.id, suggested_name: s.suggested_name, suggested_candidates: s.suggested_candidates, suggested_metadata: (s.suggested_metadata ?? null) as Record<string, unknown> | null })),
  );
  if (!disagreed.length) return [];
  blankFields(candidates, disagreed);
  const sentence = siblingReviewWords(disagreed);
  for (const sib of sibs) {
    if (!sib.suggested_name || !name || sib.suggested_name.trim().toLowerCase() !== name.trim().toLowerCase()) continue;
    const list = storedCandidateList(sib.suggested_candidates) as Array<{ fields?: Record<string, unknown> }>;
    const prior = Array.isArray((sib.suggested_metadata as { split_disagreed?: unknown } | null)?.split_disagreed)
      ? ((sib.suggested_metadata as { split_disagreed: unknown[] }).split_disagreed.filter((k): k is string => typeof k === "string"))
      : [];
    const removed = blankFields(list, disagreed);
    const known = disagreed.every((k) => prior.includes(k));
    if (!removed && known) continue;
    const merged = [...new Set([...prior, ...disagreed])].sort();
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        // jsonb-replace-ok: the sibling's own list, minus the fields the twins disagree on
        suggested_candidates: JSON.stringify(list) as never,
        suggested_metadata: mergeMeta({ low_trust: true, split_disagreed: merged }) as never,
        ...(sib.ai_notes?.includes(sentence) ? {} : { ai_notes: [sib.ai_notes ?? "", sentence].filter(Boolean).join(" ") }),
        updated_at: new Date(),
      })
      .where("id", "=", sib.id)
      .execute();
  }
  return disagreed;
}

export async function matchItem(opts: MatchItemOpts): Promise<unknown[] | null> {
  return runMatch(`${opts.orgId}:${opts.itemId}`, opts.force, () => matchItemNow(opts));
}

export async function matchItemNow(opts: MatchItemOpts): Promise<unknown[] | null> {
  try {
    // Acquire a LIVE pool — this runs detached minutes after the request
    // that scheduled it, past the idle reaper (see the /scan read-back note).
    const db = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", opts.itemId)
      .executeTakeFirst();
    if (!row) return null;
    if (!row.suggested_name && !row.barcode_text) return null;
    const meta = (row.suggested_metadata ?? {}) as {
      category?: string;
      entity_type?: "asset" | "part";
      description?: string;
      photo_observations?: string;
      /** What the observation saw of the packaging (#3006), with the fields below. */
      packaging?: string;
      /** How many DISTINCT things the observation pass saw (units of one thing
       *  don't count — that's a quantity). >= 2 is what makes the inbox offer a
       *  split, and it costs nothing: the observe call already counted them. */
      photo_distinct?: number;
      /** Those things, named — so the split offer can LIST them without paying
       *  for a second vision call to find out what they are. */
      photo_individuals?: Array<{ name: string; brand: string | null; qty: number }>;
      /** WHICH image the three fields above describe. A retake swaps the photo
       *  out from under them, and an observation about a photo that no longer
       *  exists is worse than none — so they're only reused when this matches. */
      photo_observed_for?: string;
      matched_at?: string;
      /** A split child: what the group photo established about it (#2945). */
      split_inherited?: SplitInherited | null;
      crop?: "ok" | "failed" | "none";
    };
    if (!opts.force && meta.matched_at) return null;
    // Why a split child's identity is the group photo's rather than its own
    // crop's: the crop could not be cut, or its read came back blind. The
    // row says so and asks for a look (low_trust), and never forgets what
    // the group read knew.
    let splitReview: "crop-failed" | "crop-unreadable" | null = meta.split_inherited && meta.crop === "failed" ? "crop-failed" : null;

    // Vision corroboration: when the scan carries the user's own photo,
    // a factual read of it ("one loose skein in hand", "sealed 10-pack,
    // label says QTY 10") joins the matchmaker context and OUTRANKS
    // listing-derived counts — this catches the unit-barcode-on-a-9-pack-
    // listing trap. The same read reports how many DISTINCT things are in frame,
    // which is what lets the inbox offer a split.
    //
    // On the PHOTO path this is already done: `identify-image` answers all three
    // in its single read, so enrichPhotoItem has written these and we make NO
    // second vision call — the split offer landed with the name, seconds earlier.
    // What's left here is the BARCODE-with-a-photo path, which never runs
    // identify. Valid only for the image it actually looked at: a retake must
    // re-observe rather than describe a photo that's gone.
    const observedFor = meta.photo_observed_for ?? null;
    const observationIsCurrent = !!observedFor && observedFor === row.image_file_id;
    let photoObservations = observationIsCurrent ? (meta.photo_observations ?? null) : null;
    let photoDistinct = observationIsCurrent ? (meta.photo_distinct ?? null) : null;
    let photoIndividuals = observationIsCurrent ? (meta.photo_individuals ?? null) : null;
    let photoObservedFor = observationIsCurrent ? observedFor : null;
    // What the observation saw of the packaging: the one key the inbox's tool
    // rule reads (#3006). Kept with the observation it came from.
    let photoPackaging: string | null = observationIsCurrent ? (meta.packaging ?? null) : null;
    // A REPLAY never makes this call. Observing a photo is a vision pass, and a
    // replay re-derives from what the row already holds rather than looking
    // again — so when the stored observation is missing, or describes a photo
    // that has since been retaken, this pass simply goes without one.
    // The tables first, so a first match can say where it goes before any
    // model is asked (#6555).
    const baseMenu = await assembleMergedMenu(opts.baseUrl, opts.orgSlug, opts.token, opts.orgId);
    // What this item's OWN batch has already proposed, offered as ordinary axis
    // values. Without it every item in a bulk scan invents in isolation and a
    // run of like things scatters across synonyms of one category — see
    // withProposedCategories for the measurement.
    const menu = withProposedCategories(baseMenu, await batchProposedCategories(db, row.scan_batch_id, opts.itemId));
    // The deterministic router answers first (#6555, heuristic first, AI
    // last): a first match writes the heuristic's table at once, so the card
    // shows where it goes with its name, and the model's answer below
    // replaces it. Marked interim, with no fallback note: nothing failed.
    if (!opts.replay && !opts.force && row.suggested_name && storedCandidateList(row.suggested_candidates).length === 0) {
      const quick = heuristicMatch(perceiveRow(row, { photoObservations }), menu).map((c) => {
        const { ai_fallback: _f, ai_fallback_reason: _r, notes: _n, ...rest } = c as typeof c & { notes?: unknown };
        return { ...rest, interim: true };
      });
      if (quick.length) {
        await db
          .updateTable("core_scan_inbox_items")
          .set({ suggested_candidates: JSON.stringify(quick) as never, updated_at: new Date() })
          .where("id", "=", opts.itemId)
          .where(sql<boolean>`coalesce(suggested_candidates::text, 'null') in ('null', '[]')`)
          .execute()
          .catch((e: Error) => console.warn(`[core-scan] ${opts.itemId}: the interim table was not written:`, e.message));
      }
    }

    // A code you keep is routed from its record (heldCandidate): looking at
    // the photo again only delays its table (#6555, 2.9 s on the owner's tea).
    const heldHere = (meta as { identified_by?: unknown }).identified_by === "your_records";
    // A barcode already named by its lookup is routed by that name: its photo
    // is still looked at (the split offer and the packaging read it), but the
    // look is stored when it lands and never holds the table back (#6555: it
    // cost the owner's sugar 4.1 s before the matchmaker began).
    const namedByCode = !!row.barcode_text && !!row.suggested_name;
    if (!photoObservations && row.image_file_id && !opts.replay && !heldHere && namedByCode) {
      const imageId = row.image_file_id;
      void observeScanPhoto(opts.orgId, imageId, opts.itemId, opts.userId)
        .then(async (obs) => {
          if (!obs) return;
          await db
            .updateTable("core_scan_inbox_items")
            .set({
              suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
                photo_observations: obs.text,
                photo_observed_for: imageId,
                ...(obs.packaging ? { packaging: obs.packaging } : {}),
                ...(obs.distinct && obs.distinct >= 2 ? { photo_distinct: obs.distinct, photo_individuals: obs.individuals ?? [] } : {}),
              })}::jsonb` as never,
              updated_at: new Date(),
            })
            .where("id", "=", opts.itemId)
            .execute();
        })
        // DETACHED: the look feeds the split offer later; the table never waits for it
        .catch((e: Error) => console.warn(`[core-scan] ${opts.itemId}: photo observation:`, e.message));
    } else if (!photoObservations && row.image_file_id && !opts.replay && !heldHere) {
      const obs = await Promise.race([
        observeScanPhoto(opts.orgId, row.image_file_id, opts.itemId, opts.userId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
      if (obs && meta.split_inherited && unreadableObservation(obs.text)) {
        // The crop shows nothing. What the group photo said about this piece
        // stands as its observation, keyed to this image so the next run
        // does not pay to look at the same blind crop again.
        splitReview = "crop-unreadable";
        photoObservations = meta.split_inherited.observation ?? "The crop could not be read; identity from the group photo.";
        photoObservedFor = row.image_file_id;
      } else if (obs) {
        photoObservations = obs.text;
        photoDistinct = obs.distinct;
        photoIndividuals = obs.individuals;
        photoObservedFor = row.image_file_id;
        photoPackaging = obs.packaging;
      }
    }

    const candidates = await runMatchmaker(
      opts.orgId,
      // Everything the lookup wrote on the row (perceiveRow): the name, the
      // catalog's category, the description, the raw blob the fields read.
      perceiveRow(row, { photoObservations }),
      menu,
      opts.itemId, // links the AI-log row to this scan
      opts.userId,
      // A replay routes from the candidates the row already carries, through the
      // same refinement a model reply gets. No call, so nothing to degrade from.
      opts.replay ? { storedCandidates: storedCandidateList(row.suggested_candidates) } : undefined,
    );

    // Decoder role-fill (P2/P3). When the item was resolved by an identifier
    // decoder (a scanned VIN), deterministically map its decoded semantic bag
    // onto each candidate's declared fields BY ROLE (`decode:<key>`), falling
    // back to name/shape — the SAME planner the client form uses. This lands
    // year/fuel/… onto the routed vehicle table even with no AI, and never
    // clobbers a value the model already filled. Generic: core-scan reads the
    // flat bag + the field roles, nothing vehicle-specific.
    // The row's code is the identifier — and by now it's the CORRECTED one (the
    // VIN decoder repairs a mangled scan and writes the fix back), so the VIN field
    // gets the VIN that exists, not the one the scanner hallucinated.
    applyDecoderFill(row.suggested_metadata, candidates, menu, row.barcode_text);
    // A receipt KNOWS its provenance; the model only guesses at it. Written
    // after the model so the till's facts win (see receipt-candidate-facts.ts),
    // and stamped as evidence so a re-run can tell them from a guess (#3008).
    const evidenceStamps = applyReceiptFacts(row.suggested_metadata as Record<string, unknown> | null, candidates, menu);
    // A pack the line's words did not settle asks once, on the routed table's
    // size field, instead of the model guessing per line (#5350).
    const packAsks = receiptPackAsks(row.suggested_metadata as Record<string, unknown> | null, candidates, menu);
    // A split child KNOWS what the group photo read about it (its set number,
    // that the box is sealed); the model, looking at one crop, only guesses.
    // Written after the model so the group's facts win (split-inherit.ts).
    applySplitInheritance(meta, candidates, menu);
    // Where a thing was bought is not in a picture of it. A purchase field
    // the router filled on a capture with no purchase evidence is invented,
    // and it goes (field-provenance.ts); the router's note stays.
    const strippedPurchase = stripUnsupportedPurchaseFields(row, candidates, evidenceStamps);
    if (strippedPurchase.length) console.log(`[core-scan] ${opts.itemId}: purchase fields with no purchase evidence dropped: ${strippedPurchase.join(", ")}`);
    // A fact the name states is not the model's to guess: "4 Ply" on a
    // yarn IS its weight, derived here on every table that offers the
    // scale, over whatever the model put there (name-facts.ts).
    const nameFacts = applyNameFacts(row.suggested_name, candidates, menu);
    if (nameFacts.length) console.log(`[core-scan] ${opts.itemId}: from the name: ${nameFacts.map((f) => `${f.field}=${f.value}${f.was ? ` (was ${f.was})` : ""}`).join(", ")}`);
    // Split children that share a name are one product in one picture; a
    // field the router answered two ways across them is blank on all of them.
    let disagreed = meta.split_inherited ? await reconcileSplitSiblings(db, opts.itemId, meta.split_inherited.from, row.suggested_name, meta, candidates) : [];
    // One storage story per card: a cold requirement fills the table's own
    // Fridge / Freezer choice and a cold choice asserts its requirement, so
    // carrots and tomatoes off one receipt wear the same chip. Empty-only.
    alignStorageFields(candidates, menu);
    // A catch-all candidate whose category NAMES one of the module's own lists
    // goes to that list: "Teas" on a base-Inventory candidate is the model
    // saying tea and filing it where nobody looks for tea.
    const retargeted = retargetByCategory(candidates, menu) + retargetIsbnToBookList(candidates, menu, row.barcode_text);
    if (retargeted) {
      console.log(`[core-scan] ${retargeted} candidate(s) re-routed to the list their category named`);
      // A moved candidate was on the catch-all when the decode filled, so it
      // holds none of the new table's decoded fields. Empty-only, so the
      // candidates that did not move are untouched.
      applyDecoderFill(row.suggested_metadata, candidates, menu, row.barcode_text);
    }
    // What a person typed for a field of this row is not on these candidates
    // and never is: it rides in user_fields and is merged over the top route
    // on every read (services/user-fields.ts), so no pass above, and no
    // re-run, outranks it. Who put each purchase-source value there, for the
    // record the row keeps (field-provenance.ts, #3008).
    // The table of the route this match just wrote, whose fields it stamps.
    const matched = candidates.length ? candidateTableOf(candidates[0]) : null;
    const topEntry = matched ? menu.find((e) => e.module === matched.module && (e.instance ?? null) === matched.instance) : undefined;
    const fieldProvenance = provenanceStamps({
      meta: row.suggested_metadata as Record<string, unknown> | null,
      candidates,
      evidence: evidenceStamps,
      tableFields: topEntry?.fields,
      priorFields: (storedCandidateList(row.suggested_candidates)[0] as { fields?: Record<string, unknown> } | undefined)?.fields ?? null,
      row: { image_file_id: row.image_file_id, suggested_name: row.suggested_name, barcode_text: row.barcode_text },
    });

    // THE REPLAY INVARIANT, checked rather than merely intended: a replay may
    // only add or refine. It re-derives from the row's own stored knowledge, so
    // it has nothing to say that could make the row worse — but every derivation
    // pass added to the path above inherits that promise without knowing it
    // exists, which is what turns one fixed bug into a closed class. Fires almost
    // never; logs when it does, because that means a pass tried to regress a row.
    if (opts.replay) {
      const held = guardReplayCandidates(storedCandidateList(row.suggested_candidates), candidates);
      if (held.refused) {
        console.warn(
          `[core-scan] replay would have downgraded item ${opts.itemId} (${held.refused}); kept what was stored`,
        );
        candidates.length = 0;
        candidates.push(...(held.candidates as typeof candidates));
      }
    }

    // Persist: candidates + the matched_at stamp (the web renders a passive
    // "AI is reading…" pulse until this lands — no client triggering) +
    // the cached photo observations. The top candidate's reconciliation
    // replaces the provenance one-liner in ai_notes when present.
    // RE-ACQUIRE the pool: the model call above can run for minutes (the
    // claude bridge queues), long past the idle reaper — writing on the
    // pre-call handle is the classic "pool after end" (see /scan read-back).
    const dbAfter = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
    const top = candidates[0];
    const idSource = ((row.suggested_metadata ?? {}) as { source?: string }).source ?? "";
    const barcodeIdentified = isCuratedBarcodeIdentification(idSource, !!row.barcode_text, !!row.suggested_name);
    const candName =
      top && typeof top === "object" && "name" in top ? String((top as { name?: string }).name ?? "").trim() : "";
    // May the top candidate RENAME the row? Four guards, each a past regression —
    // see services/adopt-name.ts, where they live as one tested decision.
    const adoptName = shouldAdoptCandidateName({
      storedName: row.suggested_name,
      candName,
      idSource,
      hasBarcode: !!row.barcode_text,
      heuristic: !!top && typeof top === "object" && (top as { heuristic?: boolean }).heuristic === true,
    });

    // Vehicle paint color: resolve the code the photo pass read (candidate notes
    // / observations / ai_notes) to a color name and fill it onto the vehicle
    // candidates. Deterministic table + web-search, no LLM — so it's outside the
    // benchmark-gated prompt surface. Best-effort; mutates `candidates` before
    // they're persisted just below. Only fires for VIN-decoded items.
    const vehColor = await resolveVehicleColor(
      row.suggested_metadata,
      [
        top && typeof top === "object" && "notes" in top ? (top as { notes?: string }).notes ?? "" : "",
        photoObservations ?? "",
        row.ai_notes ?? "",
      ].join("\n"),
    ).catch(() => null);
    if (vehColor) applyPaintColorFill(vehColor, candidates, menu);

    // "Do we ALREADY have this?" — resolved here, at match time, rather than left
    // to the card. The collapsed card's one-tap "Add" CREATES an entity, so it
    // must not be the offer when the workspace already tracks the thing (that's
    // how you get a second Honda Civic). The card can only suppress it if it
    // knows without a per-card round trip, so the answer rides on the row. The
    // expanded banner still queries live and stays authoritative — this stamp is
    // the hint that keeps the collapsed CTA honest. Best-effort: a lookup failure
    // must never fail the match.
    // The one derivation (services/tracked-stamp.ts): a person's name over
    // the model's, so a re-run after a rename matches what the row is called.
    const tracked = await findTracked(
      opts.orgId,
      matchQuery(
        row,
        (top as { fields?: Record<string, unknown> } | undefined)?.fields ?? null,
        (top as { category?: string } | undefined)?.category ?? null,
        adoptName ? candName : row.suggested_name,
      ),
    ).catch(() => null);
    // A place read that fails leaves no stamp, as a failed match does: the
    // place-less stamp it fell back to offered "+1 more" into whichever row
    // matched first, a place nobody chose (#4985).
    const trackedStamp = await trackedMatchStampAt(opts.orgId, tracked, scanPlaceOf(row), row.suggested_metadata).catch(() => null);
    // What the workspace already knows outranks what the model guessed: the
    // table the record this thing IS lives in, else the table its twins in
    // the inbox are headed to, the most specific of them (kept-route.ts,
    // #4591). The same thing then lands in the same place on every add,
    // replay and re-run.
    // A thing handed over through a share says which collection the giver
    // kept it in: one of its known tables, by the same rule (#4682).
    const offeredIn = (row.suggested_metadata as { offered_collection?: { module?: string; instance?: string | null } } | null)?.offered_collection;
    const keptIn = routeWhereKept(candidates, menu, {
      tracked: trackedStamp ? { instance: trackedStamp.instance ?? null, kind: trackedStamp.kind } : null,
      twins: [
        ...(offeredIn?.module ? [{ module: offeredIn.module, instance: offeredIn.instance ?? null }] : []),
        ...(await twinTables(dbAfter, opts.itemId, adoptName ? candName : row.suggested_name, destinationTables(menu)).catch(() => [])),
      ],
    });
    if (keptIn) console.log(`[core-scan] ${opts.itemId}: routed to ${keptIn.label}, where the workspace keeps the same thing`);
    // The values a person or their agent gave say which list it belongs in
    // when the route has no field for one of them: a bed size is a 3D
    // printer's, never refused because the model guessed Machines (#4591).
    // The record it already is still decides (kept-route.ts).
    const given = Object.keys(userFieldsOf(row.suggested_metadata)?.values ?? {});
    const givenNames: TableFieldNames | null = given.length
      ? new Map(await Promise.all(menu.map(async (e) => [e.kind, new Set((await agentFieldsFor(opts.orgId, e.kind, e.fields)).map((f) => f.name))] as const)))
      : null;
    // The lists below may move it only to one that keeps every given value.
    const keepsGiven = (e: ScanMenuEntry) => !givenNames || tablesForGiven(given, [e], givenNames).length > 0;
    if (givenNames && !trackedStamp) {
      const byFields = routeByGivenFields(candidates, menu, given, givenNames);
      if (byFields) console.log(`[core-scan] ${opts.itemId}: routed to ${byFields.label}, the list the given values belong to`);
    }
    // A catch-all route yields to the one list that already holds the same
    // maker's things (kept-route.ts routeBySameMaker): two Bambu printers in
    // 3D Printers say where a Bambu Lab P1P goes (#4591).
    const maker = (() => {
      const v = userFieldsOf(row.suggested_metadata)?.values?.manufacturer ?? row.suggested_manufacturer ?? (candidates[0] as { fields?: Record<string, unknown> } | undefined)?.fields?.manufacturer;
      return typeof v === "string" && v.trim() ? v.trim() : null;
    })();
    // What the thing IS (its category, or what the matchmaker said it is)
    // names its list before who made it is asked (#5065): the fit rule the
    // card reads, so the stored route and the card agree.
    if (!trackedStamp && onCatchAll(candidates)) {
      const item = scanFitItem({ suggested_name: adoptName ? candName : row.suggested_name, suggested_manufacturer: row.suggested_manufacturer, suggested_metadata: row.suggested_metadata, suggested_candidates: candidates });
      const byIdentity = routeByIdentity(candidates, menu, item, destinationTables(menu), keepsGiven);
      if (byIdentity) console.log(`[core-scan] ${opts.itemId}: routed to ${byIdentity.label}, the list for what it is`);
    }
    if (maker && !trackedStamp && onCatchAll(candidates)) {
      const holding = new Set<string>();
      await Promise.all(
        menu
          .filter((e) => !!e.instance)
          .map(async (e) => {
            const page = await platform()
              .entities.list(opts.orgId, e.kind, { filter: { manufacturer: maker }, limit: 3 })
              .catch(() => ({ items: [] as Array<{ fields: Record<string, unknown> }> }));
            // A resolver that ignored the filter returns other makers: only a
            // record that really carries this maker counts.
            if (page.items.some((r) => String(r.fields.manufacturer ?? "").trim().toLowerCase() === maker.toLowerCase())) holding.add(e.kind);
          }),
      );
      const byMaker = routeBySameMaker(candidates, menu, holding, keepsGiven);
      if (byMaker) console.log(`[core-scan] ${opts.itemId}: routed to ${byMaker.label}, where the workspace keeps ${maker}'s things`);
    }
    // The values a person or their agent gave follow this route, and who it
    // came from is read out of them into an empty seller, on a replay too, so
    // a row kept before the split heals when it is next looked at (#4591).
    const routedEntry = candidates[0] ? menu.find((e) => e.module === candidates[0]!.module && (e.instance ?? null) === (candidates[0]!.instance ?? null)) : undefined;
    const followed = userFieldsAfterMatch(
      row.suggested_metadata,
      routedEntry?.kind ?? (candidates[0]?.kind as string | undefined) ?? null,
      {
        name: [row.suggested_name, (row.suggested_metadata as { description?: string } | null)?.description].filter(Boolean).join(". ") || null,
        roles: new Map((routedEntry?.fields ?? []).filter((f) => f.field_role).map((f) => [f.name, f.field_role!] as [string, string])),
        // Only a row that holds values pays for its table's field list.
        fieldNames: routedEntry && userFieldsOf(row.suggested_metadata) ? new Set((await agentFieldsFor(opts.orgId, routedEntry.kind, routedEntry.fields)).map((f) => f.name)) : null,
      },
      (values, name, roles) => withSellersApart(values, name, roles) as typeof values,
    );

    // A fact about the model is the model's, not the one model call this row
    // got: its empty model fields fill from what the workspace already knows
    // about this model, what it teaches is kept, and the model's other
    // waiting rows get it too (model-facts.ts, #6013). A unit's own facts
    // (its seller, serial, price) never move.
    const modelFacts = await applyModelFacts(opts.orgId, dbAfter as never, {
      itemId: opts.itemId,
      name: adoptName ? candName : row.suggested_name,
      candidates: candidates as never,
      provenance: fieldProvenance as Record<string, unknown>,
      meta: row.suggested_metadata,
    }).catch((err) => {
      console.error(`[core-scan] ${opts.itemId}: model facts not applied:`, (err as Error).message);
      return null;
    });
    if (modelFacts?.filled.length || modelFacts?.spread) console.log(`[core-scan] ${opts.itemId}: model facts filled ${modelFacts.filled.join(", ") || "none"}; learned ${modelFacts.learned.join(", ") || "none"}, filled into ${modelFacts.spread} other row(s)`);

    // A row the lookup could not name stays nameless (adopt-name.ts, guard
    // 0): the route and the fields are stored, the invented name on each
    // candidate is not, and the router's confidence does not stand in for an
    // identification the row never got (#2918).
    const nameless = !row.suggested_name && !adoptName;
    await dbAfter
      .updateTable("core_scan_inbox_items")
      .set({
        // jsonb-replace-ok: candidates are a LIST wholly re-derived by this match; a merge would fuse two runs
        suggested_candidates: JSON.stringify(nameless ? candidatesForNamelessRow(candidates) : candidates) as never,
        ...(adoptName ? { suggested_name: candName } : {}),
        // jsonb-merge ONLY the keys this match sets onto the LIVE row value —
        // never a stale in-memory snapshot. Otherwise a concurrent write (the
        // detached matchmaker races apply-theme's pending_tags, or a user_hint /
        // series stamp) is silently clobbered. `||` overlays keys DB-side.
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
          // Always written (null included): a re-run after you deleted the
          // duplicate must CLEAR a stale match, not leave the card offering to
          // merge into something that's gone.
          tracked_match: trackedStamp,
          ...(photoObservations ? { photo_observations: photoObservations } : {}),
          ...(photoObservedFor ? { photo_observed_for: photoObservedFor } : {}),
          ...(photoPackaging ? { packaging: photoPackaging } : {}),
          // The multi-item signal, from the observation call we already paid for.
          // Only stamped when it's actually a group — a lone item writes nothing,
          // so the common case adds no bytes and the UI's check stays a truthy read.
          ...(photoDistinct && photoDistinct >= 2
            ? {
                photo_distinct: photoDistinct,
                photo_individuals: photoIndividuals ?? [],
              }
            : {}),
          // Reliability net: if identify didn't STRUCTURE a serial but the model
          // named one in its reasoning/observations, promote it to the native
          // key so it reaches the item's serial_number field on commit. Only
          // when not already set (never clobber a structured read).
          ...((() => {
            const existing = (row.suggested_metadata as { serial_number?: string } | null)?.serial_number;
            if (existing) return {};
            const s = extractSerial(
              [
                top && typeof top === "object" && "notes" in top ? (top as { notes?: string }).notes ?? "" : "",
                photoObservations ?? "",
                row.ai_notes ?? "",
              ].join("\n"),
            );
            return s ? { serial_number: s } : {};
          })()),
          matched_at: new Date().toISOString(),
          ...(splitReview ? { low_trust: true, split_review: splitReview } : {}),
          ...(disagreed.length ? { low_trust: true, split_disagreed: disagreed } : {}),
          ...(nameFacts.length ? { name_facts: nameFacts } : {}),
          ...(packAsks.length || (meta as { pack_asks?: unknown }).pack_asks ? { pack_asks: packAsks } : {}),
          // The whole map, re-derived: `||` replaces the key, which is what
          // lets a stamp for a field the route no longer fills go away.
          [FIELD_PROVENANCE_KEY]: fieldProvenance,
          ...(followed ? { user_fields: followed } : {}),
        })}::jsonb` as never,
        // The routing's sentence joins the lookup's verdict; it never replaces
        // it (routing-note.ts, cardNote). A store's own label, never looked
        // up, must not read "The AI errored on this one" (#2907).
        // The row's confidence is how sure the pipeline is of WHAT this is.
        // A model's route carries that; a heuristic route's score (0.3 for
        // the fallback table, up to 0.6 by keyword hits) says how sure the
        // code is of the TABLE, and stamping it here read every no-AI receipt
        // line as "identified at 38% confidence", flagged for review, so a
        // workspace with no AI could never file a receipt in bulk once the
        // flag gated the sweep (#2980). A heuristic route leaves the
        // confidence the lookup wrote, or none.
        ...(top && typeof top === "object" && "notes" in top && (top as { notes?: string }).notes && !barcodeIdentified
          ? {
              ai_notes: cardNote(lookupVerdictOf(row), [splitReviewWords(splitReview), siblingReviewWords(disagreed), nameFactWords(nameFacts), (top as { notes: string }).notes].filter(Boolean).join(" ")),
              ...(nameless || (top as { heuristic?: boolean }).heuristic ? {} : { ai_confidence: String((top as { confidence: number }).confidence) }),
            }
          : splitReview || disagreed.length || nameFacts.length
            ? { ai_notes: cardNote(lookupVerdictOf(row), [splitReviewWords(splitReview), siblingReviewWords(disagreed), nameFactWords(nameFacts)].filter(Boolean).join(" ")) }
            : {}),
        // Stamp the canonical "matchmaker has run" marker. Without it a note that
        // matched NOTHING (e.g. "3d printer" on a blank workspace) left the web's
        // "reading…" pulse spinning forever — the UI keys off ai_suggested_at to
        // know enrichment finished. Set once; a re-match keeps the original stamp.
        ...(row.ai_suggested_at ? {} : { ai_suggested_at: new Date() }),
        updated_at: new Date(),
      })
      .where("id", "=", opts.itemId)
      .execute();

    // A twin that persisted while this run was in flight is seen now: the
    // last of two concurrent runs always reads the other's answer, so one
    // picture can never leave two weights standing on one product name.
    // This row is re-read too: a twin's own run may have blanked it and
    // written split_disagreed here between the check above and the persist,
    // which the persist's candidate list just overwrote.
    if (meta.split_inherited) {
      const own = await dbAfter
        .selectFrom("core_scan_inbox_items")
        .select("suggested_metadata")
        .where("id", "=", opts.itemId)
        .executeTakeFirst();
      const ownMeta = { ...((own?.suggested_metadata ?? {}) as Record<string, unknown>) };
      const late = await reconcileSplitSiblings(dbAfter, opts.itemId, meta.split_inherited.from, row.suggested_name, ownMeta, candidates);
      const fresh = late.filter((k) => !disagreed.includes(k));
      if (fresh.length) {
        disagreed = late;
        await dbAfter
          .updateTable("core_scan_inbox_items")
          .set({
            // jsonb-replace-ok: the same list this run derived, minus the fields the twins disagree on
            suggested_candidates: JSON.stringify(candidates) as never,
            suggested_metadata: mergeMeta({ low_trust: true, split_disagreed: disagreed }) as never,
            ai_notes: sql`concat_ws(' ', ai_notes, ${siblingReviewWords(fresh)}::text)` as never,
            updated_at: new Date(),
          })
          .where("id", "=", opts.itemId)
          .execute();
      }
    }

    // "Where should this go?" — with the item identified + routed, suggest a
    // home from where its siblings already live. Only when the user hasn't
    // already set a location (a scan-session bin, or a note like "…in Bin 4").
    // Detached-safe: it's the last step and best-effort; a failure never affects
    // the match. Re-reads the row (adoptName above may have changed the name).
    try {
      if (!row.target_location_id) {
        const identified = adoptName ? candName : row.suggested_name;
        // The candidate's category is the table's OWN axis (food_category on
        // Groceries); meta.category is the vision pass's word and is null on a
        // receipt line. Reading only meta.category left the category-table
        // fallback dead on every receipt (2026-09-06).
        const suggestCategory =
          (candidates[0] as { category?: string } | undefined)?.category ?? meta.category ?? null;
        const sug = await suggestLocationForItem(opts.orgId, {
          name: identified,
          category: suggestCategory,
          excludeId: opts.itemId,
          // The item's OWN answer first, its category second. Groceries
          // declares a storage_requirement field the scan fills, and the
          // category table deliberately says nothing about "Fresh vegetables"
          // (potatoes do not want a fridge) - so reading only the table left
          // the suggestion silent on the very items whose own field said cold,
          // and the warning then fired on the placement it had declined to
          // suggest. One resolver now answers for both.
          // Where the rest of this kind lives, when routing has decided what
          // this is. A shop is thirty things never scanned before and one
          // obvious home; the per-name sibling signal cannot see that.
          kind: candidates[0]?.kind ?? null,
          // The collection's own name, from the workspace's menu for that kind.
          kindLabel: menu.find((e) => e.kind === candidates[0]?.kind)?.label ?? null,
          kindIsCollection: !!menu.find((e) => e.kind === candidates[0]?.kind)?.instance,
          requirement: resolveRequirement(
            (meta as { storage_requirement?: unknown }).storage_requirement ??
              (candidates[0]?.fields as Record<string, unknown> | undefined)?.storage_requirement,
            [suggestCategory, await tableCategoryWord(opts.orgId, candidates[0]?.kind ?? null, null, candidates[0]?.fields as Record<string, unknown> | undefined)],
            identified,
          ),
        });
        if (sug) {
          const dbSug = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
          // Guard the write: skip if the user set a location while we looked.
          await dbSug
            .updateTable("core_scan_inbox_items")
            .set({
              suggested_location_id: sug.location_id,
              suggested_location_note: `${sug.location_name} — ${sug.reason}`,
              suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ location_suggestion: { source: sug.source, reason: sug.reason } })}::jsonb` as never,
              updated_at: new Date(),
            })
            .where("id", "=", opts.itemId)
            .where("target_location_id", "is", null)
            .execute();
        }
      }
    } catch (e) {
      console.error(`[core-scan] location suggestion for ${opts.itemId} failed:`, (e as Error).message);
    }
    // When the matchmaker RENAMED the item (adoptName), the stage-1 cover was
    // fetched for the OLD name and would pop in a poll or two later — reading as
    // "still working" after the card looked settled. Re-fetch the cover for the
    // final name HERE so it lands inside the finalized window, not after it.
    // A receipt line fetches its picture HERE, not at insert: now the category
    // is known, the search can be told "fresh produce" and the ranking can
    // refuse a tin (see refreshCatalogImageByName). Not awaited - the match is
    // settled; the tile fills when the search does.
    // The row's plan says whether its picture waits for the match (a receipt
    // line, a typed phrase or identifier: the category sharpens the search);
    // a row admitted before the plan reads by its columns (services/intake.ts).
    const pictureNow = pictureSearchAfterMatch(rowShape(row)) && !row.catalog_image_file_id && !row.catalog_image_url;
    if (adoptName || pictureNow) {
      const nameForCover = adoptName ? candName : row.suggested_name ?? "";
      const category =
        (candidates[0] as { category?: string } | undefined)?.category ??
        ((candidates[0] as { fields?: Record<string, unknown> } | undefined)?.fields?.food_category as string | undefined) ??
        null;
      const soldBy = (meta as { receipt_vendor?: string } | null)?.receipt_vendor ?? null;
      const refresh = refreshCatalogImageByName(
        opts.orgId,
        opts.itemId,
        nameForCover,
        row.suggested_manufacturer ?? null,
        soldBy,
        category,
      ).catch((e) => console.error(`[core-scan] finalize image refresh for ${opts.itemId} failed:`, (e as Error).message));
      if (adoptName || opts.settle) await refresh;
    }
    // The scan's order line, now its name is known (#5734): filled when it
    // was scanned from the line, offered when it looks like one.
    await orderLinePass(db, opts.itemId, async (lineId, received) => {
      const line = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", lineId).executeTakeFirst();
      const lm = (line?.suggested_metadata ?? {}) as { receipt_order_id?: unknown; receipt_order_item_id?: unknown };
      if (typeof lm.receipt_order_id === "string" && typeof lm.receipt_order_item_id === "string") {
        await reportReceived({ baseUrl: opts.baseUrl, slug: opts.orgSlug, headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" }, orderId: lm.receipt_order_id, itemId: lm.receipt_order_item_id, received });
      }
    }).catch((e: Error) => console.warn(`[core-scan] order line for ${opts.itemId}:`, e.message));
    // The run has settled - record on ITS history entry whether a model
    // actually answered, so the timeline stops claiming an answer it never got.
    await stampScanHistoryOutcome(
      db,
      opts.itemId,
      !(top && typeof top === "object" && "heuristic" in top
        && (top as { heuristic?: boolean }).heuristic === true),
    );
    // Backfill a book's ISBN from Open Library when the match left it blank —
    // the ISBN isn't on the cover, so vision can't read it, but title+author can
    // look it up. Mutates `candidates` + rewrites, before finalize/reconcile.
    await backfillBookIsbn(
      opts.orgId,
      opts.itemId,
      candidates as MatchCandidate[],
      menu,
      row.suggested_manufacturer ?? null,
      decodedIsbnOf(row.suggested_metadata),
      photoReadOf(row)?.title ?? null,
    );
    // Stamp finalized_at — the canonical "nothing more will change" marker.
    // matched_at means the matchmaker RAN; finalized_at means the whole tail
    // (location + cover) is done too. The inbox UI keys its "finishing… → ready"
    // transition + the session "all set" signal off this, so a card stops
    // reading as settled while its title/genre/thumbnail are still mutating.
    try {
      const dbFin = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
      await dbFin
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_metadata:
            sql`coalesce(suggested_metadata, '{}'::jsonb) || jsonb_build_object('finalized_at', now()::text)` as never,
          updated_at: new Date(),
        })
        .where("id", "=", opts.itemId)
        .execute();
    } catch (e) {
      console.error(`[core-scan] finalize stamp for ${opts.itemId} failed:`, (e as Error).message);
    }
    // Normalise secondary routing across same-series siblings in this session so
    // the shelf routes uniformly (deterministic; #3 of the routing-consistency
    // work, on top of the tightened model prompt).
    await reconcileSeriesRouting(
      opts.orgId,
      row.scan_batch_id,
      (row.suggested_metadata as { series?: string } | null)?.series ?? null,
    );
    return candidates;
  } catch (err) {
    // The match FAILED before stamping matched_at — the menu fetch, the model
    // call, or (classically) a write on the now-stale tenant pool after the
    // model ran for minutes. Without a matched_at stamp the card spins on
    // "finding the best table…" FOREVER (serverMatching keys off its absence),
    // with no give-up. Best-effort: stamp matched_at (+ a match_failed marker) so
    // the UI stops spinning and shows the resolved name; the user can re-run or
    // route by hand. Re-acquire the pool; swallow a second failure quietly.
    console.error(`[core-scan] matchItem ${opts.itemId} failed:`, (err as Error).message);
    try {
      const dbErr = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
      await dbErr
        .updateTable("core_scan_inbox_items")
        .set({
          // finalized_at too: a failed match is still DONE churning — the UI must
          // settle it (needs manual routing), not park it in "finishing…" forever.
          suggested_metadata:
            sql`coalesce(suggested_metadata, '{}'::jsonb) || jsonb_build_object('matched_at', now()::text, 'match_failed', true, 'finalized_at', now()::text)` as never,
          ai_suggested_at: sql`coalesce(ai_suggested_at, now())` as never,
          updated_at: new Date(),
        })
        .where("id", "=", opts.itemId)
        .execute();
    } catch (e2) {
      console.error(`[core-scan] matchItem ${opts.itemId} fail-stamp also failed:`, (e2 as Error).message);
    }
    return null;
  }
}

/** Intake auto-match: wait (detached) for enrichment to land — the barcode
 *  race may overrun its budget, and photo items identify via the wire —
 *  then match once. Looks at once, then on enrichmentPollDelays, for about
 *  2 min; gives up silently. */
export function autoMatchWhenEnriched(opts: Omit<MatchItemOpts, "force">): void {
  void (async () => {
    try {
      // At once, then close together, then the old 3 s pace (match-poll.ts).
      for (const wait of enrichmentPollDelays()) {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const db = (await platform().tenants.getDb(opts.orgId)) as unknown as ReturnType<typeof tenantDb>;
        const row = await db
          .selectFrom("core_scan_inbox_items")
          .select(["suggested_name", "ai_suggested_at", "status", "suggested_metadata"])
          .where("id", "=", opts.itemId)
          .executeTakeFirst();
        if (!row || row.status !== "pending") return; // gone / triaged already
        const meta = (row.suggested_metadata ?? {}) as { matched_at?: string };
        if (meta.matched_at) return; // someone matched it (rerun, explicit)
        if (row.suggested_name || row.ai_suggested_at) {
          await matchItem({ ...opts, force: false });
          return;
        }
      }
    } catch (err) {
      console.error("[core-scan] intake auto-match failed:", (err as Error).message);
    }
  })();
}
