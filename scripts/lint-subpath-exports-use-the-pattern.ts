#!/usr/bin/env tsx
// A workspace package whose subpath exports map ./x to one place exports them with one pattern, and lists no subpath the pattern already covers, so a new file never edits package.json.
//
// THE BUG THIS PREVENTS. packages/platform-contract/package.json conflicted in 68 merges in 14 days
// (2026-10-11, #5761): every new contract file appended `"./x": "./src/x.ts"` to the end of its exports
// map, so any two branches that each added a file collided there, on the trailing comma of the last
// line. The semver merge driver settles the version line beside it; nothing settles that. With
// `"./*": "./src/*.ts"` a new file is importable with no edit at all, and there is nothing to collide on.
//
// THE RULE. In every packages/*/package.json and modules/*/package.json:
//   - three or more string entries of one shape (`./<k>` to `./<dir>/<k><ext>`) with no pattern for that
//     shape fail: say it once as `"./*": "./<dir>/*<ext>"`;
//   - an entry a pattern already resolves to the same file fails: it is the line two branches fight over.
// An entry that maps elsewhere (`.` to the index, `./app-surface` to a .generated.ts file) is not of
// the shape and stays. Condition objects ({ types, import }) are not judged: a module's typed-source,
// built-runtime pairs are a different shape, and none has conflicted.
//
// AND NOTHING IMPORTS A TEST FILE THROUGH A PACKAGE. The list kept exactly one thing private: the test
// files, which no entry named. A pattern exposes them, and the package map cannot close them again:
// `"./*.test": null` is what Node reads, but Vite's resolver then refused "./production-test" and three
// api test files failed to load (run 44882). So the third rule: no source imports `@cobblr/<pkg>/<x>.test`.
//
// THE BOUNDARY. Fewer than three of a shape is a package with one or two deliberate doors, not a list
// that grows; a pattern there would open every file for nothing.
//
//   npx tsx scripts/lint-subpath-exports-use-the-pattern.ts   (pnpm lint subpath-exports-use-the-pattern)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Violation {
  file: string;
  what: string;
}

/** PURE. The shape of a string entry: `./<k>` to `./<dir>/<k><ext>`, as `<dir>/*<ext>`, or null. */
export function shapeOf(key: string, target: unknown): string | null {
  if (typeof target !== "string" || !key.startsWith("./") || key.includes("*")) return null;
  const k = key.slice(2);
  const t = target.replace(/^\.\//, "");
  const i = t.lastIndexOf(k);
  if (i < 0) return null;
  const dir = t.slice(0, i);
  const ext = t.slice(i + k.length);
  if (!/^\.[a-z.]+$/.test(ext) || (dir !== "" && !dir.endsWith("/"))) return null;
  return `${dir}*${ext}`;
}

/** PURE. An import of a package's test file, as `from "@cobblr/x/y.test"`, on this line; null when none. */
export function testImport(line: string): string | null {
  return /\bfrom\s+["'](@cobblr\/[^"']+\.test)["']|\bimport\(\s*["'](@cobblr\/[^"']+\.test)["']/.exec(line)?.slice(1).find(Boolean) ?? null;
}

/** PURE. Every violation in one package's exports. */
export function check(file: string, exportsField: unknown): Violation[] {
  if (!exportsField || typeof exportsField !== "object") return [];
  const entries = Object.entries(exportsField as Record<string, unknown>);
  const patterns = new Set(entries.filter(([k, t]) => k === "./*" && typeof t === "string").map(([, t]) => (t as string).replace(/^\.\//, "")));
  const byShape = new Map<string, string[]>();
  for (const [k, t] of entries) {
    const shape = shapeOf(k, t);
    if (shape) byShape.set(shape, [...(byShape.get(shape) ?? []), k]);
  }
  const out: Violation[] = [];
  for (const [shape, keys] of byShape) {
    if (patterns.has(shape)) {
      for (const k of keys) out.push({ file, what: `"${k}" is already exported by "./*": "./${shape}"; remove the line` });
    } else if (keys.length >= 3) {
      out.push({ file, what: `${keys.length} subpath exports map ./x to ./${shape.replace("*", "x")}; replace them with "./*": "./${shape}"` });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const root of ["packages", "modules"]) {
    for (const name of readdirSync(root)) {
      const file = join(root, name, "package.json");
      if (!existsSync(file)) continue;
      violations.push(...check(file, (JSON.parse(readFileSync(file, "utf8")) as { exports?: unknown }).exports));
    }
  }
  // git grep: the whole tree in well under a second, where walking it read every file.
  let hits = "";
  try {
    hits = execFileSync("git", ["grep", "--untracked", "-nE", "@cobblr/[^\"']+\\.test[\"']", "--", "*.ts", "*.tsx", "*.mts", "*.mjs", "*.js"], { encoding: "utf8" });
  } catch {
    hits = ""; // git grep exits 1 when nothing matches
  }
  for (const hit of hits.split("\n").filter(Boolean)) {
    const [file = "", lineNo = "", ...rest] = hit.split(":");
    const spec = testImport(rest.join(":"));
    if (spec && !file.endsWith("lint-subpath-exports-use-the-pattern.ts") && !file.endsWith("a-new-contract-file-merges-without-touching-package-json.test.ts")) violations.push({ file: `${file}:${lineNo}`, what: `imports ${spec}, a test file, through the package; import what it tests instead` });
  }
  if (violations.length) {
    console.error(`lint:subpath-exports-use-the-pattern - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}  ${v.what}`);
    console.error("A list of subpath exports is a line every new file appends, and two branches that each add one conflict (#5761).");
    process.exit(1);
  }
  console.log(`lint:subpath-exports-use-the-pattern OK`);
}
