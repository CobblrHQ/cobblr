#!/usr/bin/env node
// Transpile-only build for the CI `test` job. esbuild-transpiles api + every
// module's src → dist (ESM, one .js per .ts, structure preserved) — the same
// dist layout `tsc` produces, but ~10x faster (~60s → ~5s). It is a pure
// TRANSFORM: no type-checking (that's the separate `typecheck` job) and no
// bundling (imports stay external, resolved by node at runtime exactly as with
// tsc). Prod docker images keep building with tsc — this only speeds the test
// job's `node dist` boot.
//
// Why this is faithful here:
//   • tsconfig has `isolatedModules: true` — the code is already written for
//     independent per-file transpilation (esbuild's model), and esbuild elides
//     type-only imports the same way tsc does.
//   • vitest + dev-tsx already transpile this exact code with esbuild, so the
//     transform is proven. The `node dist` (not tsx) requirement was about tsx's
//     RUNTIME loader hooks breaking the wasm sandbox — an ahead-of-time build to
//     static .js + plain `node dist` has no such hooks (identical to tsc).
//   • Shared packages/* (platform-contract, …) are consumed as .ts source via
//     node type-stripping — the tsc build doesn't emit them either, so we match
//     it by building only modules/* + api.

import { build } from "esbuild";
import { readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// api + every module that has a src/ dir. NOT packages/* — those are consumed as
// .ts source at runtime (node type-stripping), exactly as the tsc build leaves them.
const pkgs = [
  "api",
  ...readdirSync(join(root, "modules"))
    .map((m) => join("modules", m))
    .filter((p) => isDir(join(root, p, "src"))),
];

const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (
      /\.(ts|tsx)$/.test(e.name) &&
      !/\.d\.ts$/.test(e.name) &&
      !/\.test\.ts$/.test(e.name)
    )
      acc.push(p);
  }
  return acc;
};

const t0 = Date.now();
let fileCount = 0;

await Promise.all(
  pkgs.map(async (pkg) => {
    const srcDir = join(root, pkg, "src");
    const entryPoints = walk(srcDir);
    if (entryPoints.length === 0) return;
    fileCount += entryPoints.length;
    // Clean dist so a renamed/deleted source can't leave a stale .js behind
    // (esbuild, unlike a fresh tsc, won't prune orphans on its own).
    rmSync(join(root, pkg, "dist"), { recursive: true, force: true });
    await build({
      entryPoints,
      outdir: join(root, pkg, "dist"),
      outbase: srcDir,
      format: "esm",
      platform: "node",
      target: "node22",
      bundle: false, // keep imports external — resolved by node like tsc output
      sourcemap: true,
      logLevel: "warning",
    });
  }),
);

console.log(
  `[fast-build] transpiled ${fileCount} files across ${pkgs.length} packages in ${Date.now() - t0}ms`,
);
