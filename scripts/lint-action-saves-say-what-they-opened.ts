#!/usr/bin/env tsx
// A save made through an action is judged like a PATCH: an update or edit action's handler refuses a save over a change made since (staleSaveRefusal) or says why not on an // UNJUDGED-SAVE: line, and a page's run of a judged action sends what its form opened with (edited_from).
//
// THE BUG THIS PREVENTS. An older maintenance schedule form's rename wrote
// back the interval a teammate had changed, both saying saved (#9446,
// 2026-11-11). The seam that refuses such a save (stale-edit.ts) ran only on a
// kind's PATCH route; a form that saved through an action (the schedule, a
// registration term, an app's record form) was never judged.
//
// THE RULE.
//   1. A registerHandler("<module>.update-…" or ".edit-…") calls
//      staleSaveRefusal, or updateRecordFields (which does), or says on an
//      `// UNJUDGED-SAVE: <why>` line in the three lines above why a save
//      over a change since cannot happen or is judged another way.
//   2. A page's run of an action whose handler is judged (rule 1's first
//      half, read from the handlers) whose `args` is an object literal
//      carries `edited_from` (EDITED_FROM_ARG): a form that opened on an older
//      copy says so, or the judgement has nothing to judge.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The assistant's and a
// script's update actions (inventory:update-item, assets:update-fields) name
// the values they mean with no form opened earlier, so they say so on rule
// 1's line instead of taking an edited_from nobody would send. A run whose
// args are not an object literal (passed whole) is not judged by rule 2.
//
// PROVE IT RED: on main before #9446 it names core-maintenance.update-schedule,
// core-maintenance.update-term and platform.update-fields (rule 1), and the
// schedule, renewal and term forms and the app record form (rule 2).
//
//   node scripts/lint-action-saves-say-what-they-opened.ts   (pnpm lint action-saves-say-what-they-opened)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

const SERVER_ROOTS = ["api/src", "modules"];
const PAGE_ROOTS = ["web/src", "packages/platform-web/src", "modules"];
const UPDATE_HANDLER = /^[a-z0-9-]+\.(update|edit)-[a-z0-9-]+$/;
const JUDGES = /\b(staleSaveRefusal|updateRecordFields)\s*\(/;
const REASON = /\/\/ UNJUDGED-SAVE: \S/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** Source files under these roots holding `needle`, picked by git grep. */
function filesWith(needle: string, roots: string[]): string[] {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-l", "--untracked", "-F", needle, "--", ...roots], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
  return out.split("\n").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts") && !isEmbeddedPayload(f));
}

const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const above = (lines: string[], line: number) => lines.slice(Math.max(0, line - 3), line + 1).join("\n");

const violations: Violation[] = [];
/** Action ids (`module:verb`) whose handler judges a save. */
const judged = new Set<string>();

for (const file of filesWith("registerHandler(", SERVER_ROOTS)) {
  const src = readFileSync(file, "utf8");
  const sf = parse(file, src);
  const lines = src.split("\n");
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && /registerHandler$/.test(n.expression.getText(sf)) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      const key = n.arguments[0].text;
      if (UPDATE_HANDLER.test(key)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
        const body = n.arguments[1]?.getText(sf) ?? "";
        if (JUDGES.test(body)) judged.add(key.replace(".", ":"));
        else if (!REASON.test(above(lines, line)) && onlyChanged(file)) {
          violations.push({ file, line: line + 1, what: `${key}: an update action's save is never judged for a change made since; call platform().http.staleSaveRefusal, or say why not on an // UNJUDGED-SAVE: line` });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

for (const file of new Set(filesWith("actionId:", PAGE_ROOTS))) {
  if (!/\/(web\/src|platform-web\/src|src\/ui)\//.test(`/${file}`) || !onlyChanged(file)) continue;
  const src = readFileSync(file, "utf8");
  const sf = parse(file, src);
  const lines = src.split("\n");
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const id = n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "actionId" && ts.isStringLiteral(p.initializer));
      const args = n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "args");
      if (id && args && ts.isPropertyAssignment(id) && ts.isPropertyAssignment(args) && judged.has((id.initializer as ts.StringLiteral).text) && ts.isObjectLiteralExpression(args.initializer)) {
        const text = args.initializer.getText(sf);
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
        if (!/\bEDITED_FROM_ARG\b|\bedited_from\b/.test(text) && !REASON.test(above(lines, line))) {
          violations.push({ file, line: line + 1, what: `${(id.initializer as ts.StringLiteral).text}: a form's save sends what it opened with (edited_from), or its older copy goes back over a teammate's change in silence` });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

if (violations.length) {
  console.error(`lint:action-saves-say-what-they-opened - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A save through an action is judged like a PATCH (stale-edit.ts, #9446): the handler refuses a save over a change since, and the form says what it opened with.");
  process.exit(1);
}
console.log(`lint:action-saves-say-what-they-opened OK (${judged.size} judged)`);
