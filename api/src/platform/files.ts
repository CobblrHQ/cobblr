// Server-side file-bytes seam. A file-storage module (core-files)
// registers a reader at boot; any module then reads a stored file's
// bytes through platform().files.read() without importing core-files
// or knowing its tables / on-disk layout. Mirrors the
// entities.registerResolver pattern (one registered fn, brokered).

import type { FileBytes, FileReader, FileVariant, FilesDriver, FileWriter, FileWriteResult } from "@cobblr/platform-contract";

let reader: FileReader | null = null;

export function registerReader(r: FileReader): void {
  reader = r;
}

let writer: FileWriter | null = null;

export function registerWriter(w: FileWriter): void {
  writer = w;
}

export async function write(
  orgId: string,
  bytes: Uint8Array,
  opts: { filename?: string; mimeType?: string },
): Promise<FileWriteResult | null> {
  if (!writer) return null;
  return writer(orgId, bytes, opts);
}

// Blob-storage driver override. Null → core-files uses its built-in local-disk
// driver. The hosted overlay registers an S3/R2 driver at boot.
let driver: FilesDriver | null = null;
export function registerDriver(d: FilesDriver): void {
  driver = d;
}
export function getDriver(): FilesDriver | null {
  return driver;
}

export async function read(
  orgId: string,
  fileId: string,
  variant: FileVariant = "original",
): Promise<FileBytes | null> {
  if (!reader) return null;
  return reader(orgId, fileId, variant);
}
