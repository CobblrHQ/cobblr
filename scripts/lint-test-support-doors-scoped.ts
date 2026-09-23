#!/usr/bin/env tsx
// A test-support run-migration door runs its boot pass on ONE workspace: it reads org_id from the body and hands the pass { onlyOrgId }, and the test that calls it sends its own org.
//
// THE BUG THIS PREVENTS. scan-category-axis-words.test.ts ran the scan-category
// reconcile over every org in the shared CI pool, relabelling the Category
// field on inventory:part in two other tests' workspaces mid-flight
// (a-choice-comes-off-by-name, core-ai-chat-replay, both finding their fixture
// by that label); both failed on ordering, and main could go red at random
// (run 23642, 2026-09-20, after #3225). The PR that added the door was green
// on its own run: a test that passes because of ordering is not a test that
// passed. A boot pass is written to walk every workspace, which is right at
// boot and wrong behind a door a test presses while 500 other tests hold
// workspaces in the same database.
//
// THE RULE. In api/src/routes/test-support.ts, every
// `testSupportRouter.post("/test-support/run-migration/<pass>", ...)` handler
// reads `org_id` from the request body and passes `onlyOrgId` to its pass,
// inline or through the file's `onlyOrg(req)` helper (whose body is held to
// the same two tokens); the pass's own signature then has to take it, which
// tsc holds. And every test under api/tests that POSTs a run-migration door
// sends `org_id` in that call's body. The precedent already in the tree is
// the receipt-placeholders door:
// `retireReceiptFailurePlaceholders(org_id ? { onlyOrgId: org_id } : {})`,
// with its test sending `{ org_id: s.orgId }` (#2898).
//
// A pass with genuinely no per-workspace shape opts out with
// `// ALLOW-POOL-WIDE: <reason>` on the door's `.post(` line. None qualifies
// today; a pass that reads per-org rows can filter by org.
//
// PROVE IT RED before you trust it green: against the tree as of 714afb67b it
// names the bookshelf, groceries-twin and scan-category-axis doors and the
// tests that press them.
//
//   npx tsx scripts/lint-test-support-doors-scoped.ts   (pnpm run lint test-support-doors-scoped)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The tree to judge: the repo, or a fixture tree in the lint's own test. */
const LINT_ROOT = process.env.COBBLR_LINT_ROOT || ".";
const DOORS_FILE = join(LINT_ROOT, "api/src/routes/test-support.ts");
const TESTS_ROOT = join(LINT_ROOT, "api/tests");
const DOOR = /testSupportRouter\.post\(\s*"\/test-support\/run-migration\/[^"]+"/g;
const PRESS = /\/test-support\/run-migration\/[^"'`]+/g;

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walkTests(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkTests(p);
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

/** The handler's whole block: from the `.post(` to the paren that closes it. */
function handlerBlock(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

/** The statement the press sits in: to the next `;`. */
const pressStatement = (src: string, from: number): string => {
  const end = src.indexOf(";", from);
  return src.slice(from, end === -1 ? undefined : end);
};

/** The file's shared helper, when it has one: `const onlyOrg = (req) => ...`
 *  whose body reads org_id and returns onlyOrgId. A door that calls it is
 *  scoped; a helper missing either token scopes nothing. */
function helperIsSound(src: string): boolean {
  const at = src.search(/const onlyOrg = /);
  if (at === -1) return false;
  // The body, not the signature: a return type of `{ onlyOrgId?: string }`
  // says nothing about what is returned.
  const open = src.indexOf("=> {", at);
  if (open === -1) return false;
  let depth = 0;
  let close = src.length;
  for (let i = open + 3; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  const body = src.slice(open, close);
  return /org_id/.test(body) && /onlyOrgId/.test(body);
}

export function checkDoors(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const helper = helperIsSound(src);
  for (const m of src.matchAll(DOOR)) {
    const line = lineOf(src, m.index);
    const lineText = src.split("\n")[line - 1] ?? "";
    if (/\/\/ ALLOW-POOL-WIDE: \S/.test(lineText)) continue;
    const block = handlerBlock(src, m.index);
    const door = /run-migration\/([^"]+)"/.exec(m[0])?.[1] ?? "?";
    if (helper && /onlyOrg\(req\)/.test(block)) continue;
    if (!/org_id/.test(block)) out.push({ file, line, what: `door "${door}" never reads org_id from the body: it runs its pass over every workspace in the pool` });
    else if (!/onlyOrgId/.test(block)) out.push({ file, line, what: `door "${door}" reads org_id but does not hand its pass { onlyOrgId }` });
  }
  return out;
}

export function checkPresses(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  for (const m of src.matchAll(PRESS)) {
    const stmt = pressStatement(src, m.index);
    if (!/org_id/.test(stmt)) out.push({ file, line: lineOf(src, m.index), what: `presses ${m[0]} without org_id in the body: the pass runs on every other test's workspace too` });
  }
  return out;
}

const violations: Violation[] = [];
try {
  violations.push(...checkDoors(DOORS_FILE, readFileSync(DOORS_FILE, "utf8")));
} catch {
  // No doors file: nothing to hold.
}
for (const file of walkTests(TESTS_ROOT)) violations.push(...checkPresses(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:test-support-doors-scoped - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "Read org_id from the body and pass { onlyOrgId: org_id } to the pass (retireReceiptFailurePlaceholders is the precedent); give the pass the option; send { org_id: s.orgId } from the test.",
  );
  process.exit(1);
}
console.log(`lint:test-support-doors-scoped OK`);
