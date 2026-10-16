#!/usr/bin/env tsx
// Person-facing engine words use the server's configured product name.
// The ratchet covers server strings and browser strings, including template
// continuations and JSX text. Fixed protocol identifiers, upstream project
// names and named apps explain themselves with PRODUCT-NAME beside the literal.
// --update only shrinks scripts/product-name-baseline.json.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/platform", "api/src/routes", "api/src/lib", "web/src", "packages/platform-web/src"];

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
    // Embedded builds hold no code to judge. The featured bundle catalog holds
    // upstream authors and published app content, rather than engine chrome.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p) && p !== "web/src/lib/featured-bundles.ts") yield p;
  }
}

const BASELINE_PATH = "scripts/product-name-baseline.json";
const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

/** Every literal naming the product on a code line, less those that say why. */
function literals(src: string, file: string): number[] {
  if (!/\bCobblrs?\b/.test(src)) return [];
  const out: number[] = [];
  const lines = src.split("\n");
  const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const raw = node.getText(ast);
      const match = /\bCobblrs?\b/.exec(raw);
      if (match) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast) + match.index).line;
        const startLine = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line;
        if (![lines[startLine - 1], ...lines.slice(startLine, line + 1)].some((l) => /PRODUCT-NAME: \S/.test(l ?? ""))) out.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const found = literals(src, file);
  const allowed = baseline[file] ?? 0;
  if (found.length <= allowed) return [];
  return found.map((line) => ({ file, line, what: `names the product as the literal Cobblr (${found.length} in this file, ${allowed} allowed)` }));
}

const counts: Record<string, number> = {};
if (process.argv.includes("--update")) {
  for (const root of ROOTS) for (const file of walk(root)) counts[file] = literals(readFileSync(file, "utf8"), file).length;
  const next: Record<string, number> = {};
  for (const [file, was] of Object.entries(baseline).sort()) { const now = Math.min(was, counts[file] ?? 0); if (now > 0) next[file] = now; }
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log(`lint:product-name-not-hard-coded baseline: ${Object.values(next).reduce((a, b) => a + b, 0)} literal(s) in ${Object.keys(next).length} file(s)`);
  process.exit(0);
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:product-name-not-hard-coded - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Name the product with `${productName()}` (server helper or platform-web, configured from /auth/config), or say why it is always Cobblr: // PRODUCT-NAME: <why>");
  process.exit(1);
}
console.log(`lint:product-name-not-hard-coded OK`);
