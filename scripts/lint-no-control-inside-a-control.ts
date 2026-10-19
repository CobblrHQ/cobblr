#!/usr/bin/env tsx
// No button, link, input, select or textarea is written inside a button or a link in JSX: a control inside a control is invalid HTML, a screen reader cannot tell the two apart, and their touch targets overlap.
//
// THE BUG THIS PREVENTS. The wire row's Enabled checkbox sat inside the
// button that opens the wire, so one tap target held another and the walk's
// tapTargets check found them overlapping on an iPhone (#7514, 2026-10-19).
// A stopPropagation on the inner one hides the wrong click, not the nesting.
//
// THE RULE. Inside the JSX of a <button>, an <a> or a router <Link>, no
// <button>, <a>, <Link>, <input>, <select> or <textarea> is written. The two
// controls are siblings instead: the row's button beside its switch. There
// is no opt-out; the fix is always available.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A <Link> is a link only
// when the file imports it from react-router(-dom): LinksSection.tsx's
// "<Link size={10} /> Link" button holds lucide's chain icon of that name.
// And only what one file writes inside the tag is judged: a
// component rendered inside a button (<Avatar />) is not opened, since what
// it renders is not known here. The walks' tapTargets check sees the page as
// drawn and holds the rest. Found at the time: the wire row and the camera
// wall's tile, whose display-only checkbox sat in its button while selecting.
//
// PROVED RED on BindingsPage.tsx and fleet.tsx before their fix (2 violations).
// Router links: a <Link> or <NavLink> around a <button> is the same fault.
//
//   npx tsx scripts/lint-no-control-inside-a-control.ts   (pnpm lint no-control-inside-a-control)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = ["web/src", "packages", "modules"];
const OUTER = new Set(["button", "a"]);
const INNER = new Set(["button", "a", "input", "select", "textarea"]);

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // The names this file imports from the router (Link, NavLink, or an alias) draw an <a>.
  const routerLinks = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !/^react-router(-dom)?$/.test((st.moduleSpecifier as ts.StringLiteral).text)) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) if (/^(Nav)?Link$/.test((el.propertyName ?? el.name).text)) routerLinks.add(el.name.text);
  }
  const isLink = (tag: string) => routerLinks.has(tag);
  const tagOf = (n: ts.Node) => (ts.isJsxElement(n) ? n.openingElement.tagName.getText(sf) : ts.isJsxSelfClosingElement(n) ? n.tagName.getText(sf) : null);
  const visit = (n: ts.Node, outer: { tag: string; line: number } | null) => {
    const tag = tagOf(n);
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    if (tag && outer && (INNER.has(tag) || isLink(tag))) out.push({ file, line, what: `<${tag}> inside the <${outer.tag}> at line ${outer.line}: a control inside a control` });
    const next = tag && (OUTER.has(tag) || isLink(tag)) ? { tag, line } : outer;
    ts.forEachChild(n, (c) => visit(c, next));
  };
  visit(sf, null);
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-control-inside-a-control - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Make the two controls siblings: the row's button beside its switch, never around it (#7514).");
  process.exit(1);
}
console.log(`lint:no-control-inside-a-control OK`);
