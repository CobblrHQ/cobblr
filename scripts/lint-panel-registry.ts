// Guard: every panel a manifest CONTRIBUTES has a component registered, and
// every registered component is contributed by some manifest.
//
// The trap: `contributes.panels` is a declare-here / register-there split — the
// manifest says WHERE a panel goes, web/src/panels/registry.tsx says WHAT
// renders. A mismatch (a typo'd id, a panel declared but never registered, a
// component registered after its declaration was removed) is deliberately
// SILENT at runtime: the host renders nothing rather than crashing. Silent is
// right for production and terrible for the author, who ships a feature that
// simply never appears. This makes the mismatch loud at lint time instead.
//
// Run: npx tsx scripts/lint-panel-registry.ts

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULES_DIR = "modules";
const REGISTRY = "web/src/panels/registry.tsx";

interface DeclaredPanel {
  id: string;
  surface: string;
  module: string;
}

async function declaredPanels(): Promise<DeclaredPanel[]> {
  const out: DeclaredPanel[] = [];
  const modules = readdirSync(MODULES_DIR).filter((d) => {
    if (d.startsWith(".")) return false;
    const p = join(MODULES_DIR, d);
    return statSync(p).isDirectory() && existsSync(join(p, "package.json"));
  });
  for (const m of modules) {
    const entry = resolve(MODULES_DIR, m, "src", "module.ts");
    if (!existsSync(entry)) continue;
    const mod = (await import(pathToFileURL(entry).href)) as {
      default?: { name?: string; contributes?: { panels?: Array<{ id: string; surface: string }> } };
    };
    for (const p of mod.default?.contributes?.panels ?? []) {
      out.push({ id: p.id, surface: p.surface, module: mod.default?.name ?? m });
    }
  }
  return out;
}

/** Ids the web registry has a component for, by surface. Text-matched rather
 *  than imported: the registry pulls in the whole web app's TSX otherwise. */
/** The `"<module>:<panel>": lazy(...)` keys of one named map in the registry. */
function mapKeys(src: string, name: string): Set<string> {
  const out = new Set<string>();
  const start = src.search(new RegExp(`const ${name}\\b[^=]*=\\s*\\{`));
  if (start < 0) return out;
  const end = src.indexOf("\n};", start);
  for (const m of src.slice(start, end < 0 ? undefined : end).matchAll(/["']([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)["']\s*:\s*lazy\(/g)) out.add(m[1]!);
  return out;
}

function registeredIds(src: string): { tabs: Set<string>; panels: Set<string>; sections: Set<string> } {
  const tabs = mapKeys(src, "PAGE_TABS");
  const sections = mapKeys(src, "CONFIG_SECTIONS");
  const panels = new Set<string>();
  // registerDetailPanel("<module>:<panel>", …)
  for (const m of src.matchAll(/registerDetailPanel\(\s*["']([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)["']/g)) {
    panels.add(m[1]!);
  }
  return { tabs, panels, sections };
}

async function main(): Promise<void> {
  if (!existsSync(REGISTRY)) {
    console.error(`[lint-panel-registry] missing ${REGISTRY}`);
    process.exit(1);
  }
  const src = readFileSync(REGISTRY, "utf8");
  const { tabs, panels, sections } = registeredIds(src);
  const declared = await declaredPanels();
  const failures: string[] = [];

  for (const d of declared) {
    const have = d.surface === "module-page-tab" ? tabs : d.surface === "configuration-section" ? sections : panels;
    if (!have.has(d.id)) {
      failures.push(
        `${d.module} declares panel "${d.id}" (${d.surface}) but nothing renders it.\n` +
          `    Fix: add it to ${REGISTRY} — ` +
          (d.surface === "module-page-tab"
            ? `a PAGE_TABS entry "${d.id}": lazy(...)`
            : d.surface === "configuration-section"
              ? `a CONFIG_SECTIONS entry "${d.id}": lazy(...)`
              : `registerDetailPanel("${d.id}", lazy(...))`),
      );
    }
  }

  // The kernel's own panels (Links) are declared in platform-web, since no
  // module owns them; text-matched for the same reason as the registry.
  const kernelSrc = readFileSync("packages/platform-web/src/panels.tsx", "utf8");
  const kernelBlock = kernelSrc.match(/export const KERNEL_PANELS[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? "";
  const kernelIds = [...kernelBlock.matchAll(/id:\s*["']([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)["']/g)].map((m) => m[1]!);
  for (const id of kernelIds) {
    if (!panels.has(id)) failures.push(`platform-web KERNEL_PANELS declares "${id}" but nothing renders it.\n    Fix: registerDetailPanel("${id}", lazy(...)) in ${REGISTRY}`);
  }
  const declaredIds = new Set([...declared.map((d) => d.id), ...kernelIds]);
  for (const id of [...tabs, ...panels]) {
    if (!declaredIds.has(id)) {
      failures.push(
        `${REGISTRY} registers "${id}" but no manifest contributes it — it can never render.\n` +
          `    Fix: add it to the owning module's contributes.panels, or drop the registration.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("[lint-panel-registry] contributed panels are out of sync:\n");
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    process.exit(1);
  }
  console.log(
    `[lint-panel-registry] ✓ ${declared.length} contributed panel(s) all have a renderer`,
  );
}

void main();
