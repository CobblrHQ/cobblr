#!/usr/bin/env tsx
// A pg Pool or Client is constructed only in api/src/db/client-error-guard.ts; everything else calls createPool or createClient, so every client listens for 'error' from creation.
//
// THE BUG THIS PREVENTS. In Node an unhandled 'error' event throws, and a
// throw out of a socket read exits the process. pg emits 'error' on a CLIENT
// whenever its backend goes away with no query in flight to reject into, which
// a dropped database, a terminated backend or a restart all do. The api exited
// 1 this way three times (2026-08-25, 2026-09-01, 2026-09-13 #2957), and each
// fix attached the listener AFTER construction: on the pool (hears idle clients
// only), on the client after checkout resolved (a microtask; a FATAL parsed
// from the same socket read as the handshake is emitted before it runs), and by
// hand next to each bare `new Client(` with a lint counting the lines between.
// Every one of those left a window. Construction does not: a class that
// listens in its constructor is listening before the socket opens.
//
// THE RULE. Under api/ and modules/ (the api process and everything it loads),
// `new Pool(` and `new Client(` may appear only in the guard file, which owns
// the two factories. Every other file uses `createPool(config, label)` or
// `createClient(config, label)` from api/src/db/client-error-guard.ts. Test
// files are not judged (a test may build a fake). A comment line does not
// count. There is no opt-out annotation: a client that "cannot die this way"
// still costs one log-only listener, which is cheaper than one process exit,
// and the last three exits each came from a client somebody was sure about.
//
// This one rule replaces lint:pool-error-handlers (count the listeners next to
// each pool, then count the guardPoolClients calls) and lint:pg-client-errors
// (an `.on("error"` within 12 lines of each bare Client). Both counted
// after-the-fact attachments; there is nothing to count now.
//
//   npx tsx scripts/lint-pg-clients-born-guarded.ts   (pnpm run lint:pg-clients-born-guarded)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites: the api process and every module it loads. */
const ROOTS = ["api", "modules"];
const OWNER = "api/src/db/client-error-guard.ts";

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
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue; // vanished between readdir and stat (a concurrent git op)
    }
    if (isDir) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

/** `new Pool(` / `new Client(` outside the owner, on a line that is code. pg's
 *  Client is sometimes imported under an alias (`PgClient`), so the alias
 *  counts too. */
const CONSTRUCTS = /\bnew\s+(?:pg\.)?(?:Pool|(?:Pg)?Client)\s*\(/;

function check(file: string, src: string): Violation[] {
  if (file === OWNER) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const m = CONSTRUCTS.exec(line);
    if (!m) continue;
    const isPool = /\bPool\b/.test(m[0]);
    out.push({
      file,
      line: i + 1,
      what: `${m[0].trim()}...) constructs a pg ${isPool ? "Pool" : "Client"} with no 'error' listener at birth; use ${
        isPool ? "createPool(config, label)" : "createClient(config, label)"
      } from ${OWNER}`,
    });
  }
  return out;
}

const violations: Violation[] = [];
let scanned = 0;
for (const root of ROOTS)
  for (const file of walk(root)) {
    scanned++;
    violations.push(...check(file, readFileSync(file, "utf8")));
  }

if (violations.length) {
  console.error(`lint:pg-clients-born-guarded - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    `Replace new Pool(...) with createPool(config, label) and new Client(...) with createClient(config, label) from ${OWNER}: ` +
      "an unlistened pg 'error' event exits the api, and only a listener attached in the constructor has no window.",
  );
  process.exit(1);
}
console.log(`lint:pg-clients-born-guarded OK (${scanned} files; every pg Pool and Client is born in ${OWNER})`);
