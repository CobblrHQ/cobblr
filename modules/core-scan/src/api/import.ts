// Scan-inbox bulk IMPORT — one-shot, user-triggered. Accepts an
// inbox export natively (JSON envelope or CSV; contract: the inbox-export interop spec v1) and any other system's CSV via a column
// `mapping`. The parse/translate half lives in ../services/import.ts (pure);
// this router owns idempotency, row insertion, and best-effort photo fetch.
//
//   POST /import          — dry_run, duplicate_policy=skip|append|replace, fetch_photos
//   POST /import/preview  — detected columns + first rows, never writes
//
// Imported items land as ordinary inbox rows (status pending unless the
// source discarded them) with every hint in suggested_metadata — including
// user_hint, which the matchmaker's prompt already honours as a tie-breaker —
// so Cobblr's OWN matchmaker routes them (§3: hints, not hard bindings).
// Nothing here auto-fires AI: 500 imported rows must not mean 500 surprise
// model calls. The inbox's existing suggest/rerun flows pick them up.

import { createHash } from "node:crypto";
import { Router, text as expressText } from "express";
import { z } from "zod";
import multer from "multer";
import { platform } from "@cobblr/platform-contract";
import { sql, type Transaction } from "kysely";
import { bearer, sessionUser, tenantContext, tenantDb, type CoreScanDB } from "../db.js";

/** An open transaction on a tenant db. The import does every one of its writes
 *  inside one, so a failure rolls the whole import back. */
type TenantTrx = Transaction<CoreScanDB>;
import { asyncHandler, requireRole } from "./util.js";
import { assembleScanMenu, heuristicMatch, type ScanMenuEntry } from "../services/matchmaker.js";
import { INTERNAL_API } from "./inbox.js";
import { assertSafeOutboundUrl } from "../services/enrich.js";
import {
  parseCsvImport,
  parseJsonImport,
  type ImportRowError,
  type NormalizedImportBatch,
  type NormalizedImportItem,
  type ParsedImport,
} from "../services/import.js";

export const importRouter = Router({ mergeParams: true });

const PHOTO_TIMEOUT_MS = 10_000;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
// Each stored photo takes a tenant DB connection for its metadata row, so a
// wide fan-out here competes with the rest of the instance for Postgres slots.
// At 4, a real 69-item import lost 4-6 photos per run to "remaining connection
// slots are reserved for roles with the SUPERUSER attribute" (2026-07-31). The
// import is not latency-sensitive - it is a bulk operation someone triggers and
// walks away from - so trading a little wall-clock for not being the reason
// another request cannot get a connection is the right way round.
const PHOTO_CONCURRENCY = 2;
/** Connection-pool contention is transient by nature: the fix is to wait and
 *  ask again, not to fail the photo. */
const PHOTO_RETRIES = 3;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

const QuerySchema = z.object({
  dry_run: z.enum(["true", "false"]).optional(),
  duplicate_policy: z.enum(["skip", "append", "replace"]).optional(),
  fetch_photos: z.enum(["true", "false"]).optional(),
});

/** Parse whichever body arrived: multipart `file` (CSV or JSON by extension /
 *  content), raw text/csv, or a JSON body. `mapping` comes from a multipart
 *  field or the JSON body's top level. */
function parseRequest(req: {
  file?: { originalname?: string; mimetype?: string; buffer: Buffer };
  headers: Record<string, unknown>;
  body: unknown;
}): ParsedImport {
  const bodyObj = (req.body ?? {}) as Record<string, unknown>;
  let mapping: Record<string, string> | undefined;
  const mRaw = bodyObj.mapping;
  if (typeof mRaw === "string" && mRaw.trim()) {
    try {
      mapping = JSON.parse(mRaw) as Record<string, string>;
    } catch {
      /* surfaced below as a normal parse of the file without mapping */
    }
  } else if (mRaw && typeof mRaw === "object") mapping = mRaw as Record<string, string>;

  if (req.file) {
    const name = (req.file.originalname ?? "").toLowerCase();
    const text = req.file.buffer.toString("utf8");
    const looksJson = name.endsWith(".json") || req.file.mimetype === "application/json" || text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
    if (looksJson) {
      try {
        return parseJsonImport(JSON.parse(text));
      } catch (e) {
        return { source: null, source_instance: null, items: [], errors: [{ row: 0, field: "", message: `invalid JSON: ${(e as Error).message}` }] };
      }
    }
    return parseCsvImport(text, mapping);
  }

  const ct = String(req.headers["content-type"] ?? "");
  if (ct.includes("text/csv")) {
    return parseCsvImport(String(req.body ?? ""), mapping);
  }
  // Raw JSON body: the envelope itself, or { items, mapping }.
  return parseJsonImport(bodyObj);
}

/** What a repeat import needs to know about an already-imported row: where it
 *  is, which photo files it holds, and the content hashes of the photos the
 *  LAST import stored - so an unchanged photo is never stored again. */
interface ExistingImported {
  id: string;
  image_file_id: string | null;
  catalog_image_file_id: string | null;
  photo_hashes: { identify?: string; display?: string };
}

/** The rows a re-import might already be looking at, keyed both ways. */
export interface ExistingRows {
  /** `<source_instance>::<source_id>` -> the row THIS importer wrote for it. */
  byProvenance: Map<string, ExistingImported>;
  /** The destination row's own id -> that row. See findExistingRow. */
  byId: Map<string, ExistingImported>;
}

/** Every row that a re-import could match, in one query. */
async function existingProvenance(db: ReturnType<typeof tenantDb>): Promise<ExistingRows> {
  // Deliberately NOT filtered on `suggested_metadata is not null`: a row that
  // reached this workspace by a route other than the importer has no metadata
  // to filter on, and those are exactly the rows byId exists to catch.
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_metadata", "image_file_id", "catalog_image_file_id"])
    .execute();
  const byProvenance = new Map<string, ExistingImported>();
  const byId = new Map<string, ExistingImported>();
  for (const r of rows) {
    const meta = r.suggested_metadata as {
      import_provenance?: { source_id?: unknown; source_instance?: unknown };
      import_photo_hashes?: { identify?: unknown; display?: unknown };
    } | null;
    const h = meta?.import_photo_hashes ?? {};
    const entry: ExistingImported = {
      id: r.id,
      image_file_id: (r.image_file_id as string | null) ?? null,
      catalog_image_file_id: (r.catalog_image_file_id as string | null) ?? null,
      photo_hashes: {
        ...(typeof h.identify === "string" ? { identify: h.identify } : {}),
        ...(typeof h.display === "string" ? { display: h.display } : {}),
      },
    };
    byId.set(r.id, entry);
    const p = meta?.import_provenance;
    if (p && p.source_id !== undefined) {
      byProvenance.set(`${String(p.source_instance ?? "")}::${String(p.source_id)}`, entry);
    }
  }
  return { byProvenance, byId };
}

/**
 * The destination row this incoming item already IS, if it is here at all.
 *
 * Provenance is the real key, and it covers every row this importer wrote. It
 * does NOT cover a workspace that was seeded some other way - a DB-level clone
 * of the source, a restore - because those rows arrive under the source's
 * ORIGINAL ids carrying no provenance at all. Dedupe cannot see them, so each
 * sync into such a workspace imports a SECOND copy of every one, beside the
 * clone-seeded original. A staging workspace seeded from a prod clone had
 * accumulated 26 such pairs by 2026-08-22, each identifiable exactly: an
 * imported row whose source_id is another local row's own id.
 *
 * Falling back to the destination row's own id is safe precisely because an
 * IMPORTED row never keeps the source's id - it is assigned a fresh one - so a
 * destination id equal to the incoming source_id can only be the same row,
 * arriving again by a different route. (Two random uuids colliding is not a
 * practical concern.)
 */
export function findExistingRow(
  provenance: { source_id: string; source_instance: string | null } | null,
  existing: ExistingRows,
): ExistingImported | undefined {
  if (!provenance) return undefined;
  const key = `${String(provenance.source_instance ?? "")}::${provenance.source_id}`;
  return existing.byProvenance.get(key) ?? existing.byId.get(provenance.source_id);
}

/** Content identity of an embedded photo. Hashing the base64 text is enough -
 *  identical bytes encode identically - and avoids a decode. */
export const photoHash = (embed: { data: string }): string =>
  createHash("sha256").update(embed.data).digest("hex");

/**
 * Should this run STORE the photo, or is the destination's existing file
 * already those bytes?
 *
 * Without this, every `replace` re-sync stored every embedded photo as a brand
 * new file and re-pointed the row, orphaning the previous file: three sync runs
 * left ~240 stored files for 81 photos (2026-08-01) - the same silent
 * unbounded growth as the web-static leak, in the file store. A matching hash
 * plus a surviving file id means the bytes are already here; a changed photo
 * still propagates because its hash differs.
 */
export function shouldStorePhoto(opts: {
  action: "create" | "replace";
  existingFileId: string | null;
  existingHash: string | undefined;
  newHash: string;
}): boolean {
  if (opts.action !== "replace") return true;
  if (!opts.existingFileId) return true;
  return opts.existingHash !== opts.newHash;
}

const provKey = (i: NormalizedImportItem): string | null =>
  i.provenance ? `${String(i.provenance.source_instance ?? "")}::${i.provenance.source_id}` : null;

/**
 * Recreate the exported SESSIONS locally and return sourceId → local batch id.
 *
 * Provenance lives in its own `import_source_id` column - it used to be
 * stamped into `origin`, which overwrote the exported origin and cost imported
 * receipt sessions their "emailed <when>" rendering. The source id is the
 * idempotency key: syncing the same inbox twice reuses the session instead of
 * cloning it, and a reused session REFRESHES its label/origin/vendor/order_ref
 * from the envelope (the source is the source of truth, same as the items -
 * this is also what heals sessions imported under the old origin-stamp
 * scheme, whose origin the 0018 migration reset to null). Best-effort per
 * batch: a session that fails just leaves its items ungrouped rather than
 * failing the whole import.
 */
async function upsertBatches(
  db: TenantTrx,
  batches: NormalizedImportBatch[],
  orgId: string,
  userId: string | null,
): Promise<{ map: Map<string, string>; created: string[] }> {
  const map = new Map<string, string>();
  const created: string[] = [];
  if (batches.length === 0) return { map, created };
  const existing = await db
    .selectFrom("core_scan_batches")
    .select(["id", "import_source_id"])
    .where("import_source_id", "in", batches.map((b) => b.source_id))
    .execute();
  for (const r of existing) {
    if (r.import_source_id) map.set(String(r.import_source_id), r.id as string);
  }
  for (const b of batches) {
    const reuseId = map.get(b.source_id);
    if (reuseId) {
      try {
        await db
          .updateTable("core_scan_batches")
          .set({ label: b.label, origin: b.origin, vendor: b.vendor, order_ref: b.order_ref })
          .where("id", "=", reuseId)
          .execute();
      } catch {
        /* a stale label is not worth failing the import over */
      }
      continue;
    }
    try {
      const ins = await db
        .insertInto("core_scan_batches")
        .values({
          label: b.label,
          origin: b.origin,
          import_source_id: b.source_id,
          vendor: b.vendor,
          order_ref: b.order_ref,
          created_by_user_id: userId,
          ...(b.created_at && !Number.isNaN(Date.parse(b.created_at))
            ? { created_at: new Date(b.created_at) }
            : {}),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      map.set(b.source_id, ins.id as string);
      created.push(ins.id as string);
      // The receipt this session was parsed from, so the inbox's "Original"
      // button still works on the destination. Embedded bytes only - a link
      // would point back at an instance the destination may not reach.
      if (b.document_embedded) {
        try {
          const fileId = await storeEmbeddedToFile(orgId, b.document_embedded);
          await db
            .updateTable("core_scan_batches")
            .set({ source_file_id: fileId })
            .where("id", "=", ins.id as string)
            .execute();
        } catch {
          /* no original → the session still imports, just without its receipt */
        }
      }
    } catch {
      /* a session that won't create leaves its items ungrouped, not the import failed */
    }
  }
  return { map, created };
}

/** Fetch a photo URL (10s / 5MB / SSRF-guarded) and store it via core-files.
 *  Returns the file id, or throws with a user-facing message. Stores through the
 *  platform files seam (in-process), NOT the HTTP upload route — a fetched photo
 *  is not a user upload, so it must bypass any gate on that route. */
async function fetchPhotoToFile(orgId: string, url: string): Promise<string> {
  // CI/test escape, same convention as the webhook + machine guards: the test
  // suite spins a loopback photo server and CI sets COBBLR_TEST_CALLBACK_HOST.
  const testHost = process.env.COBBLR_TEST_CALLBACK_HOST;
  if (!(testHost && new URL(url).hostname === testHost)) assertSafeOutboundUrl(url);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": "cobblr-core-scan-import/1" }, signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message;
    const tailnet = /\.ts\.net(\/|:|$)/.test(url) ? " (a *.ts.net tailnet URL — reachable only if this Cobblr is on the same tailnet; rehost the photos or re-run the import from a tailnet-connected instance)" : "";
    throw new Error(`fetch failed: ${msg}${tailnet}`);
  }
  if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > PHOTO_MAX_BYTES) throw new Error(`photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const blob = await res.blob();
  if (blob.size > PHOTO_MAX_BYTES) throw new Error(`photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const contentType = res.headers.get("content-type") ?? "";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const written = await platform().files.write(orgId, new Uint8Array(await blob.arrayBuffer()), {
    filename: `import-${Date.now()}.${ext}`,
    mimeType: blob.type || contentType || "image/jpeg",
  });
  if (!written) throw new Error("file store failed");
  return written.fileId;
}

/** Store a baked-in (embed-mode) photo: decode its base64 and hand the bytes to
 *  core-files. NO network — this is the offline / LAN-only import path. */
async function storeEmbeddedToFile(orgId: string, embed: { mime: string; data: string }): Promise<string> {
  const bytes = Buffer.from(embed.data, "base64");
  if (bytes.byteLength === 0) throw new Error("embedded photo is empty / not valid base64");
  if (bytes.byteLength > PHOTO_MAX_BYTES) throw new Error(`embedded photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const ext = embed.mime.includes("png") ? "png" : embed.mime.includes("webp") ? "webp" : "jpg";
  const written = await platform().files.write(orgId, new Uint8Array(bytes), {
    filename: `import-${Date.now()}.${ext}`,
    mimeType: embed.mime,
  });
  if (!written) throw new Error("file store failed");
  return written.fileId;
}

/**
 * A replaced row's snapshot, made safe to write back.
 *
 * The snapshot comes straight out of jsonb, so `suggested_candidates` is a JS
 * array - and writing a JS array to a jsonb column is the exact node-pg
 * array-literal bug this module has now hit twice (#1536, and here). The undo
 * path escaped the lint because it writes a spread variable, not a literal
 * key, and it escaped testing because no test undid a REPLACE run - which is
 * the only kind the prod->staging sync produces. Every array value is
 * stringified (this table's only array-typed columns are jsonb; there are no
 * text[] columns to corrupt), and the identity/timestamp columns Postgres owns
 * are stripped.
 */
export function encodeRowForRestore(before: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, created_at: _created, ...rest } = before;
  for (const [k, v] of Object.entries(rest)) {
    if (Array.isArray(v)) rest[k] = JSON.stringify(v);
  }
  return rest;
}

/** Is this failure worth another go? Pool exhaustion and the driver's own
 *  "too many clients" are transient contention; a 404, a bad mime or a decode
 *  failure will fail identically every time and must not be retried. */
export function isTransientStorageError(message: string): boolean {
  return /remaining connection slots|too many clients|connection terminated|ECONNRESET|timeout expired|timed out|Connection terminated unexpectedly/i.test(
    message,
  );
}

/** Run `fn`, retrying only transient storage failures with a widening backoff. */
async function withStorageRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= PHOTO_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === PHOTO_RETRIES || !isTransientStorageError((e as Error).message ?? "")) throw e;
      await new Promise((r) => setTimeout(r, 250 * attempt * attempt));
    }
  }
  throw last;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ── POST /import/preview — parse + mapping report, never writes ─────────────
// AI-REACH: takes or produces a file (multipart or binary), which an action cannot carry
importRouter.post(
  "/import/preview",
  expressText({ type: ["text/csv", "text/plain"], limit: "32mb" }),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = parseRequest(req as never);
    res.json({
      source: parsed.source,
      source_instance: parsed.source_instance,
      count: parsed.items.length,
      columns: parsed.columns ?? null,
      errors: parsed.errors,
      rows: parsed.items.slice(0, 5).map((i) => ({
        row: i.row,
        name: i.suggested_name,
        barcode: i.barcode,
        status: i.status,
        source_kind: i.source_kind,
        quantity: i.quantity,
        scan_area: i.scan_area,
        hint_category: i.metadata.hint_category ?? null,
        has_photo: !!(i.photo_identify_url || i.photo_identify_embedded),
      })),
    });
  }),
);

// ── POST /import ─────────────────────────────────────────────────────────────
// AI-REACH: takes or produces a file (multipart or binary), which an action cannot carry
importRouter.post(
  "/import",
  expressText({ type: ["text/csv", "text/plain"], limit: "32mb" }),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const q = QuerySchema.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: { code: "bad_query", message: "bad query params", details: q.error.issues } });
      return;
    }
    const dryRun = q.data.dry_run === "true";
    const policy = q.data.duplicate_policy ?? "skip";
    const fetchPhotos = q.data.fetch_photos !== "false";

    const parsed = parseRequest(req as never);
    const errors: ImportRowError[] = [...parsed.errors];
    if (parsed.items.length === 0) {
      res.status(errors.length ? 400 : 200).json({
        imported_count: 0, skipped_count: 0, errors, created_ids: [], photos_fetched: 0, photos_failed: 0,
      });
      return;
    }

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const user = sessionUser(req);
    const token = bearer(req) ?? "";

    const existing = await existingProvenance(db);
    // Also dedupe within the file itself (same source_id twice in one export).
    const seenInFile = new Set<string>();

    type Plan = { item: NormalizedImportItem; action: "create" | "skip" | "replace"; existingId?: string; prior?: ExistingImported };
    const plan: Plan[] = parsed.items.map((item) => {
      const key = provKey(item);
      if (!key || policy === "append") return { item, action: "create" as const };
      if (seenInFile.has(key)) return { item, action: "skip" as const };
      seenInFile.add(key);
      const prior = findExistingRow(item.provenance, existing);
      if (!prior) return { item, action: "create" as const };
      return policy === "replace"
        ? { item, action: "replace" as const, existingId: prior.id, prior }
        : { item, action: "skip" as const, existingId: prior.id };
    });

    const toWrite = plan.filter((p) => p.action !== "skip");
    if (dryRun) {
      res.json({
        imported_count: toWrite.length,
        skipped_count: plan.length - toWrite.length,
        errors,
        created_ids: [],
        photos_fetched: 0,
        photos_failed: 0,
        dry_run: true,
      });
      return;
    }

    // ── Where the source had things filed, as a SUGGESTION ───────────────
    // The export carries the location by NAME (its uuid is meaningless here).
    // An exact, unambiguous name match adopts the local location; anything else
    // leaves the name visible in the location note rather than dropping it, and
    // never guesses a nearby match - filing something into the wrong room is
    // worse than filing it nowhere.
    const localLocations = new Map<string, string[]>();
    if (parsed.items.some((i) => i.x_location_name)) {
      try {
        const locs = await platform().entities.list(ctx.org.id, "core-locations:location", { limit: 2000 });
        for (const l of locs.items) {
          const name = (l.title ?? String((l.fields as Record<string, unknown>)?.name ?? "")).trim().toLowerCase();
          if (!name) continue;
          localLocations.set(name, [...(localLocations.get(name) ?? []), String(l.id)]);
        }
      } catch {
        /* no locations module here → every name stays a note */
      }
    }
    for (const i of parsed.items) {
      if (!i.x_location_name) continue;
      const hit = localLocations.get(i.x_location_name.trim().toLowerCase());
      if (hit && hit.length === 1) i.x_target_location_id = hit[0]!;
      else if (!i.x_location_note) i.x_location_note = i.x_location_name;
    }

    // ── Photos FIRST, outside the transaction ────────────────────────────
    // Resolving bytes to a stored file id is slow (a fetch can take seconds) and
    // must not hold a write transaction open. Doing it up front also means the
    // row lands WITH its images already attached, so there is no window where an
    // item exists without its photo - and a photo that cannot be stored costs
    // that item its image, never the import.
    let photosFetched = 0;
    let photosFailed = 0;
    const photoIds = new Map<number, { identify?: string; display?: string }>();
    await mapLimit(toWrite, PHOTO_CONCURRENCY, async (p) => {
      const i = p.item;
      const roles = [
        ["identify", fetchPhotos ? i.photo_identify_url : null, i.photo_identify_embedded],
        ["display", fetchPhotos ? i.photo_display_url : null, i.photo_display_embedded],
      ] as const;
      const hashes: Record<string, string> = {};
      for (const [role, url, embed] of roles) {
        if (!embed && !url) continue;
        try {
          if (embed) {
            const h = photoHash(embed);
            hashes[role] = h;
            const existingFileId = role === "identify" ? (p.prior?.image_file_id ?? null) : (p.prior?.catalog_image_file_id ?? null);
            if (!shouldStorePhoto({ action: p.action as "create" | "replace", existingFileId, existingHash: p.prior?.photo_hashes[role], newHash: h })) {
              continue; // bytes already here from a previous sync - keep the file
            }
          }
          const fileId = await withStorageRetry(() =>
            embed ? storeEmbeddedToFile(ctx.org.id, embed) : fetchPhotoToFile(ctx.org.id, url!),
          );
          const slot = photoIds.get(i.row) ?? {};
          slot[role] = fileId;
          photoIds.set(i.row, slot);
          photosFetched++;
        } catch (e) {
          photosFailed++;
          errors.push({ row: i.row, field: embed ? `${role}_photo_embedded` : `${role}_photo_url`, message: (e as Error).message });
        }
      }
      // The hashes ride in the row's metadata so the NEXT sync can recognise
      // unchanged bytes. Written into i.metadata here, before the transaction
      // builds its values from it.
      if (Object.keys(hashes).length) i.metadata.import_photo_hashes = hashes;
    });

    // ── Then ONE transaction for every row ───────────────────────────────
    // All of it lands or none of it does. A bulk import that half-succeeds
    // leaves an inbox nobody can reason about: some items new, some updated,
    // some untouched, and no way to tell which without reading them all. Any
    // failure here rolls the whole thing back and the caller gets an error
    // instead of a partial success (reported 2026-07-31: "if it fails it fails
    // completely, no half of the items as fragments making it through").
    const createdIds: string[] = [];
    const createdBatchIds: string[] = [];
    const replacedBefore: Array<{ id: string; before: Record<string, unknown> }> = [];
    let runId: string | null = null;

    try {
      await db.transaction().execute(async (trx) => {
        // Sessions first, so every item can point at a local batch id.
        const { map: batchIdBySource, created } = await upsertBatches(
          trx,
          parsed.batches ?? [],
          ctx.org.id,
          user?.id ?? null,
        );
        createdBatchIds.push(...created);

        for (const p of toWrite) {
          const i = p.item;
          const localBatch = i.x_batch_source_id ? (batchIdBySource.get(i.x_batch_source_id) ?? null) : null;
          const photos = photoIds.get(i.row) ?? {};
          const values = {
            status: i.status,
            source_kind: i.source_kind,
            barcode_text: i.barcode,
            source_url: i.source_url,
            suggested_name: i.suggested_name,
            suggested_sku: i.suggested_sku,
            suggested_metadata: i.metadata,
            ai_notes: i.ai_notes,
            // numeric(3,2) rides as a string through kysely
            ai_confidence: i.ai_confidence === null ? null : i.ai_confidence.toFixed(2),
            scan_area: i.scan_area,
            quantity: i.quantity,
            // Cobblr→Cobblr richness restored from x_cobblr. A foreign CSV leaves
            // these null and behaves exactly as before.
            suggested_manufacturer: i.x_manufacturer,
            suggested_location_note: i.x_location_note,
            target_kind: i.x_entity_type,
            scan_batch_id: localBatch,
            updated_at: new Date(),
            ...(photos.identify ? { image_file_id: photos.identify } : {}),
            ...(photos.display ? { catalog_image_file_id: photos.display } : {}),
            // An external catalog link is the ONLY visual a third of a real
            // inbox has. Keep it verbatim; the card renders it directly, same
            // as the source does, with no fetch.
            ...(i.x_catalog_image_url ? { catalog_image_url: i.x_catalog_image_url } : {}),
            // jsonb ARRAY column: it must be handed a JSON STRING, not a JS
            // array. node-pg renders a JS array as a Postgres array literal
            // ({...}), which the jsonb column rejects with "invalid input
            // syntax for type json" - and because every write is one
            // transaction now, that single bad value rolls back the entire
            // import. (A plain object is fine, which is why suggested_metadata
            // above needs no cast; only arrays are ambiguous.) The `as never`
            // matches the other jsonb-array writers in this module: the Kysely
            // column type says unknown[], the driver wants text.
            ...(Array.isArray(i.x_candidates)
              ? { suggested_candidates: JSON.stringify(i.x_candidates) as never }
              : {}),
            ...(i.x_target_location_id ? { target_location_id: i.x_target_location_id } : {}),
          };
          if (p.action === "replace" && p.existingId) {
            // Snapshot what we are about to overwrite, so the run is reversible.
            const before = await trx
              .selectFrom("core_scan_inbox_items")
              .selectAll()
              .where("id", "=", p.existingId)
              .executeTakeFirst();
            if (before) replacedBefore.push({ id: p.existingId, before: before as unknown as Record<string, unknown> });
            await trx.updateTable("core_scan_inbox_items").set(values).where("id", "=", p.existingId).execute();
            createdIds.push(p.existingId);
          } else {
            const ins = await trx
              .insertInto("core_scan_inbox_items")
              .values({
                ...values,
                created_by_user_id: user?.id ?? null,
                // Sessions group by TIME, so stamping import-time here would
                // collapse months of scanning into one bogus session.
                ...(i.x_created_at && !Number.isNaN(Date.parse(i.x_created_at))
                  ? { created_at: new Date(i.x_created_at) }
                  : {}),
              })
              .returning("id")
              .executeTakeFirstOrThrow();
            createdIds.push(ins.id);
          }
        }

        // The run record is written in the SAME transaction, so a recorded run
        // always describes rows that actually exist.
        const run = await trx
          .insertInto("core_scan_import_runs")
          .values({
            created_by_user_id: user?.id ?? null,
            source_instance: parsed.source_instance,
            source_label: parsed.source,
            item_count: toWrite.length,
            created_count: createdIds.length - replacedBefore.length,
            replaced_count: replacedBefore.length,
            undo: {
              created_item_ids: createdIds.filter((id) => !replacedBefore.some((r) => r.id === id)),
              created_batch_ids: createdBatchIds,
              replaced: replacedBefore,
            },
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        runId = run.id;
      });
    } catch (e) {
      res.status(500).json({
        error: {
          code: "import_failed",
          message: `import rolled back, nothing was written: ${(e as Error).message}`,
        },
        errors,
        photos_fetched: photosFetched,
        photos_failed: photosFailed,
      });
      return;
    }

    // AN IMPORTED SCAN IS STILL A SCAN: it needs a stamp saying identification
    // is finished, and a route.
    //
    // Neither happened, so every imported item sat under "finishing..." with no
    // destination, and the seeded fixture this repo uses for scan testing could
    // never reach the state it was seeded to test.
    //
    // ROUTING IS DONE HERE, IN PROCESS, WITH THE HEURISTIC ONLY. The obvious
    // version - a detached matchmaker per row, the same call a live scan makes -
    // is wrong for a bulk operation. The committed fixture alone is 156 rows, so
    // that is 156 concurrent runs each opening pools and calling this same api
    // over HTTP: it took the api's Postgres client down in CI and turned the
    // suite into 488 ECONNREFUSED. It would also spend 156 model calls on an
    // operation whose entire purpose is to replay work already paid for.
    //
    // The heuristic needs neither. One menu build for the whole import, then a
    // pure function per row. Free, bounded, and enough: a table's noun and its
    // declared keywords are exactly what routes "Tazo Tea" to Tea.
    if (createdIds.length > 0) {
      const stampedAt = new Date();
      let menu: ScanMenuEntry[] = [];
      const token = bearer(req);
      if (token) {
        try {
          const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
          menu = await assembleScanMenu(baseUrl, ctx.org.slug, token);
        } catch (err) {
          // No menu means no routing, which is a worse import, not a failed one.
          console.error("[core-scan] import: could not read the table menu:", (err as Error).message);
        }
      }
      // The rows as WRITTEN, not the import plan: the plan is a different shape
      // and does not carry what routing reads.
      let rows: Array<{ id: string; suggested_name: string | null; barcode_text: string | null; suggested_manufacturer: string | null }> = [];
      try {
        rows = (await db
          .selectFrom("core_scan_inbox_items")
          .select(["id", "suggested_name", "barcode_text", "suggested_manufacturer"])
          .where("id", "in", createdIds)
          .execute()) as typeof rows;
      } catch (err) {
        console.error("[core-scan] import: could not read back the new rows:", (err as Error).message);
      }
      for (const row of rows) {
        const id = row.id;
        let candidates: unknown[] = [];
        if (menu.length > 0 && row.suggested_name) {
          try {
            candidates = heuristicMatch(
              {
                name: row.suggested_name ?? "",
                ...(row.barcode_text ? { barcode: row.barcode_text } : {}),
                ...(row.suggested_manufacturer ? { manufacturer: row.suggested_manufacturer } : {}),
              },
              menu,
            );
          } catch (err) {
            console.error("[core-scan] import: routing threw for one row:", (err as Error).message);
          }
        }
        try {
          await db
            .updateTable("core_scan_inbox_items")
            .set({
              ai_suggested_at: stampedAt,
              updated_at: stampedAt,
              ...(candidates.length > 0
                ? { suggested_candidates: sql`${JSON.stringify(candidates)}::jsonb` as never }
                : {}),
            })
            .where("id", "=", id)
            .execute();
        } catch (err) {
          console.error("[core-scan] import: could not stamp one row:", (err as Error).message);
        }
      }
    }

    res.json({
      imported_count: createdIds.length,
      skipped_count: plan.length - toWrite.length,
      errors,
      created_ids: createdIds,
      photos_fetched: photosFetched,
      photos_failed: photosFailed,
      // The handle for one-click undo.
      run_id: runId,
    });
  }),
);

// ──────────────── Import runs: list + one-click undo ────────────────────────
// A bulk import is the one scan operation a person cannot unpick by hand, and
// with duplicate_policy=replace it overwrites rows that were already there. So
// every run records what it created and the prior contents of what it replaced,
// and this reverses it in one call (reported 2026-07-31: "1 click reversible in the
// event of an issue").

importRouter.get(
  "/import/runs",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rows = await tenantDb(req)
      .selectFrom("core_scan_import_runs")
      .select([
        "id", "created_at", "source_instance", "source_label",
        "item_count", "created_count", "replaced_count", "undone_at",
      ])
      .orderBy("created_at", "desc")
      .limit(25)
      .execute();
    res.json({ items: rows });
  }),
);

// AI-REACH: exempt - a destructive BULK reversal (it deletes rows and rewrites
// others from a snapshot), owner/admin only, and it only makes sense against a
// specific run the person is looking at. "Undo the import" is exactly the kind
// of instruction that is cheap to say, ambiguous about WHICH import, and
// expensive to get wrong, so the affordance belongs next to the run in the UI
// rather than in a chat turn. Listing runs (the GET above) is not restricted.
importRouter.post(
  "/import/runs/:id/undo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = String(req.params.id ?? "");
    const db = tenantDb(req);
    const run = await db
      .selectFrom("core_scan_import_runs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "no such import run" } });
      return;
    }
    if (run.undone_at) {
      res.status(409).json({ error: { code: "already_undone", message: "this import has already been undone" } });
      return;
    }
    const undo = (run.undo ?? {}) as {
      created_item_ids?: string[];
      created_batch_ids?: string[];
      replaced?: Array<{ id: string; before: Record<string, unknown> }>;
    };

    let removed = 0;
    let restored = 0;
    // The reversal is itself one transaction: an undo that half-applied would
    // be strictly worse than the import it was meant to fix.
    await db.transaction().execute(async (trx) => {
      const createdIds = undo.created_item_ids ?? [];
      if (createdIds.length) {
        const del = await trx
          .deleteFrom("core_scan_inbox_items")
          .where("id", "in", createdIds)
          .executeTakeFirst();
        removed = Number(del.numDeletedRows ?? 0);
      }
      for (const r of undo.replaced ?? []) {
        await trx
          .updateTable("core_scan_inbox_items")
          .set(encodeRowForRestore(r.before) as never)
          .where("id", "=", r.id)
          .execute();
        restored++;
      }
      // Only drop a session this run created AND that nothing else now lives in.
      for (const batchId of undo.created_batch_ids ?? []) {
        const still = await trx
          .selectFrom("core_scan_inbox_items")
          .select("id")
          .where("scan_batch_id", "=", batchId)
          .limit(1)
          .executeTakeFirst();
        if (!still) await trx.deleteFrom("core_scan_batches").where("id", "=", batchId).execute();
      }
      await trx
        .updateTable("core_scan_import_runs")
        .set({ undone_at: new Date() })
        .where("id", "=", id)
        .execute();
    });

    res.json({ undone: true, run_id: id, items_removed: removed, items_restored: restored });
  }),
);
