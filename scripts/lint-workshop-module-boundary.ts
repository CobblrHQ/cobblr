#!/usr/bin/env tsx
// A workshop module imports only its own files, the platform contract, the host web package and the packages its own package.json declares, so it installs in Cobblr or the new shop front end unchanged.
//
// THE BUG THIS PREVENTS. 2026-10-14: the owner asked for the workshop modules to install in Cobblr or the new shop product (#6570); the audit found their unit tests reaching into scripts/, e2e/ and the root's undeclared test packages (#6572).
//
// THE RULE. For each module in WORKSHOP_MODULES, every import in its package
// source (src/, scripts/: code and unit tests, type-only imports included,
// because a typecheck in isolation needs them too) must be one of:
//   - a relative path that stays inside modules/<name>/;
//   - a node builtin;
//   - @cobblr/platform-contract or @cobblr/platform-web (the contract and the
//     host-slot seam every front end provides);
//   - a package named in the module's own package.json (dependencies,
//     peerDependencies or devDependencies).
// Anything else (web/src, api/src, another module, scripts/lib, e2e/, a
// package the root happens to hoist) fails. There is no opt-out: the fix is
// to move the helper into the module or the contract, or declare the package.
//
// THE BOUNDARY. modules/<name>/tests/ is out of scope: those are the HOST's
// integration tests (they boot the api and reach api/tests helpers on
// purpose), not part of the package a second front end installs. The audit's
// near-miss was digifab/tests/an-idle-printer-is-not-a-finished-print.test.ts
// importing api/tests/mock-job.js, which is right for a host test.
//
//   npx tsx scripts/lint-workshop-module-boundary.ts   (pnpm lint workshop-module-boundary)
import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { readRepoFile, repoFiles } from "./lib/repo-files.ts";
import { stripComments } from "./lib/source-scan.ts";

/** The modules a second front end installs (#6570). Add one here when it joins. */
export const WORKSHOP_MODULES = ["digifab", "machines", "builds"];

const CONTRACT = new Set(["@cobblr/platform-contract", "@cobblr/platform-web"]);
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]));
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

const SPECIFIERS = [
  /(?:^|[\n;])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"'\n]+)["']/g,
  /(?:^|[\n;])\s*import\s*["']([^"'\n]+)["']/g,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/** One offending place. `line` is 1-based for a clickable path:line. */
export interface Violation {
  file: string;
  line: number;
  what: string;
}

/** Every specifier a file imports, with its 1-based line. */
export function specifiersOf(src: string): Array<{ spec: string; line: number }> {
  const code = stripComments(src);
  const out: Array<{ spec: string; line: number }> = [];
  for (const re of SPECIFIERS) {
    for (const m of code.matchAll(re)) {
      const at = (m.index ?? 0) + m[0].lastIndexOf(m[1]!);
      out.push({ spec: m[1]!, line: code.slice(0, at).split("\n").length });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The package a bare specifier names, or null for relative, builtin and `node:` ones. */
function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  return BUILTINS.has(name) ? null : name;
}

/** Every violation in one file of module `mod`, whose package.json declares `declared`. */
export function check(file: string, src: string, mod: string, declared: Set<string>): Violation[] {
  const home = `modules/${mod}/`;
  const out: Violation[] = [];
  for (const { spec, line } of specifiersOf(src)) {
    if (spec.startsWith(".")) {
      const target = normalize(join(dirname(file), spec));
      if (!`${target}/`.startsWith(home)) out.push({ file, line, what: `"${spec}" reaches ${target}, outside ${home}` });
      continue;
    }
    const pkg = packageOf(spec);
    if (pkg === null || CONTRACT.has(pkg) || declared.has(pkg)) continue;
    out.push({
      file,
      line,
      what: pkg.startsWith("@cobblr/") ? `"${spec}" is another Cobblr package, not the contract` : `"${pkg}" is not in ${home}package.json`,
    });
  }
  return out;
}

function declaredBy(mod: string): Set<string> {
  const pj = JSON.parse(readRepoFile(`modules/${mod}/package.json`) ?? "{}") as Record<string, Record<string, string> | undefined>;
  return new Set([pj.dependencies, pj.peerDependencies, pj.devDependencies].flatMap((d) => Object.keys(d ?? {})));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const mod of WORKSHOP_MODULES) {
    const declared = declaredBy(mod);
    // The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
    for (const file of repoFiles([`modules/${mod}/src`, `modules/${mod}/scripts`])) {
      if (!SOURCE.test(file) || file.endsWith(".d.ts") || !onlyChanged(file)) continue;
      const src = readRepoFile(file);
      if (src !== null) violations.push(...check(file, src, mod, declared));
    }
  }

  if (violations.length) {
    console.error(`lint:workshop-module-boundary - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Move the helper into the module or the platform contract, or declare the package in the module's own package.json (#6572).");
    process.exit(1);
  }
  console.log(`lint:workshop-module-boundary OK`);
}
