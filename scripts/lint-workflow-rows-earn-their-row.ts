#!/usr/bin/env tsx
// A pull request or comment event starts one workflow, ci.yml: any other workflow it starts says why it needs a row of its own, and a workflow that listens to issue_comment or a labeled pull request uses that event in its first job's if.
//
// THE BUG THIS PREVENTS. #6199, 2026-10-13: the owner called the Actions list "a warzone". Forgejo writes a
// row for every event a workflow's `on:` matches, even when every job then skips. fast-lane.yml listened to
// every pull request event and every issue comment in the repository to find the rare `critical` one, about
// a thousand skipped rows a day; csp-shell.yml listened to the same pull request events as ci.yml, a second
// row for each. One push made about seven rows.
//
// THE RULE. A workflow whose `on:` has pull_request, pull_request_target or issue_comment is ci.yml, or carries
// a line `# OWN ROW OK: <why>` (it runs on its own runner or a path filter of its own, say). And a workflow that
// listens to issue_comment, or to a pull request's `labeled`, names that event in its first job's `if:`
// (`github.event.comment`, `github.event.issue`, `github.event.label`): a listener that never reads what it
// heard is the skipped row in waiting. Work started by something rarer than an event (the fast lane) is a
// `workflow_dispatch` the merge queue sends.
//
// THE BOUNDARY. Push, schedule and workflow_dispatch are not judged: a merge is one push, and main's own
// workflows (ci-main.yml, docker-build.yml) are not in the pull request list the owner reads. ci.yml listens
// to `labeled` and is still judged by the second half: `ci:ready` is its start signal, and its first job's
// `if:` reads github.event.label.
//
//   npx tsx scripts/lint-workflow-rows-earn-their-row.ts   (pnpm lint workflow-rows-earn-their-row)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.env.COBBLR_LINT_ROOT || ".", ".forgejo", "workflows");
const PR_EVENTS = ["pull_request", "pull_request_target", "issue_comment"];

interface Violation {
  file: string;
  what: string;
}

/** The `on:` block's event names, and a pull request's types when it lists them. */
export function triggers(yml: string): { events: Set<string>; labeled: boolean } {
  const events = new Set<string>();
  let labeled = false;
  const inline = /^on:\s*\[([^\]]*)\]/m.exec(yml) ?? /^on:\s*([a-z_]+)\s*$/m.exec(yml);
  if (inline) for (const e of (inline[1] ?? "").split(",")) events.add(e.trim());
  const block = /^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(yml)?.[1] ?? "";
  let current = "";
  for (const line of block.split("\n")) {
    const ev = /^ {2}([a-z_]+):/.exec(line);
    if (ev) {
      current = ev[1]!;
      events.add(current);
      continue;
    }
    if ((current === "pull_request" || current === "pull_request_target") && /^\s+types:.*\blabeled\b/.test(line)) labeled = true;
  }
  return { events, labeled };
}

/** The first job's `if:` text, folded block or one line. */
export function firstJobIf(yml: string): string {
  const jobs = yml.slice(yml.search(/^jobs:\s*$/m));
  const job = /^ {2}[A-Za-z0-9_-]+:\s*\n((?: {4,}.*\n|\s*\n)*)/m.exec(jobs)?.[1] ?? "";
  const m = /^ {4}if:\s*(.*)\n((?: {6,}.*\n)*)/m.exec(job);
  return m ? `${m[1]} ${m[2] ?? ""}` : "";
}

export function check(file: string, yml: string): Violation[] {
  const out: Violation[] = [];
  const t = triggers(yml);
  const prEvents = PR_EVENTS.filter((e) => t.events.has(e));
  if (prEvents.length && file !== "ci.yml" && !/^\s*# OWN ROW OK: \S.{8,}/m.test(yml)) {
    out.push({ file, what: `${prEvents.join(", ")} starts it beside ci.yml, a second row for each event: make it a job of ci.yml, a dispatch, or say why with '# OWN ROW OK: <why>'` });
  }
  const cond = firstJobIf(yml);
  if (t.events.has("issue_comment") && !/github\.event\.(comment|issue)\b/.test(cond)) {
    out.push({ file, what: "it listens to issue_comment and its first job's if never reads the comment: every comment in the repository is a skipped row" });
  }
  if (t.labeled && !/github\.event\.label\b/.test(cond)) {
    out.push({ file, what: "it listens to labeled and its first job's if never reads which label: every label change is a row" });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const f of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort()) violations.push(...check(f, readFileSync(join(DIR, f), "utf8")));
  if (violations.length) {
    console.error(`lint:workflow-rows-earn-their-row - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  .forgejo/workflows/${v.file}  ${v.what}`);
    console.error("One pull request event, one row: fold the work into ci.yml, dispatch it, or say why it needs its own (# OWN ROW OK: <why>).");
    process.exit(1);
  }
  console.log("lint:workflow-rows-earn-their-row OK");
}
