#!/usr/bin/env tsx
// Code that opens a pull request opens it ready for CI, or says why not.
//
// THE BUG THIS PREVENTS. CI runs on a pull request only once it carries the
// ci:ready label (since 2026-09-30). The staged-docs publish cron opened its
// pull request with a bare POST to /pulls, so #4445 never got CI, could never
// merge, and the docs it carried stalled while ci-floor called it a scheduler
// fault (2026-10-01). The embed-bridge workflow opened its own the same way.
//
// THE RULE. A file under scripts/ or .forgejo/workflows/ that POSTs to a
// repository's `/pulls` (opening a pull request) either goes through
// scripts/lib/open-ready-pr.mjs, which opens it carrying ci:ready and marks an
// existing one ready, or carries `ci-ready: <how>` within the five lines above
// the call, saying how that pull request gets CI (a person's tool: it is
// marked ready when queued; a re-land merge-pr marks ready on its merge).
//
// THE BOUNDARY. Only a POST to `/pulls` itself: listing them,
// one pull request (`/pulls/123`), and merging (`/pulls/123/merge`) open
// nothing, and neither does a line that only SAYS it would (forgejo-pr.sh's
// dry run echoes "would POST .../pulls"): a client call (curl, fetch, api(,
// a Request) has to be near the URL. Tests are out: their fakes answer a POST to /pulls on purpose.
//
//   npx tsx scripts/lint-automation-prs-ready.ts   (pnpm lint automation-prs-ready)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = (process.env.LINT_AUTOMATION_PRS_ROOTS ?? "scripts,.forgejo/workflows").split(",");
const HELPER = "scripts/lib/open-ready-pr.mjs";

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
    if (name === "node_modules" || name === "dist" || name === "fixtures") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(sh|mjs|js|ts|ya?ml)$/.test(name) && !/\.test\.[mc]?[jt]s$/.test(name) && !p.endsWith(HELPER) && !/lint-automation-prs-ready/.test(name)) yield p;
  }
}

/** A URL that ends at `/pulls`: opening one, as opposed to `/pulls?`, `/pulls/N`. */
const CREATE_URL = /\/pulls(?=["'`)\s]|$)/;

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!CREATE_URL.test(line)) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    if (!/\bPOST\b/.test(near)) continue;
    if (!/\bcurl\b|\bfetch\(|\bapi\(|Request\(/.test(near)) continue;
    const above = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    if (/ci-ready:\s*\S/.test(above)) continue;
    out.push({ file, line: i + 1, what: `opens a pull request without ci:ready: use ${HELPER}, or say \`ci-ready: <how it gets CI>\` above it` });
  }
  return out;
}

if (process.argv[1]?.endsWith("lint-automation-prs-ready.ts")) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:automation-prs-ready - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A pull request without ci:ready gets no CI and never merges (#4445).");
    process.exit(1);
  }
  console.log(`lint:automation-prs-ready OK`);
}
