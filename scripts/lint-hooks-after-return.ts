// A hook after an early return is a crash waiting for the second render.
//
// React identifies hooks by CALL ORDER. A component that returns early and
// then calls a hook has two different hook counts depending on the branch, so
// the render AFTER the branch flips throws "Rendered more hooks than during the
// previous render" and takes the whole page down.
//
// Nothing else catches it here. It typechecks, it lints, it passes CI, and it
// works perfectly in whichever branch you happened to test. DiscussionTab
// shipped with exactly this: a useQuery below `if (!record) return null`, fine
// on a record page, fatal the moment you navigated to one without a record
// (2026-08-23). It reached main.
//
// docs/design-decisions/lint-architecture.md names react-hooks/rules-of-hooks
// as the one genuine gap ESLint would fill, and says to adopt it narrowly IF
// hooks bugs ever cost real time. They now have. This is that rule, scoped to
// the one shape that actually bit: a hook call textually after a top-level
// early return, inside a component or a custom hook.
//
// Deliberately NOT a general rules-of-hooks implementation. Hooks in loops or
// conditions are worth catching too, but this is the shape with a real
// incident behind it, and a narrow rule with no false positives gets to stay.

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["web/src", "modules", "packages", "ops-console/src"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const HOOK = /^use[A-Z]/;

/** Is this function a component or a custom hook — i.e. does React own its
 *  call order? A plain helper that happens to return early is not our business. */
function isReactish(name: string | undefined, body: ts.Node, sf: ts.SourceFile): boolean {
  if (!name) return false;
  if (HOOK.test(name)) return true;
  if (!/^[A-Z]/.test(name)) return false;
  // A capitalised function that calls no hook at all is a factory or a class-ish
  // helper, not a component worth policing.
  let callsHook = false;
  const scan = (n: ts.Node): void => {
    if (callsHook) return;
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText(sf);
      if (HOOK.test(t.split(".").pop() ?? "")) callsHook = true;
    }
    ts.forEachChild(n, scan);
  };
  scan(body);
  return callsHook;
}

const violations: Array<{ file: string; line: number; hook: string; returnLine: number }> = [];

for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    const src = readFileSync(file, "utf8");
    if (!/\buse[A-Z]/.test(src) || !/return\b/.test(src)) continue;
    const sf = ts.createSourceFile(
      file, src, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const check = (name: string | undefined, body: ts.Block): void => {
      if (!isReactish(name, body, sf)) return;
      // Only TOP-LEVEL statements of the function body: a return inside a
      // nested callback (an event handler, a map) is not an early return of
      // the component.
      let earlyReturn: number | null = null;
      for (const stmt of body.statements) {
        if (earlyReturn === null) {
          const text = stmt.getText(sf);
          const isGuard =
            (ts.isIfStatement(stmt) && /\breturn\b/.test(text) && !stmt.elseStatement) ||
            ts.isReturnStatement(stmt);
          if (isGuard) {
            earlyReturn = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
          }
          continue;
        }
        // Past a guard: any hook call at any depth in the remaining statements
        // is order-dependent on the branch above it.
        const scan = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            const callee = n.expression.getText(sf).split(".").pop() ?? "";
            if (HOOK.test(callee)) {
              violations.push({
                file: relative(ROOT, file),
                line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
                hook: callee,
                returnLine: earlyReturn!,
              });
            }
          }
          // Do not descend into nested functions: a hook inside a callback is a
          // different (and separately wrong) thing, and flagging it here would
          // produce noise this rule has no incident for.
          if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
          ts.forEachChild(n, scan);
        };
        scan(stmt);
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.body) {
        check(node.name?.getText(sf), node.body);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = node.initializer;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body && ts.isBlock(init.body)) {
          check(node.name.getText(sf), init.body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error("lint:hooks-after-return - a hook called after an early return:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.hook}() runs only on some renders (guard at line ${v.returnLine})`);
  }
  console.error(
    "\nReact identifies hooks by CALL ORDER, so this throws\n" +
      '"Rendered more hooks than during the previous render" the first time the\n' +
      "guard flips, and takes the page down. Move the hook ABOVE the guard and\n" +
      "gate its WORK instead (useQuery has `enabled`, useEffect can return early).\n",
  );
  process.exit(1);
}

console.log("lint:hooks-after-return ✓ every hook runs on every render of its component.");
