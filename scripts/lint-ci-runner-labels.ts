#!/usr/bin/env tsx
// A workflow must ask for a runner label that exists.
//
// THE BUG THIS EXISTS FOR (2026-08-16): coupling-census.yml shipped with
// `runs-on: self-hosted`, a label no runner on this instance carries. Forgejo
// accepted the file, showed a small warning next to it in the UI, and the
// workflow simply never ran. Nothing failed, because a job that is never
// scheduled cannot fail — the census would have quietly produced no readings
// until somebody noticed the absence, which is the worst shape of bug: silence
// where you expected data.
//
// The label was written from memory instead of copied from a working workflow.
// That is not a mistake care prevents; it is one an allowlist prevents.
//
//   npx tsx scripts/lint-ci-runner-labels.ts   (npm run lint:ci-runner-labels)

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".forgejo", "workflows");

/** Labels runners on this instance actually carry.
 *
 *  `ubuntu-latest` is the hosted-style default the images answer to; `light`
 *  is the small A6 runner used for typecheck/lint work; `ci-test` is the one
 *  pinned for the postgres-backed suite. Adding a label here without adding a
 *  runner that answers to it re-creates exactly the silence above, so treat
 *  this list as a claim about infrastructure, not a formality. */
// bake-<box> is one label per PHYSICAL machine: the pool image is baked and
// committed locally, so the nightly bake has to land on each box by name.
const KNOWN = new Set(["ubuntu-latest", "light", "ci-test", "ci-test-full", "ci-e2e", "bake-a6", "bake-aurora"]);

const errors: string[] = [];
const seen = new Map<string, string[]>();

for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
  const src = readFileSync(join(DIR, f), "utf8");
  src.split("\n").forEach((line, i) => {
    const m = /^\s*runs-on:\s*(.+?)\s*$/.exec(line);
    if (!m) return;
    const label = m[1]!.replace(/^["']|["']$/g, "");
    // `runs-on: ${{ matrix.box }}` USED to be waved through as "an expression,
    // not ours to judge" — but a matrix is where the typo hides best: the job
    // is never scheduled and nothing fails, which is the exact silence this
    // lint exists for. Expand it: find that matrix key's values in the file and
    // judge each one.
    const mx = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/.exec(label);
    if (mx) {
      const key = mx[1]!;
      const vals = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(src);
      if (!vals) {
        errors.push(
          `.forgejo/workflows/${f}:${i + 1} runs-on is \`${label}\` but no \`${key}: [ … ]\` matrix was found in the file — ` +
            `a job whose label never resolves is never scheduled, and never fails.`,
        );
        return;
      }
      for (const raw of vals[1]!.split(",")) {
        const v = raw.trim().replace(/^["']|["']$/g, "");
        if (!v) continue;
        seen.set(v, [...(seen.get(v) ?? []), `${f}:${i + 1}`]);
        if (!KNOWN.has(v)) {
          errors.push(
            `.forgejo/workflows/${f}:${i + 1} matrix ${key} includes runner label "${v}", which no runner carries. ` +
              `That leg is never scheduled, so it fails SILENTLY — known labels: ${[...KNOWN].join(", ")}`,
          );
        }
      }
      return;
    }
    if (label.startsWith("$")) return; // some other expression; not ours to judge
    seen.set(label, [...(seen.get(label) ?? []), `${f}:${i + 1}`]);
    if (!KNOWN.has(label)) {
      errors.push(
        `.forgejo/workflows/${f}:${i + 1} asks for runner label "${label}", which no runner carries. ` +
          `A job with an unmatched label is never scheduled, so it fails SILENTLY — ` +
          `known labels: ${[...KNOWN].join(", ")}`,
      );
    }
  });
}

if (seen.size === 0) {
  console.error("[lint:ci-runner-labels] ✗ found no runs-on at all — did the workflow dir move?");
  process.exit(1);
}

if (errors.length === 0) {
  console.log(`[lint:ci-runner-labels] ✓ ${seen.size} distinct runner label(s), all real`);
  process.exit(0);
}
console.error(`\n[lint:ci-runner-labels] ✗ ${errors.length} unmatched runner label(s):\n`);
for (const e of errors) console.error(`  - ${e}`);
console.error(
  `\nCopy the label from a workflow that already runs rather than writing one from\n` +
    `memory. If a genuinely new runner exists, add its label to KNOWN in this lint —\n` +
    `and only once a runner answers to it.\n`,
);
process.exit(1);
