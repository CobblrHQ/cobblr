#!/usr/bin/env tsx
// A screen that writes a list's settings through the shared override door (upsertOverride) names the registered action that does the same for the assistant, AI-ACTION within six lines above the call, so a settings toggle cannot ship that Cobb and the MCP server cannot reach.
//
// THE BUG THIS PREVENTS. The record page's + Lending chip turned a face on through upsertOverride with no action behind it, so the assistant could not do it (2026-10-13, #6335)
//
// WHY THE ROUTE LINT MISSED IT. PUT /entity-kind-overrides is one door for
// many settings (a list's name, icon, nav place, faces, the word for what is
// inside). lint:ai-reach-routes judges the route, and the route carries
// `AI-ACTION: platform:rename-thing`, which is true for a rename and said
// nothing about the faces the same door also writes. One annotation covered
// every caller, so a new caller with a new capability passed by inheritance.
//
// THE RULE. Every call to upsertOverride from a screen (web/src, the shared
// platform-web package, a module's UI) has `// AI-ACTION: <id>[, <id>...]`
// within six lines above it, and every id is an action some module or the
// kernel declares. The judgement moves from the shared door to each caller,
// where the author knows what this screen writes. A setting the screen writes
// that no action covers yet is said beside it with `AI-GAP: <what>, #<issue>`,
// so the gap is a sentence with an issue, never silence.
//
// THE BOUNDARY. The method's own definitions (`upsertOverride:` in a client,
// `upsertOverride?(` in an interface) and a host passing it through to the
// package are not calls a person's tap reaches, so a line that defines the
// property is not judged. Test files are not walked. The server's own callers
// (api/src) are actions or bundle installs, judged by the route lints.
//
// Proven red on faces.tsx at the merge-base: the "+ Lending" chip's call.
//
//   npx tsx scripts/lint-ui-settings-writes-name-their-action.ts   (pnpm lint ui-settings-writes-name-their-action)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { manifestSources } from "./lib/manifest-sources.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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

/** Every action id declared anywhere: the kernel's list and each module's manifest. */
function declaredActions(): Set<string> {
  const files = ["api/src/platform/platform-actions.ts"];
  for (const m of readdirSync("modules")) files.push(...manifestSources(join("modules", m)));
  const ids = new Set<string>();
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/\bid:\s*"([a-z0-9-]+:[a-z0-9-]+)"/g)) ids.add(m[1]!);
  }
  return ids;
}

const ACTIONS = declaredActions();
const CALL = /\bupsertOverride!?\s*\(/;
const MARK = /AI-ACTION:\s*([a-z0-9-]+:[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+:[a-z0-9-]+)*)/;
const LOOKBACK = 6;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!CALL.test(line)) continue;
    // `upsertOverride: (slug, body) => api.upsertOverride(slug, body)` defines
    // the property a package calls; the package's caller is what is judged.
    if (/\bupsertOverride\s*[?]?\s*:/.test(line) || /\bupsertOverride\?\(/.test(line)) continue;
    const above = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join("\n");
    const mark = MARK.exec(above);
    if (!mark) {
      out.push({ file, line: i + 1, what: "upsertOverride with no `// AI-ACTION: <id>` naming the action that does the same for the assistant" });
      continue;
    }
    if (/AI-GAP:/.test(above) && !/AI-GAP:[^\n]*#\d+/.test(above)) out.push({ file, line: i + 1, what: "AI-GAP names no issue (#<n>) for the setting no action covers yet" });
    for (const id of mark[1]!.split(",").map((x) => x.trim())) {
      if (!ACTIONS.has(id)) out.push({ file, line: i + 1, what: `AI-ACTION names "${id}", which no module or the kernel declares` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:ui-settings-writes-name-their-action - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:ui-settings-writes-name-their-action OK`);
