#!/usr/bin/env tsx
// A screen that takes a picture or file (usePhotoPick, usePasteImage) and uploads it keeps what it could not send through useKeptPhotos from @cobblr/platform-web, or says on a // photo-not-kept: line why nothing is lost there.
//
// THE BUG THIS PREVENTS. Offline, a part's photo was dropped with a toast to try again while the banner said changes wait until you're back (2026-11-20, #4115)
//
// THE RULE. A .tsx file that takes a picture or a file from the person
// (usePhotoPick or usePasteImage) AND uploads (api.uploadFile, uploadJson,
// sendUpload) passes when it sends through useKeptPhotos, which keeps on the
// device what could not reach the server and sends it when the connection is
// back, or calls the scan doors' own keeper, keepShot (web/src/lib/keptShots.ts):
// the keeper must really be called, never only named. Otherwise it carries
// `// photo-not-kept: <why nothing is lost>`: a form that keeps the file until
// its Save lands, a report that lists the file that failed.
// The set is discovered, the exemptions written down one by one.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A screen that only READS a
// photo (a label's barcode, a shelf for the assistant to look at) uploads
// nothing and is out of scope: ReceivePackage, RecountPage and WhatsStillHere
// drew that line. Tests are not judged; the hook's own files are.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-picture-door-keeps-what-it-could-not-send.ts   (pnpm lint a-picture-door-keeps-what-it-could-not-send)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!file.endsWith(".tsx") || /\/useKeptPhoto\.tsx$/.test(file)) return [];
  const takes = src.search(/\b(usePhotoPick|usePasteImage)\(/);
  if (takes < 0) return [];
  if (!/\bapi\.uploadFile\(|\buploadJson\s*[<(]|\bsendUpload\(/.test(src)) return [];
  // A keeper the file really calls: useKeptPhotos, or the scan doors' keepShot (web/src/lib/keptShots.ts).
  if (/\buseKeptPhotos\(|\bkeepShot\(/.test(src)) return [];
  if (/\/\/ photo-not-kept: \S/.test(src)) return [];
  return [{ file, line: src.slice(0, takes).split("\n").length, what: "takes a picture or file and uploads it, but keeps nothing that could not be sent: a photo taken offline is lost" }];
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-picture-door-keeps-what-it-could-not-send - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Send the file through useKeptPhotos(door, upload).send and render <KeptPhotoNote>, or add // photo-not-kept: <why nothing is lost>");
  process.exit(1);
}
console.log(`lint:a-picture-door-keeps-what-it-could-not-send OK`);
