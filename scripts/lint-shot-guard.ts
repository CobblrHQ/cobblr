// Guard: every capture script must load e2e/shot-guard.mjs.
//
// A screenshot of a crashed page is worse than a missing one — it looks real,
// gets committed, and ships. The public docs carried a labels-queue shot of the
// "Something broke on this page." card for a month after the underlying React
// error was fixed, because the image was captured before the fix and nothing
// re-checked it.
//
// e2e/shot-guard.mjs patches Playwright so any page it hands out refuses to
// screenshot while the error boundary is up. The patch is process-wide once the
// module is in the graph, but a script that never imports it gets nothing. That
// is what this checks: if a file captures, the guard must be reachable from it.
//
// The alternative — asking 80-plus capture scripts to remember a check — is the
// thing that already failed.
//
// Run: npx tsx scripts/lint-shot-guard.ts

import { readFileSync, globSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const GUARD = "e2e/shot-guard.mjs";

const files = globSync("e2e/**/*.mjs").filter(
  (f) => !f.includes("node_modules") && !f.includes("/_tmp/") && f !== GUARD,
);
if (files.length === 0) {
  console.error("shot-guard lint: matched no e2e scripts — the check would pass vacuously.");
  process.exit(1);
}

const source = new Map<string, string>();
const read = (file: string) => {
  let text = source.get(file);
  if (text === undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    source.set(file, text);
  }
  return text;
};

/** Local (relative) specifiers a file imports, resolved to repo-relative paths. */
function localImports(file: string): string[] {
  const out: string[] = [];
  for (const m of read(file).matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
    out.push(relative(process.cwd(), resolve(dirname(file), m[1]!)));
  }
  return out;
}

/** Does the guard sit anywhere in this file's local module graph? */
function reachesGuard(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  for (const dep of localImports(file)) {
    if (dep === GUARD) return true;
    if (dep.endsWith(".mjs") && reachesGuard(dep, seen)) return true;
  }
  return false;
}

const captures = (text: string) =>
  text.split("\n").some((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return false;
    return /\.screenshot\s*\(/.test(line);
  });

const offenders = files.filter((f) => captures(read(f)) && !reachesGuard(f));

if (offenders.length > 0) {
  console.error(
    `shot-guard lint: ${offenders.length} capture script(s) do not load ${GUARD}, so they will\n` +
      `happily write a screenshot of a crashed page. Add this next to the playwright import:\n\n` +
      `  import "./shot-guard.mjs";\n\n` +
      offenders.map((f) => `  ${f}`).join("\n"),
  );
  process.exit(1);
}

console.log(`shot-guard lint: ok (${files.filter((f) => captures(read(f))).length} capture scripts guarded)`);
