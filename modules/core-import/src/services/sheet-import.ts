// Carry out a spreadsheet plan, and take it back.
//
// An import happens in two halves. The structural half runs in the request,
// with the person's own session, because installing a collection, adding a
// field or a collection are admin acts the platform checks against a person:
// install, collection, fields, places. The records half runs in the
// background, through the platform's in-process writers, so a long sheet does
// not hold a request open and the job needs no session at all.
//
// Every change is a step in core_import_run_steps as it is made: what was
// created, a record's whole row before it was changed, and a fingerprint of
// what the import left. Undo walks the steps backwards. It takes away what
// the import created and puts back what it changed, exactly (a restore, id
// and all, never a lookalike), and it stops at anything a person has changed
// since: that is theirs now, and the undo says so and asks, instead of
// quietly taking their edit away with the import. Asked again with `force`,
// it goes through with those too.

import { createHash } from "node:crypto";
import { sql } from "kysely";
import { fieldTypeTakesUnit, platform, SYSTEM_VIEWER } from "@cobblr/platform-contract";
import { splitEntityKind } from "@cobblr/platform-contract/entity-kind";
import { isStockPreviewUrl } from "@cobblr/platform-contract/stock-preview";
import type { CoreImportDB, ImportDb } from "../db.js";
import type { SheetPlan, RecordPlan, SummaryCheck } from "./sheet-plan.js";
import { pathKey } from "./sheet-plan.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";

export const SHEET_IMPORT_QUEUE = "core-import.sheet";
const LOCATION_KIND = "core-locations:location";
const PROGRESS_EVERY = 20;

// ─── what a run carries ──────────────────────────────────────────────────────

export interface WorkSheet {
  sheet: string;
  label: string;
  kind: string;
  /** Records land in this instance (a collection that is not the module's default). */
  instance: string | null;
  /** Fields that are columns on the module's own table, not custom fields. */
  native: string[];
  /** Every place path the sheet names, by pathKey, to its location id. */
  places: Record<string, string>;
  records: RecordPlan[];
  /** The sheet's own totals, checked in the dry run, kept with the import. */
  checks?: SummaryCheck[];
}

export interface RunWork {
  /** The workspace's slug, for the address a stored picture is shown at. */
  slug: string;
  sheets: WorkSheet[];
}

export interface SheetSummary {
  sheet: string;
  label: string;
  kind: string;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Things imported as no longer the person's (sold, given away, …). */
  retired?: number;
  checks?: SummaryCheck[];
  /** The first fifty, as sentences, for a reader that predates `issues`. */
  problems: string[];
  /** Every row that did not go in exactly as written, and why: a value that
   *  did not fit its field (kept as written), a picture left out, a row that
   *  could not be written. Complete up to ISSUE_LIMIT; `issue_count` is the
   *  true total. The result screen lists them and offers them as a file. */
  issues?: ImportIssue[];
  issue_count?: number;
}

export interface ImportIssue {
  row: number;
  name: string;
  problem: string;
}

const ISSUE_LIMIT = 10_000;

/** Record one row's problem, in full and in the old fifty-line list. */
function note(sum: SheetSummary, row: number, name: string, problem: string): void {
  sum.issue_count = (sum.issue_count ?? 0) + 1;
  if ((sum.issues ??= []).length < ISSUE_LIMIT) sum.issues.push({ row, name, problem });
  if (sum.problems.length < 50) sum.problems.push(`Row ${row} (${name}): ${problem}`);
}

export interface StepRow {
  seq: number;
  kind: "module" | "install" | "collection" | "field" | "location" | "category" | "record-create" | "record-update" | "tag" | "photo";
  entity_kind?: string | null;
  entity_id?: string | null;
  label?: string | null;
  before?: unknown;
  after_hash?: string | null;
  detail?: Record<string, unknown>;
}

// ─── fingerprints ────────────────────────────────────────────────────────────

/** Keys a write changes on its own (a timestamp), which say nothing about
 *  whether a person has been at the record since. */
const VOLATILE = new Set(["updated_at", "last_seen_at", "search_vector"]);

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .filter((k) => !VOLATILE.has(k))
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function stateHash(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  return createHash("sha256").update(JSON.stringify(stable(row))).digest("hex").slice(0, 32);
}

// ─── the steps ledger ────────────────────────────────────────────────────────

async function recordStep(db: ImportDb, runId: string, step: StepRow): Promise<void> {
  await db
    .insertInto("core_import_run_steps")
    .values({
      run_id: runId,
      seq: step.seq,
      kind: step.kind,
      entity_kind: step.entity_kind ?? null,
      entity_id: step.entity_id ?? null,
      label: step.label ?? null,
      before: step.before === undefined ? null : (JSON.stringify(step.before) as never),
      after_hash: step.after_hash ?? null,
      detail: JSON.stringify(step.detail ?? {}) as never,
    })
    .execute();
}

export class Ledger {
  private seq = 0;
  constructor(
    private db: ImportDb,
    public runId: string,
    start = 0,
  ) {
    this.seq = start;
  }
  async add(step: Omit<StepRow, "seq">): Promise<void> {
    this.seq += 1;
    await recordStep(this.db, this.runId, { ...step, seq: this.seq });
  }
  get last(): number {
    return this.seq;
  }
}

// ─── the structural half: runs in the request ────────────────────────────────

export interface Loopback {
  base: string;
  slug: string;
  token: string;
}

async function call<T>(lb: Loopback, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await apiFetch(`${lb.base}/api/v1/orgs/${lb.slug}${path}`, {
    method,
    headers: { Authorization: `Bearer ${lb.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // import-swallow-ok: an empty or non-JSON body is a normal answer (a 204);
  // the STATUS is what every caller branches on.
  const json = (await res.json().catch(() => null)) as T;
  return { status: res.status, json };
}

async function listPlaces(lb: Loopback): Promise<Array<{ id: string; name: string; parent_id: string | null }>> {
  const r = await call<{ items?: Array<{ id: string; name: string; parent_id: string | null }> }>(lb, "GET", "/modules/core-locations/locations");
  return r.json?.items ?? [];
}

export class ImportRefused extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Install, make collections, add fields and places; everything the records
 *  need to land. Returns the work the background half carries out. */
export async function prepareRun(
  ledger: Ledger,
  lb: Loopback,
  plans: SheetPlan[],
  knownPlaces: Array<{ id: string; name: string; parent_id: string | null }>,
  placePaths: Map<string, string>,
): Promise<RunWork> {
  const work: RunWork = { slug: lb.slug, sheets: [] };
  const places = new Map(placePaths);
  for (const plan of plans) {
    const t = plan.target;
    if (plan.enable) {
      const r = await call<{ already_enabled?: boolean; error?: { message?: string } }>(lb, "POST", `/modules/${encodeURIComponent(plan.enable.module)}/enable`, {});
      if (r.status >= 300) throw new ImportRefused("enable_failed", `Could not turn on ${plan.enable.label}: ${r.json?.error?.message ?? `status ${r.status}`}`);
      if (!r.json?.already_enabled) await ledger.add({ kind: "module", entity_id: plan.enable.module, label: plan.enable.label });
    }
    if (plan.install) {
      const r = await call<{ bundle?: { id: string }; applied?: { instances_created?: string[] }; error?: { message?: string } }>(
        lb,
        "POST",
        "/bundles/install",
        { id: plan.install.bundle_external_id, confirm: true },
      );
      if (r.status >= 300 || !r.json?.bundle?.id) {
        throw new ImportRefused("install_failed", `Could not install ${plan.install.label}: ${r.json?.error?.message ?? `status ${r.status}`}`);
      }
      // An install does more than add a collection: it can switch on the
      // modules it needs and set up places. The install itself claims them
      // (bundle resource claims), and uninstalling it puts back whatever
      // nobody has used since, so the ledger needs the install alone.
      await ledger.add({ kind: "install", entity_id: r.json.bundle.id, label: plan.install.label, detail: { instances_created: r.json.applied?.instances_created ?? [] } });
      // The places it set up are where a row naming them lands ("Kitchen /
      // Fridge"), rather than a second Fridge made beside the first.
      const after = await listPlaces(lb);
      const byId = new Map(after.map((l) => [l.id, l]));
      const pathOf = (l: { id: string; name: string; parent_id: string | null }): string[] => {
        const segs: string[] = [];
        let cur: typeof l | undefined = l;
        const guard = new Set<string>();
        while (cur && !guard.has(cur.id)) {
          guard.add(cur.id);
          segs.unshift(cur.name);
          cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        }
        return segs;
      };
      const known = new Set(knownPlaces.map((l) => l.id));
      for (const l of after) {
        if (known.has(l.id)) continue;
        places.set(pathKey(pathOf(l)), l.id);
        knownPlaces.push(l);
      }
    }
    if (plan.new_collection) {
      const r = await call<{ error?: { message?: string } }>(lb, "POST", "/instances", {
        module_name: plan.new_collection.module,
        instance_name: plan.new_collection.instance,
        display_name: plan.new_collection.label,
      });
      if (r.status >= 300) throw new ImportRefused("collection_failed", `Could not make ${plan.new_collection.label}: ${r.json?.error?.message ?? `status ${r.status}`}`);
      await ledger.add({ kind: "collection", entity_id: plan.new_collection.instance, label: plan.new_collection.label });
    }
    for (const f of plan.fields_to_create) {
      const r = await call<{ id?: string; error?: { code?: string; message?: string } }>(lb, "POST", "/field-defs", {
        entity_kind: t.kind,
        name: f.field,
        display_label: f.label,
        type: f.type,
        ...(f.choices?.length ? { choices: f.choices } : {}),
        ...(f.unit && fieldTypeTakesUnit(f.type) ? { unit: f.unit } : {}),
        ...(f.field_role ? { field_role: f.field_role } : {}),
      });
      // Already there (a bundle brought it a moment ago, or a second sheet
      // asked for the same field): nothing was made, so nothing to undo.
      if (r.status === 409) continue;
      if (r.status >= 300 || !r.json?.id) throw new ImportRefused("field_failed", `Could not add the field ${f.label}: ${r.json?.error?.message ?? `status ${r.status}`}`);
      await ledger.add({ kind: "field", entity_id: r.json.id, entity_kind: t.kind, label: f.label, detail: { name: f.field } });
    }
    // A place the sheet names by itself ("Fridge") that an install has just
    // set up somewhere ("Kitchen / Fridge") is that place, not a second one.
    const leafNow = new Map<string, string | null>();
    for (const l of knownPlaces) leafNow.set(l.name.toLowerCase(), leafNow.has(l.name.toLowerCase()) ? null : l.id);
    for (const path of plan.locations_to_create) {
      const key = pathKey(path);
      if (places.has(key)) continue;
      const leaf = path.length === 1 ? leafNow.get(path[0]!.toLowerCase()) : undefined;
      if (leaf) {
        places.set(key, leaf);
        continue;
      }
      const parent = path.length > 1 ? (places.get(pathKey(path.slice(0, -1))) ?? null) : null;
      const r = await call<{ id?: string; error?: { code?: string; details?: { existing_id?: string }; message?: string } }>(lb, "POST", "/modules/core-locations/locations", {
        name: path[path.length - 1],
        parent_id: parent,
      });
      if (r.status === 409 && r.json?.error?.details?.existing_id) {
        places.set(key, r.json.error.details.existing_id);
        continue;
      }
      if (r.status >= 300 || !r.json?.id) throw new ImportRefused("place_failed", `Could not add the place ${path.join(" / ")}: ${r.json?.error?.message ?? `status ${r.status}`}`);
      places.set(key, r.json.id);
      await ledger.add({ kind: "location", entity_kind: LOCATION_KIND, entity_id: r.json.id, label: path.join(" / ") });
    }
    // A single-name place written without its parents ("Pegboard") is that
    // place wherever it sits, when the name is unique in the workspace.
    const leafIds = new Map<string, string | null>();
    for (const l of knownPlaces) leafIds.set(l.name.toLowerCase(), leafIds.has(l.name.toLowerCase()) ? null : l.id);
    const sheetPlaces: Record<string, string> = {};
    for (const rec of plan.records) {
      if (!rec.location_path) continue;
      const key = pathKey(rec.location_path);
      const id = places.get(key) ?? (rec.location_path.length === 1 ? leafIds.get(rec.location_path[0]!.toLowerCase()) : undefined);
      if (id) sheetPlaces[key] = id;
    }
    work.sheets.push({
      sheet: plan.sheet,
      label: t.label,
      kind: t.kind,
      // A collection's own kind (<instance>:item) says which instance; the
      // module's default table takes none.
      instance: t.kind.endsWith(":item") ? t.instance : null,
      // Every column of the module's own table, not only those a sheet
      // column chose: a count made from identical rows lands in one too.
      native: t.fields.filter((f) => f.native).map((f) => f.name),
      places: sheetPlaces,
      records: plan.records.filter((r) => r.action !== "unchanged"),
      ...(plan.summary.length ? { checks: plan.summary } : {}),
    });
  }
  return work;
}

// ─── the records half: runs in the background ────────────────────────────────

function recordFields(rec: RecordPlan, ws: WorkSheet): { top: Record<string, unknown>; metadata: Record<string, unknown> } {
  const native = new Set(ws.native);
  const top: Record<string, unknown> = { name: rec.name };
  const metadata: Record<string, unknown> = {};
  if (ws.instance) top.instance = ws.instance;
  if (rec.qty != null) top.qty = rec.qty;
  if (rec.unit) top.unit = rec.unit;
  for (const [k, v] of Object.entries(rec.fields)) {
    if (native.has(k)) top[k] = v;
    else metadata[k] = v;
  }
  return { top, metadata };
}

async function placeRecord(orgId: string, baseKind: string, id: string, locationId: string | undefined): Promise<void> {
  if (!locationId) return;
  await platform().placement.place({ orgId, containee: { kind: baseKind, id }, container: { kind: LOCATION_KIND, id: locationId } });
}

const PICTURE_MAX_BYTES = 8 * 1024 * 1024;
const PICTURE_TIMEOUT_MS = 15_000;

/** A picture from a row's image column, stored in the workspace's files, or
 *  why not. The address is one a person typed into their sheet, so it goes
 *  through the workspace's egress guard like any address a person gives; a
 *  stock agency's watermarked preview is refused before it is fetched (#3804). */
export async function storeRowPicture(orgId: string, url: string): Promise<{ fileId: string; existed: boolean } | { refused: string }> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { refused: "not a web address" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { refused: "not a web address" };
  if (isStockPreviewUrl(u.href)) return { refused: "a watermarked stock preview, never used as a picture" };
  let res: Response;
  try {
    res = await platform().egress.guardedFetch(orgId, u.href, { signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS) });
  } catch (err) {
    return { refused: `could not be fetched (${(err as Error).message})` };
  }
  if (!res.ok) return { refused: `the address answered ${res.status}` };
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("image/")) return { refused: "the address is not a picture" };
  if (Number(res.headers.get("content-length") ?? 0) > PICTURE_MAX_BYTES) return { refused: "the picture is over 8 MB" };
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > PICTURE_MAX_BYTES) return { refused: "the picture is over 8 MB" };
  if (buf.byteLength === 0) return { refused: "the picture is empty" };
  const name = decodeURIComponent(u.pathname.split("/").pop() || "picture");
  const w = await platform().files.write(orgId, buf, { filename: name, mimeType: type });
  if (!w) return { refused: "there is nowhere to store pictures" };
  return { fileId: w.fileId, existed: !!w.existed };
}

async function setProgress(db: ImportDb, runId: string, done: number): Promise<void> {
  await db.updateTable("core_import_runs").set({ progress_done: done }).where("id", "=", runId).execute();
}

export async function runImport(orgId: string, runId: string): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as ImportDb;
  const run = await db.selectFrom("core_import_runs").selectAll().where("id", "=", runId).executeTakeFirst();
  if (!run || run.status !== "queued") return;
  await db.updateTable("core_import_runs").set({ status: "running" }).where("id", "=", runId).execute();
  const work = (typeof run.work === "string" ? JSON.parse(run.work) : run.work) as RunWork;
  const lastSeq = await db
    .selectFrom("core_import_run_steps")
    .select((eb) => eb.fn.max("seq").as("seq"))
    .where("run_id", "=", runId)
    .executeTakeFirst();
  const ledger = new Ledger(db, runId, Number(lastSeq?.seq ?? 0));
  const summaries: SheetSummary[] = [];
  let done = 0;
  const grownCategories = new Set<string>();

  try {
    for (const ws of work.sheets) {
      const sum: SheetSummary = { sheet: ws.sheet, label: ws.label, kind: ws.kind, created: 0, updated: 0, unchanged: 0, failed: 0, retired: 0, ...(ws.checks ? { checks: ws.checks } : {}), problems: [], issues: [], issue_count: 0 };
      summaries.push(sum);
      const writer = await platform().entities.getWriter(orgId, ws.kind);
      if (!writer) {
        sum.failed = ws.records.length;
        sum.problems.push(`Nothing can write into ${ws.label}.`);
        continue;
      }
      const baseKind = await platform().entities.baseKindOf(orgId, ws.kind);
      const axis = await platform().categoryAxis.for({ orgId, kind: ws.kind, instance: ws.instance });
      const knownValues = new Set((axis?.values ?? []).map((v) => v.toLowerCase()));

      for (const rec of ws.records) {
        // What the dry run found about this row's values (a date that is not a
        // date, a count that is not a number) goes in as written; said here too,
        // so the result names every one, not only the plan the person closed.
        for (const p of rec.problems ?? []) note(sum, rec.row, rec.name, p);
        try {
          const { top, metadata } = recordFields(rec, ws);
          if (rec.category) {
            const assignment = await platform().categoryAxis.commit({ orgId, kind: ws.kind, value: rec.category, instance: ws.instance });
            if (!assignment) {
              // The collection had nowhere to file it after all. The value is
              // kept on the record, and said, never dropped.
              metadata.category = rec.category;
              note(sum, rec.row, rec.name, `kept "${rec.category}" as text, ${ws.label} has no category list`);
            } else {
              if (assignment.slot.kind === "extras") metadata[assignment.slot.name] = assignment.value;
              else top[assignment.slot.column] = assignment.value;
              const key = `${ws.kind}|${rec.category.toLowerCase()}`;
              if (!knownValues.has(rec.category.toLowerCase()) && !grownCategories.has(key)) {
                grownCategories.add(key);
                await ledger.add({ kind: "category", entity_kind: ws.kind, label: rec.category, detail: { instance: ws.instance } });
              }
            }
          }
          const locationId = rec.location_path ? ws.places[pathKey(rec.location_path)] : undefined;

          // The picture is stored before the record is written, so the record
          // arrives with it (and is not queued for a picture search it does
          // not need). A picture a person set is never replaced: an update
          // fills an empty picture only.
          let picture: { fileId: string; existed: boolean } | null = null;
          const wantsPicture =
            !!rec.photo_url &&
            (rec.action === "create" ||
              (rec.action === "update" && rec.existing_id && !(await platform().entities.snapshot(orgId, ws.kind, rec.existing_id))?.image_path));
          if (wantsPicture && rec.photo_url) {
            const got = await storeRowPicture(orgId, rec.photo_url);
            if ("refused" in got) {
              note(sum, rec.row, rec.name, `the picture was left out, ${got.refused}`);
            } else {
              picture = got;
              top.image_path = `/api/v1/orgs/${work.slug}/modules/core-files/files/${got.fileId}/raw`;
            }
          }
          const attachPicture = async (id: string) => {
            if (!picture) return;
            const { module, type } = splitEntityKind(baseKind);
            const a = await platform().files.attach(orgId, { fileId: picture.fileId, source_module: module, source_type: type, source_id: id, role: "gallery" });
            if (a && !a.existed) await ledger.add({ kind: "photo", entity_kind: baseKind, entity_id: a.attachmentId, label: rec.name, detail: { file_id: picture.fileId, file_existed: picture.existed, record_id: id } });
          };

          // Gone from the collection (sold, given away, …): marked the way the
          // collection means "out of use", and the Fate's words stay on it.
          const retire = async (id: string) => {
            if (!rec.disposition) return;
            if (!writer.retire) {
              note(sum, rec.row, rec.name, `${ws.label} cannot mark things as no longer yours, so "${rec.disposition.text}" is kept as written`);
              return;
            }
            await writer.retire(orgId, id, { disposition: rec.disposition.kind });
            sum.retired = (sum.retired ?? 0) + 1;
          };

          if (rec.action === "create") {
            const id = await writer.create(orgId, { ...top, metadata });
            await retire(id);
            await attachPicture(id);
            await placeRecord(orgId, baseKind, id, locationId);
            for (const t of rec.tags ?? []) {
              const r = await platform().tags.attach({ orgId, tagName: t, target: { kind: baseKind, id } });
              await ledger.add({ kind: "tag", entity_kind: baseKind, entity_id: id, label: t, detail: { assigned: r.created, tag_created: r.tagCreated ?? false } });
            }
            const after = await platform().entities.snapshot(orgId, ws.kind, id);
            // After its tags, so an undo (newest first) reaches the record
            // first and knows whether it is kept before touching its tags.
            await ledger.add({ kind: "record-create", entity_kind: ws.kind, entity_id: id, label: rec.name, after_hash: stateHash(after) });
            sum.created++;
          } else if (rec.action === "update" && rec.existing_id) {
            const id = rec.existing_id;
            const before = await platform().entities.snapshot(orgId, ws.kind, id);
            if (!before) throw new Error("the record is gone");
            // The writer replaces the metadata bag, so what the row holds now
            // is carried forward under what the sheet says.
            const held = (before.metadata && typeof before.metadata === "object" ? before.metadata : {}) as Record<string, unknown>;
            await writer.update(orgId, id, { ...top, metadata: { ...held, ...metadata } });
            await retire(id);
            await attachPicture(id);
            if (locationId) await placeRecord(orgId, baseKind, id, locationId);
            for (const t of rec.tags ?? []) {
              const r = await platform().tags.attach({ orgId, tagName: t, target: { kind: baseKind, id } });
              await ledger.add({ kind: "tag", entity_kind: baseKind, entity_id: id, label: t, detail: { assigned: r.created, tag_created: r.tagCreated ?? false } });
            }
            const after = await platform().entities.snapshot(orgId, ws.kind, id);
            await ledger.add({ kind: "record-update", entity_kind: ws.kind, entity_id: id, label: rec.name, before, after_hash: stateHash(after) });
            sum.updated++;
          }
        } catch (err) {
          sum.failed++;
          note(sum, rec.row, rec.name, `not written: ${(err as Error).message}`);
        }
        done++;
        if (done % PROGRESS_EVERY === 0) await setProgress(db, runId, done);
      }
    }
    await db
      .updateTable("core_import_runs")
      .set({
        status: "done",
        progress_done: done,
        finished_at: new Date(),
        // jsonb-replace-ok: a run's summary and work have one writer, this job
        summary: sql`${JSON.stringify({ sheets: summaries })}::jsonb`,
        work: sql`'{}'::jsonb`, // jsonb-replace-ok: the run is finished, its plan is no longer needed
      } as never)
      .where("id", "=", runId)
      .execute();
    // One line in the workspace's activity for the whole run: where it lands,
    // and the door back to the run (its undo) from the activity feed.
    await platform()
      .activity.log({
        orgId,
        userId: run.created_by_user_id,
        action: "sheet_imported",
        ref: { module: "core-import", entityType: "import_run", entityId: runId },
        diff: { title: run.filename ?? "a spreadsheet", filename: run.filename, sheets: summaries.map((x) => ({ sheet: x.sheet, label: x.label, created: x.created, updated: x.updated, failed: x.failed })) },
      })
      // import-swallow-ok: the activity line is a courtesy; the run's own row is the record of what happened
      .catch(() => undefined);
  } catch (err) {
    await db
      .updateTable("core_import_runs")
      .set({
        status: "failed",
        error: (err as Error).message,
        progress_done: done,
        finished_at: new Date(),
        summary: sql`${JSON.stringify({ sheets: summaries })}::jsonb`, // jsonb-replace-ok: this row has one writer
      } as never)
      .where("id", "=", runId)
      .execute();
  }
}

export function registerSheetImportWorker(): void {
  platform().queue.registerWorker(SHEET_IMPORT_QUEUE, async (job) => {
    const runId = (job.payload as { runId?: string } | null)?.runId;
    if (!runId) return;
    await runImport(job.orgId, runId);
  });
}

// ─── undo ────────────────────────────────────────────────────────────────────

export interface HeldStep {
  kind: string;
  label: string;
  why: string;
}

export interface UndoReport {
  undone: number;
  held: HeldStep[];
  status: "undone" | "partly-undone";
}

export async function undoRun(orgId: string, db: ImportDb, lb: Loopback, runId: string, force: boolean): Promise<UndoReport> {
  const steps = await db
    .selectFrom("core_import_run_steps")
    .selectAll()
    .where("run_id", "=", runId)
    .where("undone_at", "is", null)
    .orderBy("seq", "desc")
    .execute();
  const held: HeldStep[] = [];
  let undone = 0;
  const done = async (id: string) => {
    undone++;
    await db.updateTable("core_import_run_steps").set({ undone_at: new Date() }).where("id", "=", id).execute();
  };
  const hold = (s: { kind: string; label: string | null }, why: string) => held.push({ kind: s.kind, label: s.label ?? "", why });
  // A record kept because somebody changed it keeps what hangs off it too.
  const keptRecords = new Set<string>();
  const modules: typeof steps = [];

  for (const s of steps) {
    try {
      switch (s.kind) {
        case "tag": {
          if (keptRecords.has(s.entity_id ?? "")) {
            hold(s, "kept with its record");
            break;
          }
          const detail = (typeof s.detail === "string" ? JSON.parse(s.detail) : s.detail) as { assigned?: boolean; tag_created?: boolean };
          // Only what the import did: an assignment that was already there
          // stays, and a tag goes only if the import made it and nothing
          // else carries it now.
          if (detail?.assigned !== false) await platform().tags.detach({ orgId, tagName: s.label ?? "", target: { kind: s.entity_kind ?? "", id: s.entity_id ?? "" } });
          if (detail?.tag_created) await platform().tags.withdraw({ orgId, tagName: s.label ?? "" });
          await done(s.id);
          break;
        }
        case "photo": {
          const detail = (typeof s.detail === "string" ? JSON.parse(s.detail) : s.detail) as { file_id?: string; file_existed?: boolean; record_id?: string };
          if (keptRecords.has(detail?.record_id ?? "")) {
            hold(s, "kept with its record");
            break;
          }
          await platform().files.detach(orgId, s.entity_id ?? "");
          // The file goes only if this import stored it and nothing else
          // shows it now.
          if (detail?.file_id && !detail.file_existed) {
            const still = (await platform().files.attachmentsOfFile(orgId, detail.file_id)) ?? [];
            if (!still.length) {
              const r = await call(lb, "DELETE", `/modules/core-files/files/${detail.file_id}`);
              if (r.status >= 300 && r.status !== 404) {
                hold(s, `the picture could not be removed (${r.status})`);
                break;
              }
            }
          }
          await done(s.id);
          break;
        }
        case "record-create": {
          const kind = s.entity_kind ?? "";
          const id = s.entity_id ?? "";
          const now = await platform().entities.snapshot(orgId, kind, id);
          if (!now) {
            await done(s.id);
            break;
          }
          if (!force && stateHash(now) !== s.after_hash) {
            keptRecords.add(id);
            hold(s, "changed since the import");
            break;
          }
          const writer = await platform().entities.getWriter(orgId, kind);
          if (!writer) {
            hold(s, "nothing can remove it");
            break;
          }
          const baseKind = await platform().entities.baseKindOf(orgId, kind);
          await platform().placement.remove({ orgId, containee: { kind: baseKind, id } });
          await writer.delete(orgId, id);
          await done(s.id);
          break;
        }
        case "record-update": {
          const kind = s.entity_kind ?? "";
          const id = s.entity_id ?? "";
          const now = await platform().entities.snapshot(orgId, kind, id);
          if (!now) {
            hold(s, "deleted since the import");
            break;
          }
          if (!force && stateHash(now) !== s.after_hash) {
            keptRecords.add(id);
            hold(s, "changed since the import");
            break;
          }
          const before = (typeof s.before === "string" ? JSON.parse(s.before) : s.before) as Record<string, unknown>;
          // Where it was kept is placement's (a pairing that mirrors into the
          // row), so it goes back first; then the row, exactly as it was.
          const baseKind = await platform().entities.baseKindOf(orgId, kind);
          const wasIn = typeof before.location_id === "string" ? before.location_id : null;
          if (wasIn) await platform().placement.place({ orgId, containee: { kind: baseKind, id }, container: { kind: LOCATION_KIND, id: wasIn } });
          else await platform().placement.remove({ orgId, containee: { kind: baseKind, id } });
          if (!(await platform().entities.restore(orgId, kind, before))) {
            hold(s, "its collection cannot put a row back");
            break;
          }
          await done(s.id);
          break;
        }
        case "category": {
          const detail = (typeof s.detail === "string" ? JSON.parse(s.detail) : s.detail) as { instance?: string | null };
          const r = await platform().categoryAxis.withdraw({ orgId, kind: s.entity_kind ?? "", value: s.label ?? "", instance: detail?.instance ?? null });
          if (r === "in-use") hold(s, "things are filed under it");
          else await done(s.id);
          break;
        }
        case "location": {
          const id = s.entity_id ?? "";
          const inside = await platform().placement.contents({ orgId, container: { kind: LOCATION_KIND, id } });
          const under = (await platform().entities.dependents(orgId, LOCATION_KIND, id)) ?? [];
          if (inside.length || under.length) {
            hold(s, "things are kept there now");
            break;
          }
          const writer = await platform().entities.getWriter(orgId, LOCATION_KIND);
          if (!writer) {
            hold(s, "nothing can remove it");
            break;
          }
          await writer.delete(orgId, id);
          await done(s.id);
          break;
        }
        case "field": {
          const detail = (typeof s.detail === "string" ? JSON.parse(s.detail) : s.detail) as { name?: string };
          const name = detail?.name ?? "";
          if (!force && name) {
            // SYSTEM-READ: an undo deciding whether a field still holds values
            // must see every value, a field hidden from some members included.
            const rows = await platform().entities.listAll(orgId, s.entity_kind ?? "", { include_retired: true }, SYSTEM_VIEWER, { cap: 5000 });
            const used = rows.items.some((r) => {
              const f = (r as { fields?: Record<string, unknown> }).fields ?? {};
              const meta = (f.metadata ?? {}) as Record<string, unknown>;
              return meta[name] != null && meta[name] !== "";
            });
            if (used) {
              hold(s, "records hold values in it");
              break;
            }
          }
          const r = await call(lb, "DELETE", `/field-defs/${s.entity_id}`);
          if (r.status >= 300 && r.status !== 404) {
            hold(s, `could not remove it (${r.status})`);
            break;
          }
          await done(s.id);
          break;
        }
        case "collection": {
          const list = await call<{ items: Array<{ instance_name: string; item_count?: number | null }> }>(lb, "GET", "/instances");
          const inst = list.json?.items?.find((i) => i.instance_name === s.entity_id);
          if (!inst) {
            await done(s.id);
            break;
          }
          if ((inst.item_count ?? 0) > 0) {
            hold(s, "it holds things now");
            break;
          }
          const r = await call(lb, "DELETE", `/instances/${encodeURIComponent(s.entity_id ?? "")}`);
          if (r.status >= 300 && r.status !== 404) {
            hold(s, `could not remove it (${r.status})`);
            break;
          }
          await done(s.id);
          break;
        }
        case "module":
          // Turned off after everything else, in rounds: a module another one
          // still needs refuses until that one is off.
          modules.push(s);
          break;
        case "install": {
          const preview = await call<{ instances?: Array<{ item_count?: number | null }>; kept?: Array<{ name: string; reason: string }> }>(lb, "GET", `/bundles/${s.entity_id}/uninstall-preview`);
          if (preview.status === 404) {
            await done(s.id);
            break;
          }
          if ((preview.json?.instances ?? []).some((i) => (i.item_count ?? 0) > 0)) {
            hold(s, "it holds things now");
            break;
          }
          // What the install switched on or set up and somebody has used
          // since (things kept in its Kitchen, a list in its Lists) stays
          // when it is uninstalled; that is a later edit like any other, so
          // it is said and waits for the person to say take it anyway.
          if (!force && (preview.json?.kept ?? []).length) {
            hold(s, (preview.json?.kept ?? []).map((k) => `${k.name}: ${k.reason}`).join("; "));
            break;
          }
          // Empty, so its collection goes with it: the workspace as it was
          // before the install, not an install with nothing in it. The
          // uninstall also switches off the modules it switched on and
          // removes the empty places it made. An import recorded before the
          // install claimed those has its own steps for them too; they find
          // the work done (a place already gone, a module already off).
          const r = await call(lb, "DELETE", `/bundles/${s.entity_id}?delete_data=1`);
          if (r.status >= 300 && r.status !== 404) {
            hold(s, `could not remove it (${r.status})`);
            break;
          }
          await done(s.id);
          break;
        }
      }
    } catch (err) {
      hold(s, (err as Error).message);
    }
  }

  let waiting = modules;
  for (let round = 0; waiting.length && round < 6; round++) {
    const next: typeof modules = [];
    const list = await call<{ items: Array<{ module_name: string; item_count?: number | null }> }>(lb, "GET", "/instances");
    for (const s of waiting) {
      // Only a module with nothing in it goes off again; the platform's
      // disable takes its empty default collection away with it.
      if ((list.json?.items ?? []).filter((i) => i.module_name === s.entity_id).some((i) => (i.item_count ?? 0) > 0)) {
        hold(s, "it holds things now");
        continue;
      }
      const r = await call<{ error?: { code?: string; message?: string } }>(lb, "POST", `/modules/${encodeURIComponent(s.entity_id ?? "")}/disable`, {});
      if (r.status < 300) await done(s.id);
      else if (r.json?.error?.code === "module_in_use") next.push(s);
      else hold(s, r.json?.error?.message ?? `could not turn it off (${r.status})`);
    }
    if (next.length === waiting.length) {
      for (const s of next) hold(s, "another module still needs it");
      break;
    }
    waiting = next;
  }

  const report: UndoReport = { undone, held, status: held.length ? "partly-undone" : "undone" };
  await platform()
    .activity.log({
      orgId,
      userId: null,
      action: report.status === "undone" ? "sheet_import_undone" : "sheet_import_partly_undone",
      ref: { module: "core-import", entityType: "import_run", entityId: runId },
      diff: { title: (await db.selectFrom("core_import_runs").select("filename").where("id", "=", runId).executeTakeFirst())?.filename ?? "a spreadsheet", undone: report.undone, held: report.held.length },
    })
    // import-swallow-ok: the activity line is a courtesy; the run's own row is the record of what happened
    .catch(() => undefined);
  await db
    .updateTable("core_import_runs")
    .set({
      status: report.status,
      ...(report.status === "undone" ? { undone_at: new Date() } : {}),
      undo_report: sql`${JSON.stringify(report)}::jsonb`, // jsonb-replace-ok: the latest undo's report replaces the last
    } as never)
    .where("id", "=", runId)
    .execute();
  return report;
}

export type { CoreImportDB };
