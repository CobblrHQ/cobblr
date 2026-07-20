// Guard: a workspace package another workspace DEPENDS ON must resolve its
// TYPES to source, never to dist.
//
// Why this is the rule, and why it isn't "export src":
//   Runtime and typecheck resolve separately. `@cobblr/workspace-tools` ships
//   "main": "dist/index.js" (runtime) with "types": "src/index.ts" (typecheck),
//   and that is CORRECT — it's the types entry that has to be buildless.
//   Nothing in the repo builds a dependency before typechecking its consumer,
//   so a types entry pointing at dist/index.d.ts makes the consumer's typecheck
//   depend on a build artifact that may not exist. The consumer then fails with
//   "cannot find module @cobblr/<pkg>" on a clean checkout — including in CI.
//
// That is exactly how packages/thermal-print landed (PR #978): types pointed at
// dist, web couldn't typecheck until someone built the package by hand, and the
// failure looked like a broken import rather than a packaging mistake.
//
// Packages nobody depends on (a standalone bin like mcp-server, the sandbox
// SDKs) are exempt — nothing typechecks against them, so there is no trap.
//
// Run: npx tsx scripts/lint-workspace-types-entry.ts

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

type Pkg = {
  name?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readPkg(file: string): Pkg | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Pkg;
  } catch {
    return null;
  }
}

/** Every package.json in the workspace, so we can see who depends on what. */
function allManifests(): { file: string; pkg: Pkg }[] {
  const out: { file: string; pkg: Pkg }[] = [];
  const roots = ["api", "web", "packages", "modules"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const direct = join(root, "package.json");
    if (existsSync(direct)) {
      const p = readPkg(direct);
      if (p) out.push({ file: direct, pkg: p });
      continue;
    }
    for (const name of readdirSync(root)) {
      const f = join(root, name, "package.json");
      if (existsSync(f) && statSync(join(root, name)).isDirectory()) {
        const p = readPkg(f);
        if (p) out.push({ file: f, pkg: p });
      }
    }
  }
  return out;
}

/** The path TypeScript will use for this package's declarations, if declared. */
function typesEntry(pkg: Pkg): string | null {
  const e = pkg.exports;
  if (e && typeof e === "object" && !Array.isArray(e)) {
    const dot = (e as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const t = (dot as Record<string, unknown>).types ?? (dot as Record<string, unknown>).import;
      if (typeof t === "string") return t;
    }
  }
  if (typeof e === "string") return e;
  return pkg.types ?? pkg.typings ?? null;
}

const manifests = allManifests();

// Who is depended upon by a DIFFERENT workspace?
const consumed = new Set<string>();
for (const { pkg } of manifests) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (dep.startsWith("@cobblr/") && dep !== pkg.name) consumed.add(dep);
    }
  }
}

const failures: string[] = [];
let checked = 0;

for (const { file, pkg } of manifests) {
  if (!file.startsWith("packages/")) continue;
  if (!pkg.name || !consumed.has(pkg.name)) continue; // nobody typechecks against it
  const entry = typesEntry(pkg);
  if (!entry) {
    failures.push(
      `${file}: ${pkg.name} is depended on by another workspace but declares no types entry — ` +
        `add "types": "src/index.ts" (or exports["."].types) so consumers typecheck without a build`,
    );
    continue;
  }
  checked++;
  const buildless = entry.includes("src/") || entry.includes("assembly/");
  if (!buildless) {
    failures.push(
      `${file}: ${pkg.name} resolves types to "${entry}" — a BUILD ARTIFACT. ` +
        `Nothing builds a dependency before typechecking its consumer, so this fails on a ` +
        `clean checkout and in CI. Point types at source ("src/index.ts"); "main" may stay on dist.`,
    );
  }
}

if (failures.length) {
  console.error("✗ lint-workspace-types-entry: a consumed package resolves types to a build artifact:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ workspace-types-entry lint: ${checked} consumed package(s) resolve types to source (buildless)`,
);
process.exit(0);
