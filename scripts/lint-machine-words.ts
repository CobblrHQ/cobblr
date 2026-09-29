#!/usr/bin/env tsx
// A machine surface that must stay kind-neutral takes its words about the work from machine-words.ts, never a literal print.
//
// THE BUG THIS PREVENTS. Digital Fabrication's job model fits any machine,
// but its words were written for 3D printers: a laser cutter's own page
// offered to "send prints to this laser cutter", headed its panel "Print
// manager" and asked "What kind of printer is this?" (owner feedback,
// 2026-09-28). The words now come from `web/src/lib/machine-words.ts`, keyed by
// the machine's kind. This lint keeps the next string on those surfaces from
// quietly saying "print" again.
//
// THE RULE. Inside each function listed in SURFACES, no string literal,
// template text or JSX text may contain a word starting with "print". Take it
// from `MachineWords` (`words.jobs`, `words.Manager`, `words.device`, …). A
// genuine exception (a string that really is about printers on a surface
// every kind sees) carries `// print-ok: <reason>` on its line. A surface
// that can no longer be found fails too, so a rename cannot turn the lint
// into a silent pass.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The rule is scoped to named
// functions, not to files. MachinesPage.tsx also prints LABELS ("Print
// labels"), and fleet.tsx holds the 3D-printer cockpit (temperatures,
// filament, a Bambu camera), where "print" is the right word. Both are in the
// same files as kind-neutral surfaces, so a file-wide rule would either flag
// correct text or need an annotation on every line of it. Identifiers
// (`<Printer />`, `PrinterDetailModal`), a MachineKind id compared in code
// (`words.kind === "3d-printer"`, which drew the KIND_ID skip) and comments
// are not text a person reads, so they are not checked.
//
//   npx tsx scripts/lint-machine-words.ts   (pnpm lint machine-words)
import { readFileSync } from "node:fs";

/** The kind-neutral surfaces: a file and the function names inside it. */
const SURFACES: { file: string; fns: string[] }[] = [
  { file: "web/src/features/digifab/fleet.tsx", fns: ["MachineDigifabPanel", "MachineCockpitPanel"] },
  { file: "web/src/pages/MachinesPage.tsx", fns: ["EnableJobManagerCard"] },
  { file: "web/src/lib/featured-bundles.ts", fns: ["connectMachinesFeature", "machineBundleChangelog"] },
];

const PRINT = /\bprint/i;

/** A MachineKind id (`"3d-printer"`) is an identifier compared in code, not
 *  words on screen. */
const KIND_ID = /^(3d-printer|laser|cnc|generic)$/;

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The [start, end) offsets of `function name(...) ... { body }`, or null. */
export function functionSpan(src: string, name: string): [number, number] | null {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) break;
  }
  const open = src.indexOf("{", i);
  if (open < 0) return null;
  depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return [m.index, j + 1];
  }
  return null;
}

/** The human-readable text on one line: string literals, template text (with
 *  its `${…}` holes removed) and JSX text between tags. */
export function textOn(line: string): string[] {
  const code = line.replace(/\/\/.*$/, "");
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " "));
  }
  for (const m of code.matchAll(/>([^<>{}=]+)</g)) out.push(m[1] ?? "");
  const trimmed = code.trim();
  // A line of bare JSX text (a paragraph that wraps onto its own line).
  if (trimmed && !/[<>{}=;()"'`]/.test(trimmed) && !/^(\*|\/\*)/.test(trimmed)) out.push(trimmed);
  return out;
}

export function check(file: string, src: string, fns: string[]): Violation[] {
  const out: Violation[] = [];
  for (const fn of fns) {
    const span = functionSpan(src, fn);
    if (!span) {
      out.push({ file, line: 1, what: `kind-neutral surface ${fn}() not found (renamed? update SURFACES)` });
      continue;
    }
    const startLine = src.slice(0, span[0]).split("\n").length;
    const body = src.slice(span[0], span[1]).split("\n");
    let inBlockComment = false;
    body.forEach((line, k) => {
      const t = line.trim();
      if (inBlockComment) {
        if (t.includes("*/")) inBlockComment = false;
        return;
      }
      if (t.startsWith("/*") || t.startsWith("{/*")) {
        if (!t.includes("*/")) inBlockComment = true;
        return;
      }
      if (t.startsWith("*") || t.startsWith("//")) return;
      if (/\/\/ print-ok: \S/.test(line)) return;
      const hit = textOn(line).find((s) => PRINT.test(s) && !KIND_ID.test(s));
      if (hit) out.push({ file, line: startLine + k, what: `${fn}(): "${hit.trim()}" says print; take the word from machine-words.ts` });
    });
  }
  return out;
}

if (process.argv[1]?.endsWith("lint-machine-words.ts")) {
  const violations: Violation[] = [];
  for (const s of SURFACES) violations.push(...check(s.file, readFileSync(s.file, "utf8"), s.fns));

  if (violations.length) {
    console.error(`lint:machine-words - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error('Take the word from web/src/lib/machine-words.ts; a genuine exception carries "// print-ok: <reason>".');
    process.exit(1);
  }
  console.log(`lint:machine-words OK (${SURFACES.reduce((n, s) => n + s.fns.length, 0)} surfaces)`);
}
