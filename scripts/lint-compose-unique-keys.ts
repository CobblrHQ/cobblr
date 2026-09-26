#!/usr/bin/env tsx
// A compose file never defines the same key twice in one mapping, because docker compose refuses the whole file.
//
// THE BUG THIS PREVENTS. 9e8bcbee1 (2026-09-20) re-added GOOGLE_OAUTH_CLIENT_ID/SECRET to docker-compose.yml's api environment; every docker compose command on the file failed to parse, unseen until server-setup's satellite check rendered it (2026-09-26, #3734)
//
// THE RULE. In every tracked compose file (docker-compose*.yml / compose*.yaml),
// a key appears at most once in the mapping that holds it: two `FOO:` lines under
// one `environment:`, or two `api:` services, fail. YAML parsers disagree about
// duplicates (some keep the last silently), but docker compose refuses the file
// outright, so the stack cannot start, update or even print its config. There is
// no opt-out: a duplicate is never intended.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The same key in two DIFFERENT
// mappings is fine and common: `environment.PGHOST` under both `api` and `backup`,
// or `image:` under every service. Scope is the mapping (indent + parent), and a
// `- ` list item opens a fresh mapping, so two services' `- key:` items never
// collide. Lines inside a `|` / `>` block scalar are script text, not keys.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-compose-unique-keys.ts   (pnpm lint compose-unique-keys)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Where the rule bites: compose files anywhere in the repo, and nothing else. */
const ROOTS = ["."];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** Every tracked compose file (git ls-files), so an untracked scratch copy never fails CI. */
function composeFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return out.split("\n").filter((f) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(f) && ROOTS.some((r) => r === "." || f.startsWith(r)));
}

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  // Open mappings, innermost last: the indent their keys sit at, and the keys seen.
  const stack: { indent: number; keys: Map<string, number> }[] = [];
  let scalarIndent = -1;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (scalarIndent >= 0) {
      if (body === "" || indent > scalarIndent) continue;
      scalarIndent = -1;
    }
    if (body === "" || body.startsWith("#") || body === "---") continue;
    let keyIndent = indent;
    let rest = body;
    if (rest.startsWith("- ") || rest === "-") {
      // a list item: whatever mapping follows the dash is a NEW one
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
      rest = rest.slice(1).trimStart();
      keyIndent = indent + (body.length - rest.length);
      stack.push({ indent: keyIndent, keys: new Map() });
    }
    const m = rest.match(/^("[^"]*"|'[^']*'|[^\s:#][^:#]*?)\s*:(\s|$)/);
    if (!m) {
      if (/[|>][-+0-9]*\s*$/.test(rest)) scalarIndent = indent;
      continue;
    }
    const key = m[1]!.replace(/^["']|["']$/g, "");
    while (stack.length && stack[stack.length - 1]!.indent > keyIndent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.indent < keyIndent) {
      top = { indent: keyIndent, keys: new Map() };
      stack.push(top);
    }
    const first = top.keys.get(key);
    if (first !== undefined) out.push({ file, line: i + 1, what: `"${key}" is already defined at line ${first} in the same mapping` });
    else top.keys.set(key, i + 1);
    if (/:\s*[|>][-+0-9]*\s*(#.*)?$/.test(rest)) scalarIndent = keyIndent;
  }
  return out;
}

const violations: Violation[] = [];
for (const file of composeFiles()) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:compose-unique-keys - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("delete the second definition (keep the one grouped with its siblings)");
  process.exit(1);
}
console.log(`lint:compose-unique-keys OK`);
