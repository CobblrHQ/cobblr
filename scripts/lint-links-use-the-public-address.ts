#!/usr/bin/env tsx
// A link the api builds from the request's Host header lets whoever sent the request choose where its token goes, so every read of the request's host is in api/src/platform/link-origin.ts or says HOST-OK: and why on that line or the one above.
//
// THE BUG THIS PREVENTS. Password reset, magic sign-in, verify, invite and email-change links were built from the Host header (#4184 audit, 2026-10-05)
//
// THE RULE. In the api (api/src) and a module's server code (modules/*/src,
// not its ui), a read of the request's host (`get("host")`,
// `get("x-forwarded-host")`, `headers.host`, `headers["host"]`,
// `headers["x-forwarded-host"]`) is only in api/src/platform/link-origin.ts,
// whose linkOrigin() puts the configured public address first. Anywhere else
// the line, or the one above it, says `HOST-OK: <why>`: the address goes
// back only to the caller who sent it (a feed URL in their own answer, a
// pairing code on their own screen), so they can only mislead themselves.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The calendar feed URL and
// the phone-pairing claim URL read the host and are not emailed: they are
// shown to the same person, so they carry HOST-OK rather than move to
// linkOrigin (a self-hoster reaching the box at a LAN address wants that
// address back). A mention in a comment is not a read and is skipped.
//
// PROVEN RED on main: password reset, magic sign-in, verify, both
// email-change links, workspace invites and the sandbox emails all built
// their emailed link from the Host header.
//
//   npx tsx scripts/lint-links-use-the-public-address.ts   (pnpm lint links-use-the-public-address)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const HOME = "api/src/platform/link-origin.ts";
const READ = /\.get\(\s*["'](x-forwarded-host|host)["']\s*\)|headers\.host\b|headers\[\s*["'](x-forwarded-host|host)["']\s*\]/i;

/** Server code only: a module's ui never sees a request. */
const inScope = (file: string) => !file.startsWith("modules/") || (/\/src\//.test(file) && !/\/src\/ui\//.test(file));

function check(file: string, src: string): Violation[] {
  if (file === HOME || !inScope(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (!READ.test(line)) continue;
    if (/HOST-OK:\s*\S/.test(line) || /HOST-OK:\s*\S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "reads the request's host: use linkOrigin(req), or say // HOST-OK: <why>" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:links-use-the-public-address - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use linkOrigin(req) from api/src/platform/link-origin.ts (the configured public address first), or write // HOST-OK: <why> when the address goes back only to the caller.");
  process.exit(1);
}
console.log(`lint:links-use-the-public-address OK`);
