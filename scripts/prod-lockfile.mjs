#!/usr/bin/env node
// Reduce pnpm-lock.yaml and pnpm-workspace.yaml to the projects the API image
// ships, so `pnpm install --frozen-lockfile --prod` installs exactly their
// production dependencies and nothing the web app or a build tool wanted.
//
//   node scripts/prod-lockfile.mjs api packages/platform-contract 'modules/*'
//   node scripts/prod-lockfile.mjs --from scripts/ci/api-image-projects.json
//
// WHY NOT `pnpm install --filter`. With the hoisted linker pnpm ignores the
// filter for a frozen-lockfile install (measured 2026-10-05: --prod alone,
// --prod with --filter, and --prod with only the shipped manifests present all
// gave the same 349 MB), because it installs for every importer the LOCKFILE
// lists. So the importers the image does not ship are taken out of the lockfile
// and out of the workspace list instead: 568 MB with everything, 242 MB with
// this (before the browser-only libraries became devDependencies).
//
// Keeps the root importer (".": its devDependencies are skipped by --prod) and
// every importer named, where `dir/*` means each direct child of dir. Writes
// both files in the current directory, in place.
import { readFileSync, writeFileSync } from "node:fs";

/** Does an importer key (a project directory) match one of the keeps? */
export function keeps(key, patterns) {
  if (key === ".") return true;
  return patterns.some((p) => (p.endsWith("/*") ? key.startsWith(p.slice(0, -1)) && !key.slice(p.length - 1).includes("/") && key.length > p.length - 1 : key === p));
}

/** The importer keys (project directories) the lockfile lists, in order. */
export function importerKeys(lock) {
  const at = lock.indexOf("\nimporters:\n");
  const end = lock.indexOf("\npackages:\n", at);
  if (at < 0 || end < 0) throw new Error("pnpm-lock.yaml has no importers:/packages: sections");
  return [...lock.slice(at, end).matchAll(/^ {2}(?=\S)'?([^'\n]+?)'?:$/gm)].map((m) => m[1]);
}

/** The lockfile text with only the kept importers (everything else untouched). */
export function reduceLockfile(lock, patterns) {
  const at = lock.indexOf("\nimporters:\n");
  const end = lock.indexOf("\npackages:\n", at);
  if (at < 0 || end < 0) throw new Error("pnpm-lock.yaml has no importers:/packages: sections");
  const head = lock.slice(0, at + "\nimporters:\n".length);
  const body = lock.slice(at + "\nimporters:\n".length, end);
  const blocks = body.split(/\n(?=  \S[^\n]*:\n)/);
  const kept = blocks.filter((b) => {
    const m = /^ {2}'?([^'\n]+?)'?:\n/.exec(b.startsWith("  ") ? b : `  ${b}`);
    return m ? keeps(m[1], patterns) : false;
  });
  if (!kept.length) throw new Error("no importer kept: check the patterns");
  return `${head}${kept.join("\n")}\n${lock.slice(end)}`;
}

/** The workspace file with its `packages:` list replaced by the kept importers,
 *  named one by one: a directory that is not in the lockfile (a module the
 *  registry step extracted into modules/) must not become a project, or a frozen
 *  install would refuse the lockfile as out of date. */
export function reduceWorkspace(ws, keptKeys) {
  const list = ["packages:", ...keptKeys.filter((k) => k !== ".").map((k) => `  - ${k}`)].join("\n");
  if (!/^packages:\n/m.test(ws)) throw new Error("pnpm-workspace.yaml has no packages: list");
  return ws.replace(/^packages:\n(?: {2}[^\n]*\n)*/m, `${list}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const patterns = args[0] === "--from" ? JSON.parse(readFileSync(args[1] ?? "", "utf8")).projects : args;
  if (!patterns?.length) {
    console.error("usage: prod-lockfile.mjs <project dir | dir/*>... | --from <projects.json>");
    process.exit(2);
  }
  const reduced = reduceLockfile(readFileSync("pnpm-lock.yaml", "utf8"), patterns);
  writeFileSync("pnpm-lock.yaml", reduced);
  writeFileSync("pnpm-workspace.yaml", reduceWorkspace(readFileSync("pnpm-workspace.yaml", "utf8"), importerKeys(reduced)));
  console.log(`prod-lockfile: kept ${patterns.join(" ")}`);
}
