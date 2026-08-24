// Kysely table types for core-files. Mirrors migrations/0001_init.sql.
//
// Same boundary-casting pattern as the other modules: we don't merge
// the api workspace's Request augmentation — instead we read tenant
// off the request via the helpers below.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export type FileKind = "image" | "document" | "video" | "other";

/** Shape of files.variants. Original is always present; medium/thumb
 *  only for images. Paths are relative to <COBBLR_FILES_ROOT>/<orgId>/
 *  so the storage root can be swapped without rewriting rows. */
export interface FileVariants {
  original: { path: string; bytes: number };
  medium?: { path: string; bytes: number; width: number; height: number };
  thumb?: { path: string; bytes: number; width: number; height: number };
}

export interface FilesTable {
  id: Generated<string>;
  org_id: string;
  owner_user_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: string; // pg bigint comes back as string
  sha256: string;
  variants: FileVariants;
  kind: FileKind;
  width: number | null;
  height: number | null;
  deleted_at: Date | null;
  created_at: Generated<Date>;
}

export interface FileAttachmentsTable {
  id: Generated<string>;
  file_id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  role: string | null;
  sort_order: Generated<number>;
  created_at: Generated<Date>;
}

export interface CoreFilesDB {
  core_files_files: FilesTable;
  core_files_attachments: FileAttachmentsTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

export interface TenantContext {
  org: { id: string; name: string; slug: string };
  role: OrgRole;
}

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<CoreFilesDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-files route called without tenant context");
  return t.db as Kysely<CoreFilesDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-files route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
