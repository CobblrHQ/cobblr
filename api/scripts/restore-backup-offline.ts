// OFFLINE (pg-native) backup restore — the disaster path (2026-07 audit F8:
// "if the Cobblr API is broken, there's no raw path to restore a backup zip
// without the app running").
//
// Restores a Cobblr backup zip's DATA straight into an EXISTING tenant
// database with nothing but Postgres access — no api, no blueprint apply.
// Use when the api won't boot but the tenant DB still has its schema (the
// normal disaster: bad image, broken migration, dead box with a DB dump).
//
//   cd api && TENANT_DATABASE_URL=postgres://<superuser>@host/tenant_xxx \
//     npx tsx scripts/restore-backup-offline.ts /path/to/backup.zip [--replace] [--dry-run]
//
//   --dry-run   parse + report what would load, write nothing
//   --replace   TRUNCATE each target table before loading (default: refuse
//               to load into a non-empty table)
//
// What it does NOT do (use the in-app restore for these — this is the
// last-resort data path, not a replacement):
//   • blueprint apply — modules/tables must already exist; dumped tables
//     missing from the target are SKIPPED and reported.
//   • file restore — uploaded file BYTES are in the zip under files/ and are
//     extracted alongside the zip (<zip>.files/) for manual placement; the
//     core_files pipeline (variants, rows) needs the app.
//   • file-id remapping — ids are preserved verbatim (that's the point).
//
// Superuser required: inserts run with session_replication_role=replica
// (FK triggers off) so preserved ids load in any order — same trick as the
// in-app restore.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import unzipper from "unzipper";
import { Pool } from "pg";
import { guardPoolClients } from "../src/db/client-error-guard.js";

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry-run");
  const replace = process.argv.includes("--replace");
  const zipPath = args[0];
  const dbUrl = process.env.TENANT_DATABASE_URL;
  if (!zipPath || !dbUrl) {
    console.error(
      "Usage: TENANT_DATABASE_URL=postgres://<superuser>@host/tenant_xxx npx tsx scripts/restore-backup-offline.ts <backup.zip> [--replace] [--dry-run]",
    );
    process.exit(2);
  }

  const dir = await unzipper.Open.buffer(readFileSync(zipPath));
  const tables = new Map<string, Array<Record<string, unknown>>>();
  let fileCount = 0;
  let manifestSeen = false;
  const filesOut = `${zipPath}.files`;
  for (const entry of dir.files) {
    if (entry.type !== "File") continue;
    if (entry.path === "manifest.json") {
      manifestSeen = true;
      continue;
    }
    if (entry.path.startsWith("data/") && entry.path.endsWith(".jsonl")) {
      const table = basename(entry.path, ".jsonl");
      const rows = (await entry.buffer())
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      tables.set(table, rows);
    } else if (entry.path.startsWith("files/")) {
      fileCount++;
      if (!dryRun) {
        mkdirSync(filesOut, { recursive: true });
        writeFileSync(join(filesOut, basename(entry.path)), await entry.buffer());
      }
    }
  }
  if (!manifestSeen) {
    console.error("Not a Cobblr backup: manifest.json missing from the zip.");
    process.exit(1);
  }
  const totalRows = [...tables.values()].reduce((n, r) => n + r.length, 0);
  console.log(`${tables.size} dumped table(s), ${totalRows} row(s), ${fileCount} file blob(s).`);

  const pool = new Pool({ connectionString: dbUrl });
  // A pool 'error' with no listener terminates Node outright, so a database
  // blip mid-restore would abort with a raw unhandled-event stack rather than
  // saying what happened. This is a RESTORE: the operator needs to know whether
  // it stopped, and where.
  guardPoolClients(pool, "restore-backup");
  pool.on("error", (err) => {
    console.error("[restore] database connection error:", (err as Error).message);
  });
  const existing = new Set(
    (
      await pool.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public'",
      )
    ).rows.map((r) => r.tablename),
  );
  const loadable = [...tables.keys()].filter((t) => existing.has(t) && t !== "migrations");
  const skipped = [...tables.keys()].filter((t) => !existing.has(t));
  if (skipped.length > 0) {
    console.log(
      `SKIPPING ${skipped.length} table(s) missing from the target (their module isn't installed/migrated): ${skipped.join(", ")}`,
    );
  }
  if (dryRun) {
    for (const t of loadable) console.log(`  would load ${t}: ${tables.get(t)!.length} row(s)`);
    console.log("(dry-run: nothing written)");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    for (const t of loadable) {
      const rows = tables.get(t)!;
      const { rows: cnt } = await client.query(`select count(*)::int as n from "${t}"`);
      if ((cnt[0]?.n ?? 0) > 0) {
        if (!replace) {
          throw new Error(`table "${t}" is not empty — re-run with --replace to truncate targets first`);
        }
        await client.query(`truncate table "${t}" cascade`);
      }
      // Column intersection: dumped rows may carry columns a newer/older
      // schema lacks — load what fits, report what didn't. data_type drives
      // encoding: json/jsonb columns need JSON text even for SCALAR values
      // (a bare string fails "invalid input syntax for type json"); ARRAY
      // columns take the JS array as-is (the pg driver encodes it).
      const { rows: colRows } = await client.query<{ column_name: string; data_type: string }>(
        "select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1",
        [t],
      );
      const colType = new Map(colRows.map((c) => [c.column_name, c.data_type]));
      let loaded = 0;
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => colType.has(k));
        if (keys.length === 0) continue;
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const values = keys.map((k) => {
          const v = row[k];
          if (v === null) return null;
          const dt = colType.get(k);
          if (dt === "json" || dt === "jsonb") return JSON.stringify(v);
          if (dt === "ARRAY") return Array.isArray(v) ? v : [v];
          return typeof v === "object" ? JSON.stringify(v) : v;
        });
        await client.query(
          `insert into "${t}" (${keys.map((k) => `"${k}"`).join(", ")}) values (${placeholders})`,
          values,
        );
        loaded++;
      }
      console.log(`  ${t}: ${loaded}/${rows.length} row(s)`);
    }
    await client.query("commit");
    console.log(
      `Done. File blobs extracted to ${fileCount > 0 ? filesOut : "(none)"} — run the in-app restore later if you need the files pipeline (variants + core_files rows).`,
    );
  } catch (err) {
    await client.query("rollback");
    console.error("Rolled back — nothing changed:", (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
