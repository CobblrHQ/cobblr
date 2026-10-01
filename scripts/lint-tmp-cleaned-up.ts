#!/usr/bin/env tsx
// A temporary file or directory a script makes is removed on every exit, or says why it is kept.
//
// THE BUG THIS PREVENTS. 2026-09-30: the runner host's /tmp (a tmpfs shared by
// every session and the CI jobs on it) ran out of INODES, 1,048,575 of
// 1,048,576, with 34 GB of space free, and every session's shell died with
// ENOSPC. What held them was ours: temp directories our scripts and tests
// made and never removed, days of them (lint-* 186k inodes, merge-pr* 123k,
// triage-says-* 74k, core-sync-* 47k).
//
// THE RULE.
//   Shell (scripts/, deploy/, docker/): every `mktemp` is assigned to a
//   variable (`X="$(mktemp …)"`), and a `trap … EXIT` in the same file removes
//   that variable (`rm -rf "$X"` or `rm -f "$X"`, directly or through a
//   function the trap calls). An anonymous `$(mktemp)` inside a larger
//   expression can never be removed and is refused.
//   JS/TS (scripts/, api/src, modules/*/src, packages/*/src, e2e/): a file
//   that calls mkdtemp/mkdtempSync removes something (rmSync / rm(…)) in the
//   same file. Vitest test files are exempt: the shared setup gives each test
//   file its own TMPDIR and removes it (scripts/lib/test-tmpdir.mjs), which
//   covers every test, the ones that forget included. A plain tsx assert
//   script gets no setup, so it is judged like any script.
//   A temp made to outlive its script on purpose (a log kept for diagnosis)
//   carries `# tmp-kept: <why>` (or `// tmp-kept: <why>`) on its line.
//
// THE BOUNDARY. The shell check is per variable and per file, not per code
// path: a trap that removes X is taken to cover every mktemp assigned to X.
// It does not prove every exit path runs the trap (a `kill -9` never does);
// the daily sweep of our own prefixes (server-setup's tmp-sweep) is the
// backstop for what no trap can catch.
//
//   npx tsx scripts/lint-tmp-cleaned-up.ts   (pnpm lint tmp-cleaned-up)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const KEPT = /tmp-kept:\s*\S/;

function checkShell(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  // Everything an EXIT trap removes, following one level of function call.
  const traps = lines.filter((l) => /\btrap\b.*\bEXIT\b/.test(l));
  const fnBodies = new Map<string, string>();
  for (const m of src.matchAll(/^\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{([\s\S]*?)^\s*\}/gm)) fnBodies.set(m[1]!, m[2]!);
  let removed = traps.join("\n");
  for (const t of traps) for (const [name, body] of fnBodies) if (new RegExp(`\\b${name}\\b`).test(t)) removed += "\n" + body;
  lines.forEach((line, i) => {
    if (!/\bmktemp\b/.test(line) || /^\s*#/.test(line) || KEPT.test(line)) return;
    // `X="$(mktemp)"`, or a temp made on another host and named here:
    // `X="$(ssh "$HOST" 'mktemp -d')"`, which a trap removes over ssh.
    const assigned = /(?:^|[\s;])(?:local\s+)?([A-Za-z_]\w*)=[^=]*\$\([^)]*\bmktemp\b/.exec(line);
    if (!assigned) {
      out.push({ file, line: i + 1, what: "an anonymous $(mktemp) no trap can remove: assign it to a variable the EXIT trap removes" });
      return;
    }
    const v = assigned[1]!;
    const re = new RegExp(`\\brm\\b[^\\n]*\\$\\{?${v}\\b`);
    // Or it joins an array the trap removes: X="$(mktemp)"; TMPS+=("$X") with rm -rf "${TMPS[@]}".
    const arrays = [...src.matchAll(new RegExp(`([A-Za-z_]\\w*)\\+=\\(\\s*"?\\$\\{?${v}\\}?"?\\s*\\)`, "g"))].map((m) => m[1]!);
    const viaArray = arrays.some((a) => new RegExp(`\\brm\\b[^\\n]*\\$\\{${a}\\[@\\]\\}`).test(removed));
    // Or it is spent where it was made (that line or the next), both ways
    // out named: the atomic write `… > "$t" && mv "$t" "$dest" || rm -f "$t"`.
    const here = `${line}\n${lines[i + 1] ?? ""}`;
    const spentHere = new RegExp(`\\bmv\\b[^\\n]*\\$\\{?${v}\\b`).test(here) && re.test(here);
    if (!re.test(removed) && !viaArray && !spentHere) out.push({ file, line: i + 1, what: `$${v} is a mktemp no \`trap … EXIT\` in this file removes` });
  });
  return out;
}

function checkJs(file: string, src: string): Violation[] {
  if (/from\s+["']vitest["']/.test(src)) return []; // the shared setup scopes TMPDIR per test file
  const out: Violation[] = [];
  const removes = /\brmSync\s*\(|\brm\s*\(|\.rm\s*\(|rimraf/.test(src);
  src.split("\n").forEach((line, i) => {
    if (!/\bmkdtemp(Sync)?\s*\(/.test(line) || KEPT.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
    if (!removes) out.push({ file, line: i + 1, what: "a mkdtemp with no rmSync/rm in this file: remove it in a finally, or say // tmp-kept: <why>" });
  });
  return out;
}

const violations: Violation[] = [];
for (const file of repoFiles(["scripts/*.sh", "scripts/**/*.sh", "deploy/*.sh", "deploy/**/*.sh", "docker/*.sh", "scripts/git-hooks/*"])) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (file.includes("/git-hooks/") && !src.startsWith("#!")) continue;
  violations.push(...checkShell(file, src));
}
for (const file of repoFiles(["scripts/*.ts", "scripts/**/*.ts", "scripts/*.mjs", "scripts/**/*.mjs", "api/src/**/*.ts", "modules/*/src/**/*.ts", "packages/*/src/**/*.ts", "e2e/*.mjs", "e2e/**/*.mjs"])) {
  if (file === "scripts/lint-tmp-cleaned-up.ts") continue;
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!/mkdtemp/.test(src)) continue;
  violations.push(...checkJs(file, src));
}

if (violations.length) {
  console.error(`lint:tmp-cleaned-up - ${violations.length} temp(s) nothing removes:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Shell: X=\"$(mktemp …)\" and trap 'rm -rf \"$X\"' EXIT. JS: try { … } finally { rmSync(dir, { recursive: true, force: true }) }. Kept on purpose: tmp-kept: <why>.");
  process.exit(1);
}
console.log("lint:tmp-cleaned-up OK");
