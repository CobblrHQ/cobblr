import type { FileAttachedTo, FileAttacher, FileAttachmentLister, FileAttachmentRow, FileAttachmentsOfFile, FileAttachResult, FileAttachSpec, FileBytes, FileDescriber, FileDescription, FileDetacher, FileFolders, FileReader, FileRemover, FileSource, FileVariant, FileWriter, FileWriteResult } from "@cobblr/platform-contract/files";
import type { FilesDriver } from "@cobblr/platform-contract/auth-email";
import type { WorkspaceFolder } from "@cobblr/platform-contract/instances";

/** Server-side access to stored file bytes, brokered so a module never
 *  imports core-files or touches its on-disk layout. core-files
 *  registers the reader at boot; everyone else just calls read(). */
export interface PlatformFiles {
  /** A file-storage module registers the byte reader once at boot. */
  registerReader(reader: FileReader): void;
  /** Read a stored file's bytes. Returns null if no reader is
   *  registered, the file doesn't exist, or the variant is missing. */
  read(
    orgId: string,
    fileId: string,
    variant?: FileVariant,
  ): Promise<FileBytes | null>;
  /** A file-storage module registers the byte writer once at boot. */
  registerWriter(writer: FileWriter): void;
  /** Store bytes as a file in `orgId` (variants + DB row). Returns its id, or
   *  null if no writer is registered. Bytes this workspace already holds
   *  return the existing file (`existed: true`), never a second copy. */
  write(
    orgId: string,
    source: FileSource,
    opts: { filename?: string; mimeType?: string; photoSource?: import("./photo-source.js").PhotoSource },
  ): Promise<FileWriteResult | null>;
  /** A file-storage module registers the attacher once at boot. */
  registerAttacher(attacher: FileAttacher): void;
  /** Attach a stored file to an entity with a role, server-side (no request,
   *  no bearer). Returns null if no attacher is registered. Idempotent: an
   *  attachment that already exists is returned with `existed: true`. */
  attach(orgId: string, spec: FileAttachSpec): Promise<FileAttachResult | null>;
  /** A file-storage module registers the detacher once at boot. */
  registerDetacher(detacher: FileDetacher): void;
  /** Remove one attachment server-side. Returns null if no detacher is
   *  registered, false if the row did not exist. */
  detach(orgId: string, attachmentId: string): Promise<boolean | null>;
  /** A file-storage module registers the remover once at boot. */
  registerRemover(remover: FileRemover): void;
  /** Remove a file and its bytes for good, now (see FileRemover). Null if no
   *  remover is registered. */
  removeForGood(orgId: string, fileId: string): Promise<boolean | null>;
  /** A file-storage module registers the attachment lister once at boot. */
  registerAttachmentLister(lister: FileAttachmentLister): void;
  /** A file-storage module registers the describer once at boot. */
  registerDescriber(describer: FileDescriber): void;
  /** What these files are (deleted ones left out). Null if no describer is
   *  registered. A record's history names a photo by this, never by its
   *  storage path (#4517). */
  describe(orgId: string, fileIds: string[]): Promise<FileDescription[] | null>;
  /** What is attached to one entity. Returns null if no lister is registered
   *  (distinct from [] - nothing attached). */
  listAttachments(
    orgId: string,
    source: { source_module: string; source_type: string; source_id: string },
  ): Promise<FileAttachmentRow[] | null>;
  /** A file-storage module registers the reverse lookup once at boot. */
  registerAttachmentsOfFile(lookup: FileAttachmentsOfFile): void;
  /** A file-storage module registers its folders once at boot. */
  registerFolders(folders: FileFolders): void;
  /** Make the folder at a path of names. Null if no folders are registered. */
  ensureFolder(orgId: string, path: string[]): Promise<string | null>;
  /** File a top-level file into a folder (see FileFolders.file). Null if no
   *  folders are registered. */
  fileInto(orgId: string, fileId: string, folderId: string): Promise<boolean | null>;
  /** Every entity one file is attached to. Null if no lookup is registered
   *  (distinct from [] - attached to nothing). */
  attachmentsOfFile(orgId: string, fileId: string): Promise<FileAttachedTo[] | null>;
  /** Override the blob-storage driver (the overlay injects S3/R2). If none is
   *  registered, core-files uses its built-in local-disk driver. */
  registerDriver(driver: FilesDriver): void;
  /** The registered driver, or null → core-files falls back to local disk. */
  getDriver(): FilesDriver | null;
  /** core-files says how a whole workspace's stored bytes are removed. */
  registerWorkspaceEraser(eraser: (orgId: string) => Promise<void>): void;
  /** Remove every byte a workspace ever stored, through whichever driver holds
   *  them. The kernel's workspace delete calls it while the workspace's
   *  database still exists (the file list lives there). Nothing registered
   *  resolves: nothing was stored. */
  eraseWorkspace(orgId: string): Promise<void>;
  /** core-files says how to list the per-workspace folders its storage holds. */
  registerWorkspaceFolderLister(lister: () => Promise<WorkspaceFolder[] | null>): void;
  /** Every workspace folder the file store holds, with its size and newest
   *  write, whether or not that workspace still exists. Null when the active
   *  storage cannot be listed this way (nothing registered, or a driver keyed
   *  only by file). Read-only. */
  listWorkspaceFolders(): Promise<WorkspaceFolder[] | null>;
}
