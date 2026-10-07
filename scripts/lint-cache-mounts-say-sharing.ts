#!/usr/bin/env tsx
// Every BuildKit cache mount in a Dockerfile states its sharing mode, and one a tool writes without its own lock (cargo) is sharing=locked.
//
// THE BUG THIS PREVENTS. 2026-10-07, main 87ae5b923: two core-api builds ran at once on one daemon and both
// unpacked crates into the same cache mount of the cargo registry (BuildKit's default is sharing=shared). One
// found the other's half-written libc and failed ("failed to open .cargo-ok: File exists"), and main went red
// for a change that had nothing to do with it.
//
// THE RULE. Every `--mount=type=cache` names `sharing=`. A cache that cargo writes (its registry, its git
// checkouts, a crate's `target` dir) must be `sharing=locked`, so concurrent builds take turns on it. pnpm's
// store locks its own writes, so `sharing=shared` is right there, and saying it is the point: the reader sees
// the choice was made.
//
// THE BOUNDARY. Only tracked Dockerfiles (Dockerfile* and *.Dockerfile, anywhere), the files BuildKit reads. A cache
// mount spelled in a shell script or a workflow is not a mount.
//
//   npx tsx scripts/lint-cache-mounts-say-sharing.ts   (pnpm lint cache-mounts-say-sharing)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.js";

const LOCK_NEEDED = /(cargo|\/target\b)/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

function dockerfiles(): string[] {
  return repoFiles().filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f) || /\.Dockerfile$/.test(f));
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of (lines[i] ?? "").matchAll(/--mount=(\S+)/g)) {
      const opts = m[1] ?? "";
      if (!/(^|,)type=cache(,|$)/.test(opts)) continue;
      const sharing = /(^|,)sharing=(\w+)/.exec(opts)?.[2];
      const target = /(^|,)target=([^,]+)/.exec(opts)?.[2] ?? "";
      if (!sharing) out.push({ file, line: i + 1, what: `cache mount on ${target || "?"} does not say sharing=` });
      else if (LOCK_NEEDED.test(target) && sharing !== "locked")
        out.push({ file, line: i + 1, what: `cache mount on ${target} is sharing=${sharing}; cargo writes it without a lock, so it must be sharing=locked` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const file of dockerfiles()) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:cache-mounts-say-sharing - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add sharing=locked (cargo, a build target dir) or sharing=shared (pnpm's store, which locks itself) to the --mount=type=cache");
  process.exit(1);
}
console.log(`lint:cache-mounts-say-sharing OK`);
