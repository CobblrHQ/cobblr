#!/usr/bin/env tsx
// A walk check or action lives in its own file under scripts/walk/checks/ or scripts/walk/actions/, never as a branch in scripts/walk.mjs, so two PRs that add unrelated checks touch no common file.
//
// THE BUG THIS PREVENTS. scripts/walk.mjs was the merge queue's sixth re-check
// hotspot in the week to 2026-10-19 (#7384): every new check was another
// `if ("x" in c)` in its one judge() and every new action another `if (a.x)`
// in its one act(), so any two PRs that each added one collided.
//
// THE RULE.
//   - scripts/walk.mjs tests no key of an expect or do entry: no `"x" in c`,
//     and no `if (a.x)` on a function's own parameter (other than `page`).
//   - It names no check: no string and no object key that is a check's key
//     (the per-step checks a runner used to add by name, { noOverflow: true },
//     are each check's own `auto` export), and no string that is an action's.
//   - Every file in scripts/walk/checks/ exports `key` equal to its file name
//     and judge(); every file in scripts/walk/actions/ exports `key` and act().
// The failure names the file to write the branch into.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A call on a parameter is
// not a branch on an entry's key: the response listener's `r.status()` reads
// a Playwright response. And an action key as an object key is not a branch:
// a FormData upload builds `new Blob(..., { type })`, and "type" is also the
// scanner action. So calls are skipped, and action keys are judged only as
// strings.
//
// PROVED RED on the runner before the split (scripts/walk.mjs at 3d374661c1,
// 101 violations): it named each of the 42 checks and the 16 actions written
// there (upload and download were already in lib/walk-file-action.mjs), and on
// a check, an action and a per-step { noOverflow } added to the split runner.
//
//   npx tsx scripts/lint-walk-kinds-in-their-files.ts   (pnpm lint walk-kinds-in-their-files)
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const RUNNER = process.env.WALK_RUNNER || "scripts/walk.mjs";
const DIR = "scripts/walk";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const stems = (sub: string) => readdirSync(`${DIR}/${sub}`).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
const CHECKS = new Set(stems("checks"));
const ACTIONS = new Set(stems("actions"));
const home = (k: string) => (ACTIONS.has(k) && !CHECKS.has(k) ? `${DIR}/actions/${k}.mjs` : CHECKS.has(k) ? `${DIR}/checks/${k}.mjs` : `${DIR}/checks/${k}.mjs (an expect) or ${DIR}/actions/${k}.mjs (a do)`);

function checkRunner(file: string, src: string): Violation[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Violation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const params: Set<string>[] = [];
  const testsAParam = (test: ts.Expression) => {
    const found: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        n.arguments.forEach(visit);
        return;
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && params.some((p) => p.has((n.expression as ts.Identifier).text))) found.push(`${n.expression.text}.${n.name.text}`);
      ts.forEachChild(n, visit);
    };
    visit(test);
    return found;
  };
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteral(n.left)) {
      out.push({ file, line: at(n), what: `"${n.left.text}" in ${n.right.getText(sf)} branches on an entry's key: write it as ${home(n.left.text)}` });
    } else if (ts.isStringLiteral(n) && (CHECKS.has(n.text) || ACTIONS.has(n.text)) && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.InKeyword)) {
      out.push({ file, line: at(n), what: `"${n.text}" names a walk kind in the runner: what it adds belongs in ${home(n.text)}` });
    } else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name) && CHECKS.has(n.name.text)) {
      out.push({ file, line: at(n), what: `{ ${n.name.text}: ... } names a check in the runner: a check every step runs is its own \`auto\` export in ${home(n.name.text)}` });
    }
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n)) {
      const test = ts.isIfStatement(n) ? n.expression : n.condition;
      for (const read of testsAParam(test)) out.push({ file, line: at(test), what: `branches on ${read}: a check or action is its own file, ${home(read.split(".")[1]!)}` });
    }
    const fn = ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
    if (fn) params.push(new Set(n.parameters.map((p) => p.name.getText(sf)).filter((p) => p !== "page")));
    ts.forEachChild(n, visit);
    if (fn) params.pop();
  };
  visit(sf);
  return out;
}

function checkKinds(): Violation[] {
  const out: Violation[] = [];
  for (const [sub, fn] of [["checks", "judge"], ["actions", "act"]] as const) {
    for (const stem of stems(sub)) {
      const file = `${DIR}/${sub}/${stem}.mjs`;
      const src = readFileSync(file, "utf8");
      if (!src.includes(`export const key = ${JSON.stringify(stem)};`)) out.push({ file, line: 1, what: `exports no key "${stem}" (a kind's key is its file name)` });
      if (!new RegExp(`export (async )?function ${fn}\\(|export const ${fn} =`).test(src)) out.push({ file, line: 1, what: `exports no ${fn}()` });
      if (!/^\/\/ "/.test(src)) out.push({ file, line: 1, what: `opens with no comment saying what "${stem}" takes and does (\`walk.mjs --kinds\` prints it)` });
    }
  }
  return out;
}

const violations = [...checkRunner(RUNNER, readFileSync(RUNNER, "utf8")), ...checkKinds()];
if (violations.length) {
  console.error(`lint:walk-kinds-in-their-files - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(`A walk check or action is one file under ${DIR}/checks/ or ${DIR}/actions/, found by a directory read, so two PRs adding unrelated ones touch no common file (#7384).`);
  process.exit(1);
}
console.log(`lint:walk-kinds-in-their-files OK - ${CHECKS.size} checks, ${ACTIONS.size} actions, each in its own file`);
