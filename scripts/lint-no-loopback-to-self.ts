#!/usr/bin/env tsx
// Code in the api process reaches the api's own routes through platform().selfFetch, never over a loopback URL to its own port (127.0.0.1 or localhost with API_PORT), or the line says loopback-ok: and why.
//
// THE BUG THIS PREVENTS. Under load a loopback call to the api's own port was refused (ECONNREFUSED) while the api kept serving, failing the assistant's plan run with fetch failed (#4901, 2026-10-07)
//
// THE RULE. In api/src and modules (server code, not tests or ui/), a line
// that builds a URL to 127.0.0.1 or localhost on the api's own port (it names
// API_PORT) is refused: the request goes through platform().selfFetch, which
// hands it to the same express app in-process (api/src/platform/self-fetch.ts).
// A genuine exception, a process that is not the api (a CLI), says
// `loopback-ok: <why>` on the line or the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only a URL naming API_PORT:
// a bridge or a device on 127.0.0.1 at its own port is somebody else's server.
// The view-as CLI runs in its own process and must use HTTP, which is why the
// exception exists. self-fetch.ts itself falls back to HTTP before the app is
// built and says so.
//
// PROVED RED on main: core-ai's ctxOf and every INTERNAL_API constant.
//
//   npx tsx scripts/lint-no-loopback-to-self.ts   (pnpm lint no-loopback-to-self)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/\.ts$/.test(file) || /\.test\.ts$|\/tests\/|\/ui\//.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const literal = /(127\.0\.0\.1|localhost):\$\{[^}]*API_PORT/.test(line);
    // The port read into a variable first (core-authoring's `port`), in a file
    // that reads API_PORT at all.
    const viaVariable = /(127\.0\.0\.1|localhost):\$\{/.test(line) && /API_PORT/.test(src);
    if (!literal && !viaVariable) continue;
    if (/loopback-ok:\s*\S/.test(line) || /loopback-ok:\s*\S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "a loopback URL to the api's own port" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-loopback-to-self - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Call platform().selfFetch(path) (or selfFetch from api/src/platform/self-fetch.ts in the kernel); a process that is not the api says // loopback-ok: <why>.");
  process.exit(1);
}
console.log(`lint:no-loopback-to-self OK`);
