#!/usr/bin/env tsx
// CLAUDE.md stays under 12,000 characters and every path it points to exists, because every agent loads it at every start.
//
// THE BUG THIS PREVENTS. CLAUDE.md had grown to 63k characters, past the
// tool's 40k warning, and cost every agent about 12k tokens at each start and
// each compaction; a local-model agent took minutes to start on it
// (2026-10-02). It grew one incident narrative at a time, each one worth
// keeping and none of them a rule an agent needs before its first step.
//
// THE RULE. Five checks, all on the slim file and what points at it:
//   1. CLAUDE.md is under MAX characters.
//   2. Every markdown link and every backticked repo path in it exists
//      (scripts/, docs/, api/, web/, modules/, packages/, changelog.d/,
//      .claude/, .forgejo/). A placeholder with <...> or * is not a path.
//   3. Every "spec §N" it cites is a heading in docs/architecture/platform-spec.md.
//   4. Every skill it names ("Skill: `x`") has .claude/skills/<x>/SKILL.md.
//   5. Nothing else in the repo cites a CLAUDE.md section number ("CLAUDE.md
//      §14.6", "CLAUDE.md 8.1"): the slim file has no numbers to keep stable,
//      so a numbered citation must name the spec instead.
// The fix for 1 is never a higher MAX: move the explanation into the spec under
// the rule's section and leave one line with a pointer.
//
// THE BOUNDARY. docs/history/ is frozen record and may say what CLAUDE.md said
// on a past date, but a numbered citation there would still send a reader to
// a number that no longer exists, so it is checked like the rest. Paths under
// .agents/ are gitignored and absent in CI, and /opt paths are on another
// machine; neither is a repo path. A migration is immutable once merged, its
// comments included, so an old numbered citation inside one stays as written
// and is not checked.
//
//   npx tsx scripts/lint-claude-md-stays-small.ts   (pnpm lint claude-md-stays-small)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "CLAUDE.md";
const SPEC = "docs/architecture/platform-spec.md";
const MAX = 12_000;
/** Where a numbered CLAUDE.md citation would be read. */
const CITE_ROOTS = ["api", "web/src", "modules", "packages", "scripts", "docs", ".claude", "docker", "deploy", "e2e"];
const CITE_FILES = ["docker-compose.yml", "README.md"];
const NUMBERED = /CLAUDE\.md[`'")\]]*(?:'s)? *\(?(?:§ *\d|\d{1,2}\.\d)/;

const out: string[] = [];
const src = readFileSync(join(ROOT, FILE), "utf8");

if (src.length >= MAX) out.push(`${FILE} is ${src.length} characters; it must stay under ${MAX}`);

const lines = src.split("\n");
const repoPath = /^(?:scripts|docs|api|web|modules|packages|changelog\.d|\.claude|\.forgejo)\/[^\s<>*]+$/;
lines.forEach((line, i) => {
  const at = `${FILE}:${i + 1}`;
  for (const m of line.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^https?:/.test(m[1]!)) continue;
    if (!existsSync(join(ROOT, m[1]!))) out.push(`${at}  link to ${m[1]} does not exist`);
  }
  for (const m of line.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1]!.replace(/[.,:;]$/, "");
    if (repoPath.test(p) && !existsSync(join(ROOT, p))) out.push(`${at}  \`${p}\` does not exist`);
  }
  for (const m of line.matchAll(/Skill: `([a-z0-9-]+)`/g)) {
    if (!existsSync(join(ROOT, ".claude/skills", m[1]!, "SKILL.md"))) out.push(`${at}  skill ${m[1]} does not exist`);
  }
});

const specHeadings = new Set(
  readFileSync(join(ROOT, SPEC), "utf8")
    .split("\n")
    .map((l) => l.match(/^#{2,3} (\d+(?:\.\d+[a-z]?)?)[. ]/)?.[1])
    .filter((x): x is string => !!x),
);
lines.forEach((line, i) => {
  for (const m of line.matchAll(/spec §(\d+(?:\.\d+[a-z]?)?)/g)) {
    if (!specHeadings.has(m[1]!)) out.push(`${FILE}:${i + 1}  spec §${m[1]} is not a heading in ${SPEC}`);
  }
});

// git grep picks the few files that mention CLAUDE.md at all; reading every
// file under the roots to find them cost 48 MB a run.
const citing = execFileSync("git", ["grep", "--untracked", "-l", "-I", "-F", "CLAUDE.md", "--", ...CITE_ROOTS, ...CITE_FILES], { maxBuffer: 1024 * 1024 * 1024, cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !/(^|\/)migrations\//.test(f))
  .map((f) => join(ROOT, f));
for (const file of citing) {
  if (file.endsWith(SPEC) || file.endsWith("lint-claude-md-stays-small.ts") || !existsSync(file)) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (NUMBERED.test(line)) out.push(`${file.slice(ROOT.length + 1)}:${i + 1}  cites a CLAUDE.md section number; cite ${SPEC} §N instead`);
    });
}

if (out.length) {
  console.error(`lint:claude-md-stays-small - ${out.length} violation(s):`);
  for (const v of out) console.error(`  ${v}`);
  console.error("move the explanation into docs/architecture/platform-spec.md and leave one line with a pointer");
  process.exit(1);
}
console.log(`lint:claude-md-stays-small OK (${src.length} of ${MAX} characters, ${specHeadings.size} spec sections)`);
