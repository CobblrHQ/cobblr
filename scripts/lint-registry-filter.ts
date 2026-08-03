// The registry-filter guard. The entity-kind registry (listEntityKinds /
// getKinds) is the FUNDAMENTAL record of everything a workspace holds. A user-
// facing enumeration of record kinds must be filtered FROM that master list —
// never sliced by an implementation detail that silently drops kinds.
//
// The bug this prevents: the "Use from a script" page filtered the registry to
// `k.instance_name` (instance-backed kinds only), which silently omitted every
// MODULE kind — Inventory, Locations, Assets. A script couldn't be shown how to
// touch them. The field that distinguishes the two routing families
// (instance vs module) is exactly the wrong axis to slice on.
//
// So: a `.filter` over the kinds registry whose predicate keys off
// `instance_name` (or `is_primary`) is flagged — that's subsetting the master
// list by routing shape. (A `.find(... === name)` single-item LOOKUP is fine and
// not flagged; it isn't dropping kinds from a user-facing list.) If you
// genuinely must slice on it, say why with an inline
// `// registry-filter-ok: <reason>` on the line or
// the line above — the reason is the point (it forces the "am I dropping kinds
// a user needs?" check). Existing hits are BASELINED (green today, fail on any
// new one); shrink the baseline, never grow it (refresh with --update).

import ts from "typescript";
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts/registry-filter-baseline.json");
// The registry-shape fields whose presence/absence slices the kinds list into a
// subset. Filtering on these is "not using the whole master list".
const SLICE_FIELD = /\b(instance_name|is_primary)\b/;
const NARROWERS = new Set(["filter"]);
const OK = /registry-filter-ok:/;

const violations: { file: string; line: number; text: string }[] = [];

function scanFile(path: string) {
  const src = readFileSync(path, "utf8");
  if (!SLICE_FIELD.test(src)) return;
  const lines = src.split("\n");
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      NARROWERS.has(node.expression.name.text)
    ) {
      const cb = node.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && SLICE_FIELD.test(cb.getText())) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        // Escape hatch: reason on this line or the line above.
        const excused = OK.test(lines[line] ?? "") || OK.test(lines[line - 1] ?? "");
        if (!excused) {
          violations.push({
            file: relative(ROOT, path),
            line: line + 1,
            text: node.expression.name.text + "(): " + cb.getText().replace(/\s+/g, " ").trim().slice(0, 80),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__snapshots__") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) scanFile(p);
  }
}

for (const root of ["web/src", "api/src", "modules", "packages"]) {
  try {
    walk(join(ROOT, root));
  } catch {
    /* absent root - skip */
  }
}

const key = (v: { file: string; text: string }) => `${v.file}::${v.text}`;

if (process.argv.includes("--update")) {
  const rows = violations.map((v) => ({ file: v.file, text: v.text })).sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`lint:registry-filter - baseline rewritten with ${rows.length} entries.`);
  process.exit(0);
}

const baseline: { file: string; text: string }[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { file: string; text: string }[])
  : [];
const known = new Set(baseline.map(key));
const fresh = violations.filter((v) => !known.has(key(v)));

if (fresh.length) {
  console.error(
    `Slicing the entity-kind registry by routing shape (${fresh.length} new). The registry is the\n` +
      `master list of everything a workspace holds; filtering it by instance_name / is_primary\n` +
      `silently drops kinds a user may need (Inventory/Locations are MODULE kinds, not instances).\n` +
      `Filter from the whole list. If you truly must slice on it, add an inline\n` +
      `'// registry-filter-ok: <reason>' on the line or the line above:`,
  );
  for (const v of fresh) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}
console.log(`lint:registry-filter - no NEW registry slicing by routing shape (${baseline.length} baselined).`);
