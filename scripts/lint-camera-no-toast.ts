// Guard: nothing in the full-screen scanner talks to the user through a toast.
//
// A toast renders at the BOTTOM of the viewport. In a page that is nothing but
// a viewfinder, that is precisely where the shutter is, so a toast covers the
// control the user is reaching for and swallows the next touch. It has been
// found the hard way three times in this file: the filing confirmation was
// moved to a top-of-frame note, then the save note, then an e2e caught a swipe
// landing on a toast instead of the drawer. Each fix converted the one message
// that had just been complained about and left the rest.
//
// Reported 2026-08-14 ("still get toasts in camera scanner, should never
// happen") with 23 sites still live, which is what makes this a lint rather
// than a fourth comment: the file's own history shows that fixing instances
// does not hold.
//
// The scanner says things through `showFilingNote(text, tone?)`, which draws
// under the top chrome, away from every control, and carries warnings as well
// as confirmations so errors have somewhere to go too.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Surfaces that are, or live inside, the full-screen camera. */
const CAMERA_SURFACES = [
  "web/src/pages/ScanCameraPage.tsx",
  "web/src/pages/ScanCaptureDrawer.tsx",
  "web/src/components/CameraCaptureSheet.tsx",
];

/** A toast call, or the hook that mints one. Comments are stripped first, so
 *  the file may keep explaining WHY it does not use them. */
const TOAST = /\b(useToast\s*\(|toast\s*\.\s*(success|error|info|warning)\s*\()/;

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const problems: string[] = [];

for (const rel of CAMERA_SURFACES) {
  let src: string;
  try {
    src = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue; // a surface that no longer exists is not a violation
  }
  stripComments(src)
    .split("\n")
    .forEach((line, i) => {
      if (TOAST.test(line)) problems.push(`  ${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
}

if (problems.length > 0) {
  console.error(
    `[lint:camera-no-toast] ✗ ${problems.length} toast use(s) inside the full-screen scanner.\n` +
      "A toast draws over the shutter and eats the next touch.\n" +
      "Use showFilingNote(text) for a confirmation, or showFilingNote(text, \"warn\") for a failure:\n",
  );
  for (const p of problems) console.error(p);
  process.exit(1);
}

console.log(`[lint:camera-no-toast] ✓ ${CAMERA_SURFACES.length} camera surface(s) speak through the frame note.`);
