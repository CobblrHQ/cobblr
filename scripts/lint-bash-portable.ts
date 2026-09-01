#!/usr/bin/env tsx
/**
 * lint:bash-portable — dev scripts must run on bash 3.2, the /bin/bash macOS ships.
 *
 * `#!/usr/bin/env bash` on the dev Mac resolves to bash 3.2.57 (2007). Anything
 * bash 4 added — associative arrays, mapfile, `${x,,}` case conversion, `|&`,
 * `&>>`, `;;&` — is a syntax error there, and under `set -e` the script dies at
 * that line with whatever it had already printed standing as the result.
 *
 * That is what `merge-pr.sh` did: `declare -A` killed the post-merge watch after
 * "merged." was printed and before one status was read, so the message an agent
 * saw was exactly the "merged = shipped" the watch had been written to end. The
 * sibling of lint:portable-sed (BSD sed vs GNU sed), same class: a construct that
 * is fine on the CI box and fatal on the machine the script is actually run from.
 *
 * A script that genuinely only ever runs on Linux may opt out with a
 * `# gnu-sed: <reason>` line (it already means "Linux-only") or `# bash4: <reason>`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OPT_OUT = /#\s*(gnu-sed|bash4):\s*\S/;

const RULES: Array<[RegExp, string]> = [
  [/\b(declare|local|typeset)\s+(-[a-zA-Z]*A)/, "associative arrays (`declare -A`) are bash 4"],
  [/\b(mapfile|readarray)\b/, "`mapfile`/`readarray` is bash 4 — use a `while read` loop"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(,,?|\^\^?)[^}]*\}/, "`${x,,}` / `${x^^}` case conversion is bash 4 — use `tr`"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*@[QEPAaU]\}/, "`${x@Q}` parameter transformation is bash 4.4"],
  [/(^|[^|])\|&(\s|$)/, "`|&` is bash 4 — write `2>&1 |`"],
  [/&>>/, "`&>>` is bash 4 — write `>>f 2>&1`"],
  [/;;&|;&\s*$/, "`;;&` / `;&` case fall-through is bash 4"],
];

function isBash(path: string, text: string): boolean {
  if (path.endsWith(".sh")) return true;
  const first = text.split("\n", 1)[0] ?? "";
  return /^#!.*\bbash\b/.test(first);
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(rel, out);
    } else if (e.isFile() && statSync(join(ROOT, rel)).size < 512 * 1024) out.push(rel);
  }
}

const candidates: string[] = [];
walk("scripts", candidates);

const fails: string[] = [];
let checked = 0;
for (const rel of candidates) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  if (!isBash(rel, text)) continue;
  if (OPT_OUT.test(text)) continue;
  checked++;
  text.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith("#")) return;
    // Strip trailing comments and single-quoted strings so prose in them does not trip a rule.
    const code = s.replace(/'[^']*'/g, "''").replace(/\s#.*$/, "");
    for (const [re, why] of RULES) {
      if (re.test(code)) {
        fails.push(`${rel}:${i + 1} ${why}.\n      ${s.slice(0, 110)}\n      This runs on macOS bash 3.2; add \`# bash4: <reason>\` only if it never runs on the dev Mac.`);
        break;
      }
    }
  });
}

if (fails.length) {
  console.error("lint:bash-portable FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`lint:bash-portable OK (${checked} bash scripts checked against bash 3.2)`);
