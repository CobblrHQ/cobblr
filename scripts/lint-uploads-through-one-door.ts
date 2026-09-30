#!/usr/bin/env tsx
// Every multipart upload goes through the platform's one upload door (platform().http.upload / uploadOne); multer is imported nowhere else, and a route reads its file only as uploadedFile(req).
//
// THE BUG THIS PREVENTS. An upload over a route's limit answered 500 internal error on the hosted app, because multer's LIMIT_FILE_SIZE was unhandled on every route that used multer directly (2026-09-30).
//
// THE RULE. Nothing imports `multer` except the door itself,
// api/src/platform/uploads.ts. A route takes its file with
// `uploadOne({ maxBytes })` (@cobblr/platform-contract) or, inside the api,
// `uploadMiddleware(...)`. The door answers every refusal (too large, too many
// files, the wrong field) as a 413/400 with the file's size and the limit, and
// logs it; a route that used multer directly answered 500 for all of them.
// There is no opt-out: a route that needs something the door does not do
// adds it to the door, where every route gets it.
//
// AND the second half: a route reads the file as `uploadedFile(req)`
// (@cobblr/platform-contract/upload), never `req.file` or the
// `Express.Multer.File` type. The door streams the file to disk, so there is
// no `buffer`; @types/multer still types one, which compiles and is
// undefined at run time (every route read `file.buffer` until uploads
// streamed, and the type would have let one keep doing it).
//
// THE BOUNDARY. Only real imports count: `import ... from "multer"`,
// `require("multer")` and `import("multer")`. The word in a comment or a
// string (this header, the lockfile, the docs) is not an import. `req.file`
// and `Multer.File` are judged outside comments, anywhere but the door.
//
// PROVE IT RED: it was run against the seven routes that imported multer
// before the door existed, and failed on each.
//
//   npx tsx scripts/lint-uploads-through-one-door.ts   (pnpm lint uploads-through-one-door)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages"];

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

/** The check. Return every violation in one file; an empty array is a pass. */
/** The door is the one place multer may be imported. */
const DOOR = "api/src/platform/uploads.ts";
const READS = /(?:\breq\??\.file\b|\bMulter\.File\b|\{\s*file\?:\s*\{\s*buffer\b)/;
const IMPORTS = /(?:\bfrom\s+["']multer["']|\brequire\(\s*["']multer["']\s*\)|\bimport\(\s*["']multer["']\s*\))/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (file.replace(/\\/g, "/") === DOOR) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (IMPORTS.test(line)) out.push({ file, line: i + 1, what: "imports multer directly; take the file through uploadOne({ maxBytes }) so a refusal is a 413 with its size, never a 500" });
    if (READS.test(line)) out.push({ file, line: i + 1, what: "reads multer's file directly; read it as uploadedFile(req), which has no buffer (the upload is on disk)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:uploads-through-one-door - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use uploadOne({ maxBytes }) from @cobblr/platform-contract (or uploadMiddleware in the api), never multer.");
  process.exit(1);
}
console.log(`lint:uploads-through-one-door OK`);
