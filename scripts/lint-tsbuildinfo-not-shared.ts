// TypeScript's incremental cache must not live in node_modules.
//
// Worktrees SHARE node_modules — new-worktree.sh symlinks it from the main
// checkout so a new branch does not cost a reinstall. web/tsconfig.app.json put
// its tsBuildInfoFile under ./node_modules/.tmp/, so every worktree on this
// machine shared ONE cache.
//
// `tsc -b` decides a project is up to date by comparing input timestamps to
// that file. Another agent's typecheck writes it; your files are older; tsc
// reports success WITHOUT READING THEM. On 2026-09-04 a PR was pushed with a
// locally-green typecheck and turned main red, and the next person's local run
// also passed on the broken tree — same cause, twice, half an hour apart.
//
// A false green from a check people run precisely to avoid this is worse than
// having no check: it is trusted.
//
// So the cache goes anywhere worktree-local (dist/ is gitignored and per
// worktree). If a config genuinely must sit under node_modules, say why:
//
//     // shared-tsbuildinfo-ok: <reason>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tsconfigs(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "dist" || e === "build") continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) tsconfigs(p, out);
    else if (/^tsconfig(\.[\w-]+)?\.json$/.test(e)) out.push(p);
  }
  return out;
}

const bad: Array<{ file: string; value: string }> = [];
for (const f of tsconfigs(ROOT)) {
  const src = readFileSync(f, "utf8");
  if (/shared-tsbuildinfo-ok:/.test(src)) continue;
  const m = /"tsBuildInfoFile"\s*:\s*"([^"]+)"/.exec(src);
  const value = m?.[1];
  if (value && /(^|\/)node_modules\//.test(value)) bad.push({ file: relative(ROOT, f), value });
}

if (bad.length) {
  console.error("lint:tsbuildinfo-not-shared - an incremental cache that every worktree shares:\n");
  for (const b of bad) console.error(`  ${b.file}\n    ${b.value}\n`);
  console.error(
    "Worktrees share node_modules (new-worktree.sh symlinks it), so a cache in\n" +
      "there is shared too. `tsc -b` then trusts another worktree's timestamps and\n" +
      "reports success without reading your files — a typecheck that passes on a\n" +
      "broken tree, which is exactly what people run it to prevent.\n\n" +
      "Put it somewhere worktree-local, e.g. ./dist/.tsbuildinfo/<name>.tsbuildinfo\n",
  );
  process.exit(1);
}
console.log("lint:tsbuildinfo-not-shared - no incremental cache is shared between worktrees.");
