// A zip read where it lies on disk, through one descriptor held open for the
// whole read (#8957).
//
// unzipper's Open.file opens the file again for every entry, on a stream with
// no error listener. An upload's temporary file is removed when its request
// ends, and a sender who hangs up ends it early: the next entry's open failed
// ENOENT as an unhandled 'error' and took the whole api down, for everyone.
// Held open, the file stays readable after it is removed, and an error that
// does come ends that entry's bytes short, so the read fails as a bad archive
// in that one request. Open one with unzipper.Open.custom(zip.source), never
// Open.file (lint:capabilities).
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

const CHUNK = 64 * 1024;

export interface ZipOnDisk {
  /** What unzipper.Open.custom reads the archive from. */
  source: { size: () => Promise<number>; stream: (offset: number, length: number) => Readable };
  /** Lets go of the file. Every read after it ends short, never throws. */
  close: () => Promise<void>;
}

export async function zipOnDisk(path: string): Promise<ZipOnDisk> {
  const handle = await open(path, "r");
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (err) {
    await handle.close();
    throw err;
  }
  let closed = false;
  return {
    source: {
      size: async () => size,
      stream(offset, length) {
        // The same span Open.file reads: to `offset + length` inclusive, or
        // to the end of the file. Read by position from the one descriptor,
        // so destroying a stream (unzipper does once its entry is done)
        // stops its reads and never closes the file under the others.
        const last = length ? Math.min(offset + length, size - 1) : size - 1;
        let at = offset;
        return new Readable({
          highWaterMark: CHUNK,
          read() {
            if (closed || at > last) {
              this.push(null);
              return;
            }
            const want = Math.min(CHUNK, last - at + 1);
            handle.read(Buffer.allocUnsafe(want), 0, want, at).then(
              ({ bytesRead, buffer }) => {
                if (this.destroyed) return;
                if (bytesRead === 0) {
                  this.push(null);
                  return;
                }
                at += bytesRead;
                this.push(buffer.subarray(0, bytesRead));
              },
              (err: Error) => {
                console.warn(`[zip] a read of ${path} stopped: ${err.message}`);
                if (!this.destroyed) this.push(null);
              },
            );
          },
        });
      },
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}
