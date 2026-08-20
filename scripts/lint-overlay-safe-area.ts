/**
 * A full-screen overlay's close button must clear the phone's safe area.
 *
 * `fixed inset-0` means the overlay's top edge is the PHYSICAL top of the
 * display, above the iOS status bar and Dynamic Island. A close button pinned
 * there with a plain `top-3` lands underneath them and the OS eats the tap.
 * Reported 2026-08-18 against the scan inbox photo viewer, which had to be
 * dismissed with its footer button instead; the same markup had already been
 * copied into the receipt viewer, which has no footer and so had no way out
 * at all.
 *
 * The fix is `OverlayCloseButton`, which carries the inset. This lint exists so
 * the next full-screen viewer cannot quietly hand-roll a third copy.
 *
 * Scope is deliberately narrow: only an element that IDENTIFIES ITSELF as a
 * close control (aria-label="Close") and is absolutely pinned near the top. A
 * badge on a card, an invisible click-catcher backdrop, or a button inside a
 * positioned card all share the `fixed inset-0` / `top-N` vocabulary and none
 * of them are this bug.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".tsx")) yield p;
  }
}

const OVERLAY = /fixed inset-0/;
/** `absolute` + a small top offset, in either order, within one className. */
const PINNED_TOP = /className="[^"]*\babsolute\b[^"]*\btop-(?:0|0\.5|1|1\.5|2|2\.5|3|3\.5|4)\b[^"]*"/;
const CLOSE_LABEL = /aria-label="Close"/;

const failures: string[] = [];

for (const file of [...walk(join(ROOT, "web/src")), ...walk(join(ROOT, "packages"))]) {
  const src = readFileSync(file, "utf8");
  if (!OVERLAY.test(src)) continue;
  // Walk each JSX element that declares itself a close control and check the
  // className it was given.
  const elements = src.split(/<(?=button|div|span|a\b)/);
  for (const el of elements) {
    const head = el.slice(0, el.indexOf(">") + 1);
    if (!CLOSE_LABEL.test(head) || !PINNED_TOP.test(head)) continue;
    if (/env\(safe-area-inset-top\)/.test(head)) continue; // rolled its own inset, fine
    const line = src.slice(0, src.indexOf(head)).split("\n").length;
    failures.push(
      `${file.replace(ROOT, "")}:${line} — a close button pinned to the top of a full-screen overlay.\n` +
        `    On a notched phone that sits under the status bar and cannot be tapped.\n` +
        `    Use <OverlayCloseButton onClose={...} /> (web/src/components/OverlayCloseButton.tsx).`,
    );
  }
}

if (failures.length) {
  console.error("lint:overlay-safe-area — hand-rolled overlay close button:\n");
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log(`lint:overlay-safe-area — ok`);
