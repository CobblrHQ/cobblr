// Server-side file seams. A file-storage module (core-files) registers a
// reader / writer / attacher / lister at boot; any module then reads, stores,
// attaches or lists files through platform().files without importing
// core-files or knowing its tables / on-disk layout. Mirrors the
// entities.registerResolver pattern (one registered fn, brokered).

import type {
  FileAttacher,
  FileAttachResult,
  FileAttachSpec,
  FileAttachmentLister,
  FileAttachmentRow,
  FileDetacher,
  FileBytes,
  FileReader,
  FileVariant,
  FilesDriver,
  FileWriter,
  FileWriteResult,
} from "@cobblr/platform-contract";

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

let attacher: FileAttacher | null = null;

export function registerAttacher(a: FileAttacher): void {
  attacher = a;
}

export async function attach(orgId: string, spec: FileAttachSpec): Promise<FileAttachResult | null> {
  if (!attacher) return null;
  return attacher(orgId, spec);
}

let detacher: FileDetacher | null = null;

export function registerDetacher(d: FileDetacher): void {
  detacher = d;
}

export async function detach(orgId: string, attachmentId: string): Promise<boolean | null> {
  if (!detacher) return null;
  return detacher(orgId, attachmentId);
}

let lister: FileAttachmentLister | null = null;

export function registerAttachmentLister(l: FileAttachmentLister): void {
  lister = l;
}

export async function listAttachments(
  orgId: string,
  source: { source_module: string; source_type: string; source_id: string },
): Promise<FileAttachmentRow[] | null> {
  if (!lister) return null;
  return lister(orgId, source);
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
