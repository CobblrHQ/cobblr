#!/usr/bin/env tsx
/**
 * lint:workflow-yaml — no duplicate sibling keys in a workflow file.
 *
 * YAML lets a later key silently win over an earlier one with the same name.
 * Forgejo's runner does not: it decodes with duplicate detection ON and logs
 * `Failed to decode node ... mapping key "workflow_dispatch" already defined`,
 * once per poll, for every job it looks at.
 *
 * That is what happened on 2026-09-04: two agents added a `workflow_dispatch:`
 * trigger to ci.yml within hours of each other, both PRs were green (nothing
 * checked for it), and main ended up with the key twice. The file still
 * "parsed" for anything using a lenient loader, which is why it survived
 * review, CI and a lint suite of 214 scripts.
 *
 * A second pair of eyes does not catch this; the second author is usually not
 * looking at the trigger block at all. A parser is the only thing that does.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = join(ROOT, ".forgejo", "workflows");

/**
 * Duplicate SIBLING keys. A scope is one mapping; its child keys all share an
 * indent. A `- ` list item starts a FRESH mapping (two steps may both have
 * `name:` and `run:` without being siblings), which is the part a naive
 * indent-only walk gets wrong. Block scalars (`run: |`) are free text.
 */
function duplicateKeys(src: string): Array<{ line: number; key: string; first: number; path: string }> {
  const out: Array<{ line: number; key: string; first: number; path: string }> = [];
  type Scope = { at: number; key: string; seen: Map<string, number> };
  const stack: Scope[] = [{ at: 0, key: "", seen: new Map() }];
  let blockIndent: number | null = null;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    const m = /^(\s*)(-\s+)?(["']?)([A-Za-z_][\w.\-/]*)\3\s*:(\s|$)/.exec(raw);
    if (!m) continue;
    const isItem = Boolean(m[2]);
    const key = m[4]!;
    const keyIndent = isItem ? indent + m[2]!.length : indent;
    while (stack.length > 1 && stack[stack.length - 1]!.at > keyIndent) stack.pop();
    if (isItem) {
      // A new list item is a new mapping, even at the same indent as the last.
      while (stack.length > 1 && stack[stack.length - 1]!.at >= keyIndent) stack.pop();
      stack.push({ at: keyIndent, key: `${stack[stack.length - 1]!.key}[]`, seen: new Map() });
    } else if (stack[stack.length - 1]!.at !== keyIndent) {
      stack.push({ at: keyIndent, key: stack[stack.length - 1]!.key, seen: new Map() });
    }
    const scope = stack[stack.length - 1]!;
    const prev = scope.seen.get(key);
    if (prev !== undefined) {
      const path = stack
        .map((s) => s.key)
        .filter((k, idx, a) => k && k !== a[idx - 1])
        .join(".") || "(top level)";
      out.push({ line: i + 1, key, first: prev, path });
    }
    scope.seen.set(key, i + 1);
    if (/:\s*[|>][-+]?\d*\s*$/.test(raw)) blockIndent = keyIndent;
    else stack.push({ at: keyIndent + 1, key: key, seen: new Map() });
  }
  return out;
}


const problems: string[] = [];
const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
for (const f of files) {
  for (const d of duplicateKeys(readFileSync(join(DIR, f), "utf8"))) {
    problems.push(
      `.forgejo/workflows/${f}:${d.line} duplicate key "${d.key}" under ${d.path} (already defined at line ${d.first}).\n` +
        `      YAML lets the later one win silently; Forgejo's runner refuses to decode the file and says so on every poll.`,
    );
  }
}
if (problems.length) {
  console.error("lint:workflow-yaml FAILED\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}
console.log(`lint:workflow-yaml OK (${files.length} workflow file(s), no duplicate sibling keys)`);
