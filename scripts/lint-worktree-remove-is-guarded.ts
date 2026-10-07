#!/usr/bin/env tsx
// Every worktree removal and metadata prune checks live process working directories first.
// Shell command sites use the shared guard. Triage's quoted command examples
// are reports, so they are outside this boundary.
import { repoFiles } from "./lib/repo-files.ts";
import { readFileSync } from "node:fs";

const files = repoFiles(["scripts/*.sh", "scripts/**/*.sh"]);
const bad: string[] = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:#|echo\b|printf\b|['"])/.test(line)) continue;
    if (/(?:^\s*(?:(?:elif|if|then)\s+)?|\$\(\s*|;\s*|\|\|\s*|&&\s*)git\b[^\n]*\bworktree\s+(?:remove|prune)\b/.test(line)) bad.push(`${file}:${index + 1}: use lib/worktree-process-guard.mjs`);
  }
}
if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
console.log("lint:worktree-remove-is-guarded OK");
