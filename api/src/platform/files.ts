// Server-side file seams. A file-storage module (core-files) registers a
// reader / writer / attacher / lister at boot; any module then reads, stores,
// attaches or lists files through platform().files without importing
// core-files or knowing its tables / on-disk layout. Mirrors the
// entities.registerResolver pattern (one registered fn, brokered).

import type {
  FileAttacher,
  FileAttachResult,
  FileSource,
  FileAttachSpec,
  FileAttachmentLister,
  FileDescriber,
  FileDescription,
  FileAttachmentRow,
  FileDetacher,
  FileBytes,
  FileReader,
  FileVariant,
  FilesDriver,
  FileWriter,
  FileWriteResult, FileAttachedTo, FileAttachmentsOfFile, FileFolders, WorkspaceFolder } from "@cobblr/platform-contract";

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
  source: FileSource,
  opts: { filename?: string; mimeType?: string },
): Promise<FileWriteResult | null> {
  if (!writer) return null;
  return writer(orgId, source, opts);
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

let describer: FileDescriber | null = null;

export function registerDescriber(d: FileDescriber): void {
  describer = d;
}

export async function describe(orgId: string, fileIds: string[]): Promise<FileDescription[] | null> {
  if (!describer) return null;
  return fileIds.length ? describer(orgId, fileIds) : [];
}

let ofFile: FileAttachmentsOfFile | null = null;

export function registerAttachmentsOfFile(l: FileAttachmentsOfFile): void {
  ofFile = l;
}

export async function attachmentsOfFile(orgId: string, fileId: string): Promise<FileAttachedTo[] | null> {
  if (!ofFile) return null;
  return ofFile(orgId, fileId);
}

let folders: FileFolders | null = null;

export function registerFolders(f: FileFolders): void {
  folders = f;
}

export async function ensureFolder(orgId: string, path: string[]): Promise<string | null> {
  if (!folders) return null;
  return folders.ensure(orgId, path);
}

export async function fileInto(orgId: string, fileId: string, folderId: string): Promise<boolean | null> {
  if (!folders) return null;
  return folders.file(orgId, fileId, folderId);
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

let workspaceEraser: ((orgId: string) => Promise<void>) | null = null;
export function registerWorkspaceEraser(eraser: (orgId: string) => Promise<void>): void {
  workspaceEraser = eraser;
}
export async function eraseWorkspace(orgId: string): Promise<void> {
  if (workspaceEraser) await workspaceEraser(orgId);
}

let folderLister: (() => Promise<WorkspaceFolder[] | null>) | null = null;
export function registerWorkspaceFolderLister(lister: () => Promise<WorkspaceFolder[] | null>): void {
  folderLister = lister;
}
export async function listWorkspaceFolders(): Promise<WorkspaceFolder[] | null> {
  return folderLister ? folderLister() : null;
}

export async function read(
  orgId: string,
  fileId: string,
  variant: FileVariant = "original",
): Promise<FileBytes | null> {
  if (!reader) return null;
  return reader(orgId, fileId, variant);
}
