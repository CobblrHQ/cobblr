#!/usr/bin/env tsx
// A module doc with its own folder is only an index: its one section lists the pages under docs/modules/<name>/, so a new part is a new page and two PRs never edit one file.
//
// THE BUG THIS PREVENTS. docs/modules/core-integrations.md was in 6 of a
// week's 224 merge re-checks (#7386), two of them as the only file the PR and
// main shared: every integration PR appended a dated section to the one doc.
// Splitting it into pages fixes that once; without a rule the next PR appends
// its section to the index and the hotspot is back.
//
// THE RULE. When docs/modules/<name>/ exists, docs/modules/<name>.md holds its
// title, an intro before the first section, and only the sections "The pages"
// and "Related docs". Any other heading, at any level, fails and names the
// folder its text belongs in. Every page in the folder is linked from the
// index, and every link the index makes into the folder is to a page that
// exists, so a page is never orphaned and the list never lies.
//
// THE BOUNDARY. Only a top-level module doc with a folder beside it: a doc
// with no folder is still one page, and lint:module-doc-grows-into-its-directory
// is what sends a long one into a folder. The intro may be edited (a status
// line, a sentence on what the module is): it changes rarely and is not where
// features land. Nothing has tested the edge yet beyond the splits themselves.
//
//   npx tsx scripts/lint-module-doc-index-stays-an-index.ts   (pnpm lint module-doc-index-stays-an-index)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULE_DOCS = "docs/modules";
const ALLOWED = new Set(["the pages", "related docs"]);

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The verdict on one index, given the pages its folder holds. Pure. */
export function check(name: string, src: string, pages: string[]): Violation[] {
  const file = `${MODULE_DOCS}/${name}.md`;
  const out: Violation[] = [];
  let fence: string | null = null;
  let titled = false;
  src.split("\n").forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      fence = fence ? (f[1]![0] === fence ? null : fence) : f[1]![0]!;
      return;
    }
    if (fence) return;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (!h) return;
    if (h[1] === "#" && !titled) {
      titled = true;
      return;
    }
    if (h[1] === "##" && ALLOWED.has(h[2]!.toLowerCase())) return;
    out.push({ file, line: i + 1, what: `"${h[2]}" is a section on the index. Write it as a page in ${MODULE_DOCS}/${name}/ and list it under "The pages"` });
  });
  const linked = new Set<string>();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of src.matchAll(new RegExp(`\\]\\((?:\\./)?${escaped}/([^)#\\s]+\\.md)(?:#[^)]*)?\\)`, "g"))) linked.add(m[1]!);
  for (const p of linked) if (!pages.includes(p)) out.push({ file, line: 1, what: `links ${name}/${p}, which does not exist` });
  for (const p of pages) if (!linked.has(p)) out.push({ file, line: 1, what: `${MODULE_DOCS}/${name}/${p} is not listed under "The pages"` });
  return out;
}

/** Every .md under a folder, as paths relative to it. */
function pagesIn(dir: string, at = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(dir, at)).sort()) {
    const rel = at ? `${at}/${n}` : n;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...pagesIn(dir, rel));
    else if (n.endsWith(".md")) out.push(rel);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  let indexes = 0;
  for (const n of readdirSync(MODULE_DOCS).sort()) {
    const dir = join(MODULE_DOCS, n);
    if (!statSync(dir).isDirectory() || !existsSync(`${dir}.md`)) continue;
    indexes++;
    violations.push(...check(n, readFileSync(`${dir}.md`, "utf8"), pagesIn(dir)));
  }
  if (violations.length) {
    console.error(`lint:module-doc-index-stays-an-index - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error(`A module doc with a folder is an index: a new part is a new page in the folder, so two PRs in one module never edit one file (#7386).`);
    process.exit(1);
  }
  console.log(`lint:module-doc-index-stays-an-index OK (${indexes} index(es), every page listed)`);
}
