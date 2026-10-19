#!/usr/bin/env tsx
// The backlog index docs/BACKLOG.md is fixed text and every entry is its own file under docs/backlog.d/ with a status, so two pull requests that add or close unrelated entries never edit one file.
//
// THE BUG THIS PREVENTS. docs/BACKLOG.md was the merge queue's fifth re-check
// hotspot, in 7 of the 224 overlapping merges in the week to 2026-10-19
// (#7383): feature pull requests struck their entry or added a deferral in the
// one 2,980-line file, so any two collided.
//
// THE RULE. docs/BACKLOG.md is exactly INDEX_TEXT from scripts/lib/backlog.mjs;
// any other content fails and points at docs/backlog.d/. Changing the index is
// a code change to that constant, then `pnpm run backlog -- --write-index`.
// Every docs/backlog.d/*.md has front matter with `status:` one of open,
// parked or shipped and a `title:`, and its first heading is `# <title>`. A
// struck title (~~...~~) is shipped, so it needs `status: shipped`. A
// `deferred_from:` names docs that exist under docs/.
//
// THE BOUNDARY. The entry's body is free: this lint judges the shape that
// keeps entries apart, not what they say (the deferral lints judge the
// deferred lists). Nothing has tested the edge yet beyond the split itself.
//
//   npx tsx scripts/lint-backlog-index.ts   (pnpm lint backlog-index)
import { existsSync, readFileSync } from "node:fs";
import { BACKLOG_DIR, BACKLOG_INDEX, INDEX_TEXT, STATUSES, deferredFrom, entries } from "./lib/backlog.mjs";

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The index: fixed text. Returns the first line that differs, or none. */
export function checkIndex(text: string): Violation[] {
  if (text === INDEX_TEXT) return [];
  const a = text.split("\n");
  const b = INDEX_TEXT.split("\n");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [
    {
      file: BACKLOG_INDEX,
      line: i + 1,
      what: `is a fixed index, so it never collides. Write a backlog entry as its own file, ${BACKLOG_DIR}/<slug>.md (status: open, title: "..."); to change the index itself, edit INDEX_TEXT in scripts/lib/backlog.mjs and run pnpm run backlog -- --write-index`,
    },
  ];
}

/** One entry file's shape. */
export function checkEntry(e: { file: string; front: Record<string, string>; body: string }, docExists: (p: string) => boolean): Violation[] {
  const out: Violation[] = [];
  const v = (what: string) => out.push({ file: e.file, line: 1, what });
  if (!Object.keys(e.front).length) return [{ file: e.file, line: 1, what: 'has no front matter: start it with ---, status: open, title: "...", ---' }];
  if (!STATUSES.includes(e.front.status ?? "")) v(`status "${e.front.status ?? ""}" is not one of ${STATUSES.join(", ")}`);
  const title = e.front.title ?? "";
  if (!title) v("has no title");
  else if (!e.body.trimStart().startsWith(`# ${title}\n`)) v(`its first heading is not "# ${title}"`);
  if (/~~.+~~/.test(title) && e.front.status !== "shipped") v("its title is struck through, so it shipped: set status: shipped");
  for (const d of deferredFrom(e.front)) if (!docExists(`docs/${d}`)) v(`deferred_from names docs/${d}, which does not exist`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = [...checkIndex(readFileSync(BACKLOG_INDEX, "utf8"))];
  const list = entries();
  for (const e of list) violations.push(...checkEntry(e, existsSync));
  if (violations.length) {
    console.error(`lint:backlog-index - ${violations.length} violation(s):`);
    for (const x of violations) console.error(`  ${x.file}:${x.line}  ${x.what}`);
    console.error(`The backlog is one file per entry in ${BACKLOG_DIR}/, so two pull requests in different areas never edit one file.`);
    process.exit(1);
  }
  console.log(`lint:backlog-index OK (${list.length} entries, the index unchanged)`);
}
