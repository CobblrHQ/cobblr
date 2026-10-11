#!/usr/bin/env tsx
// Every ai.invoke call says what happens when no AI answers: the heuristic it falls back to, or what the person does by hand.
//
// THE BUG THIS PREVENTS. "Heuristic first, AI last" was a convention: when no provider is connected (or the
// plan's limit, or a refusal) `platform().ai.invoke` throws, and each of 29 call sites handled that its own
// way, or did not, with nothing to say which. A feature written against a connected workspace shipped with
// no answer for the workspaces without one, and nobody could list which calls had a no-AI path (#5761).
//
// THE RULE. The object passed to `.ai.invoke({...})` carries `noAi:`, either `{ heuristic: "<the
// deterministic answer it falls back to>" }` or `{ byHand: "<what the person is told to do instead>" }`
// (the contract's type, packages/platform-contract). The call sites that predate the rule are counted per
// file in scripts/ai-invoke-no-ai-baseline.json: a file may not have more undeclared calls than it had,
// so every new call declares, and an old one leaves the count when its owner adds the declaration.
//
// THE BOUNDARY. Only `.ai.invoke(` with an object literal, the shape every caller uses; a call through a
// variable is not seen, as lint:ai-invoke's userId check does not see it either. Tests are not scanned.
//
// PROVED RED with a new undeclared call in a scanned file (lint-ai-invoke-no-ai.test.ts).
//
//   npx tsx scripts/lint-ai-invoke-no-ai.ts                    (pnpm lint ai-invoke-no-ai)
//   npx tsx scripts/lint-ai-invoke-no-ai.ts --write-baseline   lower the counts after declaring old calls
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.COBBLR_LINT_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["modules", "api/src", "cloud/src"];
const BASELINE = join(ROOT, "scripts", "ai-invoke-no-ai-baseline.json");

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "tests") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The object literal opening at `open`, through its matching brace, with every string's contents
 *  blanked: a key named inside a string is not the call's own. */
function literal(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  let out = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") {
        quote = null;
        out += c;
      } else out += " ";
      continue;
    }
    out += c;
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return out;
  }
  return out;
}

/** The lines of `src`'s `.ai.invoke({...})` calls that declare no `noAi`. */
export function undeclaredCalls(src: string): number[] {
  const out: number[] = [];
  const call = /\.ai\.invoke\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src)) !== null) {
    const open = src.indexOf("{", m.index);
    if (!/\bnoAi\s*[:,}]/.test(literal(src, open))) out.push(src.slice(0, m.index).split("\n").length);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("lint-ai-invoke-no-ai.ts")) {
  const now: Record<string, number[]> = {};
  for (const dir of SCAN) for (const file of walk(join(ROOT, dir))) {
    const lines = undeclaredCalls(readFileSync(file, "utf8"));
    if (lines.length) now[relative(ROOT, file).split("\\").join("/")] = lines;
  }
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(now).sort().map(([f, l]) => [f, l.length])), null, 2)}\n`);
    console.log(`lint:ai-invoke-no-ai: baseline written (${Object.values(now).flat().length} undeclared call(s) in ${Object.keys(now).length} file(s))`);
    process.exit(0);
  }
  let baseline: Record<string, number> = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {}
  const over = Object.entries(now).filter(([f, l]) => l.length > (baseline[f] ?? 0));
  const lower = Object.entries(baseline).filter(([f, n]) => (now[f]?.length ?? 0) < n).map(([f]) => f);
  if (over.length) {
    console.error(`lint:ai-invoke-no-ai - ${over.length} file(s) gained an ai.invoke with no no-AI path:`);
    for (const [f, l] of over) console.error(`  ${f}:${l.join(",")}  ${l.length} undeclared, ${baseline[f] ?? 0} allowed`);
    console.error(`Say what happens when no AI answers, in the call: noAi: { heuristic: "<the deterministic answer>" } or noAi: { byHand: "<what the person does>" }.`);
    process.exit(1);
  }
  if (lower.length) console.log(`lint:ai-invoke-no-ai: ${lower.length} file(s) now declare more than the baseline counts; lower it: npx tsx scripts/lint-ai-invoke-no-ai.ts --write-baseline`);
  console.log(`lint:ai-invoke-no-ai OK (${Object.values(now).flat().length} undeclared call(s), all from before the rule)`);
}
