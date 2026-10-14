#!/usr/bin/env tsx
// Record create and edit dialogs use RecordFormModal and never set their own width.
//
// THE BUG THIS PREVENTS. Record creation dialogs used small modal presets while editing the same record used a wide panel.
//
// THE RULE. A dialog with record-write calls in its enclosing component and
// editable fields uses RecordFormModal. That shell accepts no width override.
// No annotation bypasses it.
//
// THE BOUNDARY. Connect Bambu and Install the edge connector share a file
// with New machine, but configure services instead of writing records.
// Their own enclosing components carry no record-write calls. Read-only
// viewers and configuration dialogs keep the generic Modal.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-record-form-shell.ts   (pnpm lint record-form-shell)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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

const RECORD_WRITE = /\.(?:create|update|patch|save)(?:Part|Asset|Machine|Record|Order|Project|List|Metric|Entry|Location|Task|Tag|Make|Build|Maintenance|Item|Customer|Vendor|Need|DigifabJob|DigifabRun)(?:\b|[A-Z])/;

export function check(file: string, src: string): Violation[] {
  if (!src.includes("Modal") && !src.includes("dialog")) return [];
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];
  const components = new Map<string, ts.Node>();
  const imports = new Map<string, string>();
  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) imports.set(node.name.text, (node.propertyName ?? node.name).text);
    if (ts.isFunctionDeclaration(node) && node.name) components.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)) components.set(node.name.getText(tree), node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const writesRecord = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    const text = node.getText(tree);
    if (RECORD_WRITE.test(text) || /\.(?:setMetricFields|addNeed|instantiateTemplate)\(/.test(text) || text.includes("/modules/core-maintenance/entries") && /method: ["']POST["']/.test(text)) return true;
    if (/^modules\/(inventory|lists|tracking|projects|builds|knowledge|sales)\/src\/ui\//.test(file) && /\bapi\.(?:create|update|patch|save)\(/.test(text)) return true;
    for (const match of text.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
      const child = components.get(match[1]!);
      if (child && writesRecord(child, seen)) return true;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(tree);
      const name = imports.get(tag) ?? tag;
      const attrs = opening.attributes.getText(tree);
      if (name === "RecordFormModal" && /\b(?:size|style)=|(?:max-w-|min-w-|\bw-\[)/.test(attrs)) {
        out.push({ file, line: tree.getLineAndCharacterOfPosition(opening.getStart(tree)).line + 1, what: "RecordFormModal owns the width; remove the override" });
      }
      if (name === "Modal" || /\brole=["']dialog["']/.test(attrs) && /max-w-|\bwidth\s*:/.test(attrs)) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner) && !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) owner = owner.parent;
        const body = node.getText(tree);
        if (owner && writesRecord(owner) && (/<(?:form|input|select|textarea|FieldPack|CustomFieldsPanel)\b/.test(body) || writesRecord(node))) {
          out.push({ file, line: tree.getLineAndCharacterOfPosition(opening.getStart(tree)).line + 1, what: "A record create/edit dialog uses <Modal>; use <RecordFormModal> without a width preset" });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

if (process.argv[1]?.endsWith("lint-record-form-shell.ts")) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

  if (violations.length) {
    console.error(`lint:record-form-shell - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Use RecordFormModal; the shared shell owns record form sizing.");
    process.exit(1);
  }
  console.log(`lint:record-form-shell OK`);

}
