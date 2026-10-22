#!/usr/bin/env tsx
// A test that needs the local document readers asks through localReadersForTest, never ocrAvailable itself: in CI their absence is a broken image and fails, elsewhere the test is skipped and says what it did not check.
//
// THE BUG THIS PREVENTS. a scanned receipt PDF test failed as a product regression on a laptop with no tesseract, while the OCR tests that asked ocrAvailable themselves skipped silently even in CI (#7778, 2026-10-22)
//
// THE RULE. A test file (*.test.ts or *.test.tsx under modules/) never calls
// ocrAvailable(): it asks localReadersForTest(what, { ocr, pdf }), which
// throws in CI when a reader is missing and, anywhere else, skips with a line
// saying what was not verified. A mention in a comment does not count.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the direct question is
// refused. A test that needs a reader and asks nothing at all fails on a
// machine without it, loudly, which is how the eleven poppler tests of #7778
// were found; that failure is visible, so a lint is not needed for it. The
// helper itself (local-readers-in-tests.ts) is no test and asks
// ocrAvailable on everyone's behalf.
//
//   npx tsx scripts/lint-tests-ask-for-the-local-readers.ts   (pnpm lint tests-ask-for-the-local-readers)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules"];

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
    else if (/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\bocrAvailable\s*\(/.test(line.replace(/\/\/.*$/, ""))) {
      out.push({ file, line: i + 1, what: "asks ocrAvailable() itself: in CI a missing engine then skips or fails as a product verdict" });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:tests-ask-for-the-local-readers - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("use localReadersForTest(what, { ocr, pdf }) from modules/core-scan/src/services/local-readers-in-tests.ts");
  process.exit(1);
}
console.log(`lint:tests-ask-for-the-local-readers OK`);
