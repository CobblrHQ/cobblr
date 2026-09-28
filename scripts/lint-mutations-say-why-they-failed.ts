#!/usr/bin/env tsx
// A useMutation on a page shows why it failed, in words, beside the control.
//
// THE BUG THIS PREVENTS. A member of a club workspace pressed -1 on a stock
// stepper. The server refused ("missing capability"), the mutation went into
// its error state, and the page showed nothing: the number stayed put and no
// sentence said why. The server had written the reason; the surface dropped
// it (2026-09-28, a club walk on the rig).
//
// THE RULE. In any .tsx under web/src, packages/platform-web/src or a module's
// src/ui, each `const x = useMutation(` must do one of:
//   - handle its failure: an `onError` in its options;
//   - show it: read `x.isError`, `x.error` or `x.failureReason`, or hand the
//     mutation to a component (`mutation={x}`, e.g. <MutationError>);
//   - let the caller handle it: call `x.mutateAsync(` (the caller awaits and
//     catches).
// A mutation with a genuine reason to stay quiet says so on its line:
// `// MUTATION-ERROR: <reason>`.
//
// PROVEN RED on QtyStepper.tsx without its <MutationError mutation={adjust}>;
// 58 mutations across the app failed it when it landed, and all 58 were fixed.
//
//   npx tsx scripts/lint-mutations-say-why-they-failed.ts   (pnpm lint mutations-say-why-they-failed)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

interface Violation {
  file: string;
  line: number;
  name: string;
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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && (!p.startsWith("modules") || /\/src\/ui(\/|$)/.test(p))) yield p;
  }
}

/** The text of the call starting at `from` (an opening paren), through its matching close. */
function callText(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useMutation\s*(?:<[^()]*?>)?\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[1]!;
    const lineNo = src.slice(0, m.index).split("\n").length;
    const lineText = src.split("\n")[lineNo - 1] ?? "";
    if (/\/\/ MUTATION-ERROR: \S/.test(lineText)) continue;
    const call = callText(src, m.index + m[0].length - 1);
    if (/\bonError\b/.test(call)) continue;
    const n = esc(name);
    if (new RegExp(`\\b${n}\\.(isError|error|failureReason)\\b`).test(src)) continue;
    if (new RegExp(`mutation=\\{\\s*${n}\\s*\\}`).test(src)) continue;
    if (new RegExp(`\\b${n}\\.mutateAsync\\s*\\(`).test(src)) continue;
    out.push({ file, line: lineNo, name });
  }
  return out;
}

const found: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) found.push(...check(file, readFileSync(file, "utf8")));

if (found.length) {
  console.error(`lint:mutations-say-why-they-failed - ${found.length} mutation(s) swallow their error:`);
  for (const v of found)
    console.error(
      `  ${v.file}:${v.line}  ${v.name}: a refused write says nothing on the page. Mount <MutationError mutation={${v.name}} /> beside the control (@cobblr/platform-web), add onError, or say why not: // MUTATION-ERROR: <reason>`,
    );
  process.exit(1);
}
console.log("lint:mutations-say-why-they-failed OK");
