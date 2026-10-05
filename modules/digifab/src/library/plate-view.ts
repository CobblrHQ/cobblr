// The part of an uploaded plate file the extractors read, taken from the file
// on disk without reading the whole of it: a large multi-plate 3MF or a long
// gcode can run to hundreds of MB, and the upload door streams it to disk so
// the api never holds it whole.
//
//   • gcode: its first and last SCAN_BYTES, joined. The extractors only ever
//     read a gcode's head (thumbnails, Orca/Bambu comments) and tail (Prusa
//     comments), so the join reads the same to them as the whole file.
//   • 3MF: a small zip holding only the entries they read (the preview PNGs
//     and the slicer's config), each inflated on its own from the archive's
//     central directory.
//
// Anything else: an empty buffer (the filename convention is all there is).

import { open } from "node:fs/promises";
import unzipper from "unzipper";
import { zipSync } from "fflate";

const SCAN_BYTES = 512 * 1024;
/** One kept 3MF entry at most: a preview PNG or a config is kilobytes. */
const ENTRY_MAX_BYTES = 8 * 1024 * 1024;
/** Everything kept from one 3MF. */
const KEPT_MAX_BYTES = 32 * 1024 * 1024;

const KEEP = /(?:\.png$|(?:^|\/)metadata\/slice_info\.config$)/i;

export async function plateView(path: string, filename: string): Promise<Buffer> {
  if (/\.3mf$/i.test(filename)) return threeMfView(path);
  if (/\.lbrn2$/i.test(filename)) {
    const file = await open(path, "r");
    try { const head = Buffer.alloc(SCAN_BYTES); const { bytesRead } = await file.read(head, 0, head.length, 0); return head.subarray(0, bytesRead); }
    finally { await file.close(); }
  }
  if (/\.(gcode|gco|g)$/i.test(filename)) return gcodeView(path);
  return Buffer.alloc(0);
}

async function gcodeView(path: string): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size <= 2 * SCAN_BYTES) {
      const all = Buffer.alloc(size);
      await fh.read(all, 0, size, 0);
      return all;
    }
    const head = Buffer.alloc(SCAN_BYTES);
    const tail = Buffer.alloc(SCAN_BYTES);
    await fh.read(head, 0, SCAN_BYTES, 0);
    await fh.read(tail, 0, SCAN_BYTES, size - SCAN_BYTES);
    return Buffer.concat([head, tail]);
  } finally {
    await fh.close();
  }
}

async function threeMfView(path: string): Promise<Buffer> {
  const dir = await unzipper.Open.file(path);
  const kept: Record<string, Uint8Array> = {};
  let total = 0;
  for (const f of dir.files) {
    if (f.type !== "File" || !KEEP.test(f.path)) continue;
    if (f.uncompressedSize > ENTRY_MAX_BYTES || total + f.uncompressedSize > KEPT_MAX_BYTES) continue;
    const bytes = await f.buffer();
    total += bytes.length;
    kept[f.path] = bytes;
  }
  return Buffer.from(zipSync(kept, { level: 0 }));
}
