/** Which stored rendition to read. Images have medium/thumb; other
 *  files only have `original`. */
export type FileVariant = "original" | "medium" | "thumb";

/** A stored file's bytes + just-enough metadata to forward it on
 *  (e.g. upload to a print farm, send to a vision model). */
export interface FileBytes {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** The byte-reading function a file-storage module (core-files)
 *  registers with the platform. */
export type FileReader = (
  orgId: string,
  fileId: string,
  variant: FileVariant,
) => Promise<FileBytes | null>;

/** Result of storing a file through the write seam. */
export interface FileWriteResult {
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  /** The workspace already held these exact bytes: this is that file, and
   *  nothing new was stored. */
  existed?: boolean;
}
/** Stores bytes as a file in `orgId` (its own variants + DB row) and returns
 *  its id; bytes the workspace already holds return the file holding them
 *  (`existed: true`) rather than a second copy. core-files registers it; the kernel calls it to
 *  COPY a file across workspaces (e.g. the graduation import duplicating a
 *  photo into the new workspace). */
/** What a file is written from: bytes in hand, or a file already on disk (an
 *  upload the door streamed there, with the hash it took as it arrived), which
 *  the store moves in without reading it into memory. */
export type FileSource = Uint8Array | { path: string; size: number; sha256?: string };

export type FileWriter = (
  orgId: string,
  source: FileSource,
  opts: { filename?: string; mimeType?: string; photoSource?: import("./photo-source.js").PhotoSource },
) => Promise<FileWriteResult>;

/** "This file is the <role> of that entity" - the same row POST
 *  /attachments writes, for a module that is acting server-side with no
 *  request to carry a bearer (an event handler reacting to an upload). */
export interface FileAttachSpec {
  fileId: string;
  source_module: string;
  source_type: string;
  source_id: string;
  role?: string | null;
  sort_order?: number;
}
export interface FileAttachResult {
  attachmentId: string;
  /** True when the (file, entity, role) row already existed and was returned
   *  rather than created - the seam is idempotent. */
  existed: boolean;
}
/** One attachment on an entity, as the list seam reports it. */
export interface FileAttachmentRow {
  id: string;
  fileId: string;
  role: string | null;
  sort_order: number;
  filename: string;
  mimeType: string;
  kind: string;
  width: number | null;
  height: number | null;
  createdAt: Date;
  /** Where the picture came from, when that was stored with it. */
  photoSource?: import("./photo-source.js").PhotoSource | null;
}
/** What a stored file is, for a person reading about it: its name, size,
 *  shape and (for a picture) where it came from. */
export interface FileDescription {
  fileId: string;
  filename: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  photoSource: import("./photo-source.js").PhotoSource | null;
}
export type FileDescriber = (orgId: string, fileIds: string[]) => Promise<FileDescription[]>;
/** Attaches a stored file to an entity. core-files registers it; it emits the
 *  same core-files.attachment.created event the HTTP route does, so wires see
 *  no difference between a user's upload and a module's server-side attach. */
export type FileAttacher = (orgId: string, spec: FileAttachSpec) => Promise<FileAttachResult>;
/** Removes one attachment by id (the file itself stays). Resolves false when
 *  there was no such row. Emits core-files.attachment.deleted like the route. */
export type FileDetacher = (orgId: string, attachmentId: string) => Promise<boolean>;
/** Remove a file and its bytes now, skipping Recently deleted: the plain copy
 *  of a document just put in the Vault. False when it cannot go yet (a live
 *  copy still names it) or was not there. */
export type FileRemover = (orgId: string, fileId: string) => Promise<boolean>;
/** Lists what is attached to one entity, oldest first (sort_order, then
 *  created_at) - the server-side twin of GET /attachments. */
export type FileAttachmentLister = (
  orgId: string,
  source: { source_module: string; source_type: string; source_id: string },
) => Promise<FileAttachmentRow[]>;
/** Where one file is attached: the reverse of FileAttachmentLister. What
 *  lets "each dropped file becomes a record" refuse to make a second record
 *  for a file a record already owns. Live attachments of a live file only. */
export interface FileAttachedTo {
  attachmentId: string;
  source_module: string;
  source_type: string;
  source_id: string;
  role: string | null;
}
export type FileAttachmentsOfFile = (orgId: string, fileId: string) => Promise<FileAttachedTo[]>;
/** Folders, server-side (#3753): a module that keeps a set of files together
 *  (a Make's model, G-code and renders) makes a place for them the way a
 *  person would, by name under a path. */
export interface FileFolders {
  /** The folder at this path of names, made as needed ("Makes" / "Round
   *  spacer"). Names match case-insensitively, as the folder list does. */
  ensure(orgId: string, path: string[]): Promise<string>;
  /** Put a file in a folder, but only a file still at the top: bytes are
   *  kept once, so a file already somewhere a person (or another record)
   *  put it stays there. Returns whether it moved. */
  file(orgId: string, fileId: string, folderId: string): Promise<boolean>;
}

/** A table's file intake, declared by its bundle: each file dropped on the
 *  table becomes one of its records, the file attached with `role` (Yarn's
 *  Patterns: every PDF is a pattern). Files arrive through core-files' one
 *  intake and land in `folder`; a zip's top folder fills `folder_field` when
 *  it names one of that field's choices; `ask` is asked once per batch. The
 *  server side is POST /orgs/:slug/instances/:instance/file-intake. */
/** A table's "Import from <service>" button (Yarn: Import from Ravelry).
 *  `connector` is a sync connector's id; `sections` maps each of its entity
 *  types to the table (instance) its rows land in ("stash" → "yarn",
 *  "projects" → "designs"). A section whose table the workspace lacks is left
 *  out. The first press asks for the service's keys once; every press after
 *  that re-imports, updating what is already here (TableConnectorImport). */
/** What a maker's notions are called, one list for the pattern reader, the
 *  pattern page and the Yarn bundle's Notions table (its Type choices), so a
 *  pattern's "2 St markers" and the stash's "Stitch markers" are one word. */
export const NOTION_NAMES = [
  "Stitch markers",
  "Stitch holders",
  "Yarn needle",
  "Cable needle",
  "Safety eyes",
  "Stuffing",
  "Buttons",
  "Row counter",
] as const;
export type NotionName = (typeof NOTION_NAMES)[number];

export interface ConnectorImportDecl {
  connector: string;
  label?: string;
  sections: Record<string, string>;
}

/** How to get files out of somewhere, shown on an import when the batch
 *  question is answered with that place (Source: Ribblr). The bundle knows the
 *  place; the import only knows to show what the bundle wrote. */
export interface FileIntakeGuide {
  when: { field: string; equals: string };
  title: string;
  steps: string[];
}

export interface FileIntakeDecl {
  accept: string[];
  role: string;
  folder?: string;
  folder_field?: string;
  ask?: string[];
  label?: string;
  guides?: FileIntakeGuide[];
}
