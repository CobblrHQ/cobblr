#!/usr/bin/env tsx
// Every Undo is judged: a server Undo step names the record History watches, a page's Undo presses the step it was handed, or the step says on an // UNDO: line why a later change is kept.
//
// THE BUG THIS PREVENTS. A filed scan, a hold, a placement, a floor plan, a
// task card, a category fold and a print file rename each had an Undo that
// wrote back over a teammate's later change, found one at a time by a person
// (#9419, 2026-11-10; #9377, #9383 and #9396 before them).
//
// THE SEAM. An action run through /actions/invoke has its Undo steps issued
// (issueUndos): each is kept with the records it names and the newest change
// on them, and judgeUndo refuses a press once anyone else changed those
// records since ("changed after it was done"). That judge only sees records a
// step NAMES: its entity_id, its puts_back, an arg keyed like an id
// (NAMES_A_RECORD, @cobblr/platform-contract/undo-watch, the same rule the
// judge reads), or the record the run was on when the step's action is
// record-scoped (undoFor fills it in). Every blind Undo the audit found was
// outside that: a step naming a list, a file by name, a category, or a page
// writing back through its own request.
//
// THE RULE.
//   1. A registerUndo(...) whose step names no record, by the judge's rule,
//      says why a later change is kept: an `// UNDO: <why>` line in the three
//      lines above the call or inside the undoer.
//   2. A page's Undo (an object with `actionLabel: "Undo"` and an onAction)
//      presses a step it was handed (pressUndo / runIssuedUndo /
//      pressIssuedUndo / runUndoSteps / offerUndo, or replays `step.action_id`)
//      or says why on an `// UNDO:` (or the older `// OWN-WAY-BACK:`) line,
//      in the four lines above or inside the handler.
// The reason is a claim a reviewer can check: "refuses unless the file still
// says what the rename set", "restores a deleted tag; nothing else can have
// changed it", "workspace setup, blind by design (#9419 audit part 2)".
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. inventory's partUndoStep
// builds `args: { ...state }`, and `state` carries partId: a spread into args
// is credited as naming, because the lint cannot see inside it and the first
// draft flagged twenty-five correct inventory steps. An undoer passed by name
// is read where it is declared in the same file; one built by a helper in
// another file (no `action_id` literal in reach) is not judged here. A step
// whose action writes no History row is credited if it names a record, yet
// the judge sees nothing (the print-file rename, #9427): that hole is closed
// in the action, not by this lint.
//
// PROVE IT RED: on main before #9419's fixes it names
// rename-print-file-action.ts (digifab.rename-print-file), the category
// promote and fold in platform-action-handlers.ts, and DatedCard.tsx's task
// tick, with every other site this lint now finds marked or fixed.
//
//   npx tsx scripts/lint-every-undo-is-judged.ts   (pnpm lint every-undo-is-judged)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { NAMES_A_RECORD } from "../packages/platform-contract/src/undo-watch.ts";

const SERVER_ROOTS = ["api/src", "modules"];
const PAGE_ROOTS = ["web/src", "packages/platform-web/src", "modules"];
const REASON = /\/\/ UNDO: \S/;
const PAGE_REASON = /\/\/ (UNDO|OWN-WAY-BACK): \S/;
/** A press of a step the server handed back: the kernel judges it. */
const PAGE_SEAM = /\b(pressUndo|runIssuedUndo|pressIssuedUndo|runUndoSteps|offerUndo)\b|\bstep\.action_id\b/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The source files under these roots that contain `needle`, picked by git
 *  grep so the tree is never read whole (a 60 MB read on the first CI run). */
function filesWith(needle: string, roots: string[]): string[] {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-l", "--untracked", "-F", needle, "--", ...roots], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // git grep answers 1 when nothing matches.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
  return out.split("\n").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts") && !isEmbeddedPayload(f));
}

const sources = new Map<string, string>();
/** Each file read once, however many of the rule's parts look at it. */
const read = (file: string) => {
  let src = sources.get(file);
  if (src === undefined) sources.set(file, (src = readFileSync(file, "utf8")));
  return src;
};

const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const keyOf = (sf: ts.SourceFile, p: ts.ObjectLiteralElementLike) => (p.name ? p.name.getText(sf).replace(/["']/g, "") : "");

/** Every action's scope, from each declaration that states both an id and a
 *  scope: a step whose action is not workspace-scoped runs on the run's own
 *  record, which undoFor names for the judge. */
function actionScopes(): Map<string, string> {
  const scope = new Map<string, string>();
  for (const file of filesWith("scope:", SERVER_ROOTS)) {
    const src = read(file);
    const sf = parse(file, src);
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        let id = "", sc = "";
        for (const p of n.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const init = ts.isAsExpression(p.initializer) ? p.initializer.expression : p.initializer;
          if (!ts.isStringLiteral(init)) continue;
          const k = keyOf(sf, p);
          if (k === "id" && /^[a-z0-9-]+:[a-z0-9-]+$/.test(init.text)) id = init.text;
          if (k === "scope") sc = init.text;
        }
        if (id && sc) scope.set(id, sc);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return scope;
}

/** Does this undoer's step name a record the judge watches? */
function namesARecord(sf: ts.SourceFile, undoer: ts.Node, scope: Map<string, string>): boolean {
  let steps = 0, names = false;
  const visit = (m: ts.Node) => {
    if (ts.isObjectLiteralExpression(m) && m.properties.some((p) => keyOf(sf, p) === "action_id")) {
      steps++;
      for (const p of m.properties) {
        const k = keyOf(sf, p);
        if (k === "entity_id" || k === "puts_back") names = true;
        if (k === "action_id" && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer) && (scope.get(p.initializer.text) ?? "workspace") !== "workspace") names = true;
        if (k === "args" && ts.isPropertyAssignment(p)) {
          if (!ts.isObjectLiteralExpression(p.initializer)) names = true;
          else for (const q of p.initializer.properties) if (ts.isSpreadAssignment(q) || NAMES_A_RECORD.test(keyOf(sf, q))) names = true;
        }
      }
    }
    if (ts.isSpreadAssignment(m) && ts.isObjectLiteralExpression(m.parent) && m.parent.properties.some((p) => keyOf(sf, p) === "action_id")) names = true;
    ts.forEachChild(m, visit);
  };
  visit(undoer);
  return steps === 0 || names;
}

/** The undoer a registerUndo call is handed: inline, or declared by name in this file. */
function undoerOf(sf: ts.SourceFile, arg: ts.Node): ts.Node {
  if (!ts.isIdentifier(arg)) return arg;
  const find = (m: ts.Node): ts.Node | undefined => {
    if ((ts.isVariableDeclaration(m) || ts.isFunctionDeclaration(m)) && m.name?.getText(sf) === arg.text) return m;
    return ts.forEachChild(m, find);
  };
  return find(sf) ?? arg;
}

const linesAbove = (lines: string[], line: number, n: number) => lines.slice(Math.max(0, line - n), line + 1).join("\n");

function checkServer(file: string, src: string, scope: Map<string, string>): Violation[] {
  if (!src.includes("registerUndo(")) return [];
  const out: Violation[] = [];
  const sf = parse(file, src);
  const lines = src.split("\n");
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && /registerUndo$/.test(n.expression.getText(sf)) && n.arguments.length >= 2) {
      const undoer = undoerOf(sf, n.arguments[1]!);
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      if (!namesARecord(sf, undoer, scope) && !REASON.test(linesAbove(lines, line, 3)) && !REASON.test(undoer.getFullText(sf))) {
        out.push({ file, line: line + 1, what: `${n.arguments[0]!.getText(sf)}: its Undo step names no record the judge watches, and no // UNDO: line says why a later change is kept` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function checkPage(file: string, src: string): Violation[] {
  if (!/actionLabel: "Undo"/.test(src)) return [];
  const out: Violation[] = [];
  const sf = parse(file, src);
  const lines = src.split("\n");
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const undo = n.properties.some((p) => ts.isPropertyAssignment(p) && keyOf(sf, p) === "actionLabel" && /^["']Undo["']$/.test(p.initializer.getText(sf)));
      const on = n.properties.find((p) => keyOf(sf, p) === "onAction");
      if (undo && on) {
        const line = sf.getLineAndCharacterOfPosition(on.getStart(sf)).line;
        // An onAction passed by name (`onAction: undoAll`) is read where it is declared.
        const init = ts.isPropertyAssignment(on) ? on.initializer : ts.isShorthandPropertyAssignment(on) ? on.name : undefined;
        const body = on.getFullText(sf) + (init && ts.isIdentifier(init) ? undoerOf(sf, init).getFullText(sf) : "");
        if (!PAGE_SEAM.test(body) && !PAGE_REASON.test(body) && !PAGE_REASON.test(linesAbove(lines, line, 4))) {
          out.push({ file, line: line + 1, what: "this Undo writes back through its own request: press the step the action handed back, or say on an // UNDO: line why a later change is kept" });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const scope = actionScopes();
const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const file of filesWith("registerUndo(", SERVER_ROOTS)) if (onlyChanged(file)) violations.push(...checkServer(file, read(file), scope));
for (const file of new Set(filesWith('actionLabel: "Undo"', PAGE_ROOTS))) if (onlyChanged(file)) violations.push(...checkPage(file, read(file)));

if (violations.length) {
  console.error(`lint:every-undo-is-judged - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("An Undo that names no record, or writes back on its own, says on an // UNDO: <why> line how a teammate's later change is kept (refused, narrowed, or nothing else can have changed it). Better: name the record, or press the step the action handed back.");
  process.exit(1);
}
console.log(`lint:every-undo-is-judged OK`);
