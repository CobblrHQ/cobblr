#!/usr/bin/env tsx
/**
 * lint:portable-sed — dev scripts must not use GNU-only sed syntax.
 *
 * These scripts run on the dev Mac, where sed is BSD. GNU-only syntax there does
 * not degrade, it ABORTS ("invalid command code T"), and under `set -e` the script
 * dies at that line with the real work silently unstarted.
 *
 * That is what `new-worktree.sh` did: a `;T;q` in the workspace-package scan killed
 * it before it linked node_modules, so every worktree created on this Mac came out
 * with no dependencies. The symptom appeared much later and somewhere else — a
 * fresh worktree failing `pnpm typecheck` with "tsx: command not found" — which
 * reads as a broken checkout, not as a sed flag. Several worktrees were in that
 * state before anyone noticed.
 *
 * A script that genuinely only ever runs on Linux (the CI box, the deploy box) may
 * opt out with a `# gnu-sed: <reason>` line anywhere in the file.
 */
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OPT_OUT = /#\s*gnu-sed:\s*\S/;

// `;T` / `;Q` / `;z` / `;F` inside a sed script, and \U \L \E case conversion.
const GNU_CMD = /sed[^|;]*'[^']*;\s*[TQFz]\s*(?:;|')/;
const GNU_CASE = /sed[^|;]*\\[ULE]/;
// GNU `sed -i` edits in place with no backup suffix; BSD sed REQUIRES one (`-i ''`).
const GNU_INPLACE = /\bsed\s+(?:-[a-zA-Z]+\s+)*-i(?:\s|$)/;

const files = readdirSync(join(ROOT, "scripts"), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".sh"))
  .map((e) => `scripts/${e.name}`);

const fails: string[] = [];
let checked = 0;

for (const rel of files) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  if (OPT_OUT.test(text)) continue; // declared Linux-only
  checked++;
  text.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith("#") || !s.includes("sed")) return;
    let why = "";
    if (GNU_CMD.test(s)) why = "GNU-only sed command (T/Q/F/z) — BSD sed aborts on it";
    else if (GNU_CASE.test(s)) why = "GNU-only \\U/\\L/\\E case conversion";
    else if (GNU_INPLACE.test(s) && !/-i\s*''/.test(s)) why = "`sed -i` with no suffix — BSD sed needs `-i ''`";
    if (why) {
      fails.push(
        `${rel}:${i + 1} ${why}.\n      ${s.slice(0, 110)}\n` +
          `      Portable alternative, or add \`# gnu-sed: <reason>\` if this only ever runs on Linux.`,
      );
    }
  });
}

if (fails.length) {
  console.error("lint:portable-sed FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`lint:portable-sed OK (${checked} macOS-run shell scripts checked)`);
