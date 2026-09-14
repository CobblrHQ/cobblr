#!/usr/bin/env tsx
// A web surface changes the workspace's shape (bundle features, module enable/disable, bundle install/remove/revert, instance create/delete, field def edits, kind overrides) only through platform-web's changeWorkspaceShape / useChangeWorkspaceShape, never the endpoint itself, so the change refreshes every query the new shape can have altered.
//
// THE BUG THIS PREVENTS. Enabling Home Inventory's Labels feature put Labels in the nav, but an open item offered no Print label until a reload: the feature save refreshed the six keys its author remembered and the item's action list was not one of them (#2975, 2026-09-14). #2969 was the same class for actions.
//
// THE RULE. In web/src, packages/platform-web/src and every module's src/ui,
// a call to a shape endpoint (`.setBundleFeatures(`, `.installBundle(`,
// `.uninstallBundle(`, `.bundleRevert(`, `.enableModule(`, `.disableModule(`,
// `.createInstance(`, `.deleteInstance(`, `.createFieldDef(`,
// `.updateFieldDef(`, `.deleteFieldDef(`, `.applyFieldPreset(`,
// `.removeFieldPreset(`, `.upsertOverride(`, `.deleteOverride(`) must sit
// inside the argument of `changeWorkspaceShape(...)` or of `changeShape(...)`,
// the name the hook's result takes (`const changeShape =
// useChangeWorkspaceShape()`). Where the endpoint is DEFINED (an api client,
// the platform-web api type, the App.tsx line that hands the client to
// platform-web's context) is not a call. Tests are not judged. A genuine
// exception opts out with `// ONE-DOOR: <why>` on the same line.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-shape-changes-run-through-one-door.ts   (pnpm run lint:shape-changes-run-through-one-door)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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

const SHAPE_METHODS = [
  "setBundleFeatures",
  "installBundle",
  "uninstallBundle",
  "bundleRevert",
  "enableModule",
  "disableModule",
  "createInstance",
  "deleteInstance",
  "createFieldDef",
  "updateFieldDef",
  "deleteFieldDef",
  "applyFieldPreset",
  "removeFieldPreset",
  "upsertOverride",
  "deleteOverride",
];
const SHAPE_CALL = new RegExp(`\\.(${SHAPE_METHODS.join("|")})\\s*\\(`, "g");
const DOOR_CALL = /\b(changeWorkspaceShape|changeShape)\s*\(/g;

/** Where an endpoint is defined rather than called. A module's own api
 *  client (`modules/<m>/src/ui/api.ts`) is matched below. */
const ALLOWED = new Set([
  "packages/platform-web/src/workspace-shape.ts",
  "packages/platform-web/src/types.ts",
  "web/src/lib/api.ts",
  "web/src/App.tsx",
]);

/** The [open, close] index of every door call's argument list. Strings,
 *  template literals and comments are skipped so a paren inside them does not
 *  end the range early. */
function doorRanges(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.matchAll(DOOR_CALL)) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(src, open);
    if (close > open) out.push([open, close]);
  }
  return out;
}

function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
      if (i < 1) return -1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function skipString(src: string, at: number): number {
  const q = src[at];
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === q) return i;
    if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
      i = matchingBrace(src, i + 1);
      if (i < 0) return src.length;
    }
  }
  return src.length;
}

function matchingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (ALLOWED.has(file)) return [];
  if (!/\/src\/ui\/|^web\/src\/|^packages\/platform-web\/src\//.test(file)) return [];
  if (/^modules\/[^/]+\/src\/ui\/api\.ts$/.test(file)) return [];
  const ranges = doorRanges(src);
  const out: Violation[] = [];
  for (const m of src.matchAll(SHAPE_CALL)) {
    const at = m.index;
    if (ranges.some(([open, close]) => at > open && at < close)) continue;
    const lineStart = src.lastIndexOf("\n", at) + 1;
    const lineEnd = src.indexOf("\n", at);
    const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
    if (/ONE-DOOR:/.test(line)) continue;
    const lineNo = src.slice(0, at).split("\n").length;
    out.push({ file, line: lineNo, what: `calls .${m[1]}( itself; run it inside changeShape(() => ...) from useChangeWorkspaceShape(), or changeWorkspaceShape(qc, slug, () => ...)` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:shape-changes-run-through-one-door - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A shape change refreshes the workspace once, from the door; a caller that remembers its own keys misses the next one.");
  process.exit(1);
}
console.log(`lint:shape-changes-run-through-one-door OK`);
