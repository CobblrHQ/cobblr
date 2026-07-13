// Guard: NO zod `.passthrough()` in the platform. Every schema is strict
// (zod's default — unknown keys are dropped, not waved through). `.passthrough()`
// turns a validation gate into a hole: it lets arbitrary unvalidated keys into
// stored JSONB, and it HIDES schema drift instead of fixing it.
//
// Why this exists: a bundle's catalog-schema validator (CatalogEntry) had
// drifted from the module's copy and silently stripped `field_map` +
// `exclude_from_global_search`, breaking features on install. The first fix
// reached for `.passthrough()` — the platform's ONLY one — which papered over
// the real problem (two schemas that should be one). The right fix was a single
// shared schema (CatalogSchemaConfig). This lint stops the shortcut from coming
// back: if you think you need passthrough, you almost certainly need to add the
// key to the schema instead.
//
// A genuine, reviewed exception opts in with an inline marker on the same line
// or the line above:  `// lint-allow-passthrough: <reason>`
//
// Run: npx tsx scripts/lint-no-passthrough.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROOTS = ["api/src", "modules", "packages", "web/src"];
// The lint itself names the pattern; skip it.
const ALLOW_FILE_PREFIXES = ["scripts/lint-no-passthrough.ts"];
const ALLOW_MARKER = "lint-allow-passthrough:";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const offenders: string[] = [];
for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    const rel = relative(ROOT, file);
    if (ALLOW_FILE_PREFIXES.some((a) => rel.startsWith(a))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes(".passthrough(")) return;
      const here = line.includes(ALLOW_MARKER);
      const above = i > 0 && lines[i - 1]!.includes(ALLOW_MARKER);
      if (here || above) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
}

if (offenders.length > 0) {
  console.error(
    "[lint:no-passthrough] zod .passthrough() disables validation — the platform is strict.\n" +
      "  Add the missing key to the schema instead. If an exception is genuinely justified,\n" +
      "  mark the line with `// lint-allow-passthrough: <reason>`.\n",
  );
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log("✓ no-passthrough lint: no zod .passthrough() (strict schemas everywhere).");
