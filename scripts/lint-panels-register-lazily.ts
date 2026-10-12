#!/usr/bin/env tsx
// A panel registered at boot passes a lazy component, lazy(() => import(...)), so registering it adds a line to the first load and never the panel.
//
// THE BUG THIS PREVENTS. Detail panels register before anything renders
// (#5954), so main.tsx loads their registrations at boot. A registration
// that hands over a component imported at the top of the file pulls that
// panel, and everything it imports, into the first load of every page. The
// dashboard's first load reached 349.6 of its 350 KB on 2026-10-12 (#5971),
// and each new panel would have added its whole weight.
//
// THE RULE. The component argument of registerDetailPanel or
// registerViewToolbar (any register...Panel) is written in place as
// lazy(() => import("...")...), the import inside a function so the bundler
// makes it its own chunk. A component passed by name, or a lazy() over a
// static import, fails. A genuine exception says why on the call or in the
// line above:
//   // EAGER-PANEL: <why>
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The definitions in
// packages/platform-web/src/panels.tsx take a parameter named `component`
// and pass it on; that is not a registration, so the file that defines the
// registry is not judged. Nothing else has tested the boundary yet.
//
// PROVE IT RED: a registration written as registerDetailPanel("x", XPanel)
// with XPanel imported at the top fails (the unit test holds it).
//
//   npx tsx scripts/lint-panels-register-lazily.ts   (pnpm lint panels-register-lazily)
import { readFileSync } from "node:fs";
import ts from "typescript";
import { repoFiles } from "./lib/repo-files.js";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];
const DEFINES = "packages/platform-web/src/panels.tsx";
const REGISTERS = /^register(\w*Panel|ViewToolbar)$/;
const EAGER_OK = /EAGER-PANEL: \S/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** lazy(() => import("x")) or lazy(() => import("x").then(...)): the import is inside the function. */
function isLazyImport(e: ts.Expression): boolean {
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== "lazy") return false;
  const fn = e.arguments[0];
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  let dynamic = false;
  const look = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic = true;
    if (!dynamic) ts.forEachChild(n, look);
  };
  look(fn.body);
  return dynamic;
}

export function check(file: string, src: string): Violation[] {
  if (file === DEFINES || !/\bregister\w*(Panel|ViewToolbar)\s*\(/.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split("\n");
  const out: Violation[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && REGISTERS.test(n.expression.text)) {
      const component = n.arguments[1];
      const at = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const excused = EAGER_OK.test(lines[at] ?? "") || EAGER_OK.test(lines[at - 1] ?? "");
      if (component && !isLazyImport(component) && !excused)
        out.push({ file, line: at + 1, what: `${n.expression.text}("${(n.arguments[0] as ts.StringLiteral | undefined)?.text ?? "?"}", ...) hands over a component that is not lazy(() => import(...)): it loads with every page` });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const file of repoFiles(ROOTS).filter((f: string) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))) violations.push(...check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:panels-register-lazily - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error('Register it as lazy(() => import("./x").then((m) => ({ default: m.XPanel }))). A genuine exception: // EAGER-PANEL: <why>');
    process.exit(1);
  }
  console.log("lint:panels-register-lazily OK");
}
