// A modal shows up on the PAGE IT WAS INVOKED FROM (the author's house rule).
//
// The recurring violation: "show me that bundle" answered by navigating to
// /bundles?open=<id>. That is a different page behind a dialog, and it throws
// away whatever the user was in the middle of. The reported case: the Build
// page's ready-made callout — you type an intent, click "View & install", land
// on Bundles, close the modal, go back, and your typing is gone.
//
// It had already been "fixed" twice without fixing the class: the dashboard
// heads-up got its own inline modal, and two other sites bolted a `returnTo`
// param onto the URL that BundlesPage never read, so even the workaround was
// dead code. Hence a lint.
//
// Use web/src/components/useBundleDetail.tsx instead — two lines, and it falls
// back to navigation only for a bundle that isn't in the catalog (nothing
// becomes unreachable).

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["web/src", "modules"];
// The one legitimate producer of this URL: the shared hook's catalog-miss
// fallback. Everything else must go through the hook.
const ALLOW = new Set(["web/src/components/useBundleDetail.tsx"]);
const BAD = /\/bundles\?open=/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const violations: Array<{ file: string; line: number; text: string }> = [];

for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    const rel = relative(ROOT, file);
    if (ALLOW.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    if (!BAD.test(src)) continue;
    const sf = ts.createSourceFile(
      file, src, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node)
      ) {
        if (BAD.test(node.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({ file: rel, line: line + 1, text: node.text.trim().slice(0, 70) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error("lint:modal-in-place - navigating to /bundles to show a bundle:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  console.error(
    "A modal belongs on the page it was invoked from; navigating away discards\n" +
      "whatever the user was doing there. Use useBundleDetail(slug):\n" +
      "  const bundleDetail = useBundleDetail(slug);\n" +
      '  <button onClick={() => bundleDetail.open(externalId)}>details</button>\n' +
      "  {bundleDetail.element}",
  );
  process.exit(1);
}

console.log("lint:modal-in-place - no page navigation stands in for a bundle modal.");
