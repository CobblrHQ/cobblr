// Guard: GENERIC web components must not hardcode module entity-kinds.
//
// web/src/components/ is the shared, module-agnostic layer — a component there
// is supposed to work for ANY module's entities. A hardcoded kind literal
// ("inventory:part", "machines:machine") quietly turns a platform feature into
// a three-module feature: every future physical/domain module is silently
// excluded (the ContentsPanel add-picker almost shipped exactly this).
//
// The right source is the entity-kind registry (api.listEntityKinds) filtered
// by the kinds' declared TRAITS (tangibility/containment/identity …) — same
// rule as "behavior derives from declared roles/traits, never keyword lists"
// (.claude/skills/code-contribution/SKILL.md rule 3).
//
// Page-level module UIs (web/src/pages/MachinesPage.tsx etc.) are exempt —
// naming your own module's kind on its own page is fine. Comments are stripped
// before matching. Deliberate exceptions go in
// scripts/generic-component-kinds-baseline.json with a reason.
//
// Run: npx tsx scripts/lint-generic-component-kinds.ts

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const COMPONENTS_DIR = join(ROOT, "web", "src", "components");
const BASELINE_PATH = join(ROOT, "scripts", "generic-component-kinds-baseline.json");

const moduleNames = new Set(
  readdirSync(join(ROOT, "modules"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name),
);

interface BaselineEntry {
  file: string;
  token: string;
  reason: string;
}
const baseline: BaselineEntry[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineEntry[])
  : [];
const baselined = new Set(baseline.map((b) => `${b.file}|${b.token}`));

function stripComments(src: string): string {
  // Block comments → keep line count (replace with newlines); line comments →
  // cut to end of line. Good enough for a lint (no need for a full parser).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/\/\/[^\n]*/g, "");
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

const KIND_LITERAL = /["'`]([a-z][a-z0-9_-]*):([a-z][a-z0-9_-]*)["'`]/g;

const findings: Array<{ file: string; line: number; token: string }> = [];
if (existsSync(COMPONENTS_DIR)) {
  for (const file of walk(COMPONENTS_DIR)) {
    const rel = relative(ROOT, file);
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((l, i) => {
      for (const m of l.matchAll(KIND_LITERAL)) {
        if (!moduleNames.has(m[1]!)) continue;
        if (baselined.has(`${rel}|${m[0]}`)) continue;
        findings.push({ file: rel, line: i + 1, token: m[0]! });
      }
    });
  }
}

if (findings.length === 0) {
  console.log(
    `[lint:component-kinds] ✓ no generic component hardcodes a module entity-kind (${baseline.length} baselined)`,
  );
  process.exit(0);
}
console.error(
  `[lint:component-kinds] ✗ ${findings.length} hardcoded module entity-kind(s) in the GENERIC components layer:`,
);
for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.token}`);
console.error(
  "\nGeneric components derive kinds from the registry (api.listEntityKinds) filtered by\n" +
    "declared traits — never a hardcoded module list (that silently excludes every future\n" +
    "module). If this literal is genuinely deliberate, add it to\n" +
    "scripts/generic-component-kinds-baseline.json with a reason.",
);
process.exit(1);
