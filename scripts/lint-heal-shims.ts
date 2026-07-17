// Guard: a one-shot boot heal shim must state its own retirement condition.
// The class: HISTORICAL DATA MIGRATION passes accrete in boot() because nothing
// records when each one is safe to delete — the two lens shims sat a month past
// their completed cutover before anyone checked. Every one-shot shim (a
// `migrate-*`/`backfill-*` file under api/src/platform, or any api/src file
// carrying the HISTORICAL DATA MIGRATION marker) must carry one of:
//   `DONE WHEN:` — the checkable condition under which the file gets deleted;
//   `PERMANENT RECONCILE` — an explicit declaration that it never terminates.
// The deletion pass itself is manual on purpose (it needs a human to run the
// DONE WHEN queries against prod/staging/dev), but the criterion being stated
// and greppable is what makes that pass possible at all.
//
// Run: npx tsx scripts/lint-heal-shims.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "api", "src");

const files: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) files.push(p);
  }
};
walk(SRC);

const failures: string[] = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  const base = f.split("/").pop() ?? "";
  const isShimByName =
    rel.startsWith("api/src/platform/") && /^(migrate|backfill)-.+\.ts$/.test(base);
  const src = readFileSync(f, "utf8");
  const isShimByMarker = src.includes("HISTORICAL DATA MIGRATION");
  if (!isShimByName && !isShimByMarker) continue;
  if (src.includes("DONE WHEN:") || src.includes("PERMANENT RECONCILE")) continue;
  failures.push(
    `${rel}: heal shim without a stated retirement condition — add a "DONE WHEN:" header (the checkable condition under which this file gets deleted) or "PERMANENT RECONCILE" if it genuinely never terminates`,
  );
}

if (failures.length) {
  console.error(`[lint:heal-shims] ${failures.length} shim(s) missing a retirement condition:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[lint:heal-shims] OK — every heal shim states DONE WHEN / PERMANENT RECONCILE`);
