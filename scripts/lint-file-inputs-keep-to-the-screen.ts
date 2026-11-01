#!/usr/bin/env tsx
// A visible file input says how wide it is (w-full, or a class that sets it), because its own width is a browser's and doubles at 200% text past a phone's edge
//
// THE BUG THIS PREVENTS. the licences create dialog's receipt field ran 274 px past a phone's edge at 200% text, red every nightly from 10-29 (#9081)
//
// THE RULE. Every <input type="file"> in the app's TSX either is not drawn
// (hidden, sr-only, invisible, opacity-0 or absolute behind its own button;
// the HTML `hidden` attribute; a style that hides it) or says its width
// (w-full, w-[...], max-w-..., or the shared `input` class, which is w-full).
// A className computed in code passes when its words carry one of those. A
// genuine exception says why on the line above:
// `// file-input-width: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Most file inputs in the
// app are hidden behind a styled button (8 `hidden`, 3 `sr-only` on
// 2026-11-01), and those are never drawn, so they never overflow. Only a
// drawn one, with the browser's own "Choose file · No file chosen" box, is
// judged.
//
//   npx tsx scripts/lint-file-inputs-keep-to-the-screen.ts   (pnpm lint file-inputs-keep-to-the-screen)
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages"];

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

/** Files the edge bridge mirrors (edge-bridge/scripts/sync-shared.mjs), where
 *  a change merged alone turns every bridge branch red until a repin lands, so
 *  their fix waits for its pair. Each names the issue that carries it. */
const BRIDGE_MIRRORED: Record<string, string> = {};

const NOT_DRAWN = /(^|[^\w-])(hidden|sr-only|invisible|opacity-0|absolute)([^\w-]|$)/;
const HAS_WIDTH = /(^|[^\w-])(w-full|input)([^\w-]|$)|(^|[^\w-])(w-\[|max-w-)/;

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}
function attrText(a: ts.JsxAttribute | undefined): string {
  const init = a?.initializer;
  if (!init) return a ? "true" : "";
  if (ts.isStringLiteral(init)) return init.text;
  return ts.isJsxExpression(init) && init.expression ? init.expression.getText() : "";
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!file.endsWith(".tsx") || !src.includes('"file"') || BRIDGE_MIRRORED[file]) return [];
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = src.split("\n");
  // A className computed from a class string kept in the same file
  // (`const control = "w-full ..."`) is judged by that string's words.
  const consts = new Map<string, string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      consts.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const withConsts = (cls: string) => cls.replace(/[A-Za-z_$][\w$]*/g, (id) => (consts.has(id) ? `${id} ${consts.get(id)}` : id));
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === "input" && attrText(attr(node, "type")) === "file") {
      const cls = withConsts(attrText(attr(node, "className")));
      const hidden = attr(node, "hidden") !== undefined || /display\s*:\s*["']none|visibility\s*:\s*["']hidden/.test(attrText(attr(node, "style")));
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const excused = /\/\/ file-input-width: \S/.test(lines[line - 1] ?? "") || /\{\/\* file-input-width: \S/.test(lines[line - 1] ?? "");
      if (!hidden && !excused && !NOT_DRAWN.test(cls) && !HAS_WIDTH.test(cls)) {
        out.push({ file, line: line + 1, what: `a drawn file input with no width${cls ? ` (className ${JSON.stringify(cls.slice(0, 60))})` : ""}` });
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
  console.error(`lint:file-inputs-keep-to-the-screen - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add className=\"block w-full min-w-0\" (or hidden / sr-only behind a button)");
  process.exit(1);
}
console.log(`lint:file-inputs-keep-to-the-screen OK`);
