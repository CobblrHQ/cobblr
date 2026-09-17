#!/usr/bin/env tsx
// A capability refusal (missing_capability) carries error.blocked, the explanation the app's blocked-action sheet turns into an ask, never a bare sentence naming an internal id.
//
// THE BUG THIS PREVENTS. A member filing from a phone was told 'This action requires the inventory:create-part capability. Ask a workspace admin to grant it.' with no way to ask (#3073, 2026-09-16).
//
// THE RULE. A 403 body whose code is `missing_capability` is a capability
// gate refusing a person, and the app's one blocked-action sheet reads
// `error.blocked` off it (contract: blocked-action.ts) to explain the real
// prerequisite and offer the ask. So within a few lines of `code:
// "missing_capability"` the same object literal must carry a `blocked` key,
// and the sentence must come from the platform (`describeBlockedCapability`
// / `describeCapabilityBlock` / `refuseCapability`), never be typed by hand.
// Passes: the kernel gate (auth/capability.ts) and the inventory module's
// twin, which both ask the platform. Fails: a module that copies the old
// shape — an identifier in a sentence and no way to ask. There is no opt-out:
// a refusal that cannot be asked about says so THROUGH `blocked`
// (`requestable: false` with a reason), not by leaving it off.
//
//   npx tsx scripts/lint-refusal-carries-blocked.ts   (pnpm run lint:refusal-carries-blocked)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/code:\s*["'`]missing_capability["'`]/.test(line)) continue;
    // The 400 for a missing :capability PARAM in core-ai reuses the word; a
    // 403 refusal is what this is about, and that one names a role.
    const window = lines.slice(Math.max(0, i - 6), i + 8).join("\n");
    if (!/your_role|status\(403\)/.test(window)) continue;
    if (!/\bblocked\b/.test(window)) {
      out.push({ file, line: i + 1, what: "a missing_capability refusal without error.blocked: the app cannot explain it or offer the ask" });
      continue;
    }
    if (/message:\s*`[^`]*\$\{actionId\}/.test(window) || /Ask a workspace admin to grant it/.test(window)) {
      out.push({ file, line: i + 1, what: "the refusal sentence is typed by hand and names an identifier; take it from describeBlockedCapability" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:refusal-carries-blocked - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:refusal-carries-blocked OK`);
