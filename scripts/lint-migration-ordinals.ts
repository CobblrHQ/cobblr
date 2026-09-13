// Guard: two migrations in the same directory must not share an ordinal:
// the platform's `YYYYMMDD-NNN` prefix, or a module's `NNNN_` prefix.
//
// Migrations apply in filename order, and a duplicate ordinal makes the order
// between the two files depend on the rest of the name. The runner that applies
// them sorts by full filename and copes. The trap was elsewhere: the boot-time
// PRE-CHECK that decides whether to call the runner at all compared a
// workspace's last applied name with the module's sorted-last name, and a
// second file under the same ordinal that sorts BEFORE the first never moves
// the sorted-last name. On 2026-09-13 core-scan's `0027_batch_read_state.sql`
// (b) landed beside `0027_inbox_placed_at.sql` (i), every workspace read as
// current, and the file went unapplied for four hours while the inbox list
// selected its column (#2944). The pre-check now counts the ledger as well
// (api/src/modules/migration-currency.ts), so the pairs baselined below are
// SAFE AGAIN, not benign by nature: they are kept only because migrations are
// immutable once merged and cannot be renamed. NOTHING new may be added.
//
// It read only the platform shape until 2026-09-13, when two branches off the
// same main each took core-scan's 0027 and it printed "no new duplicate
// ordinals" on a tree that had one (#2910). A module migration is `NNNN_name.sql`;
// both shapes are read now. Take the next free ordinal at PR time, against
// origin/main, not against the main you branched from.
// Run: npx tsx scripts/lint-migration-ordinals.ts

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ordinalOf } from "./lib/migration-ordinal.js";

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

// Pre-existing duplicate ordinals (dir → ordinal). Immutable history, made safe
// by the count-aware pre-check (see the header). NOTHING new may be added here.
const BASELINE = new Set<string>([
  "api/migrations/platform|20260617-065",
  "api/migrations/platform|20260702-071",
  "api/migrations/platform|20260821-107",
  // Module pairs the widened lint found on the day it learned to read them
  // (2026-09-13, #2910): two older ones, and #2904 against #2908, branched
  // from one main, both taking core-scan's 0027. Benign for the same reason,
  // and just as immutable.
  "modules/core-scan/migrations|0003",
  "modules/core-scan/migrations|0027",
  "modules/digifab/migrations|0028",
]);

const problems: string[] = [];

for (const dir of migrationDirs()) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  const byOrd = new Map<string, string[]>();
  for (const f of readdirSync(abs)) {
    if (!f.endsWith(".sql")) continue;
    const ord = ordinalOf(f);
    if (!ord) continue;
    const list = byOrd.get(ord) ?? [];
    list.push(f);
    byOrd.set(ord, list);
  }
  for (const [ord, files] of byOrd) {
    if (files.length > 1 && !BASELINE.has(`${dir}|${ord}`)) {
      problems.push(`${dir}: ordinal ${ord} used by ${files.length} files — ${files.join(", ")}`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    "lint:migration-ordinals — two migrations share an ordinal (YYYYMMDD-NNN, or NNNN_ in a module):\n",
  );
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    "\nGive the new migration the next free ordinal in that directory. Migrations are\nimmutable once merged, so fix this BEFORE the file lands.",
  );
  process.exit(1);
}

console.log("lint:migration-ordinals — no new duplicate ordinals.");
