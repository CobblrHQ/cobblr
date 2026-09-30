#!/usr/bin/env tsx
// Every icon a module manifest declares at its top level is one the web app can draw: a key of the map in web/src/lib/module-icon.ts. All apps shows one per card, and an unknown name draws a generic lightning bolt.
//
// THE BUG THIS PREVENTS. All apps showed the same lightning bolt on Assets, Purchases, Locations, Files, Views and more, because the icon map knew 12 names and the manifests used 40 (#4046, 2026-09-29)
//
// THE RULE. The first `icon:` at a manifest's top level (two spaces in) in
// modules/<name>/src/module.ts, and the one inside its top-level `nav: {}`
// (which the card prefers, so it is checked too), name a key of `MAP` in
// web/src/lib/module-icon.ts. The map is read as text (its quoted or bare
// keys), so the lint needs nothing from the web build. No opt-out: a module
// with no drawable icon is a card with the wrong picture.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Top level only. Actions,
// header buttons and settings carry their own `icon:` (undo, eraser, unlink,
// ...) and are drawn by other resolvers; the first pattern matched those
// and asked for 60 names the card never shows. A specialisation's icon comes
// from its instance, at runtime, and is not in the manifest at all.
//
//   npx tsx scripts/lint-module-icons-resolve.ts   (pnpm lint module-icons-resolve)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MAP_FILE = "web/src/lib/module-icon.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function mapKeys(src: string): Set<string> {
  const body = /const ICON_NAMES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  return new Set([...body.matchAll(/^\s*"?([a-z0-9-]+)"?\s*:/gm)].map((m) => m[1] ?? ""));
}

const keys = mapKeys(readFileSync(MAP_FILE, "utf8"));
if (keys.size === 0) {
  console.error(`lint:module-icons-resolve - could not read MAP out of ${MAP_FILE}; the lint's parser and the file drifted`);
  process.exit(1);
}

function check(file: string, src: string): Violation[] {
  const found: Array<{ name: string; at: number }> = [];
  const top = /^ {2}icon:\s*"([^"]+)"/m.exec(src);
  if (top) found.push({ name: top[1] ?? "", at: top.index });
  const nav = /^ {2}nav:\s*\{([\s\S]*?)\n {2}\}/m.exec(src);
  const navIcon = nav ? /icon:\s*"([^"]+)"/.exec(nav[1] ?? "") : null;
  if (nav && navIcon) found.push({ name: navIcon[1] ?? "", at: nav.index + (nav[0].indexOf(navIcon[0])) });
  return found
    .filter((f) => !keys.has(f.name))
    .map((f) => ({ file, line: src.slice(0, f.at).split("\n").length, what: `icon "${f.name}" is not in ${MAP_FILE}, so its card draws a lightning bolt` }));
}

const violations: Violation[] = [];
for (const name of readdirSync("modules")) {
  const file = join("modules", name, "src", "module.ts");
  if (existsSync(file)) violations.push(...check(file, readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error(`lint:module-icons-resolve - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Add the name to MAP in web/src/lib/module-icon.ts (a lucide icon), or use one already there");
  process.exit(1);
}
console.log(`lint:module-icons-resolve OK`);
