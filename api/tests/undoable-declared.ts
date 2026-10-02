// Every action id declared undoable across the manifests and the kernel. One
// reading for the pinned test (undoable-actions-pinned.test.ts) and for `pnpm
// pins:update` (scripts/pins-update.ts), so the two can never disagree.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PLATFORM_ACTIONS } from "../src/platform/platform-actions.js";

const MODULES = fileURLToPath(new URL("../../modules", import.meta.url));

/** Every action id declared undoable across the manifests and the kernel. */
export function declaredUndoable(): string[] {
  const ids: string[] = [];
  for (const mod of readdirSync(MODULES)) {
    const manifest = join(MODULES, mod, "src", "module.ts");
    if (!existsSync(manifest)) continue;
    const lines = readFileSync(manifest, "utf8").split("\n");
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

