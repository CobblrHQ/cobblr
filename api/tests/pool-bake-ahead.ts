// The org pool is baked nightly from main, and a branch is tested against
// that pool. A branch behind main then sees pooled workspaces carrying
// migrations its own tree has never heard of, and the parity test read that
// as "signup does not give it" (#5219 and #5209, 398 commits behind, sent
// someone to fix a signup path that was fine). A migration the pool applied
// whose file is not in this tree means the bake is ahead of the branch.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function sqlFilesUnder(dir: string, into: Set<string>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (n.endsWith(".sql")) into.add(n);
    else if (statSync(p).isDirectory()) sqlFilesUnder(p, into);
  }
}

/** Every migration file name this checkout carries: the api's and each module's. */
export function migrationFilesInThisTree(repo: string = REPO): Set<string> {
  const files = new Set<string>();
  sqlFilesUnder(join(repo, "api", "migrations"), files);
  let modules: string[] = [];
  try {
    modules = readdirSync(join(repo, "modules"));
  } catch {
    modules = [];
  }
  for (const m of modules) sqlFilesUnder(join(repo, "modules", m, "migrations"), files);
  return files;
}

/** The ledger rows (`<scope>::<file>`) whose file this tree does not have. */
export function migrationsThisTreeLacks(applied: readonly string[], files: ReadonlySet<string>): string[] {
  return applied.filter((name) => {
    const file = name.slice(name.lastIndexOf("::") + 2);
    return !files.has(file);
  });
}

export function bakeAheadMessage(lacking: readonly string[]): string {
  return (
    `This branch is behind the pool's bake (main): merge main.\n` +
    `The pooled workspace applied migrations this tree does not have, so every difference below is main's newer code, not a signup gap:\n  ` +
    lacking.join("\n  ")
  );
}
