#!/usr/bin/env tsx
// A cache that expires on a clock is a ttlCache (api/src/lib/ttl-cache.ts), never a Map of {at, value} read with a freshness check: its misses must be shared, or a list resolving its rows at once runs one query per row at the moment the entry lapses.
//
// THE BUG THIS PREVENTS. 2026-10-05: the bounded-meta test passed only on a retry (#4917); serverManagedFields' 5s entry lapsed mid-list and every row ran its own statement
//
// THE RULE. In api/src, a cache that expires on a clock is a `ttlCache`
// (api/src/lib/ttl-cache.ts): one load per miss, shared by every concurrent
// asker. A `Map<string, { at: number; ... }>` (a value and the time it was
// stored, read back with `Date.now() - hit.at < TTL`) is refused: it answers
// from memory while warm and, the moment it is cold or lapses, every concurrent
// asker misses before the first load lands and runs its own query. A list that
// resolves 200 rows at once then runs 200 statements, on one request in a
// hundred, and a warm run never sees it. A map that is read by one asker at a
// time (an outside fetch behind a sign-in, not a list's row) opts out with
// `single-flight: <why one asker at a time is fine>` on the line, or one of the
// three above it. Never a baseline that grows.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Nothing has tested the
// boundary yet: the nine caches this found were all per-row loaders and are
// converted; the five that stay are outside fetches (a provider's discovery
// document, GitHub's index, a model list) and say why. The match is the
// declaration, not the freshness check, so a differently spelled check on the
// same shape is still caught.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it (api/src/platform/entities.ts at 4e3970ca, serverManagedFields).
//
//   npx tsx scripts/lint-a-ttl-cache-shares-its-misses.ts   (pnpm lint a-ttl-cache-shares-its-misses)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
export interface Violation {
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
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** A Map whose value carries the time it was stored: `{ at: number` or `expiresAt: number`. */
const TIMED_MAP = /new Map<[^>]*\{[^}]*\b(?:at|expiresAt|storedAt)\s*:\s*number\b/;

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!TIMED_MAP.test(line)) continue;
    if (lines.slice(Math.max(0, i - 3), i + 1).some((l) => /single-flight: \S/.test(l))) continue;
    out.push({ file, line: i + 1, what: "a Map of {at, value} expiring on a clock: its misses are not shared, so a list's rows each run the load when it lapses" });
  }
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const violations: Violation[] = [];
  let files = 0;
  for (const root of ROOTS)
    for (const file of walk(root)) {
      files++;
      violations.push(...check(file, readFileSync(file, "utf8")));
    }
  if (violations.length) {
    console.error(`lint:a-ttl-cache-shares-its-misses - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("ttlCache<V>(ttlMs).get(key, load) from ../lib/ttl-cache.js; or say 'single-flight: <why one asker at a time is fine>' above the map");
    process.exit(1);
  }
  console.log(`lint:a-ttl-cache-shares-its-misses OK (${files} files)`);
}
