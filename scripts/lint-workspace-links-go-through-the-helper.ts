#!/usr/bin/env tsx
// A router link or navigation never names a workspace: a Link, NavLink or Navigate to, or a navigate() argument, never starts with /w/, because the router is already inside /w/<slug>; a link into a workspace goes through WorkspaceLink or useWorkspaceTarget.
//
// THE BUG THIS PREVENTS. Your account's Change the order linked to /w/<slug>/configuration/ai inside the /w/<slug> router and landed on the dashboard; 13 more links did the same (#5403, 2026-10-08)
//
// THE RULE. Inside web/src and modules (tests aside), a JSX `to=` (Link,
// NavLink, Navigate, or any component that hands it to one) and a
// `navigate()` argument never start with "/w/", as a string or a template.
// The app's router runs under basename /w/<handle>, so such a target becomes
// /w/<handle>/w/<slug>/..., no route matches, and the catch-all lands on the
// dashboard. A link into this workspace is the path alone; a link into any
// workspace goes through WorkspaceLink / useWorkspaceTarget
// (@cobblr/platform-web), which is a router path for this workspace and a
// full-page href for another. A page mounted OUTSIDE the workspace router
// (a station tablet at /station/:slug) may name /w/ with
// `// workspace-link-ok: <why>` on the line or the one above, never a
// blanket exemption.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. `<a href="/w/...">` passes:
// a full-page load is exactly right for a workspace address, and the account
// deletion and quick-access links do that on purpose. Only router targets are
// judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-workspace-links-go-through-the-helper.ts   (pnpm lint workspace-links-go-through-the-helper)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules"];

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const target = /\bto=\{?\s*[`"']\/w\//.test(line) ? "a router link's to" : /\bnavigate\(\s*[`"']\/w\//.test(line) ? "a navigate() target" : null;
    if (!target) continue;
    if (/workspace-link-ok: \S/.test(line) || /workspace-link-ok: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: `${target} starts with /w/, inside a router already at /w/<slug>` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workspace-links-go-through-the-helper - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("use <WorkspaceLink slug={slug} to=\"/path\"> from @cobblr/platform-web, or the path alone when the link is to this workspace");
  process.exit(1);
}
console.log(`lint:workspace-links-go-through-the-helper OK`);
