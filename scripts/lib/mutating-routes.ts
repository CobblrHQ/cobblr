// Every route in the platform that changes something: a module's (under its
// router's mount prefix, read from the module's api/index.ts) and the
// kernel's (api/src/routes, whose paths are written in full). One reader, for
// every lint that asks a question of each write: who can reach it (the
// assistant: lint-ai-reach-routes; a person on a screen: lint-ui-reach). Two
// copies of this parsing would find different route sets, and a route one
// lint could not see would be a route nobody judged.
import { readOnce } from "./read-once.ts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MODULES = "modules";
export const KERNEL = join("api", "src", "routes");

const WIRE_WORDS = "poll|respond|register|webhook|hooks?|callback|heartbeat|probe|healthz|sweep|openapi|_internal";

/** A device's or a sweep's own calls (a bridge's poll, a webhook, a health
 *  probe): never something a person asks for, on a screen or of the
 *  assistant. */
export const DEVICE_WIRE_PATH = new RegExp(`\\/(${WIRE_WORDS})(\\/|$)`, "i");

/** The same, and everything under /edge. For the assistant every edge route
 *  is the bridge's business; a person does reach some of them (the bridges
 *  page's Disconnect), so the screen's lint uses DEVICE_WIRE_PATH. */
export const WIRE_PATH = new RegExp(`\\/(edge|${WIRE_WORDS})(\\/|$)`, "i");

export type WriteVerb = "POST" | "PATCH" | "PUT" | "DELETE";

export interface MutatingRoute {
  /** The module's directory name, or "kernel". */
  area: string;
  /** Repo-relative path of the file that registers it. */
  file: string;
  /** 1-based line of the registration. */
  line: number;
  verb: WriteVerb;
  /** Normalised (every parameter is `:x`): a module's route under its mount
   *  prefix, relative to the module; a kernel route as written. */
  path: string;
  /** Where a client calls it, below /api/v1: a module's route under
   *  /orgs/:x/modules/<name>; a kernel route under the prefix its router is
   *  mounted at in api/src/server.ts (its written path when the router is
   *  mounted somewhere this reader cannot see). */
  served: string;
  /** The lines above the registration, where a route's annotations sit. */
  above: string;
}

/** A path with every parameter (`:id`, `{id}`) spelled `:x`, one leading
 *  slash and no trailing one. */
export const norm = (p: string): string =>
  ("/" + p.replace(/^\/+/, "")).replace(/\{[^}]+\}/g, ":x").replace(/:[a-zA-Z_]+/g, ":x").replace(/\/+$/, "") || "/";

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}
export { walk as walkTs };

/** `x.post("/p", …)` / `x.patch(\n "/p"` on a variable named *Router. */
function* routesIn(file: string, lookback: number): Generator<{ line: number; varName: string; verb: WriteVerb; path: string; above: string }> {
  const lines = readOnce(file).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*(\w+)\s*\.\s*(post|patch|put|delete)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/);
    if (!m) continue;
    const [, varName, verb, sub] = m;
    if (!/[Rr]outer$/.test(varName!)) continue;
    // The path may sit on the next line: `router.post(\n  "/x",`
    const path = sub ?? lines[i + 1]?.match(/^\s*["'`]([^"'`]*)["'`]/)?.[1];
    if (path === undefined) continue;
    yield {
      line: i + 1,
      varName: varName!,
      verb: verb!.toUpperCase() as WriteVerb,
      path,
      above: lines.slice(Math.max(0, i - lookback), i).join("\n"),
    };
  }
}

/** The modules that serve routes: those with a manifest and an api/ dir. */
export function routedModules(): string[] {
  return readdirSync(MODULES).filter((mod) => existsSync(join(MODULES, mod, "src", "module.ts")) && existsSync(join(MODULES, mod, "src", "api")));
}

/** One module's write routes, each under the mount prefix its router is
 *  `.use()`d at in the module's api/index.ts. */
export function moduleRoutes(mod: string, lookback = 6): MutatingRoute[] {
  const api = join(MODULES, mod, "src", "api");
  const idx = join(api, "index.ts");
  const mounts = new Map<string, string>();
  if (existsSync(idx)) {
    for (const m of readOnce(idx).matchAll(/\.use\(\s*(?:["'`]([^"'`]+)["'`]\s*,\s*)?(\w+)\s*\)/g)) {
      mounts.set(m[2]!, m[1] ? norm(m[1]) : "");
    }
  }
  // Where each router really answers: its own prefix under every router it
  // is mounted inside (`partsRouter.use(holdingsRouter)` puts holdings under
  // /parts). `path` keeps the one-level reading the assistant's lint was
  // built on; `served` is the composed one.
  const edges: Array<{ parent: string; prefix: string; child: string }> = [];
  for (const f of walk(api)) {
    for (const m of readOnce(f).matchAll(/\b(\w+)\.use\(\s*(?:["'`]([^"'`]+)["'`]\s*,\s*)?(\w+)\s*\)/g)) {
      edges.push({ parent: m[1]!, prefix: m[2] ? norm(m[2]) : "", child: m[3]! });
    }
  }
  const composed = new Map<string, string>();
  const under = (router: string, seen: Set<string>): string => {
    if (composed.has(router)) return composed.get(router)!;
    const e = edges.find((x) => x.child === router && !seen.has(x.parent));
    const full = e ? under(e.parent, new Set([...seen, router])) + e.prefix : "";
    composed.set(router, full);
    return full;
  };
  const out: MutatingRoute[] = [];
  for (const f of walk(api)) {
    for (const r of routesIn(f, lookback)) {
      const prefix = mounts.get(r.varName);
      const tail = r.path === "/" ? "" : r.path;
      const full = prefix === undefined ? norm(r.path) : norm(prefix + tail);
      const served = norm(`/orgs/:x/modules/${mod}${under(r.varName, new Set())}${tail}`);
      out.push({ area: mod, file: f, line: r.line, verb: r.verb, path: full, served, above: r.above });
    }
  }
  return out;
}

/** Each kernel router's mount prefix: `v1.use("/prefix", xRouter)` (or
 *  `v1.use(xRouter)`, no prefix) in api/src/server.ts, and a router mounted
 *  inside another (`superAdminRouter.use("/scan-url-resolvers", yRouter)`)
 *  under its parent's prefix. */
export function kernelMounts(): Map<string, string> {
  const edges: Array<{ parent: string; prefix: string; child: string }> = [];
  const USE = /\b(\w+)\.use\(\s*(?:["'`]([^"'`]+)["'`]\s*,\s*)?(\w+Router)\s*\)/g;
  const files = [join("api", "src", "server.ts"), ...(existsSync(KERNEL) ? walk(KERNEL) : [])];
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const m of readOnce(f).matchAll(USE)) edges.push({ parent: m[1]!, prefix: m[2] ? norm(m[2]) : "", child: m[3]! });
  }
  const mounts = new Map<string, string>();
  const resolve = (router: string, seen: Set<string>): string | undefined => {
    if (mounts.has(router)) return mounts.get(router);
    const e = edges.find((x) => x.child === router && !seen.has(x.parent));
    if (!e) return undefined;
    const above = e.parent === "v1" ? "" : resolve(e.parent, new Set([...seen, router]));
    if (above === undefined) return undefined;
    const full = above + e.prefix;
    mounts.set(router, full);
    return full;
  };
  for (const e of edges) resolve(e.child, new Set());
  return mounts;
}

/** The kernel's write routes (api/src/routes), paths as written. */
export function kernelRoutes(lookback = 6): MutatingRoute[] {
  if (!existsSync(KERNEL)) return [];
  const mounts = kernelMounts();
  const out: MutatingRoute[] = [];
  for (const f of walk(KERNEL)) {
    for (const r of routesIn(f, lookback)) {
      const path = norm(r.path);
      const prefix = mounts.get(r.varName) ?? "";
      out.push({ area: "kernel", file: f, line: r.line, verb: r.verb, path, served: norm(prefix + (path === "/" ? "" : path)), above: r.above });
    }
  }
  return out;
}
