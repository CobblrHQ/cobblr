#!/usr/bin/env tsx
// A periodic pass that walks the workspaces and opens their databases registers with platform().sweeps; a file with its own repeating timer, a loop over the workspaces and a tenant open is refused.
//
// THE BUG THIS PREVENTS. Every self-healing or periodic pass used to walk
// all workspaces on its own timer with its own pool discipline. Each was
// correct alone; together, on the dev rig (352 workspaces, max_connections
// 100), six of them started within minutes of boot and refused 811
// connections in six hours ("remaining connection slots are reserved",
// #3036), and the next pass written would have made it worse. The kernel
// now walks the workspaces ONCE for every registered pass that is due, with
// one connection budget and a boot stagger (api/src/platform/
// tenant-sweeps.ts); this refuses the next private walker.
//
// THE RULE. Under api/src and modules/, a source file that has all three of
//   1. a repeating timer of its own (`setInterval(`),
//   2. a walk of the workspaces (`selectFrom("orgs")` or `of orgs)`), and
//   3. a tenant open (`tenants.getDb(`, `tenants.withDb(`, `getTenantDb(`,
//      `withTenantDbForSweep(`)
// is a private tenant walker and is refused. The scheduler itself is exempt.
// A per-org queue worker (no walk) is not this shape and passes.
//
// And a module's one-shot heal (a file under modules/ with a "DONE WHEN:"
// header) that walks the workspaces and opens them is refused with or without
// a timer: it walks at boot beside every other module's boot work, which is a
// storm too. core-scan's two such heals failed 339 and 340 of 340 staging
// workspaces on "remaining connection slots are reserved" (#3647). It
// registers with registerHealPass (platform-contract heal-pass.ts). The
// kernel's own boot passes run one after another in boot() and are exempt.
// There is no opt-out annotation: a walker that "cannot storm" is one more
// walk the budget does not know about.
//
// PROVEN RED on the walkers it replaced: the pictures sweep, the retrim, the
// split-series heal, the re-route, the receipt tracking, cadence,
// maintenance, purchases' arrival, lists' expiry, inventory's burn rate,
// digifab's pump, before they were moved onto the walk.
//
//   npx tsx scripts/lint-tenant-sweep-registered.ts   (pnpm run lint tenant-sweep-registered)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules"];
const SCHEDULER = "api/src/platform/tenant-sweeps.ts";

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
      continue;
    }
    if (isDir) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

const TIMER = /\bsetInterval\s*\(/;
const WALK = /selectFrom\(\s*["']orgs["']\s*\)|\bof orgs\)/;
const OPEN = /tenants\.getDb\(|tenants\.withDb\(|\bgetTenantDb\(|withTenantDbForSweep\(/;

function check(file: string, src: string): Violation[] {
  if (file === SCHEDULER) return [];
  const code = src
    .split("\n")
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
    .join("\n");
  // A module's one-shot heal walks at boot beside every other module's boot
  // work, so it storms exactly as a timer does: core-scan's two failed 339
  // and 340 of 340 staging workspaces for want of a connection (#3647). A
  // module heal registers with registerHealPass (platform-contract
  // heal-pass.ts). The kernel's own boot passes run in one chain in boot()
  // and are not this shape.
  if (file.startsWith("modules/") && /^\/\/ DONE WHEN:/m.test(src) && WALK.test(code) && OPEN.test(code)) {
    const line = code.split("\n").findIndex((l) => OPEN.test(l)) + 1;
    return [{ file, line, what: "a module heal shim walking the workspaces itself at boot: register it with registerHealPass (platform-contract heal-pass.ts)" }];
  }
  if (!TIMER.test(code) || !WALK.test(code) || !OPEN.test(code)) return [];
  const line = code.split("\n").findIndex((l) => TIMER.test(l)) + 1;
  return [
    {
      file,
      line,
      what: "a repeating timer, a walk of the workspaces and a tenant open in one file: a private tenant walker",
    },
  ];
}

const violations: Violation[] = [];
let scanned = 0;
for (const root of ROOTS)
  for (const file of walk(root)) {
    scanned++;
    violations.push(...check(file, readFileSync(file, "utf8")));
  }

if (violations.length) {
  console.error(`lint:tenant-sweep-registered - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "Register the per-workspace visit with platform().sweeps.register({ name, everyMs, module, visit }) and drop the timer; " +
      "the kernel walks the workspaces once for every due pass under one budget (api/src/platform/tenant-sweeps.ts).",
  );
  process.exit(1);
}
console.log(`lint:tenant-sweep-registered OK (${scanned} files; every periodic tenant walk is a registered pass)`);
