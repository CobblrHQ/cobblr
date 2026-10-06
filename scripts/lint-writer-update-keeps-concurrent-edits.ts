#!/usr/bin/env tsx
// Kernel code that reads a record and then overwrites it through a module's writer keeps a person's edit made in between: the writer has no compare-and-set, so the function checks the activity log for writes since its read, or says read-then-write: and why.
//
// THE BUG THIS PREVENTS. A friend's edit to a share copy, made while the mirror copied the owner's change over it, was lost: overwritten or folded into the base, never sent (main red at bb51e8d57, 2026-10-06)
//
// THE RULE. In api/src, a function that reads a record (`lookup(`) and then
// writes it through a module's writer (`getWriter(...)`, then `<w>.update(`)
// is refused unless it keeps what a person wrote in between. The right way:
// read the writer's `version` before the record and write with
// `updateIf(..., version)`, a compare-and-set that writes nothing if the
// record changed (#5031); an `updateIf` call is not an `update` and is never
// flagged. Otherwise the function calls one of GUARDS (which read the
// activity log from a mark taken before the read and put a person's writes
// back), or the update's line or the one above says `read-then-write: <why>`
// (a kind with no updateIf, a record nobody else writes, or a lost edit there
// costs nothing).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only a read and a write in
// the SAME function: a create, or an update with no read of the record first,
// writes nothing it decided from a stale copy. Module code is out of scope: a
// module's own routes write their own rows; the kernel writing a module's
// rows on someone else's behalf (a share's mirror, a sync, a hand-over) is
// where two writers meet. Nothing else has tested the boundary yet.
//
// PROVED RED on the share mirror's apply (share-mirror.ts, mirror.upsert)
// before keepEditsMadeDuringApply existed.
//
//   npx tsx scripts/lint-writer-update-keeps-concurrent-edits.ts   (pnpm lint writer-update-keeps-concurrent-edits)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Functions that keep a person's concurrent edit (share-mirror.ts). */
const GUARDS = ["keepEditsMadeDuringApply"];

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src"];

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!src.includes("getWriter(") || !src.includes("lookup(")) return [];
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = src.split("\n");
  const said = (line: number) => /read-then-write:\s*\S/.test(lines[line - 1] ?? "") || /read-then-write:\s*\S/.test(lines[line - 2] ?? "");
  const visitFn = (fn: ts.FunctionLikeDeclaration) => {
    let firstRead = Infinity;
    let guarded = false;
    const writers = new Set<string>();
    const updates: Array<{ pos: number; line: number }> = [];
    const v = (n: ts.Node): void => {
      if (n !== fn && ts.isFunctionLike(n)) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /\bgetWriter\(/.test(n.initializer.getText(sf))) writers.add(n.name.text);
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee) && callee.text === "lookup") firstRead = Math.min(firstRead, n.getStart(sf));
        if (ts.isIdentifier(callee) && GUARDS.includes(callee.text)) guarded = true;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "update" && ts.isIdentifier(callee.expression) && writers.has(callee.expression.text))
          updates.push({ pos: n.getStart(sf), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
      }
      ts.forEachChild(n, v);
    };
    if (fn.body) ts.forEachChild(fn.body, v);
    if (guarded) return;
    for (const u of updates) {
      if (u.pos < firstRead || said(u.line)) continue;
      out.push({ file, line: u.line, what: "reads the record, then overwrites it through its writer: a person's edit made in between is lost" });
    }
  };
  const all = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body) visitFn(n as ts.FunctionLikeDeclaration);
    ts.forEachChild(n, all);
  };
  all(sf);
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:writer-update-keeps-concurrent-edits - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Write with the writer's updateIf(..., version) after reading its version first; or keep a person's edit made in between (call one of: " + GUARDS.join(", ") + "); or write // read-then-write: <why>.");
  process.exit(1);
}
console.log(`lint:writer-update-keeps-concurrent-edits OK`);
