// Size-bounded reads/decompression for the catalog PULLER. A catalog source is
// an operator/admin-supplied URL whose (optionally gzipped) body we fetch and
// import in-request. Without a ceiling, a small ".gz" that inflates to many GB
// OOMs the shared host before any post-hoc `raw.length` check can fire — a
// cross-tenant DoS (audit M-BOMB). Both helpers abort EARLY, before the giant
// buffer is ever materialized.

import { gunzipSync } from "node:zlib";

/** Thrown when a bounded read/decompress would exceed its ceiling. Carries the
 *  RangeError name so the existing `instanceof RangeError` handling (Node's zlib
 *  also throws RangeError past `maxOutputLength`) maps it to a 413 "too_large". */
export class DecompressLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "DecompressLimitError";
  }
}

/** gunzip with a hard ceiling on the DECOMPRESSED output. Node's zlib throws a
 *  RangeError the moment the inflated size would pass `maxOutputBytes`, so a
 *  gzip bomb aborts mid-inflate instead of fully materializing gigabytes. A
 *  legitimate catalog under the cap decompresses byte-for-byte as before. */
export function gunzipBounded(buf: Buffer, maxOutputBytes: number): Buffer {
  return gunzipSync(buf, { maxOutputLength: maxOutputBytes });
}

/** Read a fetch Response body, aborting as soon as more than `maxBytes` of
 *  COMPRESSED data have arrived — so a huge compressed payload can't OOM us
 *  before we even reach decompression. Streams when the body is a ReadableStream;
 *  falls back to `arrayBuffer()` (still cap-checked) when it isn't (e.g. a
 *  mocked Response in a test). */
export async function readBodyBounded(resp: Response, maxBytes: number): Promise<Buffer> {
  const body = resp.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== "function") {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new DecompressLimitError(`Compressed body exceeds ${maxBytes} bytes.`);
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new DecompressLimitError(`Compressed body exceeds ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
