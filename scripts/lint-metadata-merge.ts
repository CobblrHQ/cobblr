#!/usr/bin/env tsx
// `suggested_metadata` may only be written as a MERGE, never as a whole object.
//
// WHY THIS IS A LINT: the column is written by a dozen independent passes -
// identify, matchmaker, cross-check, hint, history, rerun snapshot - several of
// them detached and racing. A write built from a value SELECTed a moment
// earlier silently deletes whatever landed in between. metadata.ts already says
// mergeMeta is "the only sanctioned way to update suggested_metadata"; that was
// a convention, and conventions do not fail builds.
//
// It has now cost data twice:
//   - a transient rate-limit REPLACED the bag, deleting receipt_group_id,
//     import_provenance and the user's box_state (fixed in-place, comment kept);
//   - appendScanHistory read the bag, appended an entry, and wrote it all back -
//     destroying the `pre_rerun` snapshot the replay had just written. The
//     "Put it back" button never appeared and a hand-picked catalog photo was
//     unrecoverable (reported 2026-08-01).
//
// Allowed: mergeMeta / identityMeta / dropMeta, or a raw sql`` expression that
// evaluates against the LIVE row. Banned: a JS object or a JSON.stringify of one.
//
//   npx tsx scripts/lint-metadata-merge.ts   (npm run lint:metadata-merge)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const offenders: Array<{ file: string; line: number; text: string }> = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * The balanced argument of every `.set(` / `.doUpdateSet(` — the UPDATE paths.
 *
 * Deliberately NOT `.values(`: an INSERT creates the row, so there is no
 * existing bag to clobber and a plain object is correct there (the note, split
 * and receipt-line intakes all build one). Only an update can lose a
 * concurrent write, so only an update is this lint's business.
 */
function writeRegions(src: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  for (const m of src.matchAll(/\.(?:doUpdateSet|set)\s*\(/g)) {
    const from = m.index! + m[0].length - 1;
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) {
          out.push({ start: from, text: src.slice(from, i + 1) });
          break;
        }
      }
    }
  }
  return out;
}

for (const file of walk(join(ROOT, "modules"))) {
  const src = readFileSync(file, "utf8");
  for (const region of writeRegions(src)) {
    for (const m of region.text.matchAll(/suggested_metadata\s*:\s*([^,\n]+)/g)) {
      const value = m[1]!.trim();
      // Sanctioned: a merge helper, or raw SQL against the live row.
      if (/mergeMeta\(|identityMeta\(|dropMeta\(|^sql`/.test(value)) continue;
      const line = src.slice(0, region.start + m.index!).split("\n").length;
      offenders.push({ file, line, text: `suggested_metadata: ${value}`.slice(0, 96) });
    }
  }
}

if (offenders.length === 0) {
  console.log("[lint:metadata-merge] ✓ every suggested_metadata write merges against the live row.");
  process.exit(0);
}
console.error(`\n[lint:metadata-merge] ✗ ${offenders.length} write(s) replace the whole metadata bag:\n`);
for (const o of offenders) console.error(`  ${relative(ROOT, o.file)}:${o.line}  ${o.text}`);
console.error(
  `\nA dozen passes write this column, several of them detached and racing. Building the\n` +
    `value from a row you SELECTed a moment ago deletes whatever committed in between -\n` +
    `that is how a replay's pre_rerun snapshot (and a user's chosen photo) was lost.\n\n` +
    `Use mergeMeta({ key: value }) — it overlays DB-side, so other writers survive.\n`,
);
process.exit(1);
