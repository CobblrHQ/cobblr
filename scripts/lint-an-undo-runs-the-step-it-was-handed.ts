#!/usr/bin/env tsx
// An Undo runs the step its action handed back, through runUndoSteps so its undo_id rides along, or says in one line why its own way back is exact.
//
// THE BUG THIS PREVENTS. A loan's toast Undo sent platform:return naming only the record and ended the loan made since in another tab (#7899)
//
// The same shape was in 23 more places on 2026-10-25: a Use one's Undo on a
// dashboard panel sent restock-one, its own idea of the opposite, which the
// server's judge (#8002) never sees as an Undo; ten surfaces replayed a
// handed step but dropped its undo_id, so a second press matched no unused
// step and ran again.
//
// THE RULE. A run marked `undo: "is-undo"` (it IS a way back) is judged by
// what it sends:
//   - a body built from a handed step (`actionId: step.action_id`) carries
//     the step's undo_id: run it through runUndoSteps (run-action.ts), which
//     sends the target, the args and the undo_id exactly as handed;
//   - a body the surface writes itself (a literal action id, an inverse it
//     picked) says why its own way back is exact, on the call or in the
//     three lines above:  // OWN-WAY-BACK: <why a later change or a second
//     press cannot be undone over>
//   - a body passed in whole (runUndoSteps's or offerUndo's own runBack)
//     passes: it is the handed step.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The builds board's takeBack
// takes a body and is handed to offerUndo, so its call names no action at
// all; that is the handed step and passes. Nothing else has tested the edge.
//
// PROVE IT RED: on main before #7899's fix it names RecordLoan (the bug),
// RecordDisposition, ViewsPage and every replay that drops undo_id.
//
//   npx tsx scripts/lint-an-undo-runs-the-step-it-was-handed.ts   (pnpm lint an-undo-runs-the-step-it-was-handed)
import { readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const OWN = /\/\/\s*OWN-WAY-BACK: \S/;

function isUndoRun(arg: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(arg) && arg.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === "undo" && ts.isStringLiteral(p.initializer) && p.initializer.text === "is-undo");
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!src.includes("is-undo")) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split("\n");
  const out: Violation[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.arguments.slice(1).some(isUndoRun)) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const said = lines.slice(Math.max(0, line - 3), line + 1).some((l) => OWN.test(l));
      const body = n.arguments[0]!;
      if (ts.isObjectLiteralExpression(body)) {
        const prop = (name: string) => body.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === name);
        const id = prop("actionId");
        const replay = !!id && ts.isPropertyAssignment(id) && ts.isPropertyAccessExpression(id.initializer) && id.initializer.name.text === "action_id";
        if (replay && !prop("undo_id")) out.push({ file, line: line + 1, what: "replays a handed step without its undo_id: run it through runUndoSteps, so a second press is refused" });
        else if (!replay && !said) out.push({ file, line: line + 1, what: "an Undo the surface wrote itself: run the step the action handed back (runUndoSteps), or say why this one is exact (// OWN-WAY-BACK: <why>)" });
      } else if (ts.isStringLiteral(body) && !said) {
        out.push({ file, line: line + 1, what: `an Undo the surface wrote itself (${body.text}): run the step the action handed back (runUndoSteps), or say why this one is exact (// OWN-WAY-BACK: <why>)` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:an-undo-runs-the-step-it-was-handed - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:an-undo-runs-the-step-it-was-handed OK`);
