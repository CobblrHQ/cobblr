#!/usr/bin/env tsx
// A refusal that sends a request's zod issues as details says what to change in its message (invalidBodyMessage from @cobblr/platform-contract/invalid-body), never a label like "Bad request body" or "Bad patch".
//
// THE BUG THIS PREVENTS. a 161-character part name came back as "Bad request body" and the form showed only that, while the details said name, at most 160 (#7592, 2026-10-20)
//
// THE RULE. Where a reply sends `details: <zod error>.issues`, its message
// is invalidBodyMessage(...) of those issues, or a sentence a person wrote
// (it ends in ".", "?" or "!" and does not open on "Bad" or "Invalid"). A
// badBody helper's default message is invalidBodyMessage(err.issues), never
// a literal. So "Bad request body", "Bad patch" and "enabled_features:
// string[] required" fail; "Choose whether warranty reminders are on." passes.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A refusal with no zod
// details ("The link is incomplete.") is not judged: it has nothing more to
// say. A hand-written sentence beside the details passes, since "Name, email
// and a password of 8 or more characters, please." already says what to do.
//
// PROVED RED on main: 141 replies across 62 files (the module badBody
// helpers among them), all rewritten in the same change.
//
//   npx tsx scripts/lint-invalid-body-says-what.ts   (pnpm lint invalid-body-says-what)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const WITH_ISSUES = /message:\s*"([^"\n]*)",\s*details:\s*[\w.?]+?issues\b/g;
const DEFAULT_LITERAL = /\w+:\s*z\.ZodError[^)]*?message\s*=\s*"([^"\n]*)"/g;
/** A sentence a person wrote, not a label. */
const sentence = (m: string) => /[.?!]$/.test(m.trim()) && !/^(Bad|Invalid)\b/.test(m);

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const line = (i: number) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(WITH_ISSUES)) if (!sentence(m[1]!)) out.push({ file, line: line(m.index!), what: `"${m[1]}" sent with the zod issues: say what to change, message: invalidBodyMessage(<the issues>)` });
  for (const m of src.matchAll(DEFAULT_LITERAL)) out.push({ file, line: line(m.index!), what: `badBody's default message is "${m[1]}": make it invalidBodyMessage(err.issues)` });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:invalid-body-says-what - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("message: invalidBodyMessage(parsed.error.issues)");
  process.exit(1);
}
console.log(`lint:invalid-body-says-what OK`);
