// Module loader. Scans `modules/<name>/module.ts` (or .js) at boot,
// dynamically imports each one, validates the default export
// against the platform manifest schema via defineModule (which the
// module itself already calls — we just re-validate here).
//
// For Phase 0 the modules/ directory is empty, so this resolves to
// a no-op. Phase 1 (Inventory) drops in `modules/inventory/` and
// the loader picks it up automatically — no central wiring needed.

import { readdir, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ModuleManifest } from "@cobblr/platform-contract";
import { register, size } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where to look. dist runtime: dist/modules/loader.js → ../../../modules
 *  dev (tsx): src/modules/loader.ts → ../../../modules. Both resolve
 *  to the repo's modules/ dir. */
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

  const loaded: string[] = [];
  for (const entry of entries) {
    // Skip dotfiles (.gitkeep) and non-dirs.
    if (entry.startsWith(".")) continue;
    const dir = join(MODULES_DIR, entry);
    const stats = await stat(dir).catch(() => null);
    if (!stats?.isDirectory()) continue;

    const manifest = await tryLoadModule(dir, entry);
    if (manifest) {
      register(manifest);
      loaded.push(manifest.name);
    }
  }

  console.log(`[modules] loaded ${size()} module(s): ${loaded.join(", ") || "(none)"}`);
  return { count: size(), names: loaded };
}

async function tryLoadModule(dir: string, entry: string): Promise<ModuleManifest | null> {
  // Prefer compiled .js (prod), fall back to .ts (dev via tsx).
  for (const ext of [".js", ".ts"]) {
    const path = join(dir, `module${ext}`);
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) continue;
    const url = pathToFileURL(path).href;
    try {
      const mod = (await import(url)) as { default?: ModuleManifest };
      if (!mod.default || typeof mod.default !== "object") {
        console.error(`[modules] ${entry}/module${ext} has no default export — skipping`);
        return null;
      }
      return mod.default;
    } catch (err) {
      console.error(`[modules] failed to load ${entry}/module${ext}:`, err);
      return null;
    }
  }
  return null;
}
