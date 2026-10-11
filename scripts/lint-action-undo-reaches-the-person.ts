#!/usr/bin/env tsx
// An Undo an action hands back reaches the person: the door's hook offers it, and a surface that runs the action itself offers it with offerUndo, draws its own (undo: "shown-here"), or says why there is none.
//
// THE BUG THIS PREVENTS. Use one on a counted record took one, and the
// response carried its Undo (inventory:restore-part, the quantity before),
// but the record's buttons dropped it: no toast, no Undo (#5812,
// 2026-10-11). A renewal correction was the same a day earlier (#5808), and
// three surfaces passed an Undo to a success toast that never drew its button.
// Every surface decided for itself whether to look at `undo`, and most never
// did.
//
// THE RULE. useRunAction (the door as a hook) now offers the Undo itself, so
// a surface on the hook gets it by doing nothing. What this lint judges is
// the ways around that:
//   1. The hook-free door, runAction(api, qc, slug, body), called anywhere but
//      run-action.ts: the file must hand the outcome to offerUndo, or the call
//      says why nothing can be undone, on it or in the three lines above:
//        // NO-UNDO: <why>
//   2. `undo: "shown-here"` tells the door this surface draws the Undo
//      itself. The file must then draw one: an "Undo" label, or
//      offerUndo. A surface that claims it and draws nothing is the bug again.
// `undo: "is-undo"` (a run that IS a way back) needs no Undo of its own.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The local name `runAction`
// is also what most surfaces call the hook's function
// (`const runAction = useRunAction()`), which takes one or two arguments; only
// a call with four (api, cache, workspace, body) is the hook-free door. That
// alias flagged twenty-odd hook callers on the first draft.
//
// PROVE IT RED: on the merge-base of #5812 it names use-invoke-action.ts (the
// record buttons, Use one among them), ScanCountBlock, ScanChoiceSelect,
// ServiceRunsPage, PlaceLights and the builds board actions.
//
//   pnpm lint action-undo-reaches-the-person
import { readFileSync } from "node:fs";
import ts from "typescript";
import { repoFiles } from "./lib/repo-files.js";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];
const DOOR_FILE = "packages/platform-web/src/run-action.ts";
const NO_UNDO = /\/\/\s*NO-UNDO: \S/;
/** A surface that draws an Undo: its label, or the shared offer. */
const DRAWS_UNDO = /["'>]\s*Undo\b|\bUndo\s*[<{]|\bofferUndo\(/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

function check(file: string, src: string): Violation[] {
  if (!/\brunAction\b|shown-here/.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Violation[] = [];
  const lines = src.split("\n");
  const offers = /\bofferUndo\(/.test(src);
  const draws = DRAWS_UNDO.test(src);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "runAction" && n.arguments.length >= 4 && file !== DOOR_FILE) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const near = lines.slice(Math.max(0, line - 3), line + 1).join("\n");
      if (!offers && !NO_UNDO.test(near)) out.push({ file, line: line + 1, what: "the hook-free door drops the action's Undo: hand the outcome to offerUndo, or say // NO-UNDO: <why>" });
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "undo" && ts.isStringLiteral(n.initializer) && n.initializer.text === "shown-here" && !draws) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      out.push({ file, line, what: 'undo: "shown-here" but this surface draws no Undo' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const violations: Violation[] = [];
for (const file of repoFiles(ROOTS)) {
  if (!/\.(ts|tsx)$/.test(file) || /\.test\.tsx?$/.test(file) || /\/(node_modules|dist)\//.test(file)) continue;
  violations.push(...check(file, readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error(`lint:action-undo-reaches-the-person - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("An Undo the action hands back is offered: useRunAction does it; the hook-free door needs offerUndo (or // NO-UNDO: <why>).");
  process.exit(1);
}
console.log("lint:action-undo-reaches-the-person OK");
