// Module loader. Scans `modules/<name>/` at boot and registers each
// installed module.
//
// Resolution order for the entry file:
//   1. modules/<name>/package.json#main  (relative to module root)
//      → typically dist/module.js after a workspace build
//   2. modules/<name>/src/module.ts  (dev fallback for tsx, used
//      when dist/ doesn't exist yet)
//
// For Phase 0 the modules/ directory was empty. Phase 1 lands the
// inventory module here and the loader picks it up — no central
// wiring needed.

import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ModuleManifest } from "@cobblr/platform-contract";
import { register, size } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** dist runtime: dist/modules/loader.js → ../../../modules
 *  dev (tsx):     src/modules/loader.ts → ../../../modules
 *  Both resolve to the repo's modules/ dir. */
const MODULES_DIR = resolve(__dirname, "..", "..", "..", "modules");

export async function loadAllModules(): Promise<{ count: number; names: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(MODULES_DIR);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.log(`[modules] no modules/ directory — nothing to load`);
      return { count: 0, names: [] };
    }
    throw err;
  }

  // Pass 1: read all manifests without registering. Lets us
  // dependency-order them before they take effect.
  const pending: Array<{ manifest: ModuleManifest; rootPath: string }> = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const moduleRoot = join(MODULES_DIR, entry);
    const stats = await stat(moduleRoot).catch(() => null);
    if (!stats?.isDirectory()) continue;

    const manifest = await tryLoadModule(moduleRoot, entry);
    if (manifest) {
      pending.push({ manifest, rootPath: moduleRoot });
    }
  }

  // Pass 2: topological sort so a module with `dependencies: ["A"]`
  // registers AFTER A. Reject cycles + missing deps loudly — a
  // module that names a missing dep just gets skipped (with a clear
  // error) so the platform stays bootable.
  const ordered = topoSort(pending);
  const loaded: string[] = [];
  for (const entry of ordered) {
    register({ manifest: entry.manifest, rootPath: entry.rootPath });
    loaded.push(entry.manifest.name);
  }

  console.log(`[modules] loaded ${size()} module(s): ${loaded.join(", ") || "(none)"}`);
  return { count: size(), names: loaded };
}

/** Kahn's algorithm. Modules with no `dependencies` come first;
 *  modules whose deps are all already-ordered come next; etc.
 *
 *  A module that names a dep we don't have is logged + dropped:
 *  the rest of the platform keeps booting. */
function topoSort(
  pending: Array<{ manifest: ModuleManifest; rootPath: string }>,
): Array<{ manifest: ModuleManifest; rootPath: string }> {
  const byName = new Map(pending.map((p) => [p.manifest.name, p]));
  const ordered: Array<{ manifest: ModuleManifest; rootPath: string }> = [];
  const inProgress = new Set<string>();
  const done = new Set<string>();

  function visit(name: string, chain: string[]) {
    if (done.has(name)) return;
    if (inProgress.has(name)) {
      throw new Error(
        `[modules] dependency cycle: ${[...chain, name].join(" → ")}`,
      );
    }
    const entry = byName.get(name);
    if (!entry) {
      // Caller has already filtered for "exists"; this is a missing
      // dependency case the visit() callsite handles.
      return;
    }
    inProgress.add(name);
    for (const dep of entry.manifest.dependencies) {
      if (!byName.has(dep)) {
        throw new Error(
          `[modules] ${name} depends on '${dep}', which is not installed.`,
        );
      }
      visit(dep, [...chain, name]);
    }
    inProgress.delete(name);
    done.add(name);
    ordered.push(entry);
  }

  for (const p of pending) {
    try {
      visit(p.manifest.name, []);
    } catch (err) {
      console.error(`[modules] skipping ${p.manifest.name}:`, (err as Error).message);
    }
  }
  return ordered;
}

async function tryLoadModule(dir: string, entry: string): Promise<ModuleManifest | null> {
  const candidates = await resolveEntryCandidates(dir);
  if (candidates.length === 0) {
    console.error(`[modules] ${entry}: no entry file found (expected package.json#main or src/module.ts)`);
    return null;
  }

  for (const path of candidates) {
    try {
      const mod = (await import(pathToFileURL(path).href)) as { default?: ModuleManifest };
      if (!mod.default || typeof mod.default !== "object") {
        console.error(`[modules] ${entry}: ${path} has no default export — trying next candidate`);
        continue;
      }
      return mod.default;
    } catch (err) {
      console.error(`[modules] ${entry}: failed to import ${path}:`, err);
    }
  }
  return null;
}

async function resolveEntryCandidates(dir: string): Promise<string[]> {
  const candidates: string[] = [];

  // 1. package.json#main if the file actually exists. Modules built
  //    via tsc will have main → dist/module.js.
  const pkgPath = join(dir, "package.json");
  const pkg = await readJsonSafe(pkgPath);
  if (pkg?.main && typeof pkg.main === "string") {
    const resolved = join(dir, pkg.main);
    if (await fileExists(resolved)) candidates.push(resolved);
  }

  // 2. src/module.ts — dev fallback for tsx. Useful when running
  //    pre-build (e.g. `npm run dev:api`).
  const devEntry = join(dir, "src", "module.ts");
  if (await fileExists(devEntry)) candidates.push(devEntry);

  return candidates;
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
