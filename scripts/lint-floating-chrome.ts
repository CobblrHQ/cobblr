// Floating chrome (fixed, bottom-anchored pills/FABs) whose z-index BEATS the
// right-side panel's z-[60] floats OVER an open Ask Cobb / Notifications sheet
// — the Live pill (z-900) sat on top of Cobb's send button on mobile (reported
// 2026-08-01), and Quick access (z-80) had the same latent bug. Anything that
// out-stacks the panel must carry HIDE_WHEN_SIDE_PANEL_OPEN (SidePanel.tsx) so
// it yields while a panel is open. Chrome BELOW z-60 is fine: the panel simply
// covers it.
//
// Deliberately dumb: it flags a single string literal that contains `fixed`, a
// `bottom-*` anchor and a z-[N] with N > 60, unless the LITERAL'S EXPRESSION
// neighbourhood references HIDE_WHEN_SIDE_PANEL_OPEN. SidePanel itself and
// modal/backdrop layers use inset/top anchoring, so they don't match.

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["web/src", "packages", "modules"];
// A MODAL is z-50 — the lowest overlay, and the most common one — so
// anything above that can cover an overlay. The first version used the
// side panel's 60 and let the z-55 feedback bubble float over every modal
// on a phone (reported 2026-08-01).
const PANEL_Z = 50;
// Either spelling: the flag moved into platform-web as HIDE_WHEN_OVERLAY_OPEN
// (modals set it too now); SidePanel re-exports the old name.
const HIDE = /HIDE_WHEN_(SIDE_PANEL|OVERLAY)_OPEN/;

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
    const src = readFileSync(file, "utf8");
    if (!/z-\[\d+\]/.test(src) || !src.includes("fixed")) continue;
    // An OVERLAY is not floating chrome: it's the thing chrome must yield TO,
    // and it obviously must not hide itself. Overlays are identified by the
    // flag they raise, so this needs no allowlist to maintain.
    if (src.includes("useOverlayOpenFlag")) continue;
    const sf = ts.createSourceFile(
      file, src, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const t = node.text;
        const z = t.match(/z-\[(\d+)\]/);
        if (
          z && Number(z[1]) > PANEL_Z &&
          /(^|\s)fixed(\s|$)/.test(t) &&
          /\bbottom-/.test(t) &&
          // A pointer-events-none layer (the toast stack) never blocks a tap,
          // and transient feedback SHOULD show over an open panel — a "Filed
          // it" toast fired from inside Ask Cobb must be visible.
          !t.includes("pointer-events-none")
        ) {
          // Allowed when the same expression mixes in the hide variant — walk a
          // few parents looking for the identifier (covers `"…" + CONST` and
          // template forms).
          let p: ts.Node | undefined = node;
          let ok = false;
          for (let i = 0; i < 4 && p; i++, p = p.parent) {
            if (HIDE.test(p.getText(sf))) { ok = true; break; }
          }
          if (!ok) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push({ file: relative(ROOT, file), line: line + 1, text: t.trim().slice(0, 100) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error("lint:floating-chrome - fixed bottom chrome out-stacks overlays (z > 50) without yielding:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  console.error(
    "This floats OVER any open overlay - a modal, Ask Cobb, Notifications (the\n" +
      "Live-pill-over-the-composer bug, then the feedback bubble over every modal\n" +
      "on a phone). Mix in HIDE_WHEN_OVERLAY_OPEN from @cobblr/platform-web, or\n" +
      "drop the z-index below 50 so overlays cover it naturally.",
  );
  process.exit(1);
}

console.log("lint:floating-chrome - all high-z floating chrome yields to overlays.");
