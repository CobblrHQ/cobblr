#!/usr/bin/env tsx
// The CI handbook's index, docs/operations/CI_DEPLOY.md, holds only its preamble and link lines: a new section goes in a topic file under docs/operations/ci/.
//
// THE BUG THIS PREVENTS. CI_DEPLOY.md was the merge queue's busiest re-check file: 40 of a week's 224 overlapping
// merges, because every CI fix appended a dated section at its end, so any two CI pull requests overlapped at its last
// line (#7379, split 2026-10-28). The topic files under docs/operations/ci/ take the sections now; the index must not
// grow back into the one file everyone appends to.
//
// THE RULE. In CI_DEPLOY.md:
//   - the preamble (before the first `## `) stays under PREAMBLE_MAX lines;
//   - its only `## ` heading is "Where each part lives";
//   - from that list's first item on, every non-blank line is a list item linking into ci/;
//   - every topic file in docs/operations/ci/ is linked from it, so a new topic file is never an orphan.
// No opt-out: a section that seems to need the index belongs in a topic file, or in a new one.
//
// THE BOUNDARY. The few prose lines between the heading and the list (why the index is an index) are allowed: they
// come before the first item. Nothing has tested the edge beyond that yet.
//
//   npx tsx scripts/lint-ci-docs-by-topic.ts   (pnpm lint ci-docs-by-topic)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.COBBLR_LINT_ROOT || ".";
const INDEX = "docs/operations/CI_DEPLOY.md";
const TOPICS = "docs/operations/ci";
const HEADING = "## Where each part lives";
const PREAMBLE_MAX = 45;

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function check(index: string, topicFiles: string[]): Violation[] {
  const out: Violation[] = [];
  const lines = index.split("\n");
  const first = lines.findIndex((l) => l.startsWith("## "));
  if (first < 0) return [{ file: INDEX, line: 1, what: `no "${HEADING}" list: the index must link every topic file` }];
  if (first > PREAMBLE_MAX) out.push({ file: INDEX, line: first, what: `the preamble is ${first} lines, over ${PREAMBLE_MAX}: a new paragraph belongs in a topic file` });
  let listed = false;
  lines.forEach((l, i) => {
    if (i < first) return;
    if (l.startsWith("#") && l.trim() !== HEADING) out.push({ file: INDEX, line: i + 1, what: `a heading in the index ("${l.trim()}"): put the section in docs/operations/ci/` });
    if (/^\s*- \[/.test(l)) listed = true;
    else if (listed && l.trim() !== "") out.push({ file: INDEX, line: i + 1, what: "a line that is not a link in the index's list: put it in the topic file it is about" });
    if (/^\s*- \[/.test(l) && !/\]\(ci\/[\w.-]+\.md(#[\w-]*)?\)/.test(l)) out.push({ file: INDEX, line: i + 1, what: "a list item that does not link a file under ci/" });
  });
  for (const f of topicFiles) if (!index.includes(`](ci/${f})`)) out.push({ file: `${TOPICS}/${f}`, line: 1, what: `not linked from ${INDEX}'s list: add "- [<title>](ci/${f}): <what belongs there>"` });
  return out;
}

if (process.argv[1] && /lint-ci-docs-by-topic\.ts$/.test(process.argv[1])) {
  const topicFiles = readdirSync(join(ROOT, TOPICS)).filter((f) => f.endsWith(".md")).sort();
  const violations = check(readFileSync(join(ROOT, INDEX), "utf8"), topicFiles);
  if (violations.length) {
    console.error(`lint:ci-docs-by-topic - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("move the section into the docs/operations/ci/<topic>.md it belongs to, or a new topic file, and link it from the index");
    process.exit(1);
  }
  console.log(`lint:ci-docs-by-topic OK (${topicFiles.length} topic files, all linked)`);
}
