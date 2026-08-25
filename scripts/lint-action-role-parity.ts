#!/usr/bin/env tsx
// A kernel action that SAYS it is owner-only must ENFORCE it on the action rail.
//
// Audit M-ACTION-PARITY. `platform:rename-workspace` is owner-only over REST
// (PATCH /orgs/:slug is hard `role === "owner"`) and its own description said
// "Owner only" — but the action rail gated it with `requireCapability` alone,
// which passes any admin. So an admin who could not rename the workspace in
// Settings could rename it through Cobb / the generic /actions/invoke door. The
// two rails disagreed on WHO may perform the SAME operation.
//
// `lint:ai-reach-routes` proves an action's REST route is REACHABLE; nothing
// proved the two rails agreed on who may reach it. This closes that gap for the
// kernel's own actions: the fix was a per-action `min_role` floor the invoke
// route enforces with `roleSatisfies`, so this lint pins the DECLARATION to the
// human-readable rule and back:
//
//   * EVERY platform action MUST declare its floor explicitly — a role rung, or
//     the deliberate "grantable" (no hard floor; requireCapability governs). No
//     default, so a new owner-only action cannot silently omit the gate;
//   * a description that restricts the action to the OWNER MUST carry
//     `min_role: "owner"`, never "grantable", so the rail cannot be more
//     permissive than the words;
//   * a rung `min_role` MUST name a real role.
//
// Why only OWNER and not admin: the invoke route's default gate
// (`requireCapability`) already lets owner/admin through and no lower role
// EXCEPT by an explicit per-action grant, so "owner or admin" wording merely
// restates that default and needs no extra floor. Owner-only is the one case
// stricter than the default, and so the one the rail can silently under-enforce.
//
// A future owner-only kernel action therefore cannot ship with a description
// that promises "Owner only" while the rail lets an admin through — the exact
// class this bug belonged to.
//
//   cd <repo> && npx tsx scripts/lint-action-role-parity.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORG_ROLES } from "../packages/platform-contract/src/org-roles.js";

const SRC = join("api", "src", "platform", "platform-actions.ts");

interface Finding {
  id: string;
  line: number;
  problem: string;
}

const src = readFileSync(SRC, "utf8");
const ids = [...src.matchAll(/^\s*id: "(platform:[a-z0-9-]+)",$/gm)];
const findings: Finding[] = [];
let checked = 0;
let gated = 0;

// Words in a description that promise an OWNER-only restriction — stricter than
// the invoke route's default requireCapability floor, so the one the rail can
// under-enforce. "owner or admin" is deliberately NOT here: it restates the
// default, so it needs no extra floor (see the header).
const RESTRICTION: Array<{ re: RegExp; role: string }> = [
  { re: /owner[\s-]only/i, role: "owner" },
  { re: /only\s+the\s+(?:workspace\s+)?owner/i, role: "owner" },
];
// Guard against a false match on "owner or admin" containing "owner" — the
// owner-only patterns above are specific enough, but keep the intent explicit.
const NOT_OWNER_ONLY = /owner\s+or\s+admin|admin\s+or\s+owner/i;

for (const [i, m] of ids.entries()) {
  const block = src.slice(m.index!, i + 1 < ids.length ? ids[i + 1]!.index! : src.length);
  const id = m[1]!;
  const line = src.slice(0, m.index!).split("\n").length;
  checked++;

  const description = block.match(/description:\s*\n?\s*"([\s\S]*?)",\n/)?.[1] ?? "";
  const minRoleMatch = block.match(/min_role:\s*"([a-z]+)"/);
  const declared = minRoleMatch?.[1] ?? null;
  const isRungFloor = declared !== null && declared !== "grantable";
  if (isRungFloor) gated++;

  // EVERY platform action must make an explicit floor decision — a role rung or
  // the deliberate "grantable" (requireCapability governs). No default, so a new
  // owner-only action cannot silently omit the gate and fall through to the
  // more-permissive requireCapability. (The type requires it too; this states
  // the rule where the fix is authored, and reports it independently of tsc.)
  if (declared === null) {
    findings.push({
      id,
      line,
      problem: `no min_role declared — every platform action must set min_role to a role rung or "grantable"`,
    });
  } else if (declared !== "grantable" && !(ORG_ROLES as readonly string[]).includes(declared)) {
    findings.push({
      id,
      line,
      problem: `min_role: "${declared}" is neither a real role (${ORG_ROLES.join(", ")}) nor "grantable"`,
    });
  }

  // The description promises an owner-only restriction the rail must enforce — so
  // the floor must be that RUNG, never "grantable" (which would let any admin,
  // or a granted member, through the more-permissive default gate).
  const promised = NOT_OWNER_ONLY.test(description)
    ? undefined
    : RESTRICTION.find((r) => r.re.test(description));
  if (promised && (declared === null || declared === "grantable")) {
    findings.push({
      id,
      line,
      problem: `description restricts this to ${promised.role} but min_role is ${declared === "grantable" ? '"grantable"' : "unset"} — the action rail would let anyone requireCapability passes (any admin, or a granted member) invoke it, more permissive than the words promise`,
    });
  }
  if (promised && isRungFloor && declared !== promised.role) {
    findings.push({
      id,
      line,
      problem: `description implies a ${promised.role} floor but min_role is "${declared}"`,
    });
  }
}

if (findings.length > 0) {
  console.error(`✗ action-role-parity: ${findings.length} kernel action(s) where the role gate and the description disagree.\n`);
  for (const f of findings) console.error(`  ${f.id}  (${SRC}:${f.line})\n      ${f.problem}\n`);
  console.error(
    `Fix: if the action is owner-only, add \`min_role: "owner"\` to its declaration in\n` +
      `${SRC} (the invoke route enforces it with roleSatisfies). If it is NOT restricted,\n` +
      `drop the owner/admin wording from its description so the two rails read the same.\n`,
  );
  process.exit(1);
}

console.log(`✓ action-role-parity: ${checked} kernel action(s) checked (${gated} role-gated); every restricted one enforces its floor.`);
