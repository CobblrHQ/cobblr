#!/usr/bin/env tsx
// Workspace-vocab lint. A placeholder / empty-state / call-to-action string
// shown to a user must read in THAT WORKSPACE'S OWN vocabulary (its enabled
// modules, its instance display names, the kinds that actually exist in the
// space) — NOT a hardcoded generic platform noun ("search a task, project…",
// "Add your first item", "part / asset / project…"). Cobblr is a modular
// kernel with nothing hardcoded (MEMORY: "modular kernel, nothing hardcoded";
// "generic placeholders in UI/prompts"): a space with only a Yarn bundle should
// never be told to "add a part". the author (2026-07-12): "lint for this type of
// generic verbiage instead of workspace-specific 'what is there' terms cuz we
// keep finding issues like this." The recurring exemplar was AllocationsPanel's
// `placeholder="search a task, project, anything to reserve for…"`.
//
// WHAT IT FLAGS — a STRING LITERAL in one of these UI roles that names a GENERIC
// platform entity-noun (see NOUNS) as if it were the user's vocabulary:
//   • placeholder=  attributes                (`placeholder="a part…"`)
//   • call-to-action / empty-state copy       ("Add your first task", "No parts
//     yet", "search a project", "create your first item")
// The offending noun should instead derive from the space — a kind's display
// name (`kindLabel(entity_kind)`), the enabled module's noun, or a neutral word
// ("anything", "something", "an entry to reserve for…").
//
// WHAT IT DOES *NOT* FLAG (kept precise to hold false-positives low):
//   • dynamic strings already built from a variable/prop ({noun}, `${x}`) — only
//     STATIC quoted/JSX-text literals are scanned.
//   • kind IDENTIFIERS ("inventory:part", "machines:machine") — config, not
//     prose; any literal containing a `word:word` token is skipped.
//   • comment lines (`//`, `*`, `/* */`).
//   • a line carrying an inline suppression comment (see SUPPRESSION).
//
// SUPPRESSION — a legitimately-generic string (a genuinely cross-kind picker, a
// platform-level noun that has no per-workspace vocabulary) opts out with an
// inline comment on the SAME line or the line ABOVE:
//     placeholder="search anything"   // vocab-lint-ok: cross-kind global picker
// Put a real reason after the colon.
//
// BASELINE — like the sibling ui-jargon lint, current hits live in a committed
// baseline (scripts/workspace-vocab-baseline.json) so the tree passes clean
// today; every NEW hit fails. To retire a baselined offender, fix the string
// (the baseline key stops matching — harmless) or, if it turns out legitimately
// generic, add a `// vocab-lint-ok:` suppression and re-run --write-baseline.
// Add a new genuinely-technical/legit literal with --write-baseline.
//
//   cd <repo> && npx tsx scripts/lint-workspace-vocab.ts
//   cd <repo> && npx tsx scripts/lint-workspace-vocab.ts --write-baseline
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "modules"];
const BASELINE = join("scripts", "workspace-vocab-baseline.json");

// Generic platform entity-nouns that should almost never be hardcoded as the
// user's vocabulary. Tuned to avoid noise (e.g. "note", "tag", "file", "user"
// are deliberately excluded — they're either true platform primitives or too
// common in honest generic use). Matched as a standalone word, singular OR
// plural.
const NOUNS = ["task", "project", "item", "part", "thing", "asset", "machine", "record", "entry"];
const NOUN_RE = new RegExp(`\\b(${NOUNS.join("|")})(s|es)?\\b`, "i");

const N = `(?:${NOUNS.join("|")})(?:s|es)?`;
// CALL-TO-ACTION / empty-state shapes that front a generic noun the user is
// meant to read as "the thing in my space". Deliberately NARROW — exactly the
// phrasings the author keeps finding, so titles / tooltips / toasts / button labels
// don't get swept in:
//   • "No <noun> yet"            (empty-state)   — "No tasks yet", "No parts yet"
//   • "Add/Create your first <noun>"             — "Add your first item"
//   • "search a/an <noun>"       (picker prompt) — the AllocationsPanel exemplar
const CTA_RES: RegExp[] = [
  new RegExp(`\\bno\\s+${N}\\b[^.]*?\\byet\\b`, "i"),
  new RegExp(`\\b(?:add|create)\\s+your\\s+first\\s+${N}\\b`, "i"),
  new RegExp(`\\bsearch\\s+an?\\s+${N}\\b`, "i"),
];

// A kind identifier like `inventory:part` or `machines:machine` — config, never
// prose. If a literal carries one, it's a target-kind field, not user copy.
const KIND_ID_RE = /[a-z0-9_]+:[a-z0-9_]+/i;

// Lines whose flagged text is an attribute/API the task says to leave alone:
// genuinely-generic titles / aria-labels / alt text, page titles, and toasts.
const IGNORE_LINE_RE = /\b(?:title|aria-label|aria-labelledby|alt)\s*=|usePageTitle\s*\(|\btoast\.(?:error|success|info|message)\s*\(/;

const SUPPRESS_RE = /vocab-lint-ok:/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".vite") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*");
}

// Extract the STATIC value of a `placeholder=` attribute, if any. Dynamic values
// (`{expr}`, or a template literal carrying `${…}`) are already derived from a
// variable → returns null (nothing to flag).
function placeholderValue(line: string): string | null {
  const m = line.match(/placeholder\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\})/);
  if (!m) return null;
  const v = m[1] ?? m[2] ?? m[3] ?? "";
  if (v.includes("${")) return null; // interpolated → dynamic
  if (v.includes("\\n") || v.includes("\n")) return null; // multi-line format/paste sample, not vocab prose
  return v;
}

interface Finding {
  file: string;
  line: number;
  snippet: string;
  role: string;
  key: string;
}

const found: Finding[] = [];
for (const root of ROOTS) {
  for (const file of tsxFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (SUPPRESS_RE.test(line)) return;
      if (i > 0 && SUPPRESS_RE.test(lines[i - 1])) return;

      let hitRole: string | null = null;
      let hitText = "";

      // Role 1 — placeholder= attribute value.
      const ph = placeholderValue(line);
      if (ph && ph.length >= 2 && !KIND_ID_RE.test(ph) && NOUN_RE.test(ph)) {
        hitRole = "placeholder";
        hitText = ph;
      }

      // Role 2 — empty-state / CTA copy (quoted literal OR JSX text). Skip lines
      // whose flagged text lives in a title/aria/alt/pageTitle/toast (generic by
      // design, per the spec's "don't flag").
      if (!hitRole && !IGNORE_LINE_RE.test(line)) {
        for (const re of CTA_RES) {
          const m = line.match(re);
          if (m && !KIND_ID_RE.test(m[0])) {
            hitRole = "cta";
            hitText = m[0].trim();
            break;
          }
        }
      }

      if (!hitRole) return;
      found.push({
        file,
        line: i + 1,
        snippet: line.trim(),
        role: hitRole,
        key: `${file}::${hitText.slice(0, 80)}`,
      });
    });
  }
}

if (process.argv.includes("--write-baseline")) {
  const keys = [...new Set(found.map((f) => f.key))].sort();
  writeFileSync(BASELINE, JSON.stringify(keys, null, 2) + "\n");
  console.log(`[lint:workspace-vocab] wrote baseline with ${keys.length} entr${keys.length === 1 ? "y" : "ies"}.`);
  process.exit(0);
}

let baseline: Set<string>;
try {
  baseline = new Set(JSON.parse(readFileSync(BASELINE, "utf8")) as string[]);
} catch {
  baseline = new Set();
}
const violations = found.filter((f) => !baseline.has(f.key));

if (process.argv.includes("--all")) {
  // Diagnostic: print every current hit (baselined or not) for triage.
  console.log(`[lint:workspace-vocab] ${found.length} total hit(s) in the tree:\n`);
  for (const f of found) {
    console.log(`  ${f.file}:${f.line} - ${f.snippet.slice(0, 120)} - suggestion: derive from workspace vocab`);
  }
  process.exit(0);
}

if (violations.length > 0) {
  console.error(
    `✗ workspace-vocab lint: ${violations.length} NEW UI string(s) hardcoding a generic platform noun instead of the workspace's own vocabulary:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} - ${v.snippet.slice(0, 120)} - suggestion: derive from workspace vocab`);
  }
  console.error(`\nA placeholder / empty-state / CTA shown to a user must read in the SPACE'S OWN nouns
(its enabled modules / instance display names / the kinds that exist), not a hardcoded
"task"/"part"/"item"/… Derive it: kindLabel(entity_kind), the module's noun, or a neutral
word ("anything", "an entry"). If this string is legitimately generic, add an inline
'// vocab-lint-ok: <reason>' on the line or the line above, then:
  npx tsx scripts/lint-workspace-vocab.ts --write-baseline`);
  process.exit(1);
}
console.log(`✓ workspace-vocab lint: no new hardcoded generic nouns in UI copy (${baseline.size} baselined).`);
