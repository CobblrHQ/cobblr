#!/usr/bin/env tsx
// The served HTML carries no inline script, so the Content-Security-Policy's
// script-src 'self' is true of the page rather than a report waiting to happen.
//
// THE BUG THIS PREVENTS. The CSP shipped with script-src 'self' in its
// report-only half, and every page load reported the two pre-paint blocks in
// web/index.html (the env icon gate and the desktop-app class): "Refused to
// execute a script because its hash, its nonce, or 'unsafe-inline' does not
// appear in the script-src directive", twice per page, on every surface. The
// day somebody promoted the report-only policy to enforced, both blocks would
// have stopped running on every page (#3300, 2026-09-20). Both now live in
// web/public/prepaint.js, loaded with a blocking <script src>, which 'self'
// permits with no hash to drift and no nonce to mint.
//
// THE RULE. In every HTML page under web/ (index.html and any sibling entry;
// src/ and dist/ are not pages), a <script> element must carry a src
// attribute, and no element may carry an inline event handler (on*="...") or
// a javascript: URL. An inline script needs a hash or a nonce the policy does
// not have, so it is refused the moment script-src is enforced, whatever it
// does. A genuine exception (there is none today) opts out with
// `<!-- csp-inline-allowed: <reason> -->` on the line before the tag, and must
// also carry its hash in docker/nginx.conf; the reason is what the next reader
// judges. HTML comments are not markup and are not read.
//
// Proven red on the index.html that motivated it (two inline blocks), then
// green once they moved.
//
//   npx tsx scripts/lint-csp-no-inline-scripts.ts   (pnpm run lint:csp-no-inline-scripts)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web"];

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
    if (name === "node_modules" || name === "dist" || name === "src" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.html$/.test(name)) yield p;
  }
}

const OPT_OUT = /<!--\s*csp-inline-allowed:\s*\S/;

/** Every violation in one page; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  // Comments are not markup: an example inside one must not read as a script.
  const uncommented = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const lineOf = (index: number) => uncommented.slice(0, index).split("\n").length;
  const allowedAt = (line: number) => OPT_OUT.test(lines[line - 2] ?? "");
  for (const m of uncommented.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1] ?? "";
    const line = lineOf(m.index ?? 0);
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (allowedAt(line)) continue;
    out.push({ file, line, what: "an inline <script> block; script-src 'self' refuses it the moment the policy is enforced" });
  }
  for (const m of uncommented.matchAll(/\s(on[a-z]+)\s*=\s*["']/gi)) {
    const line = lineOf(m.index ?? 0);
    if (allowedAt(line)) continue;
    out.push({ file, line, what: `an inline event handler (${m[1]}=...); refused like an inline script` });
  }
  for (const m of uncommented.matchAll(/=\s*["']\s*javascript:/gi)) {
    out.push({ file, line: lineOf(m.index ?? 0), what: "a javascript: URL; refused like an inline script" });
  }
  return out;
}

if (process.argv[1] && /lint-csp-no-inline-scripts\.ts$/.test(process.argv[1])) {
  const violations: Violation[] = [];
  let pages = 0;
  for (const root of ROOTS)
    for (const file of walk(root)) {
      pages++;
      violations.push(...check(file, readFileSync(file, "utf8")));
    }
  if (pages === 0) {
    console.error("lint:csp-no-inline-scripts - found no HTML page under web/; the check would pass vacuously");
    process.exit(1);
  }
  if (violations.length) {
    console.error(`lint:csp-no-inline-scripts - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("move the script to web/public/prepaint.js (or another same-origin file) and load it with <script src>");
    process.exit(1);
  }
  console.log(`lint:csp-no-inline-scripts OK (${pages} page(s), no inline script)`);
}
