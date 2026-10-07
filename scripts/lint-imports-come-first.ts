#!/usr/bin/env tsx
// A file the web app serves declares nothing above an import, because Vite's dev server turns a named import into a binding declared where the import sits, and code above it reaches that binding before it exists.
//
// THE BUG THIS PREVENTS. On 2026-10-07 b484fc37 put const RecentlyDeletedPage = lazy(...) on line 1 of web/src/App.tsx, above the react import: every page on the dev server threw 'Cannot access lazy before initialization', and a walk on a dev rig failed 406 steps. The production build hoists imports, so it built, typechecked and passed.
//
// THE RULE. In a file the web app serves, no top-level statement reads, as
// the module loads, a name an import further down brings in. `const X =
// lazy(...)` above `import { lazy }` fails; the same line below it passes,
// and so does a statement above an import that reads only what is already
// imported, or reads the later name inside a function body (which runs after
// every import). Read with TypeScript's own parser.
//
// THE NEAR-MISS THAT DREW IT. "Nothing above an import" was the first draft,
// and it flagged 544 statements: App.tsx alone interleaves its lazy pages with
// its imports, all after the react import, and none of them crash. The crash
// is a read of a binding before its import, so that is the rule. Then three
// re-exports (`export { captionBox } from "..."` above `import { captionBox }`
// in bluetooth-label.ts, field-note.ts and the builds ui) read the other
// module's binding, not this file's, so a re-export is never a read.
//
// THE BOUNDARY. What the dev server serves: web/src, the shared web package,
// and each module's own ui (modules/<name>/src/ui). Not the api or a
// module's server code, which node runs as real modules where an import is
// hoisted and the order does not matter; tests are left out the same way.
//
//   npx tsx scripts/lint-imports-come-first.ts   (pnpm lint imports-come-first)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", ...readdirSync("modules").map((m) => join("modules", m, "src", "ui"))];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The names an import brings in, by the import's position in the file. */
function importedNames(s: ts.ImportDeclaration): string[] {
  const c = s.importClause;
  if (!c || c.isTypeOnly) return [];
  const names: string[] = [];
  if (c.name) names.push(c.name.text);
  const b = c.namedBindings;
  if (b && ts.isNamespaceImport(b)) names.push(b.name.text);
  if (b && ts.isNamedImports(b)) for (const el of b.elements) if (!el.isTypeOnly) names.push(el.name.text);
  return names;
}

/** Identifiers a statement reads while the module loads: not inside a
 *  function body, which runs later, and not in a type. */
function eagerReads(node: ts.Node, out: Set<string>): void {
  if (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return;
  if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
  if (ts.isIdentifier(node)) out.add(node.text);
  ts.forEachChild(node, (c) => eagerReads(c, out));
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const top = [...sf.statements];
  const out: Violation[] = [];
  top.forEach((s, i) => {
    if (ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s)) return;
    // `export { x } from "./y"` reads y's binding, never this file's import of x.
    if (ts.isExportDeclaration(s) && s.moduleSpecifier) return;
    const later = new Set(top.slice(i + 1).flatMap((x) => (ts.isImportDeclaration(x) ? importedNames(x) : [])));
    if (!later.size) return;
    const reads = new Set<string>();
    eagerReads(s, reads);
    const early = [...reads].filter((n) => later.has(n));
    if (!early.length) return;
    const line = sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1;
    out.push({ file, line, what: `reads ${early.join(", ")} while the module loads, above the import that brings it in` });
  });
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:imports-come-first - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Move the statement below the file's last import.");
  process.exit(1);
}
console.log(`lint:imports-come-first OK`);
