// Tenant-side DB types + request helpers for core-file-preview's
// installed-renderer store. One table per workspace (lives in the tenant
// DB, so it's already workspace-scoped).

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface FilePreviewRenderersTable {
  id: Generated<string>;
  /** Stable install key (also the upsert key). */
  name: string;
  version: string | null;
  /** File extensions this renderer handles. */
  exts: string[];
  /** The renderer's JS bundle — UNTRUSTED; runs only in the sandboxed
   *  iframe on the client. Stored verbatim. */
  renderer_js: string;
  /** ed25519 public key (SPKI base64) the bundle was signed with, if any.
   *  Integrity record; the trust *tier* (official/unverified) is computed
   *  from the registry's vouched keys at browse time. */
  signed_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface FilePreviewDB {
  core_file_preview_renderers: FilePreviewRenderersTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<FilePreviewDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-file-preview route called without tenant context");
  return t.db as Kysely<FilePreviewDB>;
}
