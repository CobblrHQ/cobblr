#!/usr/bin/env tsx
// A test that mocks @cobblr/platform-web or @cobblr/platform-contract extends the real module (async (orig) => ({ ...(await orig()), ... })) and replaces only what it needs.
//
// THE BUG THIS PREVENTS. A whole-package mock of platform-web failed three menu tests and two dashboard tests the day the code under test imported one more hook (useEscapeToClose, usePasteImage), with nothing wrong in the product (2026-10-01)
//
// THE RULE. `vi.mock("@cobblr/platform-web", () => ({ … }))` REPLACES the
// shared package with what the test listed, so every export the code under
// test uses had to be named there. The day that code imported one more hook,
// the test failed on "no export defined" with nothing wrong in the product,
// and it failed on the merged tree of two green pull requests, so main's
// queue went red for a test-only reason, twice in one day. A mock of a
// shared package extends the real one and replaces only its stand-ins:
//   vi.mock("@cobblr/platform-web", async (orig) => ({
//     ...(await orig<typeof import("@cobblr/platform-web")>()),
//     useToast: () => toast,
//   }));
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the two shared
// libraries, platform-web and platform-contract, which everything imports. A
// module's UI entry (`@cobblr/labels/ui` stubbing its LabelsBasket) is a
// stand-in for one component on purpose and passes. A test can still replace
// the whole package where it means to, with `// whole-mock: <why>` above it;
// none does today.
//
//   npx tsx scripts/lint-shared-package-mocks-extend-the-real-one.ts   (pnpm lint shared-package-mocks-extend-the-real-one)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules", "api/tests", "ops-console/src", "scripts"];

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
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /vi\.mock\(\s*["'](@cobblr\/platform-(?:web|contract))["']\s*,\s*(?:async\s*)?\(\s*(\w*)\s*\)\s*=>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length;
    const above = src.split("\n")[line - 2] ?? "";
    if (/whole-mock:\s*\S/.test(above)) continue;
    const orig = m[2];
    // The factory's first lines: it spreads what the original resolves to.
    const head = src.slice(m.index, m.index + 400);
    // Spread directly (`...(await orig())`) or through a name it is bound to
    // (`const real = await orig(); return { ...real, … }`).
    const bound = orig ? new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*await\\s+${orig}\\b`).exec(head)?.[1] : undefined;
    const spreads =
      !!orig &&
      (new RegExp(`\\.\\.\\.\\s*\\(\\s*await\\s+${orig}\\b`).test(head) || (!!bound && new RegExp(`\\.\\.\\.\\s*${bound}\\b`).test(head)));
    if (spreads) continue;
    out.push({ file, line, what: `a mock that replaces all of ${m[1]}: extend the real one (async (orig) => ({ ...(await orig()), … }))` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:shared-package-mocks-extend-the-real-one - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("vi.mock(\"@cobblr/platform-web\", async (orig) => ({ ...(await orig<typeof import(\"@cobblr/platform-web\")>()), <only the parts you stand in for> }))");
  process.exit(1);
}
console.log(`lint:shared-package-mocks-extend-the-real-one OK`);
