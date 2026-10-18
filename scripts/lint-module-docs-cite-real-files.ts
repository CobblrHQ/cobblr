#!/usr/bin/env tsx
// A module doc names only files that exist: every repo path it cites in code format is a file or directory in this repo.
//
// THE BUG THIS PREVENTS. The #7217 audit, 2026-10-17: 20 paths cited in
// docs/modules pointed at files that had moved (tests out of api/tests into
// the folder of the code they hold) or been removed (a retired boot pass, a
// renamed page). A reader sent to a missing file stops trusting the doc.
//
// THE RULE. A code-formatted token that starts with a top-level folder of this
// repo (`modules/`, `api/`, `web/`, `packages/`, `scripts/`, `e2e/`, `docs/`,
// `bundles/`, `deploy/`, `docker/`, `changelog.d/`) must name something on
// disk, after a `:line` or `#anchor` suffix is dropped. A module doc often
// cites a path inside its own module (`api/inbox.ts`, `src/stock-floor.ts`),
// so a path is also found under any `modules/<name>/` or
// `modules/<name>/src/`. A token with a wildcard or a placeholder (`*`, `<`,
// `{`) is a pattern, not a path, and is skipped.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Some docs cite files of
// another repository: the older app's `api/src/routes/inbox.ts`
// and the bridge's `docs/sdcp.md`. Those name their repo on the same line or
// the line before, and a line that does is skipped. A path that was removed is
// written without code format ("`x.ts`, since removed" keeps the bare name),
// never cited as if it were still there.
//
//   npx tsx scripts/lint-module-docs-cite-real-files.ts   (pnpm lint module-docs-cite-real-files)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOT = process.cwd();
const DOCS = "docs/modules";
const REPO_FOLDER = /^(modules|api|web|packages|scripts|e2e|docs|bundles|deploy|docker|changelog\.d)\//;
const OTHER_REPO = /\brepo(sitory)?\b|\bClassic\b|bridge's/i;
const MODULES = readdirSync(join(ROOT, "modules"));

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function citedPath(token: string): string | null {
  const path = token.replace(/[:#].*$/, "").replace(/[),.;]+$/, "");
  if (!REPO_FOLDER.test(path) || /[*<{]/.test(path)) return null;
  return path;
}

export function exists(path: string): boolean {
  if (existsSync(join(ROOT, path))) return true;
  return MODULES.some((m) => existsSync(join(ROOT, "modules", m, path)) || existsSync(join(ROOT, "modules", m, "src", path)));
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (OTHER_REPO.test(line) || OTHER_REPO.test(lines[i - 1] ?? "")) continue;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const path = citedPath(m[1] ?? "");
      if (path && !exists(path)) out.push({ file, line: i + 1, what: `\`${path}\` is not in this repo` });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const name of readdirSync(join(ROOT, DOCS)).filter((n) => n.endsWith(".md")).sort()) {
  const file = `${DOCS}/${name}`;
  if (onlyChanged(file)) violations.push(...check(file, readFileSync(join(ROOT, file), "utf8")));
}

if (violations.length) {
  console.error(`lint:module-docs-cite-real-files - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("point the path at where the file is now, or say it was removed without code-formatting the old path");
  process.exit(1);
}
console.log(`lint:module-docs-cite-real-files OK`);
