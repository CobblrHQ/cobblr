#!/usr/bin/env tsx
// A script that runs on a box kills only the pid it spawned, never by name,
// pattern or port: pkill -f, killall, fuser -k and lsof -ti | xargs kill reach
// every container whose pid 1 matches.
//
// THE BUG THIS PREVENTS (#2951). A throwaway-api harness run as root over ssh
// on the CI box cleaned up with `pkill -f "node dist/index.js"`. In the box's
// pid namespace that pattern also matched pid 1 of the dev rig's api container
// (`node dist/index.js`), so every harness run TERM'd the rig and docker
// restarted it: four times one afternoon, five the next, each read by the
// builder whose refresh had just started it as a boot that would not stay up.
// The harness wrote a pidfile and never read it.
//
// THE RULE. In scripts/ and e2e/ (what runs on boxes) and in the skills that
// write rig recipes, a line may not kill by pattern, name or port:
//   pkill <anything>        killall <anything>       fuser -k <port>
//   lsof -ti ... | xargs kill      kill $(lsof -t ...) / $(pgrep ...)
// Kill the pid you spawned: `$!`, or the pidfile you wrote
// (`kill "$(cat "$PIDFILE")"`). A command that provably runs inside its own
// pid namespace (a step in a per-job CI container) opts out on the same line
// with `ALLOW-PATTERN-KILL: <why the namespace is yours>`. Comment lines, and
// markdown outside a code fence, are not read: that is where the rule is taught.
//
// PROVE IT RED before you trust it green: write `pkill -f node` into a scratch
// file under scripts/, run it, watch it fail, delete the file.
//
//   npx tsx scripts/lint-no-pattern-kill.ts   (pnpm run lint:no-pattern-kill)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["scripts", "e2e", ".claude/skills"];
const FILE = /\.(sh|bash|mjs|cjs|js|ts|md)$/;
const SELF = "scripts/lint-no-pattern-kill.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const RULES: { re: RegExp; what: string }[] = [
  { re: /(^|[\s;&|(`])pkill(\s|$)/, what: "pkill kills by name or pattern" },
  { re: /(^|[\s;&|(`])killall(\s|$)/, what: "killall kills by name" },
  { re: /(^|[\s;&|(`])fuser\s+(-\S*k|-k)/, what: "fuser -k kills whoever holds the port" },
  { re: /lsof\s+-t[i]?\S*.*\|\s*xargs\s+(-\S+\s+)*kill/, what: "lsof | xargs kill kills whoever holds the port" },
  { re: /kill\s+(-\S+\s+)*["']?\$\(\s*(lsof|pgrep|pidof)\b/, what: "kill $(lsof/pgrep/pidof …) kills by port or name" },
];

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === "worktrees") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (FILE.test(name)) yield p;
  }
}

// A comment that names the forbidden form to say "not this" is the rule
// being taught, not broken: comment lines are skipped in code, and in a
// skill's markdown only fenced code blocks are read (prose is where the rule
// is explained).
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const md = file.endsWith(".md");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (md) {
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (!inFence) continue;
    } else if (/^\s*(#|\/\/|\*|\/\*)/.test(line)) continue;
    if (/ALLOW-PATTERN-KILL:\s*\S/.test(line)) continue;
    for (const r of RULES) {
      if (r.re.test(line)) {
        out.push({ file, line: i + 1, what: r.what });
        break;
      }
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (file !== SELF) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-pattern-kill - ${violations.length} kill(s) by name, pattern or port:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    `\n  On a box that runs containers this reaches every container whose pid 1 matches\n` +
      `  (#2951: a harness's pkill -f "node dist/index.js" restarted the dev rig's api on\n` +
      `  every run). Kill the pid you spawned: $! or the pidfile you wrote. A command that\n` +
      `  runs inside its own pid namespace opts out on the line: ALLOW-PATTERN-KILL: <why>.`,
  );
  process.exit(1);
}
console.log("lint:no-pattern-kill OK");
