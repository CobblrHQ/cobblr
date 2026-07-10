#!/usr/bin/env tsx
// Consume-once URL-param lint. A deep-link search param that OPENS a modal or
// ARMS a mode (?organize=pending, ?livesort=1, ?sort=1) is copied into `useState`
// on mount. If it is never stripped from the URL it persists: closing the modal
// leaves the param behind, and every refresh re-seeds the state and re-opens /
// re-arms it against the user's wish. That's the 2026-07-10 "scan?organize=pending
// keeps reopening" bug, which had also spread to ScanCameraPage's ?sort=1.
//
// The rule: if a `useState(...)` initializer derives a flag from a search param
// compared to a literal (`.get("KEY") === "literal"`), the file MUST consume that
// param — an explicit `.delete("KEY")` on a URLSearchParams. A param forked into
// useState but never deleted is the leak.
//
// Why the `=== "literal"` shape (not any `.get`): that is the tell for a one-shot
// TRIGGER flag. Genuinely-persistent, shareable URL state (a tab, a filter, a
// "show all" view) should be DERIVED from the param each render as the source of
// truth (e.g. `const showAll = params.get("all") === "1"` at the top level), never
// forked into useState — so it is not matched here, and correctly not flagged.
//
//   cd <repo> && npx tsx scripts/lint-consume-once-params.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "modules"];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// Extract the argument text of every `useState(` call, matching balanced parens
// so a multi-line arrow initializer is captured whole.
function useStateInitializers(src: string): string[] {
  const spans: string[] = [];
  const NEEDLE = "useState(";
  let from = 0;
  for (;;) {
    const start = src.indexOf(NEEDLE, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + NEEDLE.length - 1; // at the '('
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    spans.push(src.slice(start + NEEDLE.length, i));
    from = i + 1;
  }
  return spans;
}

// A search param compared to a string literal (a trigger flag): params.get("x")
// === "1" — regardless of whether the receiver is a useSearchParams var or a
// `new URLSearchParams(...)`.
const PARAM_FLAG = /\.get\(\s*['"]([\w-]+)['"]\s*\)\s*[=!]==\s*['"]/g;

function consumesParam(src: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.delete\\(\\s*['"]${esc}['"]`).test(src);
}

const findings: string[] = [];
for (const root of ROOTS) {
  for (const file of tsxFiles(root)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(".get(")) continue;
    const seen = new Set<string>();
    for (const span of useStateInitializers(src)) {
      let m: RegExpExecArray | null;
      PARAM_FLAG.lastIndex = 0;
      while ((m = PARAM_FLAG.exec(span))) {
        const key = m[1]!;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!consumesParam(src, key)) {
          findings.push(`  ${file}  seeds useState from ?${key} but never .delete("${key}")`);
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`✗ consume-once-params lint: ${findings.length} deep-link param(s) forked into useState but never consumed.\n`);
  console.error(findings.join("\n"));
  console.error(`\nA ?param that opens a modal / arms a mode must be stripped after it seeds state, or it
persists in the URL and every refresh reopens it against the user (scan?organize=pending, 2026-07-10).
Fix: on mount, delete it — const [params, setParams] = useSearchParams(); … next.delete("KEY");
setParams(next, { replace: true }). Genuinely-persistent URL state should be DERIVED from the param
each render (source of truth), not forked into useState.`);
  process.exit(1);
}
console.log("✓ consume-once-params lint: every deep-link param forked into useState is consumed.");
