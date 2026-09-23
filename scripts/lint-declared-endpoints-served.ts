#!/usr/bin/env tsx
// Every endpoint a kind declares (get, create, update, delete) is a route its module serves.
//
// THE BUG THIS PREVENTS. `lists:item` declared `getEndpoint: "/items/{id}"`
// and the module served PATCH and DELETE at that address but no GET. Nothing
// read an item alone until the trial carry did (2026-09-22), reading each
// record through its kind's own declared door, and met a 404 for every list
// item a visitor had made. The declaration is a promise every generic caller
// takes at its word (the entity resolver, the assistant's tools, the MCP
// server, the carry), so a declared door that is not there fails for all of
// them at once and for none of the module's own screens, which call their
// routes by hand.
//
// THE RULE. For each kind in a module manifest, each declared endpoint must
// match a route in that module's `src/api`: the same method (get → GET,
// create → POST, update → PATCH or PUT, delete → DELETE) at the same path,
// with any `{param}` and `:param` treated as one parameter. A route mounted
// under a prefix the scan cannot see opts out at the declaration with a
// `// ENDPOINT-SERVED: <where it is served>` comment within three lines above
// it; there is no baseline.
//
//   npx tsx scripts/lint-declared-endpoints-served.ts   (pnpm run lint:declared-endpoints-served)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULES_DIR = "modules";
const MARKER = "ENDPOINT-SERVED:";

interface KindDecl {
  id?: string;
  getEndpoint?: string;
  createEndpoint?: string;
  updateEndpoint?: string;
  deleteEndpoint?: string;
}

interface Violation {
  file: string;
  line: number;
  what: string;
}

const VERBS: Array<[keyof KindDecl, string[]]> = [
  ["getEndpoint", ["get"]],
  ["createEndpoint", ["post"]],
  ["updateEndpoint", ["patch", "put"]],
  ["deleteEndpoint", ["delete"]],
];

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

/** A path with every parameter spelled the same, so `/items/{id}` and
 *  `/items/:itemId` compare equal. */
export function shapeOf(path: string): string {
  return path.replace(/\{[^}]+\}/g, ":").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":").replace(/\/+$/, "") || "/";
}

/** Every route a module's api serves, as "method shape", with the prefix each
 *  sub-router is mounted under (`router.use("/orders", ordersRouter)` makes
 *  `ordersRouter.post("/")` serve POST /orders). Names are matched across the
 *  module's files, which is how its routers are wired in practice. */
export function servedRoutes(sources: string[]): Set<string> {
  const routes: Array<{ router: string; method: string; path: string }> = [];
  const mounts: Array<{ parent: string; prefix: string; child: string }> = [];
  const routeRe = /(\w+)\.(get|post|patch|put|delete)\(\s*["'`](\/[^"'`]*)["'`]/g;
  const mountRe = /(\w+)\.use\(\s*["'`](\/[^"'`]*)["'`]\s*,([^;]*?)\)\s*;/g;
  for (const src of sources) {
    for (const m of src.matchAll(routeRe)) routes.push({ router: m[1]!, method: m[2]!, path: m[3]! });
    for (const m of src.matchAll(mountRe)) {
      const child = /(\w+)\s*$/.exec(m[3]!.trim())?.[1];
      if (child) mounts.push({ parent: m[1]!, prefix: m[2]!, child });
    }
  }
  const prefixes = (name: string, depth = 0): string[] => {
    const up = mounts.filter((x) => x.child === name);
    if (up.length === 0 || depth > 6) return [""];
    return up.flatMap((x) => prefixes(x.parent, depth + 1).map((p) => `${p}${x.prefix === "/" ? "" : x.prefix}`));
  };
  const out = new Set<string>();
  for (const r of routes) {
    for (const p of prefixes(r.router)) out.add(`${r.method} ${shapeOf(`${p}${r.path === "/" && p ? "" : r.path}`)}`);
    out.add(`${r.method} ${shapeOf(r.path)}`);
  }
  return out;
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  let checked = 0;
  for (const m of readdirSync(MODULES_DIR)) {
    const dir = join(MODULES_DIR, m);
    const entry = resolve(dir, "src", "module.ts");
    if (m.startsWith(".") || !existsSync(entry)) continue;
    let kinds: KindDecl[];
    try {
      const mod = (await import(pathToFileURL(entry).href)) as { default?: { provides?: { entityKinds?: KindDecl[] } } };
      kinds = mod.default?.provides?.entityKinds ?? [];
    } catch {
      continue; // an invalid manifest is lint-manifests' failure, not this one's
    }
    if (kinds.length === 0) continue;
    const apiDir = join(dir, "src", "api");
    const routes = servedRoutes([...walk(apiDir)].map((f) => readFileSync(f, "utf8")));
    const manifest = readFileSync(entry, "utf8").split("\n");
    for (const k of kinds) {
      for (const [field, methods] of VERBS) {
        const path = k[field];
        if (!path) continue;
        checked++;
        if (methods.some((verb) => routes.has(`${verb} ${shapeOf(path)}`))) continue;
        const at = manifest.findIndex((l) => l.includes(`${field}:`) && l.includes(path));
        const above = at >= 0 ? manifest.slice(Math.max(0, at - 3), at + 1).join("\n") : "";
        if (above.includes(MARKER)) continue;
        violations.push({
          file: entry.replace(`${process.cwd()}/`, ""),
          line: at + 1,
          what: `${k.id ?? "?"} declares ${field} ${methods.map((v) => v.toUpperCase()).join("/")} ${path}, and ${m}'s api serves no such route`,
        });
      }
    }
  }
  if (violations.length) {
    console.error(`lint:declared-endpoints-served - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Serve the route, or stop declaring the endpoint.");
    process.exit(1);
  }
  console.log(`lint:declared-endpoints-served OK (${checked} declared endpoints, each one served)`);
}

void main();
