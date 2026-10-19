#!/usr/bin/env tsx
// A route file over 2,000 lines takes no new route: the next group of routes is a file of its own beside it, so two PRs adding unrelated routes never edit one file.
//
// THE BUG THIS PREVENTS. modules/core-scan/src/api/inbox.ts reached 10,977
// lines and 72 routes and was in 6 of a week's 224 merge re-checks (#7385):
// every scan inbox route was added to one file, so two scan PRs collided in it
// and the merge queue sent the green one back to re-run.
//
// THE RULE. A route file (api/src/routes/**, modules/*/src/api/**) longer than
// 2,000 lines may register no more routes (`<x>Router.get|post|put|patch|
// delete|all(`) than scripts/route-file-routes-baseline.json allows it (none
// for a file not listed). A new route goes in a file of its own beside it that
// registers its own routes and is mounted by the big file. The baseline only
// shrinks (scripts/merge-shrink-only.mjs keeps the lower count).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A long file with no routes
// (inventory's action-handlers.ts, 2,048 lines) is not a route file and passes:
// the count is of registrations, so a big helper file is someone else's
// concern. Tests are never route files.
//
//   npx tsx scripts/lint-route-file-grows-into-its-directory.ts   (pnpm lint route-file-grows-into-its-directory)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const CAP = 2000;
const BASELINE_PATH = "scripts/route-file-routes-baseline.json";
const ROUTE = /\b\w*[Rr]outer\.(get|post|put|patch|delete|all)\(/g;

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* routeFiles(): Generator<string> {
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
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
    }
  }
  yield* walk("api/src/routes");
  for (const m of readdirSync("modules")) yield* walk(join("modules", m, "src", "api"));
}

/** The line of each route registration. Pure. */
function routesOf(src: string): number[] {
  const at: number[] = [];
  for (const m of src.matchAll(ROUTE)) at.push(src.slice(0, m.index).split("\n").length);
  return at;
}

/** The verdict on one file. Pure. */
function judge(file: string, src: string, allowed: number | undefined): Violation[] {
  const lines = src.split("\n").length;
  if (lines <= CAP) return [];
  const routes = routesOf(src);
  const may = allowed ?? 0;
  if (routes.length <= may) return [];
  const dir = file.replace(/\.ts$/, "/");
  return [
    {
      file,
      line: routes[may] ?? 1,
      what: `${lines} lines and ${routes.length} routes (${may} allowed): register the new route in a file of its own under ${dir} and mount it from here`,
    },
  ];
}

const baseline: Record<string, number> = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
const violations: Violation[] = [];
const stale: string[] = [];
for (const file of routeFiles()) {
  const src = readFileSync(file, "utf8");
  if (file in baseline && (src.split("\n").length <= CAP || routesOf(src).length < baseline[file]!)) stale.push(file);
  if (onlyChanged(file)) violations.push(...judge(file, src, baseline[file]));
}
for (const file of Object.keys(baseline)) if (!existsSync(file)) stale.push(file);

if (stale.length) console.log(`(${BASELINE_PATH} can shrink: ${stale.join(", ")})`);
if (violations.length) {
  console.error(`lint:route-file-grows-into-its-directory - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(`A route file over ${CAP} lines only mounts: each new group of routes is a file of its own (#7385).`);
  process.exit(1);
}
console.log(`lint:route-file-grows-into-its-directory OK`);
