#!/usr/bin/env tsx
// A module's own page talks to its workspace through workspaceFetch from @cobblr/platform-web, never a bare fetch, so a guest's read the server would refuse never leaves the page.
//
// THE BUG THIS PREVENTS. 2026-10-11, #5598: the nightly walk saw a guest's inventory page ask three routes the guest gate refuses, past the shell's guard (#5190)
//
// The shell's own client (web/src/lib/api.ts) already refused a guest's read
// the guest allow-list cannot answer; every module page that brought its own
// client called fetch directly, 37 calls in 17 files, and each one could ask
// past the guard.
//
// THE RULE. In a module's UI code (modules/<name>/src/ui), a call to the bare
// global `fetch(` fails. workspaceFetch(...) passes; so do `.fetch(`,
// `refetch(` and `prefetch` names, which are not the global. A call that
// genuinely must not be judged (an address that is never this workspace's)
// opts out with `// BARE-FETCH: <why>` on the same line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only src/ui: a module's
// server code fetches outside services (a supplier's catalogue, a printer
// manager) with the egress rules of its own, and is not a page a guest opens.
// Tests are out too: they stub fetch on purpose.
//
// PROVED RED on the inventory page's client before it was switched.
//
//   npx tsx scripts/lint-module-pages-fetch-through-the-workspace.ts   (pnpm lint module-pages-fetch-through-the-workspace)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && /\/src\/ui\//.test(p.replace(/\\/g, "/"))) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const code = line.replace(/\/\/.*$/, "");
    if (/(?<![\w.$])fetch\(/.test(code) && !/\/\/ BARE-FETCH: \S/.test(line)) {
      out.push({ file, line: i + 1, what: "a bare fetch() in a module page; a guest's refused read would leave the page" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:module-pages-fetch-through-the-workspace - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("import { workspaceFetch } from \"@cobblr/platform-web\" and call it as fetch");
  process.exit(1);
}
console.log(`lint:module-pages-fetch-through-the-workspace OK`);
