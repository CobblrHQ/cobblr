#!/usr/bin/env tsx
// The platform contract's index.ts holds only re-exports: a declaration goes in its surface's file under packages/platform-contract/src/, so two PRs adding unrelated types never edit one file.
//
// THE BUG THIS PREVENTS. packages/platform-contract/src/index.ts was 8,507
// lines with 414 exports and in 10 of a week's 224 merge re-checks (#7381):
// every new contract type (calendar sources, module actions, auth) was written
// into the one barrel, so any two of those PRs touched the same file and the
// merge queue sent the green one back to re-run.
//
// THE RULE. Outside comments and blank lines, index.ts holds only
// `export ... from "..."` statements. A declaration, an import, or a local
// `export { x }` fails, naming the surface file whose name best matches what
// was declared. The surfaces are the files the index already re-exports with
// `export * from`; a new surface is a new file plus one line here.
//
// THE BOUNDARY. Only the package's index: the surface files hold declarations
// by design. A re-export line may be added or removed freely: one line per
// surface collides far less often than a declaration body does. Nothing has
// tested the edge yet beyond the split itself.
//
//   npx tsx scripts/lint-contract-index-only-re-exports.ts   (pnpm lint contract-index-only-re-exports)
import { readFileSync } from "node:fs";

const INDEX = "packages/platform-contract/src/index.ts";
const PKG = "@cobblr/platform-contract/";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.replace(/s$/, ""));

/** The surface whose name shares the most words with a declared name. Pure. */
export function surfaceFor(name: string, surfaces: string[]): string | null {
  const want = new Set(words(name));
  let best: { s: string; n: number } | null = null;
  for (const s of surfaces) {
    const n = words(s).filter((w) => want.has(w)).length;
    if (n > (best?.n ?? 0)) best = { s, n };
  }
  return best?.s ?? null;
}

/** The verdict on the index's text. Pure. */
export function check(src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const surfaces = [...src.matchAll(/^export \* from "@cobblr\/platform-contract\/([^"]+)";$/gm)].map((m) => m[1]!);
  let inExport = false;
  let inComment = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (inComment) {
      if (t.includes("*/")) inComment = false;
      return;
    }
    if (inExport) {
      if (/^}\s*from\s+"[^"]+";$/.test(t)) inExport = false;
      return;
    }
    if (t === "" || t.startsWith("//")) return;
    // A declaration's body is reported once, at the statement that opens it.
    if (/^\s/.test(line) || /^[}\])]/.test(t)) return;
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inComment = true;
      return;
    }
    if (/^export (type )?(\* |\* as \w+ |\{[^}]*\} )from\s+"[^"]+";$/.test(t)) return;
    if (/^export (type )?\{$/.test(t)) {
      inExport = true;
      return;
    }
    const declared = t.match(/^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/)?.[1];
    const s = declared ? surfaceFor(declared, surfaces) : null;
    const where = s ? `packages/platform-contract/src/${s}.ts` : "the surface file it belongs to under packages/platform-contract/src/ (or a new one, re-exported here)";
    out.push({ file: INDEX, line: i + 1, what: declared ? `declares ${declared}: put it in ${where}` : `"${t.slice(0, 60)}" is not a re-export: put it in ${where}` });
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = readFileSync(INDEX, "utf8");
  const violations = check(src);
  if (!src.includes(`export * from "${PKG}`)) violations.push({ file: INDEX, line: 1, what: "re-exports no surface file" });
  if (violations.length) {
    console.error(`lint:contract-index-only-re-exports - ${violations.length} violation(s):`);
    for (const v of violations.slice(0, 40)) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    if (violations.length > 40) console.error(`  ... and ${violations.length - 40} more`);
    console.error("The contract's index only re-exports, so two PRs adding unrelated contract types never edit one file (#7381).");
    process.exit(1);
  }
  console.log("lint:contract-index-only-re-exports OK");
}
