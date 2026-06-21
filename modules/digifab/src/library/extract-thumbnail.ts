// Pull the slicer-embedded preview out of a 3MF or gcode file — no slicer, no
// renderer, no external dependency. Both formats already carry a PNG:
//   • 3MF is a ZIP; plate previews live at Metadata/plate_<n>.png.
//   • gcode embeds a base64 PNG between "; thumbnail begin … ; thumbnail end".
// We read the ZIP via its central directory (always has correct sizes/offsets,
// unlike local headers when a data-descriptor is used) and inflate with zlib.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

/** Find a file in a ZIP buffer by predicate and return its decompressed bytes. */
function readZipEntry(buf: Buffer, match: (name: string) => boolean): Buffer | null {
  // Locate the End-Of-Central-Directory record (scan back from the end; the
  // trailing comment is almost always empty, but allow up to 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central-directory offset
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (match(name)) {
      // The local header's name/extra lengths can differ from the central one,
      // so re-read them to find where the data actually starts.
      const lhNameLen = buf.readUInt16LE(localOff + 26);
      const lhExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lhNameLen + lhExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data); // stored
      if (method === 8) { try { return inflateRawSync(data); } catch { return null; } } // deflate
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Count the plate_<n>.png entries a 3MF carries (≥1). */
function countPlates(buf: Buffer): number {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const plates = new Set<string>();
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const m = /(?:^|\/)plate_(\d+)\.png$/i.exec(name);
    if (m) plates.add(m[1]!);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return Math.max(1, plates.size);
}

/** Extract the largest embedded gcode thumbnail (base64 PNG). */
function extractGcodeThumb(buf: Buffer): Buffer | null {
  // Only scan the head + tail — thumbnails sit in the file's comment header (and
  // some slicers repeat them at the end). Decoding the whole multi-MB file as
  // text would be wasteful.
  const head = buf.subarray(0, Math.min(buf.length, 512 * 1024)).toString("latin1");
  const re = /;\s*thumbnail begin\s+\d+[xX]\d+\s+\d+([\s\S]*?);\s*thumbnail end/g;
  let best: Buffer | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    const b64 = m[1]!.replace(/;/g, "").replace(/\s+/g, "");
    try {
      const png = Buffer.from(b64, "base64");
      if (png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && (!best || png.length > best.length)) best = png;
    } catch { /* skip a malformed block */ }
  }
  return best;
}

export interface ExtractedThumb {
  png: Buffer | null;
  plateCount: number;
}

/** Pull the preview PNG (and plate count) out of a 3MF or gcode upload. */
export function extractThumbnail(filename: string, bytes: Buffer): ExtractedThumb {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".3mf")) {
    const png =
      readZipEntry(bytes, (n) => /(?:^|\/)metadata\/plate_1\.png$/i.test(n)) ??
      readZipEntry(bytes, (n) => /metadata\/.*\.png$/i.test(n)) ??
      readZipEntry(bytes, (n) => /\.png$/i.test(n));
    return { png, plateCount: countPlates(bytes) };
  }
  if (/\.(gcode|gco|g)$/i.test(lower)) {
    return { png: extractGcodeThumb(bytes), plateCount: 1 };
  }
  return { png: null, plateCount: 1 };
}

/** The library accepts these (a .bgcode binary has no extractable PNG here). */
export function isLibraryFile(filename: string): boolean {
  return /\.(3mf|gcode|gco|g)$/i.test(filename);
}
