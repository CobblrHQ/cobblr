#!/usr/bin/env tsx
// An api test that posts a photo scan says allow_duplicate, because CI shares workspaces between test files and a fixture another file uploaded minutes ago is, correctly, the same picture.
//
// THE BUG THIS PREVENTS. The inbox answers the same picture posted again
// within ten minutes with the item it already made (#3852). The first CI run
// with that rule went red in receipt-shape-routes-before-identify: the file
// uploads receipt-torn.png into one workspace three times and counts three
// failed reads, and the second and third uploads were, correctly, one item.
// CI hands pooled workspaces to test files, so the same trap waits for any
// test uploading a shared fixture, one run in several, depending on which
// file had that workspace last.
//
// THE RULE. A body in api/tests that posts `source_kind: "photo"` carries
// `allow_duplicate` in the same object literal (true: every post is a new
// item, which is what a test that counts items means). A test ABOUT the
// duplicate rule opts out with `// SAME-PICTURE-TEST: <why>` on the line or
// the line above, and gives its pictures bytes of their own.
//
// THE BOUNDARY. Only api/tests, and only the object literal on that line: the
// e2e walks sign up a fresh workspace each and never share one. A body built
// across several lines is read from `source_kind: "photo"` to its closing
// brace. Nothing has tested the boundary further yet.
//
//   npx tsx scripts/lint-test-photo-scans-say-if-a-repeat-is-new.ts   (pnpm lint test-photo-scans-say-if-a-repeat-is-new)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "api/tests";
const OPT_OUT = /\/\/ SAME-PICTURE-TEST: \S/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The object literal that starts at `from`: up to its matching brace. */
function literalFrom(src: string, from: number): string {
  const open = src.lastIndexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (const m of src.matchAll(/source_kind:\s*"photo"/g)) {
    const at = m.index ?? 0;
    const lineNo = src.slice(0, at).split("\n").length;
    const here = lines[lineNo - 1] ?? "";
    const above = lines[lineNo - 2] ?? "";
    if (OPT_OUT.test(here) || OPT_OUT.test(above)) continue;
    if (/\ballow_duplicate\b/.test(literalFrom(src, at))) continue;
    out.push({ file, line: lineNo, what: 'a photo scan without allow_duplicate: in a shared workspace a fixture another file uploaded is the same picture, and the post returns that item instead of a new one' });
  }
  return out;
}

const violations: Violation[] = [];
for (const name of readdirSync(ROOT)) {
  if (name === ".git" || !/\.test\.ts$/.test(name)) continue;
  const file = join(ROOT, name);
  violations.push(...check(file, readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error(`lint:test-photo-scans-say-if-a-repeat-is-new - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error('Add allow_duplicate: true to the body, or // SAME-PICTURE-TEST: <why> on a test about the rule itself.');
  process.exit(1);
}
console.log(`lint:test-photo-scans-say-if-a-repeat-is-new OK`);
