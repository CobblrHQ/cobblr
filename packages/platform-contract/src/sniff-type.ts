// What a file IS, from its first bytes: the one answer every reader of a
// stored file trusts over the type it was stored with.
//
// A stored content type is a claim (the browser's, the upload's, whatever an
// earlier door wrote) and claims go wrong: a scanned bill of sale was stored
// under a non-PDF type, served as a download, and then shown as its raw bytes
// in the text viewer (`%PDF-1.3 … /Subtype /Image …`, then binary). The bytes
// cannot be wrong about themselves. So the store corrects a wrong claim on the
// way in, the raw route serves the bytes' own type and heals the row on the
// way out, and a viewer chooses its renderer from the same answer, refusing to
// show anything binary as text.

/** A type the bytes name for themselves, or null when they name none (plain
 *  text, CSV, or a format with no fixed signature here). */
export function sniffType(head: Uint8Array): string | null {
  const b = head;
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 5 && at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf"; // %PDF-
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (b.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^avif$/.test(brand)) return "image/avif";
  }
  return null;
}

/** Whether the bytes are not text: a NUL, or more than one in ten control
 *  characters that text never carries. A text viewer refuses these. */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 4096);
  if (n === 0) return false;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = head[i]!;
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) odd++;
  }
  return odd / n > 0.1;
}

/** The type a stored file should be treated as: the bytes' own when they name
 *  one, else the stored claim. */
export function trueType(head: Uint8Array, stored: string | null | undefined): string {
  return sniffType(head) ?? (stored || "application/octet-stream");
}

/** How a viewer shows a file: as an image, a PDF, text, or not at all. */
export type ShownAs = "image" | "pdf" | "text" | "binary";

export function shownAs(head: Uint8Array, stored: string | null | undefined): ShownAs {
  const t = trueType(head, stored);
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("image/") && sniffType(head)) return "image";
  return looksBinary(head) ? "binary" : "text";
}
