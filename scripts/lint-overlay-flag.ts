// A FULL-SCREEN overlay must announce itself, or floating chrome floats over it.
//
// `data-overlay-open` (platform-web/overlay-open.ts) is how the Live pill, Quick
// access and the feedback bubble know to get out of the way. It is opt-in, so it
// only protects overlays that remember to raise it — and the camera scanner never
// did. It is a body-portaled `fixed inset-0 z-40` surface covering the entire app,
// and the Live pill sat on top of the viewfinder for months (the author, 2026-08-03:
// "it def does not belong anywhere in the camera scanner").
//
// The z-index fix (Live now sits BELOW every overlay) is the structural half. This
// lint is the other half: it stops the NEXT full-screen overlay from being invisible
// to everything that yields to overlays. Any component that paints a `fixed inset-0`
// layer at z >= 40 must call useOverlayOpenFlag (directly, or by rendering a Modal /
// SidePanel, which raise it for you).
//
// Deliberately narrow: only `fixed inset-0` (a full-screen cover) at overlay depth.
// A positioned popover or a scrim inside an already-flagged overlay is not this.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["web/src", "packages", "modules"];
/** A Modal is the lowest overlay at z-50; the scanner is z-40. Below 40 a layer
 *  is page furniture, and overlays are meant to cover it. */
const OVERLAY_Z = 40;
// ONLY the direct call counts. The first draft also accepted "renders a <Modal>
// somewhere in the file", which let the camera scanner through — it renders the
// assign-area Modal, so it looked covered while its OWN fixed inset-0 layer was
// unflagged. That is the precise bug this lint exists for, and the free pass
// meant it would never have caught it. A Modal raises the flag while the MODAL
// is open; it says nothing about the page-level surface hosting it.
// The CALL, not the mention: an import alone satisfied the first version, so
// commenting out the call still passed. (Caught by testing the lint against the
// bug it was written for — twice.)
const RAISES = /useOverlayOpenFlag\s*\(|<OverlayFlag\b/;
/** The helper's own module and its tests describe the mechanism, not a surface. */
const EXEMPT = /overlay-open\.(ts|tsx)$|\.test\.(ts|tsx)$/;

// A RATCHET, not a clean sweep. These overlays predate the rule and are all at
// z >= 50, so the Live pill (now z-35) no longer reaches them — but the OTHER
// yielding chrome (Quick access at z-120, the feedback bubble) still can, which
// is the same bug with a different pill. Fixing all fourteen is its own change
// with its own blast radius; recording them here stops the list from GROWING
// while that happens. Delete a line as each one starts raising the flag.
// See docs/BACKLOG.md "Overlays that do not raise data-overlay-open".
const KNOWN_GAPS = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const violations: string[] = [];

for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    if (EXEMPT.test(file)) continue;
    if (KNOWN_GAPS.has(relative(ROOT, file))) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("fixed inset-0")) continue;
    if (RAISES.test(src)) continue;

    // Find each `fixed inset-0 …` class run and read its z-index.
    for (const m of src.matchAll(/[^"'`]*fixed inset-0[^"'`]*/g)) {
      const z = m[0].match(/z-\[?(\d+)\]?/);
      if (!z) continue;
      // A pointer-events-none layer is DECORATION, not an overlay: the
      // impersonation ring around the viewport and the drive-presence glow
      // cover the screen but block nothing, so chrome must NOT hide for them.
      // (Found by actually working the list, 2026-08-03.)
      if (/pointer-events-none/.test(m[0])) continue;
      if (Number(z[1]) < OVERLAY_Z) continue;
      const line = src.slice(0, m.index).split("\n").length;
      violations.push(`  ${relative(ROOT, file)}:${line}  fixed inset-0 at z-${z[1]}`);
      break;
    }
  }
}

if (violations.length > 0) {
  console.error(
    "lint:overlay-flag - full-screen overlay does not raise data-overlay-open:\n",
  );
  console.error(violations.join("\n"));
  console.error(
    "\nFloating chrome (the Live pill, Quick access, the feedback bubble) yields\n" +
      "to `data-overlay-open`. A `fixed inset-0` layer at z >= " + OVERLAY_Z + " covers the whole\n" +
      "app, so it must raise the flag or that chrome will float on top of it:\n\n" +
      "  import { useOverlayOpenFlag } from \"@cobblr/platform-web\";\n" +
      "  useOverlayOpenFlag();\n\n" +
      "Rendering a <Modal> or <SidePanel> instead raises it for you.",
  );
  process.exit(1);
}

console.log("lint:overlay-flag ok");
