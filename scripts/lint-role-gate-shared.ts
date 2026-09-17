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
// The same bug has a second spelling, and this lint missed it for three
// months:
//
//     if (role === "owner" || role === "admin") return true;
//
// That is an exact-set test with the set unrolled into a chain, and it sat at
// the top of the capability layer (`userHasCapability`). An editor therefore
// cleared every rank gate in the product and failed every capability gate
// behind them — installed the bundle, could not create the record it exists
// for (#3072). A chain of two or more literal role comparisons on one
// variable is now the same finding as `.includes(role)`.
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
    "|ROLE_RANK|ROLE_ORDER" +
    // The unrolled spelling: any literal comparison against a role name. Most
    // files with ONE such comparison are fine (owner-only is exact by
    // construction, a data filter on `m.role === "owner"` is not a gate); the
    // detailed pass below only fails a CHAIN of two or more.
    "|[!=]==[[:space:]]*[\"'](owner|admin|editor|member|guest)[\"']";
  try {
    // A plain git pathspec has no `**`: `api/src/**/*.ts` needs a second
    // slash, so a file sitting directly in a root — api/src/index.ts, where
    // the capability layer lives — was never read. The bug this lint was
    // widened for sat there, one directory above the prefilter's reach.
    // `:(glob)` makes `**` mean "any depth, including none".
    const out = execFileSync(
      "git",
      ["grep", "-lE", "--", PREFILTER, ...ROOTS.map((r) => `:(glob)${r}/**/*.ts`), ...ROOTS.map((r) => `:(glob)${r}/**/*.tsx`)],
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

    // 1b. The same test unrolled: `x === "owner" || x === "admin"`, or its
    // negation `x !== "owner" && x !== "admin"`. Two or more literal role
    // comparisons chained on ONE variable name a set, and a set is exact.
    // The governance annotation stands here too.
    // The variable may be a member chain with `?.` and `!.` in it
    // (`caps.data?.role`, `req.tenant!.role`).
    const ROLE_CMP = /([A-Za-z_$][\w$]*(?:(?:\?\.|!\.|\.)[\w$]+)*)\s*([!=]==)\s*["'](owner|admin|editor|member|guest)["']/g;
    const seen = new Set<number>();
    for (const m of src.matchAll(ROLE_CMP)) {
      if (seen.has(m.index)) continue;
      const subject = m[1]!;
      const op = m[2]!;
      // Walk forward: same variable, same operator, joined by || (for ===) or
      // && (for !==). Stop at the first link that is not part of the chain.
      const joiner = op === "===" ? "\\|\\|" : "&&";
      let end = m.index + m[0].length;
      let links = 1;
      for (;;) {
        const rest = src.slice(end);
        const next = new RegExp(
          `^(\\s*${joiner}\\s*)${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${op}\\s*["'](owner|admin|editor|member|guest)["']`,
        ).exec(rest);
        if (!next) break;
        // The later links are matches of ROLE_CMP in their own right; mark
        // them so one chain is one finding.
        seen.add(end + next[1]!.length);
        end += next[0].length;
        links += 1;
      }
      if (links < 2) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const preceding = src.slice(0, m.index).split("\n").slice(-8).join("\n");
      if (/role-gate:\s*exact/.test(preceding)) continue;
      problems.push(
        `${file}:${line}\n      \`${src.slice(m.index, end).replace(/\s+/g, " ")}\` is an exact-set role test spelled as a chain, so it\n` +
          `      rejects any MORE privileged role that is not literally named — which is how the\n` +
          `      capability layer forgot "editor". Use roleSatisfies(role, allowed) (or requireRole)\n` +
          `      from @cobblr/platform-contract/org-roles; a governance gate says // role-gate: exact — <why>.`,
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
