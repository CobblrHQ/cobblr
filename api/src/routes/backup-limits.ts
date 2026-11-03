// Size ceilings for backup RESTORE, so a decompression-bomb .zip (a tiny upload
// that inflates to hundreds of GB) can't OOM the shared host (audit M-BOMB).
// The uploaded archive is capped by multer at 1 GB COMPRESSED; these caps bound
// the UNCOMPRESSED total we will materialize while parsing it.
//
// Sizing: a real workspace backup is the tenant DB (JSONL) plus its uploaded
// files. Even a large workspace lands in the low GBs, so a 4 GB total / 2 GB
// per-entry ceiling restores every realistic dump while stopping a bomb well
// before it exhausts host memory. Enforced by reading each entry through a
// running byte budget that aborts mid-stream, so a lying central-directory
// size can't slip a giant entry past a pre-check.

export const RESTORE_MAX_ENTRY_UNCOMPRESSED = 2 * 1024 ** 3; // 2 GB per entry
export const RESTORE_MAX_TOTAL_UNCOMPRESSED = 4 * 1024 ** 3; // 4 GB total

/** Raised when a backup archive would exceed an uncompressed ceiling. */
export class BackupTooLargeError extends Error {
  code = "backup_too_large";
  constructor(message: string) {
    super(message);
    this.name = "BackupTooLargeError";
  }
}

/** Read a zip entry's decompressed bytes, aborting the moment the running count
 *  passes the per-entry cap OR the total budget's remaining allowance. Counting
 *  the ACTUAL streamed bytes (not the declared central-directory size) is what
 *  defeats a bomb with a lying header: we stop inflating as soon as too much has
 *  come out, so the giant buffer is never fully materialized. */
export async function readEntryBounded(
  chunks: AsyncIterable<Uint8Array>,
  opts: { maxEntryBytes: number; remainingTotalBytes: number },
): Promise<Buffer> {
  const out: Buffer[] = [];
  let n = 0;
  for await (const chunk of chunks) {
    n += chunk.byteLength;
    if (n > opts.maxEntryBytes) {
      throw new BackupTooLargeError(
        `A backup entry exceeds the ${opts.maxEntryBytes}-byte uncompressed limit.`,
      );
    }
    if (n > opts.remainingTotalBytes) {
      throw new BackupTooLargeError(
        `Backup exceeds the ${RESTORE_MAX_TOTAL_UNCOMPRESSED}-byte total uncompressed ceiling.`,
      );
    }
    out.push(Buffer.from(chunk));
  }
  return Buffer.concat(out);
}

/** A .jsonl entry's rows, parsed as its bytes come, under the same limits as
 *  readEntryBounded. The entry can be longer than one string can hold, though
 *  no line of it is (#7704), and only the unfinished line is ever held. A
 *  newline byte never sits inside a multi-byte UTF-8 character, so each line
 *  decodes whole. */
export async function readJsonlRowsBounded(
  chunks: AsyncIterable<Uint8Array>,
  opts: { maxEntryBytes: number; remainingTotalBytes: number },
): Promise<{ rows: Array<Record<string, unknown>>; bytes: number }> {
  const rows: Array<Record<string, unknown>> = [];
  const take = (line: Buffer) => {
    const text = line.toString("utf8");
    if (text.trim()) rows.push(JSON.parse(text) as Record<string, unknown>);
  };
  let unfinished: Buffer[] = [];
  let n = 0;
  for await (const chunk of chunks) {
    n += chunk.byteLength;
    if (n > opts.maxEntryBytes) {
      throw new BackupTooLargeError(
        `A backup entry exceeds the ${opts.maxEntryBytes}-byte uncompressed limit.`,
      );
    }
    if (n > opts.remainingTotalBytes) {
      throw new BackupTooLargeError(
        `Backup exceeds the ${RESTORE_MAX_TOTAL_UNCOMPRESSED}-byte total uncompressed ceiling.`,
      );
    }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let at = 0;
    for (let nl = bytes.indexOf(10, at); nl !== -1; nl = bytes.indexOf(10, at)) {
      const end = bytes.subarray(at, nl);
      take(unfinished.length ? Buffer.concat([...unfinished, end]) : end);
      unfinished = [];
      at = nl + 1;
    }
    if (at < bytes.length) unfinished.push(Buffer.from(bytes.subarray(at)));
  }
  if (unfinished.length) take(Buffer.concat(unfinished));
  return { rows, bytes: n };
}

/** Running uncompressed-byte budget across all entries of one archive. */
export function makeUncompressedBudget(
  maxTotalBytes = RESTORE_MAX_TOTAL_UNCOMPRESSED,
  maxEntryBytes = RESTORE_MAX_ENTRY_UNCOMPRESSED,
) {
  let total = 0;
  return {
    maxEntryBytes,
    /** Bytes still allowed before the total ceiling would blow. */
    remaining(): number {
      return maxTotalBytes - total;
    },
    /** Cheap pre-check on an entry's DECLARED size, before any inflate. */
    precheck(declaredBytes: number | undefined): void {
      if (typeof declaredBytes === "number" && declaredBytes > maxEntryBytes) {
        throw new BackupTooLargeError(
          `A backup entry declares ${declaredBytes} bytes, over the ${maxEntryBytes}-byte limit.`,
        );
      }
    },
    /** Charge the ACTUAL bytes read for an entry to the running total. */
    charge(actualBytes: number): void {
      total += actualBytes;
      if (total > maxTotalBytes) {
        throw new BackupTooLargeError(
          `Backup exceeds the ${maxTotalBytes}-byte total uncompressed ceiling.`,
        );
      }
    },
    get total(): number {
      return total;
    },
  };
}
