#!/usr/bin/env tsx
// A forge list read names its page: a GET of actions/tasks or actions/runs carries page=, and one of issues carries limit= or page= (or goes through paged()). Pull request lists are lint:pr-lists-are-paged's.
//
// THE BUG THIS PREVENTS. 2026-10-30 19:2xZ: actions/tasks and actions/runs read with limit but no page returned every row the forge holds (~97 MB) and hung for minutes; the merge queue's admission pass ran past its 120 s bound twice and the watchdog opened admission.
//
// THE RULE. A URL literal (it ends in `?` or its closing quote) for `/actions/tasks` or `/actions/runs` carries
// `page=` later on its line: this forge ignores `limit` there without it. One for `/issues` carries
// `limit=` or `page=`. A line that reads through `paged(` pages itself. A genuine whole-list read says
// `forge-list: whole <why>` on its line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first pass over scripts/ flagged 41 places and 34 were writes:
// a POST to `/issues` or `/pulls` opens one and lists nothing (open-pr.sh and surface-up.mjs put the POST a line or
// three from the URL, so a POST within two lines above or three below counts). The rest were comments and a
// docstring naming the endpoint in prose ("an /actions/tasks page"): a comment line is skipped, and a URL must end
// at `?` or a quote, never a space. `/actions/runs/123` is one run, not the list. Tests are out: their fakes answer
// list paths on purpose.
//
//   npx tsx scripts/lint-forge-lists-are-paged.ts   (pnpm lint forge-lists-are-paged)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites: the scripts, workflows and agent tools that call the forge. */
const ROOTS = ["scripts", ".forgejo/workflows", ".agents"];
const SELF = "scripts/lint-forge-lists-are-paged.ts";

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
    if (name === "node_modules" || name === "dist" || name === "fixtures" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mjs|js|sh|py|ya?ml)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && p !== SELF && !isEmbeddedPayload(p)) yield p;
  }
}

const LIST = /\/(actions\/tasks|actions\/runs|issues)(?=[?"'`])/g;

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|#|\*|\/\*)/.test(line) || /forge-list: whole \S/.test(line) || line.includes("paged(")) continue;
    if (lines.slice(Math.max(0, i - 2), i + 4).some((l) => /POST/.test(l))) continue;
    for (const m of line.matchAll(LIST)) {
      const ep = m[1]!;
      const rest = line.slice((m.index ?? 0) + m[0].length);
      const paged = ep.startsWith("actions/") ? /page=/.test(rest) : /(limit|page)=/.test(rest);
      if (!paged) out.push({ file, line: i + 1, what: ep.startsWith("actions/") ? `/${ep} read without page= (the forge ignores limit without it and returns every row)` : `/${ep} read without limit= or page=` });
    }
  }
  return out;
}

if (process.argv[1]?.endsWith("lint-forge-lists-are-paged.ts")) {
  const violations: Violation[] = [];
  // The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

  if (violations.length) {
    console.error(`lint:forge-lists-are-paged - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Add page=1 (and a limit) to the URL, or read through a paged() helper; the forge ignores limit without page on these endpoints. A genuine whole-list read says `forge-list: whole <why>` on its line.");
    process.exit(1);
  }
  console.log(`lint:forge-lists-are-paged OK`);
}
