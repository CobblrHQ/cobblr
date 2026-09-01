// A literal route registered after a parameter route on the same prefix is
// never reached.
//
// Express matches in registration order. `GET /inbox/:id` declared at line
// 1685 caught `GET /inbox/session-theme` declared at line 5685: the literal
// segment was read as an id, failed the identifier check, and every inbox load
// with two or more pending items got a 400 for it. The session theme had been
// dead in production, on every page load, and nothing said so - the web
// swallowed the error and the feature simply never appeared.
//
// This reads every router file, collects (method, path, line) in order, and
// fails when a path with a literal segment appears AFTER a path that would
// match it with a parameter in that position and the same segment count.
//
//   npx tsx scripts/lint-route-shadowing.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules"];
const ROUTE_RE = /\b(\w+Router|router|app)\.(get|post|put|patch|delete)\(\s*\n?\s*["'`]([^"'`]+)["'`]/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !p.includes("/tests/")) yield p;
  }
}

interface Route { method: string; path: string; line: number; segs: string[] }

/** Does an earlier route swallow a later literal one? Same method, same segment
 *  count, and every segment either equal or a parameter on the EARLIER side. */
function shadows(earlier: Route, later: Route): boolean {
  if (earlier.method !== later.method || earlier.segs.length !== later.segs.length) return false;
  let viaParam = false;
  for (let i = 0; i < earlier.segs.length; i++) {
    const e = earlier.segs[i]!;
    const l = later.segs[i]!;
    if (e === l) continue;
    if (e.startsWith(":") && !l.startsWith(":")) { viaParam = true; continue; }
    return false;
  }
  return viaParam;
}

const problems: string[] = [];
let files = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    if (!ROUTE_RE.test(src)) continue;
    ROUTE_RE.lastIndex = 0;
    files++;
    const routes: Route[] = [];
    for (const m of src.matchAll(ROUTE_RE)) {
      const line = src.slice(0, m.index).split("\n").length;
      const path = m[3]!;
      routes.push({ method: m[2]!, path, line, segs: path.split("/").filter(Boolean) });
    }
    for (let j = 0; j < routes.length; j++) {
      for (let i = 0; i < j; i++) {
        if (shadows(routes[i]!, routes[j]!)) {
          problems.push(`${file}:${routes[j]!.line} ${routes[j]!.method.toUpperCase()} ${routes[j]!.path} is never reached: ${routes[i]!.method.toUpperCase()} ${routes[i]!.path} (line ${routes[i]!.line}) is registered first and matches it`);
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`[lint:route-shadowing] ✗ ${problems.length} route(s) registered where a parameter route already swallows them:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("  Move the literal route ABOVE the parameter route in the same file.");
  process.exit(1);
}
console.log(`[lint:route-shadowing] ✓ no literal route is shadowed by an earlier parameter route (${files} router files)`);
