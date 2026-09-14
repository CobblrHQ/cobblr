// A catalog picture that reached the store untrimmed is trimmed where it
// sits, once, and every stored picture says what the trim decided.
//
// Two rows in the owner's lab inbox showed a bottle adrift in a white field
// while their neighbour filled its column (#3002). The trim existed and
// would have cut both (measured on the bytes: 640x640 to 265x605, 1024x597
// to 267x612); the pictures had simply arrived through a door that never
// ran it. The rows were mirrored from another workspace, and the import
// stored the source's display picture verbatim; the source had picked its
// pictures the day the trim shipped. Every door trims now (downloadCatalogImage
// and the import's display photo), and this pass is the self-heal for what
// was stored before: a pending row whose picture carries no
// `catalog_image_trim` verdict is read back, trimmed if the trim says so,
// and stamped either way, so a second look at the row costs nothing and a
// picture the trim declines is declined on the record, with the reason.
//
// Per workspace and bounded per tick, on its own cadence: the first pass
// ninety seconds after boot, a page a minute while any workspace still has
// a full page waiting (an inbox of a hundred untrimmed pictures heals in
// minutes, not hours), then every twenty minutes for whatever arrives. Never
// on the pictures sweep's engine-asking tick, which must stay spaced. The
// untrimmed file is kept and named on the verdict (`untrimmed_file_id`):
// the viewer keeps the full picture.
//
// Idempotent: the SQL filter matches only rows without the stamp, and the
// stamp is written for every row visited, trimmed or not.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { trimCatalogMarginsWithVerdict, type TrimVerdict } from "./trim-margins.js";

/** Rows per workspace per tick. Image decoding is the cost, not the query. */
export const RETRIM_PER_TICK = 24;
/** Between passes once nothing is waiting. */
const TICK_MS = 20 * 60 * 1000;
/** Between passes while a workspace still had a full page. */
const DRAIN_MS = 60 * 1000;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let drainHandle: ReturnType<typeof setTimeout> | null = null;

export function startRetrimSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeRetrimTick, TICK_MS);
  setTimeout(safeRetrimTick, 90_000); // after boot settles
  console.log(`[core-scan] retrim sweeper started — every ${TICK_MS / 60_000} min, a page a minute while there is a backlog`);
}

async function safeRetrimTick(): Promise<void> {
  try {
    let backlog = false;
    await platform().exclusive.run("core-scan.retrim-sweep", async () => {
      backlog = (await retrimTick()).backlog;
    });
    if (backlog) {
      if (drainHandle) clearTimeout(drainHandle);
      drainHandle = setTimeout(safeRetrimTick, DRAIN_MS);
    }
  } catch (err) {
    console.error("[core-scan] retrim sweep failed:", (err as Error).stack ?? (err as Error).message);
  }
}

interface UntrimmedRow {
  id: string;
  catalog_image_file_id: string;
}

export async function retrimTick(opts: { orgId?: string } = {}): Promise<{ visited: number; trimmed: number; backlog: boolean }> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m", (j) => j.onRef("m.org_id", "=", "orgs.id").on("m.module_name", "=", "core-scan"))
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);
  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[core-scan] retrim sweep skipped — meta read failed:", (err as Error).message);
    return { visited: 0, trimmed: 0, backlog: false };
  }
  let visited = 0;
  let trimmed = 0;
  let backlog = false;
  for (const { id: orgId } of orgs) {
    try {
      const done = await retrimWorkspace(orgId);
      visited += done.visited;
      trimmed += done.trimmed;
      // A full page means more is waiting behind it.
      if (done.visited >= RETRIM_PER_TICK) backlog = true;
    } catch (err) {
      console.warn(`[core-scan] retrim sweep skipped org ${orgId}:`, (err as Error).message);
    }
  }
  if (visited > 0) console.log(`[core-scan] retrim sweep: ${trimmed} of ${visited} stored picture(s) trimmed in place${backlog ? "; more waiting, next page in a minute" : ""}`);
  return { visited, trimmed, backlog };
}

/** One workspace: the next few pending rows whose picture has no verdict. */
export async function retrimWorkspace(orgId: string): Promise<{ visited: number; trimmed: number }> {
  let rows: UntrimmedRow[] = [];
  await platform().tenants.withDb(orgId, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    const q = sql<UntrimmedRow>`
      select id, catalog_image_file_id
      from core_scan_inbox_items
      where status = 'pending'
        and catalog_image_file_id is not null
        and (suggested_metadata->'catalog_image_trim') is null
        -- The person's own picture (their scan photo, an upload, a crop of
        -- one) is not a catalog shot and is left exactly as they chose it.
        and coalesce(suggested_metadata->>'catalog_source', '') not in ('yours', 'upload', 'crop')
      order by created_at desc
      limit ${RETRIM_PER_TICK}
    `.compile(tdb);
    rows = (await tdb.executeQuery(q)).rows as UntrimmedRow[];
  });
  let trimmed = 0;
  for (const row of rows) {
    const verdict = await retrimRow(orgId, row);
    if (verdict.status === "trimmed") trimmed++;
  }
  return { visited: rows.length, trimmed };
}

/** Read the stored picture back, trim it if the trim says so, stamp the
 *  verdict. A file that cannot be read is stamped `failed` so it is not read
 *  again every tick. */
export async function retrimRow(orgId: string, row: UntrimmedRow): Promise<TrimVerdict> {
  const file =
    (await platform().files.read(orgId, row.catalog_image_file_id, "original").catch(() => null)) ??
    (await platform().files.read(orgId, row.catalog_image_file_id, "medium").catch(() => null));
  let verdict: TrimVerdict;
  let newFileId: string | null = null;
  if (!file) {
    verdict = { status: "failed", reason: "undecodable" };
  } else {
    const out = await trimCatalogMarginsWithVerdict(new Uint8Array(file.bytes));
    verdict = out.verdict;
    if (out.bytes && out.verdict.status === "trimmed") {
      const written = await platform().files.write(orgId, out.bytes, { filename: `trimmed-${row.catalog_image_file_id}.jpg`, mimeType: "image/jpeg" });
      if (written) newFileId = written.fileId;
      else verdict = { status: "failed", reason: "undecodable" };
    }
  }
  const stamp = newFileId ? { ...verdict, untrimmed_file_id: row.catalog_image_file_id } : verdict;
  await platform().tenants.withDb(orgId, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    const q = sql`
      update core_scan_inbox_items
         set suggested_metadata = coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ catalog_image_trim: stamp })}::jsonb,
             ${newFileId ? sql`catalog_image_file_id = ${newFileId},` : sql``}
             updated_at = now()
       where id = ${row.id}
         and catalog_image_file_id = ${row.catalog_image_file_id}
    `.compile(tdb);
    await tdb.executeQuery(q);
  });
  return verdict;
}
