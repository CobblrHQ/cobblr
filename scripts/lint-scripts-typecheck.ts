#!/usr/bin/env tsx
// RULE: scripts/ is typechecked, like the rest of the repo.
//
// It was not. `pnpm typecheck` walks the pnpm workspaces, and scripts/ is not
// one of them, so 200+ TypeScript files that run in CI, on the deploy box and
// on the bench were checked by nothing.
//
// It cost a night. The corpus bench's quota roll-over said `attempt -= 1`,
// naming a loop counter declared thirty lines below it and out of scope. That
// branch runs only when every API key has spent its daily quota, which is
// exactly the moment the nightly needed it: the run died with a
// ReferenceError, the answer cache never refilled, and every merge for the
// next day deferred its bench (2026-09-10). tsc had always known.
//
// This started as a gate on four error codes, because scripts/ carried 63
// other errors and a gate that cannot go green is a gate someone turns off.
// Those are fixed - a test file that imported the same four names twice, two
// version comparisons that read a short version as undefined rather than as
// zeroes, a dozen regex captures used without being there - so it now fails on
// any type error at all.
//
// Only scripts/ is judged here: everything else has its own typecheck, and a
// file pulled in by an import answers to that one.
//
// A GENERATED MULTI-MEGABYTE FILE IS NEVER TYPECHECKED THROUGH scripts/. A test
// that imported the 6 MB embedded bridge bundle made every run of this check
// parse it, and its read budget went red on every push from every session
// (17.3 MB against 7, 2026-10-08). tsc lists what it read; a file over
// BIG_BYTES outside node_modules is named, with the remedy.
//
// WITH tsgo, the compiler CI already gates on (2026-10-11, #5761): tsc took 35 to 63 s here and was the
// slowest lint by far; tsgo reads the same project in about 9 s and reports the same errors (0 in scripts/,
// the same 57 outside it, which this lint does not judge, on the day it switched).
//
// Placement row: dev-script + lint (scripts/placement-registry.ts).

// IT PROVES IT READ scripts/ BEFORE IT SAYS GREEN (#6289). The cause, found by that proof on its first CI run
// (48570): CI's compiler printed its pretty, coloured form, and nothing matched an error line. It said green in CI on #6188's recheck tree
// (run 48474) while the same files carried two TS2554 errors that every local push then refused on. A lint
// that passes when the compiler printed nothing it recognises cannot tell "no errors" from "checked nothing",
// so a run whose file list names no scripts/ file, or a compiler that failed without one error line, is red.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BIG_BYTES = 1_500_000;
/** Fewer scripts/ files than this in the compiler's list is a run that did not read the project. */
export const MIN_SCRIPTS_READ = 50;

/** PURE. The lint's verdict from what tsgo printed (`--listFiles` and its errors) and whether it exited 0. */
export function judge(out: string, exitedClean: boolean, cwd = process.cwd()) {
  const lines = out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim());
  const errors = lines.filter((l) => /error TS\d+/.test(l));
  const read = lines.filter((l) => l && !/error TS\d+/.test(l) && !l.includes("/node_modules/") && /(^|\/)scripts\/[^/]/.test(l.replace(`${cwd}/`, "")));
  const hits = errors.filter((l) => /^(\.\/)?scripts\/.*error TS\d+/.test(l.replace(`${cwd}/`, "")));
  if (read.length < MIN_SCRIPTS_READ) return { ok: false as const, why: "read", read: read.length, hits, head: lines.filter(Boolean).slice(0, 8) };
  if (!exitedClean && errors.length === 0) return { ok: false as const, why: "crashed", read: read.length, hits, head: lines.filter(Boolean).slice(0, 8) };
  if (hits.length) return { ok: false as const, why: "errors", read: read.length, hits, head: [] };
  return { ok: true as const, read: read.length, hits, head: [] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let out = "";
  let clean = true;
  try {
    // --pretty false: under CI the compiler printed its pretty form (`file:line:col - error TS…`, coloured), which
    // no filter here matched, so this lint was green there whatever scripts/ carried (#6289, run 48570).
    out = execFileSync("npx", ["tsgo", "-p", "tsconfig.scripts.json", "--noEmit", "--listFiles", "--pretty", "false"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    clean = false;
  }

  const big = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("/node_modules/") && !/error TS\d+/.test(l))
    .flatMap((f) => {
      try {
        const n = statSync(f).size;
        return n > BIG_BYTES ? [`${f.replace(`${process.cwd()}/`, "")} (${(n / 1e6).toFixed(1)} MB)`] : [];
      } catch {
        return [];
      }
    });
  if (big.length > 0) {
    console.error("scripts/ typechecks a file too big to parse on every run:");
    for (const b of big) console.error(`  ${b}`);
    console.error("  A script or test imports it statically. Load it when the test runs instead, through a");
    console.error("  specifier the compiler does not follow (see scripts/lib/a-downloaded-bridge-can-serve-several-instruments.test.ts).");
    process.exit(1);
  }

  const v = judge(out, clean);
  if (!v.ok && v.why !== "errors") {
    console.error(
      v.why === "read"
        ? `scripts/ was NOT typechecked: the compiler listed ${v.read} scripts/ file(s), fewer than ${MIN_SCRIPTS_READ}. A green here would have checked nothing. Its first lines:`
        : "scripts/ was NOT typechecked: the compiler failed without printing one error. Its first lines:",
    );
    for (const h of v.head) console.error(`  ${h}`);
    process.exit(1);
  }
  if (!v.ok) {
    console.error(`scripts/ does not typecheck (${v.hits.length} error(s)):`);
    console.error("");
    for (const h of v.hits.slice(0, 40)) console.error(`  ${h}`);
    if (v.hits.length > 40) console.error(`  ...and ${v.hits.length - 40} more`);
    process.exit(1);
  }
  console.log(`scripts/ typechecks (${v.read} scripts/ files read)`);
}
