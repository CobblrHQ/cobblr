#!/usr/bin/env tsx
// A bundle id a script or e2e hands the server is one the catalog has.
//
// THE BUG THIS PREVENTS. Three scripts installed `cobblr.flagship.bookshelf`,
// an id no bundle has ever had: Bookshelf has been `cobblr.community.bookshelf`
// since the file was created. Install by id is an exact lookup, so each call
// got a 404, and none of the three read the response. For nine days the
// show-week review pack and two e2e scripts judged book barcodes in a
// workspace with no book table, and every run looked fine (#3472, 2026-09-22).
//
// THE RULE. In tracked .ts/.tsx/.mjs/.js outside tests, every string literal
// shaped like a bundle id (`cobblr.flagship.<x>` or `cobblr.community.<x>`,
// the only two tiers bundles/ uses) is the `id` of a manifest in bundles/.
// Comment lines are skipped. Tests are skipped because fixtures invent ids on
// purpose. A retired id in `api/src/lib/bundle-aliases.ts` does NOT pass:
// that table resolves old ids where stored data is READ, and install by id
// does not consult it, so a script naming a retired id 404s exactly like a
// typo.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Two walkthroughs carry the
// retired `cobblr.flagship.filament-stash`, and they are right to: each posts
// its OWN manifest inline, so the id is being defined, not looked up. So a
// literal passes when it is an object's `id` and a `version:` follows within a
// few lines, which is what makes that object a manifest. A bare `id:` does not
// pass on its own, because a request body can carry an id as a reference too.
// A comment in the quickstart route quotes an invented `cobblr.flagship.x-y`
// to describe what must never be shown, which is why comment lines are skipped.
// And `api/src/lib/bundle-aliases.ts` fired on all eight of its keys the first
// time this ran, because naming retired ids is the whole job of that file: it
// is the record of every rename, kept in step with the migration by its own
// test. It is the one file exempt by path.
//
// PROVED RED on the tree of 2026-09-22: three violations, the three bookshelf
// references, and nothing else among 66 bundle-id literals.
//
//   npx tsx scripts/lint-bundle-ids-exist.ts   (pnpm run lint:bundle-ids-exist)
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Violation {
  file: string;
  line: number;
  what: string;
}

const ID = /["'`](cobblr\.(?:flagship|community)\.[a-z0-9-]+)["'`]/g;
const MANIFEST_WINDOW = 6;
/** The record of retired ids. Naming them is what it is for. */
const RENAME_RECORD = "api/src/lib/bundle-aliases.ts";

/** Every `manifest.id` under bundles/, the one list that decides. */
export function catalogIds(dir = "bundles"): Set<string> {
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".lock.json")) continue;
    const doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as { manifest?: { id?: string } };
    if (doc.manifest?.id) ids.add(doc.manifest.id);
  }
  return ids;
}

/** Is the literal at this position the `id` of a manifest the code defines? */
function definesAManifest(lines: string[], i: number, col: number): boolean {
  const before = (lines[i] ?? "").slice(0, col);
  if (!/\bid\s*[:=]\s*$/.test(before)) return false;
  for (let j = i; j < Math.min(lines.length, i + MANIFEST_WINDOW); j++) {
    if (/\bversion\s*:/.test(lines[j] ?? "")) return true;
  }
  return false;
}

export function check(file: string, src: string, ids: Set<string>): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    for (const m of line.matchAll(ID)) {
      const id = m[1] as string;
      if (ids.has(id)) continue;
      if (definesAManifest(lines, i, m.index ?? 0)) continue;
      out.push({ file, line: i + 1, what: `${id} is not the id of any bundle in bundles/` });
    }
  }
  return out;
}

function candidates(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mjs", "*.js"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => f !== RENAME_RECORD && !f.startsWith("bundles/") && !/\.test\.|(^|\/)tests?\/|__tests__/.test(f));
}

if (process.argv[1]?.endsWith("lint-bundle-ids-exist.ts")) {
  const ids = catalogIds();
  const violations: Violation[] = [];
  for (const file of candidates()) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!src.includes("cobblr.")) continue;
    violations.push(...check(file, src, ids));
  }
  if (violations.length) {
    console.error(`lint:bundle-ids-exist - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Use the id the bundle's manifest carries in bundles/.");
    process.exit(1);
  }
  console.log(`lint:bundle-ids-exist OK (${ids.size} bundles)`);
}
