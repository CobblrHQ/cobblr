// Guard: the role vocabulary is written down ONCE.
//
// Before this, the list of workspace roles was hand-authored in 49 places and
// 47 had fallen behind:
//
//   33 module `db.ts` files typed it "owner" | "admin" | "member" | "guest"
//   13 requireRole signatures spelled the same stale union
//    3 zod enums REJECTED "editor" outright, so a cross-workspace link could
//      not be restricted to editors and a super-admin could not create one
//    1 user manual listed four roles while the members modal offered five
//
// Adding a role meant finding all 49. Nobody did, twice: `editor` was added and
// reached two of them.
//
// So the names live in @cobblr/platform-contract/org-roles and everything
// derives. This fails the build on a fresh hand-written list, in code OR in the
// manual, because a list that drifts silently is how the last one got here.
//
// Run: npx tsx scripts/lint-role-vocabulary.ts

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// The lint does not get to retype the vocabulary either. If it hardcoded the
// names it would be the 50th copy, and the first to go stale unnoticed.
//
// By RELATIVE PATH, like lint-catalog-schema-complete beside it: the repo root
// has no dependency on @cobblr/platform-contract, so the bare specifier
// resolves on a dev machine (where node_modules is hoisted) and fails in CI's
// clean install. It did exactly that.
import { ORG_ROLES } from "../packages/platform-contract/src/org-roles.js";

/** The one file allowed to name them. */
const HOME = "packages/platform-contract/src/org-roles.ts";

/** Where the manual explains them to a person. */
const GUIDE = "docs/USER_GUIDE.md";
const GUIDE_SECTION = "**Roles right now:**";

const ROLES: readonly string[] = ORG_ROLES;

/**
 * Is this line DECLARING the vocabulary, as opposed to comparing against it?
 *
 *   ["owner", "admin", "member"]        ← a list. The thing that drifts.
 *   "owner" | "admin" | "member"        ← a union. Same.
 *   z.enum(["owner", …])                ← same.
 *   role === "owner" || role === "admin" ← a GATE. Not vocabulary; it names the
 *                                          two roles it allows and would still
 *                                          be correct if a sixth role existed.
 *
 * The distinction matters: flagging gates buries the real finding in noise, and
 * a lint people learn to skim is a lint that has stopped working.
 */
function looksLikeAList(line: string): boolean {
  const quoted = ROLES.filter((r) => line.includes(`"${r}"`) || line.includes(`'${r}'`));
  if (quoted.length < 2) return false;
  if (/[!=]==/.test(line)) return false;
  const names = ROLES.join("|");
  const inArray = new RegExp(`\\[[^\\]]*["'](${names})["']`).test(line);
  const inUnion = new RegExp(`["'](${names})["']\\s*\\|`).test(line);
  return inArray || inUnion;
}

function candidates(): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-lE", "--", '"(owner|guest|editor)"', "--", "*.ts", "*.tsx"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    return out.split("\n").filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

const problems: string[] = [];

// ── 1. code ────────────────────────────────────────────────────────
for (const file of candidates()) {
  if (file === HOME) continue;
  if (/\.test\.tsx?$/.test(file)) continue; // a test may name what it asserts
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // Prose is not a list. A comment explaining the stale union it replaced has
    // to be able to quote it.
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (!looksLikeAList(line)) return;
    // A gate naming the roles it allows is a CALL, not a vocabulary:
    //   requireRole(req, res, "owner", "admin", "member")
    if (/requireRole\(|roleSatisfies\(|ADMINISH|\.includes\(/.test(line)) return;
    // An explicit, stated exception.
    if (/role-vocab:\s*ok/.test(lines.slice(Math.max(0, i - 4), i + 1).join("\n"))) return;
    problems.push(
      `${file}:${i + 1}\n      ${line.trim().slice(0, 100)}\n` +
        `      is a hand-written role list. Import ORG_ROLES (or INVITABLE_ORG_ROLES,\n` +
        `      or the OrgRoleName type) from @cobblr/platform-contract/org-roles.`,
    );
  });
}

// ── 2. the manual ──────────────────────────────────────────────────
// The drift that started this was not in code at all: the guide described four
// roles while the app offered five, so there was nothing to check the missing
// one's behaviour against.
const guide = readFileSync(GUIDE, "utf8");
const at = guide.indexOf(GUIDE_SECTION);
if (at < 0) {
  problems.push(
    `${GUIDE}\n      has no "${GUIDE_SECTION}" section, so nothing describes the roles to a person.`,
  );
} else {
  const section = guide.slice(at, at + 3000);
  const missing = ROLES.filter((r) => !new RegExp(`\\*\\*${r}\\*\\*`).test(section));
  if (missing.length > 0) {
    problems.push(
      `${GUIDE}\n      the roles section never describes: ${missing.join(", ")}.\n` +
        `      Every role the app offers has to be explained where people read about them.`,
    );
  }
}

if (problems.length > 0) {
  console.error("lint:role-vocabulary — the roles are written down once:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`lint:role-vocabulary — ${ROLES.length} roles, one list, and the manual describes them all.`);
