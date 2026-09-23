#!/usr/bin/env tsx
// A walk that moves to another workspace after naming one names it again before its next W() navigation, or W() keeps sending it to the workspace it left.
//
// THE BUG THIS PREVENTS. W() (e2e/prod-look.mjs) builds `/w/<slug>/…` from
// the workspace useWorkspace() last named. That is module state, so it goes
// on pointing wherever it was pointed. assorted-contents named its home
// workspace, then made a second one and switched `slug` to it, then
// navigated with W(): the form filled in the HOME workspace, and the walk
// failed "record not created" while the same walk with bare URLs passed
// 17/17. move-between-instances had the identical shape and passed only
// because it happened to call the login helper with explicit creds (#3422).
//
// THE RULE. In e2e/, when a file calls useWorkspace(<web>, <v>) and later
// assigns <v> again, the next W( after that assignment must be preceded by
// another useWorkspace( call. Line-level and conservative: it catches the
// shape that shipped, not every way to be confused.
//
// PROVED RED 2026-09-22 against assorted-contents and move-between-instances
// as first converted; green once each named its workspace right before the
// first W() navigation.
//
//   npx tsx scripts/lint-w-follows-the-workspace.ts   (pnpm run lint:w-follows-the-workspace)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "e2e";
const violations: { file: string; line: number; text: string }[] = [];

// `.git` skipped by name: a fetch writes <branch>.lock into it mid-walk.
for (const name of readdirSync(ROOT).filter((n) => n !== ".git" && /\.(mjs|js)$/.test(n))) {
  const file = join(ROOT, name);
  const lines = readFileSync(file, "utf8").split("\n");
  // variables named to useWorkspace, and where
  const named: { v: string; at: number }[] = [];
  lines.forEach((l, i) => {
    const m = /useWorkspace\(\s*\w+\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(l);
    if (m) named.push({ v: m[1]!, at: i });
  });
  for (const { v, at } of named) {
    const reassign = new RegExp(`(^|[^.\\w$])${v.replace(/\$/g, "\\$")}\\s*=(?!=)`);
    for (let b = at + 1; b < lines.length; b++) {
      const lb = lines[b]!;
      if (/^\s*\/\//.test(lb) || !reassign.test(lb) || /\b(const|let|var)\s/.test(lb.split(v)[0] ?? "")) continue;
      // the next W( after this reassignment, and whether it is re-named first
      for (let c = b + 1; c < lines.length; c++) {
        const lc = lines[c]!;
        if (/useWorkspace\(/.test(lc)) break;
        if (/\bW\(/.test(lc)) {
          violations.push({ file, line: c + 1, text: `W() after \`${v}\` was reassigned on line ${b + 1}, with no useWorkspace() between` });
          break;
        }
      }
    }
  }
}

if (violations.length) {
  console.error(`lint:w-follows-the-workspace - ${violations.length} navigation(s) aimed at a workspace the walk has left:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error("Call useWorkspace(WEB, <slug>) again after the walk moves, before the next W().");
  process.exit(1);
}
console.log("lint:w-follows-the-workspace OK (every W() points at the workspace the walk is in)");
