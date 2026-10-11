#!/usr/bin/env tsx
// The merge train is retired (the owner chose direct merges, #5738): no script or workflow names it, its labels, its branches or its state.
//
// THE BUG THIS PREVENTS. The owner chose direct merges on 2026-10-11 and still saw "a merge train in
// queue": pull requests kept getting train:queued and train:first, every pull request showed a
// "CI / wake-train" check, and merge-train.yml, the train's state branch and a dozen scripts lived on.
// Retired by one change; this keeps it retired, so a copied snippet or a stale branch merged later
// cannot bring a piece of it back half-wired.
//
// THE RULE. No file under scripts/ or .forgejo/ (code, workflows, hooks, comments alike) contains the
// train's names: "merge train" / "merge-train", the train:queued and train:first labels, the wake-train
// job, train/ branches (refs/heads/train/, 'train/**'), its state branch merge-train-state, or its
// environment (TRAIN_PUSH_ENV, MERGE_TRAIN_*), or a dispatch of it (`watch-dispatch.mjs train`, the hourly
// watch's way to start a train, which reopened one after the retirement on 2026-10-11 while its workflow
// was still on main). No opt-out: there is nothing left to name.
//
// THE BOUNDARY. Recorded forge data (scripts/ci/fixtures/) keeps the pull request titles it recorded,
// "train: #5690" among them: a fixture is what the forge returned, never edited to suit a rule. This
// file and its own duration record name the patterns, so they are skipped too. The word "train" alone is not matched: "missed train
// after train" is English, and docs/ may tell the history.
//
// PROVED RED on main before the retirement (scripts/lint-no-merge-train.test.ts runs it on a tree
// with one such line).
//
//   npx tsx scripts/lint-no-merge-train.ts   (pnpm lint no-merge-train)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.env.COBBLR_LINT_ROOT ?? ".";
const ROOTS = ["scripts", ".forgejo"];
const SKIP = [/^scripts\/ci\/fixtures\//, /^scripts\/lint-no-merge-train(\.test)?\.ts$/, /^scripts\/lint-durations\/no-merge-train\.json$/];

export const TRAIN = /merge[- ]?train|train:(queued|first)\b|wake-train|refs\/heads\/train\/|['"]train\/\*\*['"]|merge-train-state|TRAIN_PUSH_ENV|MERGE_TRAIN_|watch-dispatch\.mjs\s+train\b/i;

interface Violation {
  file: string;
  line: number;
  text: string;
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
    else yield p;
  }
}

/** Every line of `src` that names the retired train. */
export function trainLines(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  src.split("\n").forEach((text, i) => {
    if (TRAIN.test(text)) out.push({ line: i + 1, text: text.trim().slice(0, 120) });
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("lint-no-merge-train.ts")) {
  const violations: Violation[] = [];
  for (const root of ROOTS) {
    for (const abs of walk(join(ROOT, root))) {
      const file = relative(ROOT, abs).split("\\").join("/");
      if (SKIP.some((re) => re.test(file))) continue;
      let src: string;
      try {
        src = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      for (const v of trainLines(src)) violations.push({ file, ...v });
    }
  }
  if (violations.length) {
    console.error(`lint:no-merge-train - ${violations.length} line(s) name the retired merge train:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
    console.error("The merge train is retired (#5738): merges are direct (scripts/lib/direct-merge.mjs). Remove the reference.");
    process.exit(1);
  }
  console.log("lint:no-merge-train OK (scripts/ and .forgejo/ never name the retired merge train)");
}
