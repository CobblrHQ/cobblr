#!/usr/bin/env tsx
// A record made by a share's mirror always carries where it came from: in the sharing code a writer's create is called only from createMirrorCopy, which stamps origin_ref, or says on the line above why it is not a copy (NOT-A-COPY: <why>).
//
// THE BUG THIS PREVENTS. The share spec (#4627) requires every copy to link to its original; a copy without origin_ref is never updated or removed again and lingers in the friend's share space
//
// THE RULE. In a sharing file (api/src/platform/share-*.ts), every call of a
// writer's `create(` sits inside `createMirrorCopy` or carries
// `// NOT-A-COPY: <why>` on the line above, and `createMirrorCopy` itself
// writes ORIGIN_REF_KEY. A copy without its origin is never found again by the
// next pass: it is not updated, not removed when it leaves the scope, and stays
// in the friend's share space for good.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The places a copy is put in
// (ensurePlace) are made with a writer's create too, and are not copies of
// anything: they carry the annotation. Hand-over (share-offers.ts) lands
// things in an inbox through the OfferIntake, never a writer's create, so it
// is untouched.
//
// PROVE IT RED: a create of a copy written inline in the upsert handler.
//
//   npx tsx scripts/lint-mirror-copies-carry-origin.ts   (pnpm lint mirror-copies-carry-origin)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/platform"];

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

const NOTE = /\/\/\s*NOT-A-COPY:\s*\S.{6,}/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/\/share-[^/]*\.ts$/.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  let inCopyFn = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/function\s+createMirrorCopy\b/.test(line)) {
      inCopyFn = true;
      depth = 0;
      const body = src.slice(src.indexOf(line));
      const end = body.indexOf("\n}\n");
      if (!/ORIGIN_REF_KEY/.test(end > 0 ? body.slice(0, end) : body)) out.push({ file, line: i + 1, what: "createMirrorCopy does not write ORIGIN_REF_KEY" });
    }
    if (inCopyFn) {
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (depth <= 0 && /}/.test(line)) inCopyFn = false;
    }
    const code = line.replace(/\/\/.*$/, "");
    if (!/\.create\(/.test(code) || inCopyFn) continue;
    if (NOTE.test(lines[i - 1] ?? "") || NOTE.test(lines[i - 2] ?? "")) continue;
    out.push({ file, line: i + 1, what: "a writer's create outside createMirrorCopy: a copy made here carries no origin_ref" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:mirror-copies-carry-origin - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Make the copy through createMirrorCopy, or annotate // NOT-A-COPY: <why> above a create that is not a copy");
  process.exit(1);
}
console.log(`lint:mirror-copies-carry-origin OK`);
