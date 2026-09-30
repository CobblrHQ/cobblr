#!/usr/bin/env tsx
// A test reads only the workspaces it made, never one it takes from the orgs table, so another test deleting that workspace mid-run cannot fail it.
//
// THE BUG THIS PREVENTS. The quiet-bridge test took the first row of orgs;
// another file in the same run deleted that workspace, and it failed three
// assertions on unrelated PRs (#4331, 2026-09-30). The owner it looked for was
// gone, and a send to the workspace's bridge read as a person's.
//
// THE RULE. In api/tests, a query on `orgs` whose ROW the test keeps (the
// result is bound: `const org = await …`, `const [x] = await …`) must pick the
// workspace by the id or slug the test itself made (`.where("id", …)`,
// `.where("slug", …)`). Taking any row (`.limit(1)`, a filter on a property
// many workspaces share) borrows somebody else's workspace, and another file
// is free to delete it. A genuine exception says why:
//   // BORROWS-ORG: <why no test can delete it>
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The same query is written
// in eleven files as a liveness probe (`await meta.selectFrom("orgs")…
// .limit(1).execute()` with nothing kept, or `.then(() => true)`): it asks
// whether the database is up and uses no row. Those pass. The waiting-sandbox
// read in no-wire-fires-in-a-sandbox is the one annotated exception: the api
// builds those ahead of a visitor and no test makes or deletes one.
//
//   npx tsx scripts/lint-tests-own-their-workspaces.ts   (pnpm lint tests-own-their-workspaces)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/tests"];

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Every statement that reads `orgs` and keeps a row it did not pick by its
 *  own id or slug. Statements split on `;`, which test code ends each with. */
function borrowedWorkspaces(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  let at = 0;
  for (const stmt of src.split(";")) {
    const start = at;
    at += stmt.length + 1;
    const i = stmt.indexOf('selectFrom("orgs")');
    if (i < 0) continue;
    const kept = /\b(const|let|var)\s+[\w[\]{},\s]+=\s*await\b/.test(stmt) || /^\s*\w+\s*=\s*await\b/m.test(stmt);
    if (!kept) continue;
    if (/\.then\(\s*\(\)\s*=>\s*true/.test(stmt)) continue;
    if (/\.where\(\s*(["'`])(id|slug)\1/.test(stmt) || /\.where\(\s*sql[^)]*\bid\b/.test(stmt)) continue;
    const before = src.slice(0, start + i);
    const line = before.split("\n").length;
    const lines = src.split("\n");
    const window = lines.slice(Math.max(0, line - 1 - stmt.split("\n").length), line).join("\n");
    if (/\/\/\s*BORROWS-ORG:\s*\S/.test(window) || /\/\/\s*BORROWS-ORG:\s*\S/.test(stmt)) continue;
    out.push({ file, line, what: "keeps a workspace it took from the orgs table instead of one it made" });
  }
  return out;
}

{
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) violations.push(...borrowedWorkspaces(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:tests-own-their-workspaces - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Sign up your own workspace (signupFreshOrg) or select by the id or slug you made; a genuine exception says // BORROWS-ORG: <why> on or above the line.");
    process.exit(1);
  }
  console.log("lint:tests-own-their-workspaces OK");
}
