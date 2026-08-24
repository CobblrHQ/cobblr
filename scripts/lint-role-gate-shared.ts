// Guard: there is ONE role ranking, and everybody imports it.
//
// The kernel's role gate has always been rank-based — a more-privileged role
// satisfies any check a lesser one passes — and it says so in a comment. Every
// module then grew its own `requireRole` in `src/api/util.ts`, and all 34 of
// them wrote it as an exact-set membership test instead:
//
//     if (!allowed.includes(ctx.role)) → 403
//
// Which meant the ordinary write gate, `requireRole(req, res, "owner",
// "admin", "member")`, rejected an `editor`. An editor could read a whole
// workspace and change nothing in it, and the 403 read "requires one of: owner,
// admin, member" — as though the role did not exist.
//
// It survived indefinitely because every test and every demo runs as the
// workspace owner, and an owner satisfies both readings. Nothing was going to
// catch this except somebody being invited as an editor.
//
// So: a role check compares RANK, from the one shared table, and a role
// ranking is not written down twice.
//
// Run: npx tsx scripts/lint-role-gate-shared.ts

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** The one place a ranking may be defined. */
const HOME = "packages/platform-contract/src/org-roles.ts";

const ROOTS = ["modules", "api/src", "packages", "web/src"];

/** Candidate files, from git rather than a tree walk.
 *
 *  This lint read every .ts in the repo and ran two regexes over each, which
 *  cost 99 seconds and made it the whole CI job on its own. Almost no file
 *  contains a role gate, so ask git for the few that might and read only those.
 *  `-lE` is one indexed pass; the detailed matching below then runs over a
 *  handful of files instead of thousands. */
function candidates(): string[] {
  // POSIX ERE, not JS: `git grep -E` has no \s or \w, and a pattern using them
  // matches NOTHING rather than erroring. That is a guardrail that silently
  // stops guarding, which is worse than not having one — it was caught only by
  // reintroducing the bug and watching this stay green.
  const PREFILTER =
    "[.]includes\\([[:space:]]*([A-Za-z_$][A-Za-z0-9_$]*[.])?role[[:space:]]*\\)" +
    "|ROLE_RANK|ROLE_ORDER";
  try {
    const out = execFileSync(
      "git",
      ["grep", "-lE", "--", PREFILTER, ...ROOTS.map((r) => `${r}/**/*.ts`), ...ROOTS.map((r) => `${r}/**/*.tsx`)],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    return out.split("\n").filter(Boolean);
  } catch (e) {
    // git grep exits 1 when nothing matches, which is a pass, not a failure.
    const err = e as { status?: number };
    if (err.status === 1) return [];
    throw e;
  }
}

const problems: string[] = [];

for (const file of candidates()) {
  {
    if (file.endsWith("org-roles.ts")) continue;
    if (/\.test\.tsx?$/.test(file)) continue;
    const src = readFileSync(file, "utf8");

    // 1. An exact-set test against the caller's role. This is the bug itself.
    //
    // Unless it is deliberate. A GOVERNANCE gate is exact on purpose: managing
    // members is owner/admin only, and an editor must not inherit it by
    // outranking a member. Those say so on the line above:
    //
    //     // role-gate: exact — <why>
    for (const m of src.matchAll(/(\w+)\.includes\(\s*(?:\w+\.)?role\s*\)/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      // A window, not a single line: the reason for a governance gate takes a
      // sentence or two, and the annotation sits above the whole explanation.
      const preceding = src.slice(0, m.index).split("\n").slice(-8).join("\n");
      if (/role-gate:\s*exact/.test(preceding)) continue;
      problems.push(
        `${file}:${line}\n      \`${m[0]}\` is an exact-set role test, so it rejects any MORE privileged\n` +
          `      role that is not literally in the list — which is how "editor" lost every write.\n` +
          `      Use roleSatisfies(role, allowed) from @cobblr/platform-contract/org-roles.`,
      );
    }

    // 2. A second ranking table. Two tables are two answers.
    if (/(?:ROLE_RANK|ROLE_ORDER)\s*(?::[^=]+)?=\s*\{/.test(src)) {
      const line = src.slice(0, src.search(/(?:ROLE_RANK|ROLE_ORDER)\s*(?::[^=]+)?=\s*\{/)).split("\n").length;
      problems.push(
        `${file}:${line}\n      defines its own role ranking. There is one, in ${HOME}.\n` +
          `      A rule written down twice is a rule that will be two different rules.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("lint:role-gate-shared — one role ranking, imported by everybody:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log("lint:role-gate-shared — every role gate compares rank from the shared table.");
