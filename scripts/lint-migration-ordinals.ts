// Guard: two migrations in the same directory must not share an ordinal
// (the `YYYYMMDD-NNN` prefix).
//
// Migrations apply in filename order, and a duplicate ordinal makes the order
// between the two files depend on the rest of the name — deterministic today
// (the runner sorts by full filename), but a latent trap: the next person who
// assumes "NNN" alone orders them, or a runner that sorts only by the ordinal,
// gets a silent reordering that can run a migration before the one it depends
// on. Three such pairs already exist and are benign; they are baselined below so
// the lint blocks NEW collisions without churning history (migrations are
// immutable once merged, so they cannot be renamed).
// Run: npx tsx scripts/lint-migration-ordinals.ts

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Directories that hold ordered .sql migrations.
function migrationDirs(): string[] {
  const dirs: string[] = ["api/migrations/platform", "api/migrations/tenant-base"];
  const modules = join(ROOT, "modules");
  if (existsSync(modules)) {
    for (const m of readdirSync(modules)) {
      const d = join("modules", m, "migrations");
      if (existsSync(join(ROOT, d))) dirs.push(d);
    }
  }
  return dirs;
}

// Pre-existing duplicate ordinals (dir → ordinal), benign because the runner
// sorts by full filename. NOTHING new may be added here.
const BASELINE = new Set<string>([
  "api/migrations/platform|20260617-065",
  "api/migrations/platform|20260702-071",
  "api/migrations/platform|20260821-107",
]);

const ORD = /^(\d{8}-\d+)/;
const problems: string[] = [];

for (const dir of migrationDirs()) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  const byOrd = new Map<string, string[]>();
  for (const f of readdirSync(abs)) {
    if (!f.endsWith(".sql")) continue;
    const m = ORD.exec(f);
    if (!m) continue;
    const list = byOrd.get(m[1]!) ?? [];
    list.push(f);
    byOrd.set(m[1]!, list);
  }
  for (const [ord, files] of byOrd) {
    if (files.length > 1 && !BASELINE.has(`${dir}|${ord}`)) {
      problems.push(`${dir}: ordinal ${ord} used by ${files.length} files — ${files.join(", ")}`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    "lint:migration-ordinals — two migrations share an ordinal (YYYYMMDD-NNN):\n",
  );
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    "\nGive the new migration the next free ordinal in that directory. Migrations are\nimmutable once merged, so fix this BEFORE the file lands.",
  );
  process.exit(1);
}

console.log("lint:migration-ordinals — no new duplicate ordinals.");
