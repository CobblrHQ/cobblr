// Every @cobblr/* package a workspace IMPORTS must be in its package.json.
//
// If it is not, the import still resolves locally — pnpm hoisting, or a linked
// worktree's node_modules — and typechecks green on your machine. Then CI does a
// clean `--frozen-lockfile` install, the link does not exist, and it fails with
// "Cannot find module", far from the code that caused it.
//
// That is exactly how packages/platform-web ended up importing
// @cobblr/platform-contract without declaring it (2026-07): green locally, red on
// CI, and the error named the import rather than the missing dependency.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const PKGS = globSync("{packages,modules,api,web}/*/package.json", {
  exclude: (p) => p.includes("node_modules"),
});

const problems: string[] = [];
for (const pkgPath of PKGS) {
  const dir = pkgPath.replace(/\/package\.json$/, "");
  let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { continue; }
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const sources = globSync(`${dir}/**/*.{ts,tsx}`, {
    exclude: (p) => p.includes("node_modules") || p.includes("/dist/"),
  });
  const missing = new Map<string, string>();
  for (const f of sources) {
    const src = readFileSync(f, "utf8");
    // Bare specifier or an exports subpath: @cobblr/x and @cobblr/x/sub both
    // resolve through the @cobblr/x dependency.
    for (const m of src.matchAll(/from\s+["'](@cobblr\/[a-z0-9-]+)(?:\/[^"']+)?["']/g)) {
      const dep = m[1]!;
      if (dep === pkg.name || declared.has(dep)) continue;
      if (!missing.has(dep)) missing.set(dep, f);
    }
  }
  for (const [dep, where] of missing) {
    problems.push(`${pkg.name ?? dir}: imports ${dep} but does not declare it  (first seen ${where})`);
  }
}

if (problems.length) {
  console.error(
    "[lint:workspace-deps] a workspace imports a @cobblr/* package it does not declare.\n" +
      "This resolves locally and FAILS on CI's clean install. Fix with:\n" +
      "    pnpm add <dep>@workspace:* --filter <package>\n" +
      "and COMMIT pnpm-lock.yaml.\n",
  );
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`lint:workspace-deps: every @cobblr/* import is declared (${PKGS.length} workspaces) ✓`);
