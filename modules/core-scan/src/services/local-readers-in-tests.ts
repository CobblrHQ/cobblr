// Whether a test that needs the local document readers may judge here (#7778).
//
// The readers are tesseract (OCR) and poppler (pdftotext, pdfinfo, pdftoppm):
// the api image and the CI image (docker/ci-pg/Dockerfile) install both, a
// laptop may not. Without them a PDF or a scanned page is one code cannot
// read, which stays personal (#5243), so a test that needs them and does not
// ask reads as a product verdict: "the scanned PDF is read" failed with "This
// is a personal document" on a machine with neither, and was filed as a
// regression. The other OCR tests split two ways: the plain scripts printed
// SKIPPED and passed even in CI, where an image that lost the engine would
// have judged nothing, and the vitest ones failed on every laptop without it.
//
// One rule now. In CI the readers must be there: their absence is a broken
// image, said as one. Anywhere else a test without them is skipped, and says
// what it did not verify.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ocrAvailable } from "./ocr.js";

/** In CI by the runner's own variable: scripts/lib/parallel.mjs sets CI for
 *  every child, on a laptop too. */
const inCi = () => process.env.GITHUB_ACTIONS === "true";

const popplerHere = () => promisify(execFile)("pdftotext", ["-v"]).then(() => true, (e: NodeJS.ErrnoException) => e.code !== "ENOENT");

/** True when the test can judge: every reader it names is here. False, with a
 *  SKIPPED line naming `what` and what is missing, off CI. Throws in CI. */
export async function localReadersForTest(what: string, need: { ocr?: boolean; pdf?: boolean } = { ocr: true }): Promise<boolean> {
  const missing = [
    ...(need.ocr && !(await ocrAvailable()) ? ["tesseract"] : []),
    ...(need.pdf && !(await popplerHere()) ? ["poppler (pdftotext)"] : []),
  ];
  if (!missing.length) return true;
  if (inCi()) {
    throw new Error(`${missing.join(" and ")} not on PATH in CI, so ${what} cannot be judged. The CI image installs tesseract-ocr and poppler-utils (docker/ci-pg/Dockerfile); rebuild it.`);
  }
  console.log(`SKIPPED: ${what}: ${missing.join(" and ")} not on this machine; nothing verified here. CI judges it.`);
  return false;
}
