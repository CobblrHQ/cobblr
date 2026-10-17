#!/usr/bin/env tsx
// A platform route under /orgs/:slug/modules/:moduleName/ never takes a path a module's own router answers.
//
// THE BUG THIS PREVENTS. 2026-10-17: the module-parts switch at
// /modules/:module/parts/:part answered inventory's
// /modules/inventory/parts/import with a 400, failing every import test. The
// platform's routes are registered before the modules are mounted, so a
// platform pattern with a module parameter in it wins every request of that
// shape, for every module, and nothing at the module says so.
//
// THE RULE. For each platform route in api/src/routes whose path has
// `/modules/:<param>/<segment>`, no module's router (src/api and each
// family's api, or a family's mount path) may declare a route or a sub-router
// starting with `/<segment>`. The fix is to put the platform route outside the
// module's path, as module-parts does (/orgs/:slug/module-parts/:module/:part).
// A module param followed by another param (`/modules/:m/:x`) is always a
// violation: it takes every module's paths.
//
// THE BOUNDARY. Only the first literal segment after the module parameter is
// compared: that is what Express matches first, and module routers mount at
// the module's root. A module route with the same segment deeper down
// (`/printers/enable`) is not a collision and is not flagged.
//
//   npx tsx scripts/lint-platform-routes-leave-module-paths.ts   (pnpm lint platform-routes-leave-module-paths)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { apiDirs, familyMounts } from "./lib/manifest-sources.ts";

interface Violation { file: string; line: number; what: string }

function* walk(dir: string): Generator<string> {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
  }
}

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;
const ROUTE = /\.(?:get|post|put|patch|delete|all|use)\(\s*["'`](\/[^"'`]*)["'`]/g;

/** Platform routes with a module parameter: segment → where it is declared. */
export function platformClaims(files: { file: string; src: string }[]): { segment: string; file: string; line: number; path: string }[] {
  const out: { segment: string; file: string; line: number; path: string }[] = [];
  for (const { file, src } of files) for (const m of src.matchAll(ROUTE)) {
    const hit = /\/modules\/:\w+\/([^/]+)/.exec(m[1]!);
    if (hit) out.push({ segment: hit[1]!, file, line: lineOf(src, m.index!), path: m[1]! });
  }
  return out;
}

/** The first segments a module's own routers answer, from its sources. */
export function moduleSegments(files: { file: string; src: string }[], mounts: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { file, src } of files) for (const m of src.matchAll(ROUTE)) {
    const seg = m[1]!.split("/")[1];
    if (seg && !seg.startsWith(":") && !out.has(seg)) out.set(seg, `${file}:${lineOf(src, m.index!)}`);
  }
  for (const p of mounts) { const seg = p.split("/")[1]; if (seg && !out.has(seg)) out.set(seg, `family mount ${p}`); }
  return out;
}

export function violationsOf(platform: ReturnType<typeof platformClaims>, modules: Map<string, Map<string, string>>): Violation[] {
  const out: Violation[] = [];
  for (const claim of platform) {
    if (claim.segment.startsWith(":")) { out.push({ file: claim.file, line: claim.line, what: `${claim.path} takes every path of every module` }); continue; }
    for (const [name, segments] of modules) {
      const at = segments.get(claim.segment);
      if (at) out.push({ file: claim.file, line: claim.line, what: `${claim.path} takes ${name}'s /${claim.segment} routes (${at})` });
    }
  }
  return out;
}

const read = (dir: string) => [...walk(dir)].map((file) => ({ file, src: readFileSync(file, "utf8") }));

if (import.meta.url === `file://${process.argv[1]}`) {
  const platform = platformClaims(read("api/src/routes"));
  const modules = new Map<string, Map<string, string>>();
  for (const name of readdirSync("modules").sort()) {
    const dir = join("modules", name);
    if (!existsSync(join(dir, "src"))) continue;
    modules.set(name, moduleSegments(apiDirs(dir).flatMap(read), familyMounts(dir).values()));
  }
  const violations = violationsOf(platform, modules);
  if (violations.length) {
    console.error(`lint:platform-routes-leave-module-paths - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Put the platform route outside /modules/:moduleName/ (module-parts sits at /orgs/:slug/module-parts/:module/:part)");
    process.exit(1);
  }
  console.log(`lint:platform-routes-leave-module-paths OK (${platform.length} platform route(s) under a module's path, ${modules.size} module(s))`);
}
