// The files a module's manifest is written in: src/module.ts and, for a
// module split into families (docs/architecture/module-parts.md), each
// src/families/<family>/manifest.ts it spreads in. Every lint that reads a
// manifest's actions or panels as text reads them all through here, so an
// action declared in a family is judged like one in module.ts, never skipped.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The manifest files of the module in `moduleDir` (modules/<name>), module.ts
 *  first, then each action file in src/actions/ (one action per file, found by
 *  module.ts in name order, #7382), then each family's manifest. */
export function manifestSources(moduleDir: string): string[] {
  const main = join(moduleDir, "src", "module.ts");
  const families = join(moduleDir, "src", "families");
  const actions = join(moduleDir, "src", "actions");
  const out = existsSync(main) ? [main] : [];
  if (existsSync(actions)) for (const f of readdirSync(actions).sort()) {
    if (/\.ts$/.test(f) && !/\.(test|d)\.ts$/.test(f)) out.push(join(actions, f));
  }
  if (existsSync(families)) for (const f of readdirSync(families).sort()) {
    const piece = join(families, f, "manifest.ts");
    if (existsSync(piece)) out.push(piece);
  }
  return out;
}

/** The folders a module's HTTP routes and action handlers live in: src/api
 *  and each family's src/families/<family>/api. */
export function apiDirs(moduleDir: string): string[] {
  const out = [join(moduleDir, "src", "api")].filter((d) => existsSync(d));
  const families = join(moduleDir, "src", "families");
  if (existsSync(families)) for (const f of readdirSync(families).sort()) {
    const api = join(families, f, "api");
    if (existsSync(api)) out.push(api);
  }
  return out;
}

/** Where each family mounts its routers: `{ path: "/arms", router: armsRouter }`
 *  in src/families/<family>/index.ts, read as router name → path. */
export function familyMounts(moduleDir: string, read: (f: string) => string = (f) => readFileSync(f, "utf8")): Map<string, string> {
  const out = new Map<string, string>();
  const families = join(moduleDir, "src", "families");
  if (!existsSync(families)) return out;
  for (const f of readdirSync(families)) {
    const idx = join(families, f, "index.ts");
    if (!existsSync(idx)) continue;
    for (const m of read(idx).matchAll(/\{\s*path:\s*["'`]([^"'`]+)["'`]\s*,\s*router:\s*(\w+)\s*\}/g)) out.set(m[2]!, m[1]!);
  }
  return out;
}
