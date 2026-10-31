// Drop the workspace-template roles nothing needs any more (#8928).
//
// BORN WITH: nothing (a cluster-wide sweep of roles that templates left behind; a template's build makes its own role, and no workspace has one)
//
// PERMANENT RECONCILE. Every template used to be built by one shared role,
// and a copy's DROP OWNED of it revoked its rights on every database, a build
// in progress among them. Each template now has its own role, dropped when the
// template is. This pass retires the shared one on a server that still has it,
// once it owns nothing (an older api still building or copying with it keeps
// it), and any template's role whose template and build are gone (a build that
// died, a template dropped by hand). Every build runs the same sweep; this is
// for a server whose next build is far off. One query that returns no rows on
// a server that never had templates.
import { env } from "../env.js";
import { retireTemplateRoles, withTemplateRoleLock } from "../db/workspace-template.js";

export async function retireUnusedTemplateRoles(): Promise<string[]> {
  if (!env.SUPERUSER_DATABASE_URL) return [];
  return withTemplateRoleLock((c) => retireTemplateRoles(c));
}
