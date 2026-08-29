// Guard: a test that just needs A WORKSPACE goes through signupFreshOrg.
//
// helpers.ts describes a raw signup as the suite's single point of failure and
// its heaviest request: it CREATE DATABASEs a tenant behind a Postgres template
// lock that serialises across every concurrent signup, runs every module
// migration, and seeds bindings. The helper exists to avoid all of that - it
// takes a pre-provisioned org from the pool when one is available, retries the
// transient 5xx/429 that 8-fork contention produces, and registers teardown.
//
// A test that hand-rolls the signup gets none of that, and pays the full cost
// inside its own timeout. attention.test.ts did exactly this and timed out at
// 30s three times in one day - the dominant flake in the suite, and read every
// time as "CI is flaky" rather than as one fixable test.
//
// Tests whose SUBJECT is signup, invites or account recovery must obviously
// call it directly, and are listed below. The list is deliberately explicit:
// a pattern like "any file starting with auth-" would quietly absorb a future
// test that has nothing to do with auth.
//
// Run: npx tsx scripts/lint-tests-use-org-helper.ts

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "api/tests";
const HELPER = "signupFreshOrg";

/** Files that are ABOUT signing up, inviting, or recovering an account, so the
 *  raw endpoint is the thing under test rather than a means to a workspace. */
const SUBJECT_IS_SIGNUP = new Set([
  "auth-pair-codes.test.ts",
  "auth-reset-verify.test.ts",
  "auth-signup-gate.test.ts",
  "default-request-guard.test.ts",
  "invite-blueprint.test.ts",
  "invite-expiry-default.test.ts",
  "me-signup-invites.test.ts",
  "org-slug-generation.test.ts",
  "signup-app.test.ts",
  "signup-gate.test.ts",
  "waitlist.test.ts",
  "helpers.ts",
]);

/** Already-established files that predate this rule. Each is a real candidate
 *  for the helper; none has been the flake that prompted it. Shrink this list,
 *  never grow it. */
const GRANDFATHERED = new Set([
  "bundle-nav-headings.test.ts",
  "bundle-preview-instances.test.ts",
  "edge-generic.test.ts",
  "me-orgs-shape.test.ts",
  "sandbox-install-happy-path.test.ts",
  "scan-export.test.ts",
  "scan-import.test.ts",
  "scan-session-theme.test.ts",
]);

function main(): void {
  if (!existsSync(DIR)) {
    console.log("✓ org helper: no api/tests dir");
    return;
  }
  const problems: string[] = [];
  const staleAllowlist: string[] = [];

  for (const name of readdirSync(DIR)) {
    if (!name.endsWith(".ts")) continue;
    const body = readFileSync(join(DIR, name), "utf8");
    // A POST to it, not a mention of it. try-sandbox-unit asserts on the STRING
    // "/auth/signup" while classifying rate-limit paths, which provisions
    // nothing; flagging that would teach people the rule is noise.
    const lines = body.split("\n");
    const rawSignup = lines.some((line, i) => {
      if (!/["'`][^"'`]*\/auth\/signup/.test(line)) return false;
      const window = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
      return /\bPOST\b/.test(window);
    });
    const exempt = SUBJECT_IS_SIGNUP.has(name) || GRANDFATHERED.has(name);

    if (rawSignup && !exempt) {
      problems.push(
        `  ${DIR}/${name} provisions a workspace with a raw /auth/signup\n` +
          `      → use ${HELPER}("<label>") from ./helpers.js: pooled when available, retries transients, teardown registered`,
      );
    }
    // An allowlist entry that no longer applies is a rule quietly getting
    // weaker, so it is reported too.
    if (!rawSignup && GRANDFATHERED.has(name)) staleAllowlist.push(name);
  }

  if (problems.length > 0) {
    console.error(`✗ tests provisioning workspaces the expensive way:\n${problems.join("\n")}`);
    process.exit(1);
  }
  if (staleAllowlist.length > 0) {
    console.error(
      `✗ these no longer use a raw signup — drop them from GRANDFATHERED in this script:\n` +
        staleAllowlist.map((n) => `  ${n}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(`✓ org helper: every test needing just a workspace uses ${HELPER}`);
}

main();
