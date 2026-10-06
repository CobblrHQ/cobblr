#!/usr/bin/env tsx
// Every package the API's server-side code imports is a dependency of a shipped project, and a dependency imported only by browser-bundled (ui/) code is a devDependency, so the production install has exactly what the API loads.
//
// THE BUG THIS PREVENTS. 2026-10-05 (#4944): the API image shipped the whole workspace install, 568 MB, with the web app's libraries and a module's three and occt-import-js declared as production dependencies though only the browser bundle imports them
//
// THE RULE. The API image installs the PRODUCTION dependencies of the projects
// it ships (the api, platform-contract, platform-net, workspace-tools,
// thermal-print, every module) and nothing else (docker/api.Dockerfile,
// prod-deps). Two halves:
//   1. A package that server-side code imports (anything not under `ui/`,
//      `scripts/`, `tests/` and not a .tsx) must be a `dependencies` entry of
//      SOME shipped project. Otherwise the image lacks it and the first request
//      or module load that needs it crashes (ERR_MODULE_NOT_FOUND), which no
//      test run against the dev checkout would show.
//   2. A `dependencies` entry that is imported from `ui/` or .tsx files of its
//      own project and by NO server-side file of any shipped project is a
//      devDependency: the web build bundles it, the image must not carry it.
//      (three, occt-import-js and pdfjs-dist in core-file-preview were 75 MB of
//      this.) A dependency imported nowhere (a CLI the image runs, a peer) is
//      left alone.
// A package imported only on a branch production never takes (a tsx dev
// branch) is listed with its reason in scripts/ci/runtime-deps-dev-only.json,
// which the in-image check reads too: the build strips comments, so an inline
// note would not reach it. An entry nothing imports any more is refused as stale.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. api/src/sandbox/pool.ts
// imports esbuild dynamically on the `.ts` (tsx dev) branch only, so it is
// listed as dev-only rather than declared: declaring it would put a bundler in
// the image.
// Type-only imports are skipped (gone from the built file). The check reads the
// import scanner the in-image check reads (scripts/lib/bare-imports.mjs), and
// that check (scripts/ci/check-runtime-deps.mjs) is the backstop for what a
// source scan cannot see: it resolves every import of the BUILT files against
// the node_modules actually in the image.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it (core-file-preview's package.json at 4e3970ca declared
// three, occt-import-js and pdfjs-dist as dependencies).
//
//   npx tsx scripts/lint-runtime-deps-are-declared.ts   (pnpm lint runtime-deps-are-declared)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { importsOf, isNotLoadedByApi } from "./lib/bare-imports.mjs";

/** The projects the API image ships: scripts/ci/api-image-projects.json, the list docker/api.Dockerfile installs for. */
function shippedDirs(root: string): string[] {
  const { projects } = JSON.parse(readFileSync(join(root, "scripts/ci/api-image-projects.json"), "utf8")) as { projects: string[] };
  return projects.flatMap((p) => (p.endsWith("/*") ? readdirSync(join(root, p.slice(0, -2))).map((c) => `${p.slice(0, -2)}/${c}`) : [p]));
}

export interface Project {
  dir: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** relative path -> source, for every .ts/.tsx under src/ */
  files: Record<string, string>;
}

export interface Violation {
  file: string;
  line: number;
  what: string;
}

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
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

export function loadProject(root: string, dir: string): Project | null {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const files: Record<string, string> = {};
  for (const f of walk(join(root, dir, "src"))) files[relative(root, f)] = readFileSync(f, "utf8");
  return { dir, dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {}, files };
}

const external = (name: string) => !name.startsWith("@cobblr/");

/** Packages imported only on a dev branch, each with its reason (scripts/ci/runtime-deps-dev-only.json). */
export type DevOnly = Record<string, string>;

/** The check, over already-loaded projects: every violation, as file:line. */
export function check(projects: Project[], devOnly: DevOnly = {}): Violation[] {
  const out: Violation[] = [];
  const seenDevOnly = new Set<string>();
  const declared = new Set(projects.flatMap((p) => Object.keys(p.dependencies)));
  const serverUsed = new Set<string>();
  const uiUsed = new Map<string, Set<string>>(); // project dir -> packages its ui imports
  for (const p of projects) {
    for (const [file, src] of Object.entries(p.files)) {
      for (const imp of importsOf(src)) {
        if (!external(imp.name)) continue;
        if (isNotLoadedByApi(file)) {
          if (!/\.test\.|\/tests?\/|\.d\.ts$/.test(file)) (uiUsed.get(p.dir) ?? uiUsed.set(p.dir, new Set()).get(p.dir)!).add(imp.name);
          continue;
        }
        serverUsed.add(imp.name);
        if (declared.has(imp.name)) continue;
        if (devOnly[imp.name]?.trim()) {
          seenDevOnly.add(imp.name);
          continue;
        }
        out.push({ file, line: imp.line, what: `imports "${imp.name}", which no shipped project declares under dependencies: the API image will not have it (declare it, or list it with a reason in scripts/ci/runtime-deps-dev-only.json if production never takes this branch)` });
      }
    }
  }
  for (const name of Object.keys(devOnly)) {
    if (!seenDevOnly.has(name)) out.push({ file: "scripts/ci/runtime-deps-dev-only.json", line: 1, what: `"${name}" is listed as dev-only but nothing imports it undeclared any more (or it is declared now, or the reason is empty): remove the entry` });
  }
  for (const p of projects) {
    for (const dep of Object.keys(p.dependencies)) {
      if (!external(dep) || serverUsed.has(dep)) continue;
      if (uiUsed.get(p.dir)?.has(dep)) {
        out.push({ file: `${p.dir}/package.json`, line: 1, what: `"${dep}" is under dependencies but only ${p.dir}'s ui/ code imports it (the web build bundles it): make it a devDependency so the API image does not carry it` });
      }
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.cwd();
  const dirs = shippedDirs(root);
  const projects = dirs.map((d) => loadProject(root, d)).filter((p): p is Project => !!p);
  const devOnly = JSON.parse(readFileSync(join(root, "scripts/ci/runtime-deps-dev-only.json"), "utf8")) as DevOnly;
  const violations = check(projects, devOnly);
  if (violations.length) {
    console.error(`lint:runtime-deps-are-declared - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("declare it under dependencies (server code) or devDependencies (browser bundle); a branch production never takes goes in scripts/ci/runtime-deps-dev-only.json with its reason");
    process.exit(1);
  }
  console.log(`lint:runtime-deps-are-declared OK (${projects.length} shipped projects)`);
}
