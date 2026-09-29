#!/usr/bin/env tsx
// A workflow that runs on a pull request push cancels its superseded run on the same ref
//
// THE BUG THIS PREVENTS. On 2026-09-28 the forge showed 110 live runs and
// the question was whether superseded pushes were holding queue slots. For
// ci.yml and verify-public-export.yml they were not: both key a concurrency
// group on the ref and cancel in progress off main, and not one of the 52
// live PR runs was for a head its PR had moved past. But docs-only.yml, run
// on every docs push beside them, declared no group, so each push added a run
// and kept every earlier one. In the same six hours 45 PR ci.yml runs were
// cancelled by a newer push, after about 630 runner-minutes of work: the
// cancel is what keeps that from being every run twice.
//
// THE RULE. A workflow triggered by `pull_request` (any event type that
// fires on a push to the branch) declares a top-level `concurrency` whose
// group names the ref (`github.ref` or `github.head_ref`) and whose
// `cancel-in-progress` is not `false`: `true`, or an expression that is true
// off main (ci.yml's `${{ github.ref != 'refs/heads/main' }}`, which keeps
// main's runs whole for lint:main-runs-complete). A genuine exception says
// why in a comment line anywhere in the file:
//   # pr-concurrency: not-needed <reason>
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. autopilot-card-on-close.yml
// runs on `pull_request: types: [closed]`: one run per PR, ever, and each
// is a notification that must be sent. Cancelling it would drop one. A
// workflow whose pull_request types are only closed/labeled/assigned-style
// events (none of opened, synchronize, reopened, and not the default set) is
// out of scope.
//
//   pnpm lint pr-runs-cancel-superseded
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".forgejo/workflows");

/** The pull_request event types that fire when a branch is pushed. */
const PUSH_TYPES = ["opened", "synchronize", "reopened"];

/** Whether the file's `on:` block runs it on a push to a pull request's branch. */
function runsOnPrPush(src: string): boolean {
  const onBlock = src.match(/^on:\s*\n((?:[ \t]+.*\n?|\s*\n)+)/m)?.[1] ?? src.match(/^on:\s*(.*)$/m)?.[1] ?? "";
  const m = /^([ \t]+)pull_request:[ \t]*(.*)\n((?:\1[ \t]+.*\n?)*)/m.exec(onBlock);
  if (!m) return /\bpull_request\b(?!_)/.test(onBlock.split("\n")[0] ?? "");
  const body = m[3] ?? "";
  const types = /types:\s*\[([^\]]*)\]/.exec(body)?.[1];
  // No `types:` means the default set, which includes synchronize.
  if (types === undefined) return true;
  return types.split(",").some((t) => PUSH_TYPES.includes(t.trim().replace(/['"]/g, "")));
}

/** What is wrong with the file's concurrency for PR pushes, or null. */
function concurrencyProblem(src: string): string | null {
  const block = /^concurrency:[ \t]*(.*)\n((?:[ \t]+.*\n?|[ \t]*#.*\n?)*)/m.exec(src);
  if (!block) return "declares no top-level `concurrency`, so every push keeps its earlier run queued and running";
  if (block[1]!.trim() && !block[1]!.trim().startsWith("#")) return "uses the one-line `concurrency:` form; give it a `group:` keyed on the ref and a `cancel-in-progress:`";
  const body = block[2] ?? "";
  const group = /^\s+group:\s*(.+)$/m.exec(body)?.[1] ?? "";
  if (!/github\.(ref|head_ref)\b/.test(group)) return "has a concurrency group that does not name the ref (github.ref or github.head_ref), so one PR's push cannot find its own earlier run";
  const cancel = /^\s+cancel-in-progress:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  if (!cancel || cancel === "false") return "does not cancel in progress, so a superseded run keeps its runner to the end";
  return null;
}

const findings: string[] = [];
for (const f of readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort()) {
  const src = readFileSync(join(DIR, f), "utf8");
  if (!runsOnPrPush(src)) continue;
  if (/^\s*#\s*pr-concurrency:\s*not-needed\s+\S.{10,}/m.test(src)) continue;
  const why = concurrencyProblem(src);
  if (why) findings.push(`  .forgejo/workflows/${f}: runs on every pull request push but ${why}`);
}

if (findings.length) {
  console.error(`lint:pr-runs-cancel-superseded - ${findings.length} workflow(s):`);
  for (const x of findings) console.error(x);
  console.error(
    "Add, as ci.yml does:\n" +
      "  concurrency:\n" +
      "    group: <name>-${{ github.ref }}\n" +
      "    cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}\n" +
      "A genuine exception: a comment line `# pr-concurrency: not-needed <reason>`.",
  );
  process.exit(1);
}
console.log("lint:pr-runs-cancel-superseded OK (every workflow run on a pull request push cancels its superseded run)");
