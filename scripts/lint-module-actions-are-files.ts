#!/usr/bin/env tsx
// A module whose actions are files of their own (it has src/actions/, which module.ts reads) declares none inline: a new inline action fails and names src/actions/, so two PRs adding unrelated actions never edit one file.
//
// THE BUG THIS PREVENTS. modules/core-scan/src/module.ts held 22 inline
// actions and was in 8 of a week's 224 merge re-checks (#7382): every scan PR
// that added an action edited the one array, so two of them collided there and
// the merge queue sent the green one back to re-run. core-scan's actions are
// now one file each under src/actions/, which module.ts reads in name order.
//
// THE RULE. A module that has src/actions/ (its module.ts reads that
// directory, docs/architecture/module-parts.md "One action, one file") may hold
// no element in its exposes.actions array literal: every action is a file. A
// module still declaring its actions inline is not judged until it moves them,
// so a PR adding an action to one of those (builds, inventory, sales …) is
// never told to use a directory its manifest does not read yet. Moving a
// module is its own change: make src/actions/, give module.ts the loader, and
// from then on this rule holds it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the elements of
// exposes.actions are counted, by parsing the manifest: an entity kind's own
// `actions` (record actions on a kind) and a family manifest
// (src/families/<f>/manifest.ts, already its own file) are not this array. A
// text count of `id: "<module>:` would also count kinds, so it is not used.
//
//   npx tsx scripts/lint-module-actions-are-files.ts   (pnpm lint module-actions-are-files)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { onlyChanged } from "./lib/lint-only-files.ts";

const MODULES = "modules";

/** The exposes.actions array literal's elements, with the line of the first
 *  one past what is allowed. Pure. */
function inlineActions(file: string, src: string): { count: number; lineOf: (i: number) => number } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.ArrayLiteralExpression | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "actions" && ts.isArrayLiteralExpression(n.initializer)) {
      const p = n.parent;
      if (ts.isObjectLiteralExpression(p) && ts.isPropertyAssignment(p.parent) && p.parent.name.getText(sf) === "exposes") found = n.initializer;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const els = (found as ts.ArrayLiteralExpression | null)?.elements ?? ts.factory.createNodeArray<ts.Expression>([]);
  return {
    count: els.filter((e) => ts.isObjectLiteralExpression(e)).length,
    lineOf: (i) => (els[i] ? sf.getLineAndCharacterOfPosition(els[i]!.getStart(sf)).line + 1 : 1),
  };
}

const violations: string[] = [];
for (const mod of readdirSync(MODULES).sort()) {
  const file = join(MODULES, mod, "src", "module.ts");
  if (!existsSync(file) || !existsSync(join(MODULES, mod, "src", "actions"))) continue;
  if (!onlyChanged(file)) continue;
  const { count, lineOf } = inlineActions(file, readFileSync(file, "utf8"));
  if (count === 0) continue;
  violations.push(`  ${file}:${lineOf(0)}  ${count} inline action(s) in a module whose actions are files: declare each in modules/${mod}/src/actions/NNN-<name>.ts`);
}

if (violations.length) {
  console.error(`lint:module-actions-are-files - ${violations.length} violation(s):`);
  for (const v of violations) console.error(v);
  console.error("An action is a file of its own that module.ts finds, so adding one touches nothing shared (#7382).");
  process.exit(1);
}
console.log("lint:module-actions-are-files OK");
