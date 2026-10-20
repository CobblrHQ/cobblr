#!/usr/bin/env tsx
// A row or card that navigates on a click and holds a control of its own (a link, a button, a field) opens through rowOpen from @cobblr/platform-web, so a tap on its control is the control's alone and one tap makes one history entry.
//
// THE BUG THIS PREVENTS. Inventory's row navigated on click and its name was a Link to the same record: one tap on the name made two history entries, and Close or Back left the record open (#7600, 2026-10-20)
//
// THE RULE. In JSX under web/src, packages and modules, an element that is
// not itself a control (a <tr>, a <div>, an <li>) whose onClick calls
// navigate( and that holds a control (<a>, <Link>, <NavLink>, <button>,
// <input>, <select>, <textarea>, <label>) writes its onClick as
// rowOpen(...). rowOpen ignores a tap that started on a control inside the
// row, so the control's own action is the only one.
//
// THE BOUNDARY. Only a handler that calls navigate( itself is judged; a row
// that calls a prop (onOpen) is the parent's to judge, and a control inside
// a control is lint:no-control-inside-a-control's. Nothing has tested the
// boundary yet.
//
// PROVED RED on main: PartsListPage's table row and phone card (2).
//
//   npx tsx scripts/lint-row-click-skips-its-controls.ts   (pnpm lint row-click-skips-its-controls)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules"];

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

const CONTROLS = new Set(["a", "button", "Link", "NavLink", "input", "select", "textarea", "label"]);

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!file.endsWith(".tsx") || !src.includes("navigate(")) return out;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const opening = (n: ts.Node) => (ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null);
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const open = node.openingElement;
      const tag = open.tagName.getText(sf);
      const click = open.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "onClick");
      const handler = click?.initializer && ts.isJsxExpression(click.initializer) ? click.initializer.expression : undefined;
      if (handler && !CONTROLS.has(tag) && /\bnavigate\(/.test(handler.getText(sf)) && !/^rowOpen\(/.test(handler.getText(sf))) {
        let inner: string | null = null;
        const look = (c: ts.Node) => {
          const o = opening(c);
          if (!inner && o && CONTROLS.has(o.tagName.getText(sf))) inner = o.tagName.getText(sf);
          ts.forEachChild(c, look);
        };
        node.children.forEach(look);
        if (inner) out.push({ file, line: sf.getLineAndCharacterOfPosition(open.getStart(sf)).line + 1, what: `<${tag}> navigates on click and holds a <${inner}>: a tap on the <${inner}> does both; write onClick={rowOpen(() => navigate(...))}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:row-click-skips-its-controls - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("onClick={rowOpen(() => navigate(href))}");
  process.exit(1);
}
console.log(`lint:row-click-skips-its-controls OK`);
