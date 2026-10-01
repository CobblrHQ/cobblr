#!/usr/bin/env tsx
// A workspace write route in the kernel names who may make it: a role or capability check in its handler, or a ROLE: line saying why any member may.
//
// THE BUG THIS PREVENTS. Where an action applies (registered-actions predicate PUT/DELETE) could be changed by any member of a workspace, 2026-09-29
//
// THE RULE. Every POST, PUT, PATCH or DELETE under api/src/routes that runs
// withTenant (so acts on one workspace) has, in its handler, a check of who
// is asking: requireRole, requireAdmin, requireEditor, requireCapability,
// adminOnly, assertAdmin, canWrite, roleSatisfies, or a comparison of the
// caller's role. A route whose check lives elsewhere, or that any member may
// use, says so as the first line of its handler: `// ROLE: any member
// (<why>)` or `// ROLE: owner, checked by <function>`. Inside the handler, not
// above the call, where the AI-REACH line belongs. A guest never
// reaches a write the guest list does not name (withTenant refuses it), so
// "any member" is the whole meaning of a route without a check.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Kernel routes only. Module
// routers mostly gate at the router (`router.use(requireWriter)`), so a
// per-handler reading of modules/ flagged sixty routes that are guarded; the
// kernel gates per handler, and there the reading is exact. Routes without
// withTenant (sign-in, /me, webhooks with their own secret) are a person's
// own or a machine's and have no workspace role to check. A route that owns
// its caller's record (`req.session!.id` in a where clause) is still named:
// ownership is a reason to write in the ROLE: line, not a role check.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-workspace-writes-name-who.ts   (pnpm lint workspace-writes-name-who)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/routes"];

/** One offending place. `line` is 1-based for a clickable path:line. */
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
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

// Every route call bounds a handler, GETs included, so a write's span never
// runs on into the next route's middleware.
const CALL = /\b\w+\.(get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+)["'`]/g;
const GUARD = /\b(requireRole|requireAdmin|requireOwnerOrAdmin|requireEditor|requireCapability|adminOnly|assertAdmin|isAdmin|canWrite|roleSatisfies)\(|\.role\s*[!=]==|\/\/ ROLE: /;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const calls = [...src.matchAll(CALL)];
  calls.forEach((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < calls.length ? (calls[i + 1]!.index ?? src.length) : src.length;
    const body = src.slice(start, end);
    if (m[1] === "get" || m[1] === "use") return;
    // withTenant among the route's own middleware, before its handler starts.
    const handlerAt = body.search(/\basync\b|\(\s*req\b|=>/);
    if (!/\bwithTenant\b/.test(handlerAt < 0 ? body : body.slice(0, handlerAt))) return;
    // The two lines above the call may carry the ROLE: line with its reason.
    const before = src.slice(0, start).split("\n").slice(-3).join("\n");
    if (GUARD.test(body) || /\/\/ ROLE: /.test(before)) return;
    out.push({ file, line: src.slice(0, start).split("\n").length, what: `${m[1]!.toUpperCase()} ${m[2]} names nobody: add a role check, or a "// ROLE: any member (<why>)" line` });
  });
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workspace-writes-name-who - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:workspace-writes-name-who OK`);
