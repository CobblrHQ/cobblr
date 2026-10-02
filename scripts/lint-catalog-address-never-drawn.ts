#!/usr/bin/env tsx
// A row's catalog_image_url is never drawn as its picture in web/src: the catalog picture is the stored file (catalog_image_file_id) or nothing; a non-drawing read says catalog-address: <why>
//
// THE BUG THIS PREVENTS. Search results and picks that kept only an address
// (#4580, 2026-10): the inbox card drew a row's catalog_image_url straight
// from its site while the thumbnail drew the stored file that never existed,
// so a picture showed in the CATALOG panel and not on the card ("how do I have
// it in the one place but not the other?"). A dozen surfaces carried the
// address as a fallback rung behind the stored file, each one free to show a
// picture Cobblr never kept and that the site could refuse at any time.
//
// THE RULE. In web/src, packages/platform-web/src and module UIs, a line that
// reads `catalog_image_url` fails unless it is a type declaration
// (`catalog_image_url?: string | null`), the empty value
// (`catalog_image_url: null`), or carries `catalog-address: <why>` on it or
// within the three lines above, for a read that never draws (whether a lookup
// found anything, which search result is marked in use). The reason is
// required. Tests and web/src/lib/api.ts (the wire type) are not judged.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The picker's "In use" mark
// compares a result's address with the row's: that is a read of the address
// that draws nothing, and is why the rule has an annotation rather than a
// flat ban. The api side is not judged: the server stores the address beside
// the file as provenance, and that is correct.
//
// PROVE IT RED before you trust it green: it failed on CaptureTile,
// OrganizePlanSheet, ScanCaptureDrawer, ScanInboxCard, ScanLivePage,
// ScanResultModal, trackedMatchNudges and waitingScans at origin/main
// 4fbd80d4c (COBBLR_LINT_ROOT=<a checkout> points it at another tree).
//
//   npx tsx scripts/lint-catalog-address-never-drawn.ts   (pnpm lint catalog-address-never-drawn)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["web/src", "packages/platform-web/src", "modules"].map((r) => join(BASE, r));
/** Module UIs only; the api side keeps the address as provenance. */
const inScope = (file: string) => (file.startsWith("modules/") ? /\/ui\//.test(file) : !/web\/src\/lib\/api\.ts$/.test(file));

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bcatalog_image_url\b/.test(line)) continue;
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    // A type (`catalog_image_url?: string`) or the empty value, and nothing else reading it.
    if (!/\bcatalog_image_url\b(?!\??:\s*(null|string)\b)/.test(line)) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    const note = /catalog-address:\s*(.*)/.exec(near);
    if (note && note[1]!.trim().length >= 8) continue;
    out.push({
      file,
      line: i + 1,
      what: note
        ? "a catalog-address: annotation with no reason"
        : "catalog_image_url read on a surface; draw the stored file (catalog_image_file_id / rowPictures) or say catalog-address: <why this draws nothing>",
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (inScope(file.slice(BASE === "." ? 0 : BASE.length + 1))) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:catalog-address-never-drawn - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:catalog-address-never-drawn OK`);
