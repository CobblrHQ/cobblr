#!/usr/bin/env tsx
// A record address sent outside the app comes from the workspace-qualified record address helper.
//
// THE BUG THIS PREVENTS. Paperless write-back stored a bare record path, which opened the reader's default workspace instead of the record's workspace.
//
// THE RULE. Code that sends a record destination through an outside-facing
// sink (`record_url`, a notification `link_url`, or an iCal URL) must not feed
// that sink from detailPathForEntity, resolveDetailPath, openRecordPath, or a
// resolver's bare detailUrl. It calls recordAddressForEntity instead. A genuine non-record
// sink may carry `// OUTSIDE-RECORD-ADDRESS: <why>` beside the construction.
//
// THE BOUNDARY. QR resolution, browser API answers and in-app navigation need
// a workspace-relative detail path and legitimately call detailPathForEntity.
// They are not outside sinks, so this rule requires an outside-facing marker
// in the same file before judging the path construction.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-outside-record-address.ts   (pnpm lint outside-record-address)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages/workspace-tools/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
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
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (file === "api/src/platform/entities.ts") return out;
  const outsideSink = /\brecord_url\b|\blink_url\b|\bbuildICS\b|\bnotifyAboutComment\b|\bwarnBatcher\.add\b/.test(src);
  if (!outsideSink) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const nearby = lines.slice(Math.max(0, i - 5), i + 3).join("\n");
    if (nearby.includes("OUTSIDE-RECORD-ADDRESS:")) continue;
    if (/\bdetailPathForEntity\s*\(|\bresolveDetailPath\s*\(|\bopenRecordPath\s*\(/.test(line)) {
      out.push({ file, line: i + 1, what: "outside-facing file builds a bare record detail path" });
      continue;
    }
    if (/\blink\s*=\s*\w+\??\.detailUrl\b/.test(line)) {
      out.push({ file, line: i + 1, what: "notification link takes a resolver's workspace-less detailUrl" });
      continue;
    }
    if (/\blink_url\s*:\s*`\/[^`]*\$\{[^}]*(?:\bid\b|Id\b)[^}]*\}/.test(line)) {
      out.push({ file, line: i + 1, what: "notification constructs a workspace-less record path" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:outside-record-address - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use platform().entities.recordAddressForEntity(orgId, kind, id) for a record link that leaves the app.");
  process.exit(1);
}
console.log(`lint:outside-record-address OK`);
