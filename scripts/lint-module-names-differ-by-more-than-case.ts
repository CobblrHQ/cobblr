#!/usr/bin/env tsx
// No two source files in one directory have names that differ only by case once the extension is gone, because an import names the module without one and a case-blind resolver picks either.
//
// THE BUG THIS PREVENTS. 2026-10-12 to 10-14: platform-web's Swatch.tsx beside swatch.ts; the e2e nightly's build resolved ./swatch to Swatch.tsx and every page timed out for three nights
//
// The e2e nightly's dev build resolved `./swatch` to Swatch.tsx where swatch.ts was meant ("No matching export
// ... for import pickThumb"), served nothing, and every page timed out: three nightly runs red before anyone read
// why. A macOS checkout (case-insensitive by default) is the same trap.
//
// THE RULE. Among tracked source files (.ts .tsx .js .jsx .mjs .cjs .mts .cts), no two in one directory have
// names that are the same once the extension is gone and case is ignored, unless they are spelled the same
// (index.ts beside index.d.ts is fine). Rename one: an import names the module without its extension.
//
// THE BOUNDARY. Test files (*.test.*, *.spec.*) are never imported, so NewBinSheet.tsx beside
// newBinSheet.test.ts is not a collision. Paths are compared within one directory: two directories may each
// have a swatch.ts.
//
// PROVE IT RED: on main before #this change it names packages/platform-web/src (Swatch.tsx, swatch.ts) and
// ops-console/src (Coverage.tsx, coverage.ts).
//
//   npx tsx scripts/lint-module-names-differ-by-more-than-case.ts   (pnpm lint module-names-differ-by-more-than-case)
import { repoFiles } from "./lib/repo-files.ts";
import { fileURLToPath } from "node:url";

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST = /\.(test|spec)\.[^/]+$/;

/** PURE. Each directory whose module names collide once case is ignored, with the files that collide. */
export function collisions(paths: string[]): Array<{ dir: string; files: string[] }> {
  const groups = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!SOURCE.test(p) || TEST.test(p) || p.endsWith(".d.ts") || p.endsWith(".d.mts")) continue;
    const slash = p.lastIndexOf("/");
    const dir = slash < 0 ? "." : p.slice(0, slash);
    const file = p.slice(slash + 1);
    const stem = file.slice(0, file.indexOf("."));
    const key = `${dir}\u0000${stem.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(file);
  }
  const out: Array<{ dir: string; files: string[] }> = [];
  for (const [key, files] of groups) {
    const stems = new Set([...files].map((f) => f.slice(0, f.indexOf("."))));
    if (stems.size > 1) out.push({ dir: key.split("\u0000")[0]!, files: [...files].sort() });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const paths = repoFiles();
  const found = collisions(paths);
  if (found.length) {
    console.error(`lint:module-names-differ-by-more-than-case - ${found.length} directory(ies):`);
    for (const c of found) console.error(`  ${c.dir}: ${c.files.join(", ")}  (an import of either names the same module on a case-blind resolver)`);
    console.error("Rename one so the names differ by more than case.");
    process.exit(1);
  }
  console.log("lint:module-names-differ-by-more-than-case OK");
}
