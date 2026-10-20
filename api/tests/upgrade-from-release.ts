import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { expect } from "vitest";

// An install on a past release, rebuilt in an in-process database: that release's own
// migrations, the rows it wrote (upgrade-baselines/<tag>.<scope>.sql), then every
// migration written since. Shared by the test that the migrations accept those rows and
// the ones that the boot heals repair them (#7679).

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "upgrade-baselines");

export const rel = (p: string) => p.replace(/\\/g, "/");
const platformDir = "api/migrations/platform";
const tenantDirs = (): string[] => [
  "api/migrations/tenant-base",
  ...readdirSync(join(ROOT, "modules"))
    .map((m) => `modules/${m}/migrations`)
    .filter((d) => existsSync(join(ROOT, d))),
];
const filesOf = (dir: string): string[] =>
  existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".sql")).sort().map((f) => `${dir}/${f}`) : [];

export interface Baseline { tag: string; sha: Map<string, string> }
// BOOT-READ-OK: a test helper; the api never imports it
export const baselines: Baseline[] = readdirSync(BASELINES)
  .filter((f) => /^\d{4}\.\d+\.\d+\.txt$/.test(f))
  .sort()
  .map((f) => ({
    tag: f.replace(/\.txt$/, ""),
    sha: new Map(readFileSync(join(BASELINES, f), "utf8").trim().split("\n").map((l) => { const [h, p] = l.split(/\s+/); return [p!, h!] as const; })),
  }));

// BOOT-READ-OK: a test helper; the api never imports it
export const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
// The sandbox database has no pgcrypto; gen_random_uuid() is built in.
// BOOT-READ-OK: a test helper; the api never imports it
const prepared = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/create\s+extension\s+(if\s+not\s+exists\s+)?"?pgcrypto"?[^;]*;/gi, "");

/** Apply files in order, each in its own transaction; a file that needs a table another
 *  module makes waits for a later round, as the runner reaches modules in their own order. */
async function applyAll(db: PGlite, paths: string[]): Promise<Array<{ path: string; error: string }>> {
  let pending = paths;
  let failed: Array<{ path: string; error: string }> = [];
  for (let round = 0; round < 6 && pending.length; round++) {
    failed = [];
    for (const path of pending) {
      await db.exec("begin");
      try {
        await db.exec(prepared(path));
        await db.exec("commit");
      } catch (e) {
        await db.exec("rollback");
        failed.push({ path, error: (e as Error).message });
      }
    }
    if (failed.length === pending.length) break;
    pending = failed.map((f) => f.path);
  }
  return failed;
}

export async function upgrade(tag: string, scope: "platform" | "tenant", baseline: Baseline, opts: { badRows?: boolean } = {}) {
  const dirs = scope === "platform" ? [platformDir] : tenantDirs();
  const all = dirs.flatMap(filesOf);
  const before = all.filter((p) => baseline.sha.has(p));
  const after = all.filter((p) => !baseline.sha.has(p));
  const db = new PGlite({ extensions: { pg_trgm } });
  const first = await applyAll(db, before);
  expect(first, `${tag}: the release's own migrations apply to an empty database`).toEqual([]);
  await db.exec(readFileSync(join(BASELINES, `${tag}.${scope}.sql`), "utf8"));
  // Rows the release wrote that a later fix stopped writing (the heals' input).
  if (opts.badRows) await db.exec(readFileSync(join(BASELINES, `${tag}.${scope}-bad-rows.sql`), "utf8"));
  const second = await applyAll(db, after);
  return { db, after, second };
}

