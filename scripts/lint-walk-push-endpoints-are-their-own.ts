#!/usr/bin/env tsx
// A walk that registers a push device gives it an endpoint of its own, with {slug} or {org_id} in it, because one endpoint is one device row and a second walk registering the same address takes the device from the first.
//
// THE BUG THIS PREVENTS. Two push walks shared one endpoint; walked together on 2026-10-20 one took the other's device mid-walk (#7625).
//
// THE RULE. A walk spec's setup step that posts to /me/push/devices names an
// endpoint holding {slug} or {org_id}, which each walk fills with its own
// workspace. A fixed address fails. A push device is one row per endpoint and
// a second registration takes the row over (api/src/routes/me-push.ts), so two
// walks on one address share one device, and the nightly walks three at once.
//
// THE BOUNDARY. Only the walk specs' setup: an api test registers devices
// with addresses it builds per test, and the browser's own subscription in a
// walk is the browser's. Nothing else has tested the boundary yet.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-walk-push-endpoints-are-their-own.ts   (pnpm lint walk-push-endpoints-are-their-own)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["e2e/walks"];

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
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith(".json")) yield p;
  }
}

/** Each fixed push endpoint a spec's setup registers. */
export function check(file: string, src: string): Violation[] {
  let spec: { setup?: Array<{ path?: string; method?: string; body?: { endpoint?: unknown } }> };
  try {
    spec = JSON.parse(src);
  } catch {
    return [];
  }
  const out: Violation[] = [];
  for (const step of spec.setup ?? []) {
    if (!/\/me\/push\/devices$/.test(step.path ?? "") || (step.method ?? "POST").toUpperCase() !== "POST") continue;
    const endpoint = String(step.body?.endpoint ?? "");
    if (/\{(slug|org_id)\}/.test(endpoint)) continue;
    const at = src.indexOf(endpoint);
    out.push({ file, line: at < 0 ? 1 : src.slice(0, at).split("\n").length, what: `the push endpoint ${JSON.stringify(endpoint)} is the same in every walk that runs this spec` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:walk-push-endpoints-are-their-own - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Put {slug} in the endpoint: https://fcm.googleapis.com/fcm/send/walk-<name>-{slug}");
  process.exit(1);
}
console.log(`lint:walk-push-endpoints-are-their-own OK`);
