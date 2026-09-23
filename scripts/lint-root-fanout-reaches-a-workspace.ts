#!/usr/bin/env tsx
// A root script that fans out with pnpm -r run --if-present reaches at least one workspace that defines it, so it cannot pass while running nothing.
//
// THE BUG THIS PREVENTS. `pnpm typecheck:fast` sat in the root package.json
// from the npm-to-pnpm migration onwards, and no workspace defined
// `typecheck:fast`. `--if-present` skips a workspace without the script, so
// the command exited 0 having checked nothing at all: a fast typecheck that
// was green because there was nothing in it (#225, 2026-09-22). Anybody who
// ran it before a push was told the tree typechecked.
//
// THE RULE. For every root script whose command is a recursive pnpm run with
// `--if-present <name>`, at least one workspace package (the globs in
// pnpm-workspace.yaml) must define `<name>`. `--if-present` is right for the
// workspaces that genuinely have nothing to do; it is wrong for all of them at
// once. A fan-out that should reach nobody should not exist.
//
// Proven red on the tree before #225 (typecheck:fast, 0 workspaces).
//
//   npx tsx scripts/lint-root-fanout-reaches-a-workspace.ts   (pnpm run lint:root-fanout-reaches-a-workspace)
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

/** The workspace globs, read from pnpm-workspace.yaml (`- "dir/*"` or `- dir`). */
function workspaceDirs(): string[] {
  const yaml = readFileSync("pnpm-workspace.yaml", "utf8");
  const block = yaml.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
  const globs = [...block.matchAll(/^\s*-\s*["']?([^"'\n#]+?)["']?\s*$/gm)].map((m) => m[1]!.trim());
  const dirs: string[] = [];
  for (const g of globs) {
    if (g.startsWith("!")) continue;
    if (g.endsWith("/*")) {
      const base = g.slice(0, -2);
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base)) {
        const p = join(base, d);
        if (statSync(p).isDirectory() && existsSync(join(p, "package.json"))) dirs.push(p);
      }
    } else if (existsSync(join(g, "package.json"))) dirs.push(g);
  }
  return dirs;
}

const defined = new Map<string, string[]>();
for (const d of workspaceDirs()) {
  const scripts = (JSON.parse(readFileSync(join(d, "package.json"), "utf8")).scripts ?? {}) as Record<string, string>;
  for (const k of Object.keys(scripts)) defined.set(k, [...(defined.get(k) ?? []), d]);
}

const problems: string[] = [];
let fanouts = 0;
for (const [name, cmd] of Object.entries(root.scripts ?? {})) {
  // pnpm -r ... run --if-present <target>   (flags may sit either side of `run`)
  for (const m of cmd.matchAll(/pnpm\s+(?:-r|--recursive)\b[^&|;]*?\brun\b[^&|;]*?--if-present\s+([\w:.-]+)|pnpm\s+(?:-r|--recursive)\b[^&|;]*?--if-present\b[^&|;]*?\brun\s+([\w:.-]+)/g)) {
    const target = m[1] ?? m[2]!;
    fanouts++;
    if (!(defined.get(target)?.length)) problems.push(`root "${name}" fans out "${target}", and no workspace defines "${target}": it passes having run nothing`);
  }
}

if (fanouts === 0) {
  console.error("lint:root-fanout-reaches-a-workspace - found no fan-out scripts at all; the pattern above has stopped matching the root package.json");
  process.exit(1);
}
if (problems.length) {
  console.error(`lint:root-fanout-reaches-a-workspace - ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("Define the script in the workspaces it is for, or remove the root fan-out.");
  process.exit(1);
}
console.log(`lint:root-fanout-reaches-a-workspace OK - ${fanouts} fan-out(s), each reaches a workspace`);
