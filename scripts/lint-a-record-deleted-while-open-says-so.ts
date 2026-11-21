#!/usr/bin/env tsx
// A page that reads one record by its id says, when that read finds the record gone, who deleted it and the way back through RecordGone from platform-web, keeping what the page showed.
//
// THE BUG THIS PREVENTS. A part a teammate deleted while it was open on a phone replaced the page, and a half-typed note, with a raw 'part not found' (2026-11-21, #4115)
//
// THE RULE. A page (.tsx) whose query reads one record by its id
// (`queryFn: () => api.getPart(id)`, any getter named get<Thing> handed an id)
// renders RecordGone somewhere in the file. A read that is not a record a
// person keeps open (a settings blob, a lookup by id that never 404s) says why
// on a `// record-gone-ok:` line, on the read's line or the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only a getter handed an id
// counts: list reads and reads by a slug or a name are not one record a page
// keeps open. Tests are not judged; a word in a comment is not a read
// (stripComments).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-record-deleted-while-open-says-so.ts   (pnpm lint a-record-deleted-while-open-says-so)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { stripComments } from "./lib/source-scan.ts";

/** Where the rule bites: the pages a person opens a record on. */
const ROOTS = ["modules", "web/src"];

const ONE_RECORD_READ = /queryFn:\s*\(\)\s*=>\s*[\w.]+\.get[A-Z]\w*\(\s*(?:id|\w+Id)!?\s*\)/;

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
  const code = stripComments(src);
  if (/\bRecordGone\b/.test(code)) return [];
  const lines = src.split("\n");
  const out: Violation[] = [];
  code.split("\n").forEach((l, i) => {
    if (!ONE_RECORD_READ.test(l)) return;
    if (/\/\/ record-gone-ok: \S/.test(`${lines[i - 1] ?? ""}\n${lines[i]}`)) return;
    out.push({ file, line: i + 1, what: "reads one record by its id but never says, through RecordGone, that it was deleted" });
  });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-record-deleted-while-open-says-so - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Render <RecordGone slug getToken kind id noun kept /> when isRecordGone(query.error), keeping the page; or // record-gone-ok: <why this read is not a record kept open>");
  process.exit(1);
}
console.log(`lint:a-record-deleted-while-open-says-so OK`);
