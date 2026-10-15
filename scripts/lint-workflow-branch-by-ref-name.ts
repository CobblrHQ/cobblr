#!/usr/bin/env tsx
// A workflow compares the branch by github.ref_name, never github.ref against a refs/heads/ name, because Forgejo's scheduled runs carry the bare branch as github.ref
//
// THE BUG THIS PREVENTS. 2026-10-15: every scheduled nightly tour skipped its issue filing and coverage recording, gated on github.ref == 'refs/heads/main', which a scheduled run never matches
//
// Forgejo 15 fills github.ref from the run's stored ref, and a scheduled run stores the bare branch
// ("main", 2,846 of 2,846 scheduled runs), while a push stores "refs/heads/main". github.ref_name is
// "main" for both. The nightly's issues were filed only by hand-dispatched runs for days before anyone
// saw the scheduled one never did.
//
// THE RULE. In .forgejo/workflows, an expression comparing github.ref with == or != to a quoted
// 'refs/heads/...' fails. startsWith(github.ref, 'refs/heads/bisect/') passes: it is reached only by a
// push, which carries the full ref, and a prefix has no ref_name form. A shell script's own
// GITHUB_REF test is outside this rule.
//
// THE BOUNDARY. Only == and != against a refs/heads/ literal. A concurrency group built from
// github.ref is not a comparison and is left alone.
//
//   npx tsx scripts/lint-workflow-branch-by-ref-name.ts   (pnpm lint workflow-branch-by-ref-name)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = [".forgejo/workflows"];

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
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.ya?ml$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /github\.ref\s*(==|!=)\s*'refs\/heads\/([^']*)'|'refs\/heads\/([^']*)'\s*(==|!=)\s*github\.ref\b/.exec(line);
    if (m) out.push({ file, line: i + 1, what: `github.ref ${m[1] ?? m[4]} 'refs/heads/${m[2] ?? m[3]}' never matches a scheduled run, whose github.ref is the bare branch` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workflow-branch-by-ref-name - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("write github.ref_name == '<branch>'");
  process.exit(1);
}
console.log(`lint:workflow-branch-by-ref-name OK`);
