#!/usr/bin/env tsx
// A write to the api's own route (apiFetch or selfFetch) passes the route's refusal on when it says no, through refusalOf or its status and words, or says why it may not on a // REFUSAL: line, so a person is never told to try again at what their role may not do.
//
// THE BUG THIS PREVENTS. #9396: a member refused a part's photo (403) was told 'could not be changed, try again' (409), 2026-11-10
//
// THE RULE. A call to the api's own route that WRITES (apiFetch/selfFetch with
// method POST, PATCH, PUT or DELETE, assigned to a name) is judged at the
// first place its answer's `.ok` is read. Within the dozen lines after it the
// refusal must be read: refusalOf / refusalFromBody
// (@cobblr/platform-contract/self-call-refusal), or its `error.message`;
// reading its `.status` alone does not count. A branch that may honestly swallow it (a probe, a
// best-effort side write whose failure the person never asked about) says so
// on a `// REFUSAL: <why>` line in the three lines above that check.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Reads are out of scope: a
// GET that answers "none" on a 404 (the matchmaker's instance list, a sheet
// workspace's lookup) is a probe, not a person's action, and judging it
// flagged a dozen honest lookups. A call whose answer is never checked for
// `.ok` is not judged here either.
//
// PROVE IT RED: run it on main, where receipt-order.ts's order create
// answered every refusal as "try again" (#9413), before that fix.
//
//   npx tsx scripts/lint-self-call-refusals.ts   (pnpm lint self-call-refusals)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const CALL = /(?:const|let)\s+(\w+)\s*=\s*await\s+(?:apiFetch|selfFetch|platform\(\)\.selfFetch)\(/;
const WRITE = /method:\s*["'`](POST|PATCH|PUT|DELETE)["'`]/;
const REASON = /\/\/\s*REFUSAL:\s*\S/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = CALL.exec(lines[i] ?? "");
    if (!m) continue;
    const name = m[1]!;
    // The call's own statement only: a read followed by a write a few lines
    // on (the receipt's vendor lookup, then its create) is still a read.
    let end = i;
    while (end < Math.min(lines.length - 1, i + 30) && !/\)\s*;\s*$/.test(lines[end] ?? "")) end++;
    const call = lines.slice(i, end + 1).join("\n");
    if (!WRITE.test(call)) continue;
    const okRead = new RegExp(`\\b${name}\\.ok\\b`);
    let at = -1;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) if (okRead.test(lines[j] ?? "")) { at = j; break; }
    if (at < 0) continue;
    if (lines.slice(Math.max(0, at - 3), at + 1).some((l) => REASON.test(l))) continue;
    const after = lines.slice(at, at + 12).join("\n");
    // Its status alone is not its refusal: the receipt's order create read
    // the status to spot "Purchases is off" and answered every other no as
    // "try again" (#9413). The words must be read.
    const reads = /refusalOf\(|refusalFromBody\(|error\??\.message/;
    if (reads.test(after)) continue;
    out.push({ file, line: at + 1, what: `a write to the api's own route answers its own words when \`${name}\` says no: pass the refusal on (refusalOf) or say why on a // REFUSAL: line` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:self-call-refusals - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:self-call-refusals OK`);
