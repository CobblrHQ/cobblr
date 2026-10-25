#!/usr/bin/env tsx
// A workflow a person or session can dispatch never cancels a run on a dispatch: its concurrency cancel-in-progress is false for workflow_dispatch, unless one dispatcher owns the group
//
// THE BUG THIS PREVENTS. 2026-10-24 23:17Z: seven empty nightly-tour dispatches cancelled another session's seven
// queued branch tours through the per-ref group. Every session dispatches as the same forge user, so a group keyed by
// the dispatcher cannot tell two sessions apart; the only seam that closes it whatever path fires the dispatch (the
// script, the API, the web button) is the workflow's own rule.
//
// THE RULE. In a workflow with a `workflow_dispatch` trigger, every `cancel-in-progress:` is one of:
//   - `false`;
//   - an expression that ANDs in `github.event_name != 'workflow_dispatch'` (a push still supersedes a push);
//   - anything else under a `# dispatch-cancel-ok: <why one dispatcher owns this group>` line directly above it.
// A dispatch with cancel-in-progress false queues behind its group's run instead (Forgejo 15 serialises the group).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. fast-lane.yml's group is one pull request, and only the merge queue
// dispatches it: a newer run for that PR replaces the older by design. That is the annotation's case. A workflow
// with no dispatch trigger (ci-fast.yml, push on fast/**) is out of scope: only its own pushes reach its group.
//
//   npx tsx scripts/lint-dispatch-never-cancels.ts   (pnpm lint dispatch-never-cancels)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const WORKFLOWS = process.env.LINT_DISPATCH_NEVER_CANCELS_DIR || ".forgejo/workflows";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const ANNOTATION = /^\s*#\s*dispatch-cancel-ok:\s*\S/;
const SPARES_DISPATCH = /github\.event_name\s*!=\s*'workflow_dispatch'/;

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const on = lines.findIndex((l) => /^(on|"on"|'on'):/.test(l));
  if (on < 0) return out;
  let dispatchable = false;
  for (let i = on + 1; i < lines.length && !/^\S/.test(lines[i] ?? ""); i++) if (/^\s+workflow_dispatch\s*:/.test(lines[i] ?? "")) dispatchable = true;
  if (/^on:\s*\[?.*workflow_dispatch/.test(lines[on] ?? "")) dispatchable = true;
  if (!dispatchable) return out;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*cancel-in-progress:\s*(.*?)\s*$/.exec(lines[i] ?? "");
    if (!m) continue;
    const value = m[1] ?? "";
    if (value === "false") continue;
    if (SPARES_DISPATCH.test(value) && !value.includes("||")) continue;
    if (ANNOTATION.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: `cancel-in-progress: ${value} can cancel a run when someone dispatches this workflow, whoever queued it` });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  let seen = 0;
  for (const name of readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = join(WORKFLOWS, name);
    seen++;
    if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));
  }
  if (!seen) {
    console.error(`lint:dispatch-never-cancels - no workflow read under ${WORKFLOWS}`);
    process.exit(1);
  }
  if (violations.length) {
    console.error(`lint:dispatch-never-cancels - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("AND in `github.event_name != 'workflow_dispatch'` (or make it false); if one dispatcher owns the group, say so in a `# dispatch-cancel-ok: <why>` line above it.");
    process.exit(1);
  }
  console.log(`lint:dispatch-never-cancels OK (${seen} workflows)`);
}
