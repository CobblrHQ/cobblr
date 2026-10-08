#!/usr/bin/env tsx
// A workflow step that ships a log to the failure sink never cuts a log file to its tail alone: it uses scripts/ci/sink-section.sh, which keeps every failure line from anywhere in it.
//
// THE BUG THIS PREVENTS. 2026-10-07, run 37750: the API image check went red, and its sink log's overlay
// section ended "Successfully tagged". The line that failed it ("mount callback failed ... failed to
// commit: rename ... no such file or directory") sat above the 150 lines the step kept. Two pull
// requests and a Codex job then chased "red with no failing step".
//
// THE RULE. Inside a step whose name says it ships to the sink, `tail -N <file>` / `tail -n N <file>`
// on a file is a violation. `bash scripts/ci/sink-section.sh <title> <file> [N]` keeps the failure
// lines above the tail too. A log that cannot hold a failure worth keeping says so on the line:
// `# sink-tail-ok: <why>`.
//
// THE BOUNDARY. Only sink steps, and only a tail of a FILE: `cmd | tail -N` trims a filtered list (the
// vitest FAIL lines), which is already the failure; a tail elsewhere in a job is that job's business.
//
//   npx tsx scripts/lint-sink-keeps-the-error.ts   (pnpm lint sink-keeps-the-error)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = ".forgejo/workflows";

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  let inSink = false, stepIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const step = /^(\s*)- name:\s*(.*)$/.exec(line);
    if (step) { inSink = /sink/i.test(step[2] ?? ""); stepIndent = (step[1] ?? "").length; continue; }
    if (inSink && /^\s*-\s/.test(line) && line.search(/\S/) <= stepIndent) inSink = false;
    if (!inSink || /^\s*#/.test(line) || /# sink-tail-ok: \S/.test(line)) continue;
    const m = /(^|[;&{(]\s*|\bthen\s+|\bdo\s+|^\s*)tail\s+(-n\s*)?-?\d+\s+("?[$/\w.-][^|;&]*)/.exec(line);
    if (m && !/\|\s*tail\b/.test(line)) out.push({ file, line: i + 1, what: `the sink keeps only the tail of ${m[3]!.trim()}: an error above it is lost` });
  }
  return out;
}

const violations: Violation[] = [];
for (const name of readdirSync(DIR).filter((n) => n.endsWith(".yml"))) violations.push(...check(join(DIR, name), readFileSync(join(DIR, name), "utf8")));

if (violations.length) {
  console.error(`lint:sink-keeps-the-error - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("bash scripts/ci/sink-section.sh <title> <file> [lines], or # sink-tail-ok: <why> for a log with no failure to lose");
  process.exit(1);
}
console.log(`lint:sink-keeps-the-error OK`);
