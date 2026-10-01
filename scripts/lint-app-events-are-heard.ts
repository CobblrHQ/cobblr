#!/usr/bin/env tsx
// Every app event a screen dispatches has something listening for it, so a button that fires one is never a button that does nothing.
//
// THE BUG THIS PREVENTS. The command palette's "Add a thing" fired
// cobblr:open-add-sheet into nothing for months (#4199). Its comment said
// "anything can ask for the quick-add sheet", the sheet did not exist, and
// the row looked finished: a click, the palette closing, no error, no sheet.
// A window event is a promise that somebody is listening, and nothing checked
// that anybody was.
//
// THE RULE. For every `new CustomEvent(X)` / `new Event(X)` in a screen's
// source (web/src, platform-web, a module's ui/) whose name is an app event
// (namespaced, "cobblr:…"), some `addEventListener(X, …)` in the same tree
// listens for that name. X may be a string or a constant naming one; the
// constant is resolved in its own file first, then across the tree. A
// dispatch that is deliberately for code outside this tree (a browser
// extension, a test harness) says so on the line or the one above:
// `// event-heard-outside: <who>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only namespaced names: a
// component that dispatches a plain DOM event ("resize", "input") is asking
// the browser, not the app. Tests are out of scope; a test that dispatches an
// event is the listener's caller, not a screen's button.
//
// PROVEN RED (2026-09-30) on main's own tree: it named
// cobblr:open-add-sheet, dispatched by CommandPalette.tsx and heard by
// nobody, before QuickAddSheet listened for it.
//
//   npx tsx scripts/lint-app-events-are-heard.ts   (pnpm lint app-events-are-heard)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "packages/platform-web/src"];
const OPT_OUT = /event-heard-outside:\s*\S/;
const APP_EVENT = /^[a-z][a-z0-9-]*:[a-z0-9-:.]+$/;

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

const files: string[] = [];
for (const r of ROOTS) files.push(...walk(r));
for (const mod of readdirSync("modules")) files.push(...walk(join("modules", mod, "src", "ui")));

const src = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));

/** `const NAME = "value"` per file, and across the tree. */
const CONST = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g;
const localConsts = new Map<string, Map<string, string>>();
const globalConsts = new Map<string, string>();
for (const [f, text] of src) {
  const m = new Map<string, string>();
  for (const c of text.matchAll(CONST)) {
    m.set(c[1]!, c[2]!);
    if (!globalConsts.has(c[1]!)) globalConsts.set(c[1]!, c[2]!);
  }
  localConsts.set(f, m);
}
const resolve = (f: string, token: string): string | null => {
  const lit = token.match(/^["'`]([^"'`]+)["'`]$/)?.[1];
  if (lit) return lit;
  return localConsts.get(f)?.get(token) ?? globalConsts.get(token) ?? null;
};

const ARG = String.raw`(["'\`][^"'\`]+["'\`]|[A-Z][A-Z0-9_]*)`;
const DISPATCH = new RegExp(String.raw`new\s+(?:Custom)?Event\s*(?:<[^>]*>)?\(\s*${ARG}`, "g");
const LISTEN = new RegExp(String.raw`addEventListener\(\s*${ARG}`, "g");

const heard = new Set<string>();
for (const [f, text] of src) {
  for (const m of text.matchAll(LISTEN)) {
    const name = resolve(f, m[1]!);
    if (name) heard.add(name);
  }
}

const out: string[] = [];
let dispatched = 0;
for (const [f, text] of src) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(DISPATCH)) {
      const name = resolve(f, m[1]!);
      if (!name || !APP_EVENT.test(name)) continue;
      dispatched++;
      if (heard.has(name)) continue;
      if (OPT_OUT.test(lines[i]!) || OPT_OUT.test(lines[i - 1] ?? "")) continue;
      out.push(`  ${f}:${i + 1}  dispatches "${name}", and nothing listens for it`);
    }
  }
}

if (out.length) {
  console.error(
    `✗ lint:app-events-are-heard: ${out.length} app event(s) fired into nothing:\n${out.join("\n")}\n\n` +
      "Whatever fires it looks like it works and does nothing. Mount the thing that listens (a sheet, a panel), " +
      "or remove the dispatch. An event for code outside this tree says so: // event-heard-outside: <who>",
  );
  process.exit(1);
}
console.log(`✓ lint:app-events-are-heard: ${dispatched} app event dispatch(es), every one heard`);
