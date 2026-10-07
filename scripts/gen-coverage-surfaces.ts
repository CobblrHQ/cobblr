#!/usr/bin/env tsx
// Writes scripts/coverage-matrix/surfaces.generated.json: the coverage matrix's rows
// and columns, from the registries (scripts/lib/coverage-surfaces.ts says
// which). The nightly walk and the attest CLI post it to the CI sink's store,
// and lint:coverage-surfaces holds it to the tree, so a page, kind or action
// added today is a matrix row today, reading "never tested".
//
//   npx tsx scripts/gen-coverage-surfaces.ts           write it
//   npx tsx scripts/gen-coverage-surfaces.ts --check   exit 1 if it is stale
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIMENSIONS, deriveSurfaces, type ManifestFacts } from "./lib/coverage-surfaces.ts";
import { routesIn } from "./lib/web-routes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = "scripts/coverage-matrix/surfaces.generated.json";

export async function generate(): Promise<string> {
  const appFile = "web/src/App.tsx";
  const appRoutes = routesIn(readFileSync(join(ROOT, appFile), "utf8"));

  const manifests: ManifestFacts[] = [];
  const moduleRoutes: Array<{ module: string; mount: string; path: string; redirect: boolean; file: string }> = [];
  for (const m of readdirSync(join(ROOT, "modules")).sort()) {
    const dir = join(ROOT, "modules", m);
    const entry = join(dir, "src", "module.ts");
    if (m.startsWith(".") || !statSync(dir).isDirectory() || !existsSync(entry)) continue;
    let d: Record<string, any> | undefined;
    try {
      d = (await import(pathToFileURL(entry).href)).default;
    } catch {
      continue; // an invalid manifest is lint:manifests' failure to report
    }
    if (!d?.name) continue;
    manifests.push({
      name: d.name,
      band: d.band,
      autoEnable: d.autoEnable,
      nav: d.nav ?? null,
      kinds: (d.provides?.entityKinds ?? []).map((k: any) => ({ id: k.id, label: k.label ?? k.displayName, detailRoute: k.detailRoute })),
      actions: (d.exposes?.actions ?? []).map((a: any) => ({ id: a.id, label: a.label, userInvokable: a.userInvokable, internal: a.internal, wireOnly: a.wireOnly })),
      file: `modules/${m}/src/module.ts`,
    });
    const ui = join(dir, "src", "ui", "index.tsx");
    if (existsSync(ui)) {
      const mount = `/${d.name}`;
      for (const r of routesIn(readFileSync(ui, "utf8"), { absolute: false })) moduleRoutes.push({ module: d.name, mount, path: r.path, redirect: r.redirect, file: `modules/${m}/src/ui/index.tsx` });
    }
  }

  // The foundational allowlist is a const in the enable path, not exported: read it where it is.
  const enable = readFileSync(join(ROOT, "api/src/modules/enable.ts"), "utf8");
  const allow = /FOUNDATIONAL_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/.exec(enable)?.[1] ?? "";
  const defaultModules = new Set<string>([...allow.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
  for (const m of manifests) if (m.autoEnable) defaultModules.add(m.name);

  const areas: Array<{ area: string; modules: string[]; paths?: string[] }> = [];
  for (const f of readdirSync(join(ROOT, "e2e")).filter((n) => /^fundamentals-.+-walk\.mjs$/.test(n)).sort()) {
    const w = await import(pathToFileURL(join(ROOT, "e2e", f)).href);
    if (typeof w.area === "string") areas.push({ area: w.area, modules: Array.isArray(w.modules) ? w.modules : [], paths: w.coveragePaths });
  }

  const appRouteFiles = pageFilesOf(readFileSync(join(ROOT, appFile), "utf8"), appFile);
  const hasDir = (p: string) => existsSync(join(ROOT, p));
  const platformFile = "api/src/platform/platform-actions.ts";
  const { PLATFORM_ACTIONS } = await import(pathToFileURL(join(ROOT, platformFile)).href);
  const platformActions = {
    file: platformFile,
    actions: (PLATFORM_ACTIONS as Array<{ id: string; label: string; user_invokable: boolean; wire_only?: boolean }>).map((a) => ({ id: a.id, label: a.label, userInvokable: a.user_invokable, wireOnly: a.wire_only })),
  };
  const surfaces = deriveSurfaces({ appRoutes, appFile, appRouteFiles, hasDir, moduleRoutes, manifests, defaultModules, areas, platformActions });
  return JSON.stringify({ dimensions: DIMENSIONS, surfaces }, null, 1) + "\n";
}

/** The page component file each `<Route path=…>` in App.tsx renders: the first
 *  component inside its element (past fragments and wrappers like Suspense),
 *  resolved through the file's own imports. A route whose component cannot be
 *  traced is left out, so its row simply has no change time. */
export function pageFilesOf(app: string, appFile: string): Record<string, string> {
  const importOf = new Map<string, string>();
  for (const m of app.matchAll(/const (\w+) = lazy\(\(\) =>\s*import\("([^"]+)"\)/g)) importOf.set(m[1]!, m[2]!);
  for (const m of app.matchAll(/import \{([^}]+)\} from "([^"]+)"/g)) for (const n of m[1]!.split(",")) importOf.set(n.trim().split(/\s+as\s+/).pop()!, m[2]!);
  for (const m of app.matchAll(/import (\w+) from "([^"]+)"/g)) importOf.set(m[1]!, m[2]!);
  const WRAPPERS = new Set(["Suspense", "RequireRole", "RequireModule", "ErrorBoundary", "Navigate"]);
  const out: Record<string, string> = {};
  for (const m of app.matchAll(/<Route\b[^>]*?\bpath="([^"]+)"[\s\S]{0,600}?element=\{([\s\S]{0,600}?)\}\s*\/?>/g)) {
    const comp = [...m[2]!.matchAll(/<([A-Z]\w*)/g)].map((x) => x[1]!).find((c) => !WRAPPERS.has(c) && importOf.has(c));
    const spec = comp ? importOf.get(comp)! : null;
    // A module's own pages, mounted by the app: @cobblr/<module>/ui is modules/<module>/src/ui.
    const pkg = spec ? /^@cobblr\/([a-z0-9-]+)\/ui$/.exec(spec) : null;
    if (pkg && existsSync(join(ROOT, "modules", pkg[1]!, "src", "ui"))) {
      if (!(m[1]! in out)) out[m[1]!] = `modules/${pkg[1]}/src/ui`;
      continue;
    }
    if (!spec || !spec.startsWith(".")) continue;
    const base = join(dirname(appFile), spec);
    const file = [".tsx", ".ts", "/index.tsx", "/index.ts"].map((e) => base + e).find((f) => existsSync(join(ROOT, f)));
    if (file && !(m[1]! in out)) out[m[1]!] = file;
  }
  return out;
}

async function main(): Promise<void> {
  const want = await generate();
  const path = join(ROOT, OUT);
  if (process.argv.includes("--check")) {
    const have = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (have !== want) {
      console.error(`lint:coverage-surfaces - ${OUT} is not what the registries give. A page, kind or action changed without its matrix row. Run: npx tsx scripts/gen-coverage-surfaces.ts`);
      process.exit(1);
    }
    console.log(`lint:coverage-surfaces OK (${JSON.parse(want).surfaces.length} surfaces)`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
    console.log(`wrote ${OUT} (${JSON.parse(want).surfaces.length} surfaces)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();

