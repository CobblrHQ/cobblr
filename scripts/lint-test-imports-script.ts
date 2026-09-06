#!/usr/bin/env tsx
// Guard: a test must not import a script that reads CREDENTIALS on import.
//
// A file in scripts/ is an executable: its module scope runs the moment it is
// imported. Most of that is harmless - a testbench that reads committed
// fixtures is fine, and this lint leaves it alone. The hazard is narrower: a
// script that resolves a CREDENTIAL at module scope. On the dev Mac that file
// exists, so the test passes; on a runner it does not, and the test fails at
// import with an error about a missing token that has nothing to do with what
// it asserts.
//
// That is exactly what happened on 2026-09-04: `scripts/reset-delay.test.ts`
// imported `bench-action-rail.ts` for one pure function, went green here and
// red in CI. The fix was to move the function into `scripts/lib/reset-delay.ts`
// and import that — which is the rule this lint makes permanent.
//
// scripts/lib/ is the exception BY DESIGN: it is where a script's pure parts
// go so they can be tested. Nothing in lib may read credentials or argv at
// module scope; that is what makes it importable.
//
//   npx tsx scripts/lint-test-imports-script.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", "dist", ".git", "_tmp", "coverage", "build"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (/\.test\.(ts|tsx|mts|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** The file an import specifier points at, if it is in scripts/. */
function resolveScript(from: string, spec: string): string | null {
  const guess = join(from, "..", spec).replace(/\.js$/, ".ts");
  for (const p of [guess, guess.replace(/\.ts$/, ".mts"), guess.replace(/\.ts$/, ".mjs")]) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** A credential read that happens on IMPORT: a top-level statement (column 0)
 *  that resolves a secret. A read inside a function body is lazy and fine. */
function readsCredentialsAtImport(file: string): string | null {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const raw of src.split("\n")) {
    if (/^\s/.test(raw) || raw.startsWith("//") || raw.startsWith("*")) continue;
    if (/secretFile\s*\(|\.secrets\b|process\.env\.[A-Z_]*(TOKEN|KEY|SECRET|PASSWORD)/.test(raw)) {
      return raw.trim().slice(0, 120);
    }
  }
  return null;
}

const offenders: string[] = [];
for (const file of testFiles(ROOT)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
    const spec = m[1]!;
    if (!/(^|\/)scripts\//.test(spec)) continue;
    if (/(^|\/)scripts\/lib\//.test(spec)) continue;
    const target = resolveScript(file, spec);
    const reason = target && readsCredentialsAtImport(target);
    if (!reason) continue;
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(
      `  ✗ ${relative(ROOT, file)}:${line} imports "${spec}", whose module scope reads a credential:\n` +
        `      ${reason}\n` +
        `      That file exists here and not on a runner, so this test passes locally and\n` +
        `      fails in CI at import. Move the pure part into scripts/lib/<name>.ts and\n` +
        `      import that instead.`,
    );
  }
}

if (offenders.length) {
  console.error(`lint:test-imports-script FAILED (${offenders.length})`);
  for (const o of offenders) console.error(o);
  process.exit(1);
}
console.log("✓ test-imports-script: no test imports a script that reads credentials on import");
