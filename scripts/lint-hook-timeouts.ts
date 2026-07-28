// A hook (beforeAll/afterAll/beforeEach/afterEach) that passes its OWN timeout
// tighter than the harness default silently opts out of the generous global
// budget — and `retry: 1` never re-runs a failed hook, so there is no safety net.
// That is exactly what flaked graduation-photos: its beforeAll capped itself at
// 60s while the config allows 120s, and 3 tenant-DB provisions overran 60s under
// CI contention. There is no upside to a lower hook ceiling (a fast hook finishes
// fast regardless; a hung one still fails at the default), so forbid it.
//
// Scope: HOOKS only. An `it(...)`/`test(...)` with a shorter timeout is a
// legitimate "this must be fast" assertion, so those are left alone.

import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readFileSync(join(ROOT, "api/vitest.config.ts"), "utf8");
const hookTimeoutMatch = /hookTimeout:\s*([\d_]+)/.exec(CONFIG);
const HOOK_TIMEOUT = hookTimeoutMatch ? Number(hookTimeoutMatch[1].replace(/_/g, "")) : 120_000;

const HOOKS = new Set(["beforeAll", "afterAll", "beforeEach", "afterEach"]);
const TEST_DIR = join(ROOT, "api/tests");

const violations: string[] = [];

for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"))) {
  const path = join(TEST_DIR, file);
  const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      HOOKS.has(node.expression.text) &&
      node.arguments.length >= 2
    ) {
      // A hook is hook(fn, timeout?) — the timeout is the 2nd argument.
      const timeout = node.arguments[1];
      if (timeout && ts.isNumericLiteral(timeout)) {
        const value = Number(timeout.text.replace(/_/g, ""));
        if (value < HOOK_TIMEOUT) {
          const { line } = src.getLineAndCharacterOfPosition(timeout.getStart());
          violations.push(
            `api/tests/${file}:${line + 1}  ${node.expression.text}(…, ${value}) caps below the ${HOOK_TIMEOUT} hookTimeout default. Remove the override so it inherits the default; a tighter ceiling reintroduces flake (retry:1 never re-runs hooks).`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

if (violations.length) {
  console.error("Hook timeout tighter than the harness default:\n" + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
console.log("lint:hook-timeouts — no hook caps below the harness hookTimeout default.");
