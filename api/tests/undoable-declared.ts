// Every action id declared undoable across the manifests and the kernel. One
// reading for the pinned test (undoable-actions-pinned.test.ts) and for `pnpm
// pins:update` (scripts/pins-update.ts), so the two can never disagree.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PLATFORM_ACTIONS } from "../src/platform/platform-actions.js";

const MODULES = fileURLToPath(new URL("../../modules", import.meta.url));

function manifestFiles(moduleDir: string): string[] {
  const main = join(moduleDir, "src", "module.ts");
  if (!existsSync(main)) return [];
  const ts = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort().filter((f) => /\.ts$/.test(f) && !/\.(test|d)\.ts$/.test(f)).map((f) => join(dir, f)) : []);
  const families = join(moduleDir, "src", "families");
  const pieces = existsSync(families) ? readdirSync(families).sort().map((f) => join(families, f, "manifest.ts")).filter((f) => existsSync(f)) : [];
  return [main, ...ts(join(moduleDir, "src", "actions")), ...pieces];
}

/** Every action id declared undoable across the manifests and the kernel. */
export function declaredUndoable(): string[] {
  const ids: string[] = [];
  for (const mod of readdirSync(MODULES)) {
    // module.ts, the module's own action files and its families' manifest
    // pieces, read as one: the list scripts/lib/manifest-sources.ts makes,
    // written here because pins:update (an .mts) cannot import that file. An
    // undoable action that moves into a family keeps its pin.
    const files = manifestFiles(join(MODULES, mod));
    if (!files.length) continue;
    const lines = files.map((f) => readFileSync(f, "utf8")).join("\n").split("\n");
    lines.forEach((line, i) => {
      if (!/^\s*undoable: true,\s*$/.test(line)) return;
      // The `id:` it belongs to is the nearest one above it.
      for (let j = i; j >= 0; j--) {
        const id = lines[j]!.match(/^\s*id: "([a-z0-9-]+:[a-z0-9-]+)",$/);
        if (id) {
          ids.push(id[1]!);
          return;
        }
      }
    });
  }
  for (const a of PLATFORM_ACTIONS) if (a.undoable) ids.push(a.id);
  return ids.sort();
}

