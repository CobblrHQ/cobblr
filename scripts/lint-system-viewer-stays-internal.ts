#!/usr/bin/env tsx
// SYSTEM_VIEWER, the reader that sees every field including hidden ones, is used only by internal logic that decides something, never in a file that answers a client, and each use says why on a SYSTEM-READ line above it.
//
// THE BUG THIS PREVENTS. undoing an import asked whether a hidden custom field still held values through a reader that could not see it, and would have deleted a field full of values (2026-09-30)
//
// THE RULE. A reference to SYSTEM_VIEWER outside its definition passes when
// (1) a `// SYSTEM-READ: <why>` comment sits within the three lines above
// it, and (2) the file does not answer HTTP requests itself: no Router(), no
// asyncHandler(, no res.status( / res.send( / res.json(<value>) on an Express
// response. Internal logic (a service, a sweeper, an undo, a heal, a
// provisioning copy) reads the truth; a route passes the person asking, so a
// field hidden from them is neither shown nor decides what they are told.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The import services read
// `await res.json()` off a fetch Response, which is not answering anybody;
// `res.json(` straight after `await`, or with nothing inside, is not a route.
//
// PROVED RED on an unannotated use and on a use moved into a route file.
//
//   npx tsx scripts/lint-system-viewer-stays-internal.ts   (pnpm lint system-viewer-stays-internal)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "api/src", "packages"];

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

const ANSWERS_A_CLIENT = /\bRouter\(|\basyncHandler\(|\bres\.(?:status|send|end)\(|(?<!await\s)\bres\.json\((?!\s*\))/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!src.includes("SYSTEM_VIEWER") || /platform-contract\/src\/index\.ts$/.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  const route = ANSWERS_A_CLIENT.test(src);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bSYSTEM_VIEWER\b/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*(import|\}|export \{)/.test(line) || /^\s*(type\s+)?SYSTEM_VIEWER,?$/.test(line.trim())) continue;
    if (route) out.push({ file, line: i + 1, what: "SYSTEM_VIEWER in a file that answers a client; pass the person asking instead" });
    const above = lines.slice(Math.max(0, i - 3), i).join("\n");
    if (!/SYSTEM-READ: \S/.test(above)) out.push({ file, line: i + 1, what: "SYSTEM_VIEWER without a SYSTEM-READ: line saying why this read must see hidden fields" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:system-viewer-stays-internal - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:system-viewer-stays-internal OK`);
