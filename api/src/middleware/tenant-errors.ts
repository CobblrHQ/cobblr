import type { ErrorRequestHandler, Response } from "express";
import { meta } from "../db/meta.js";
import { workspaceIsDeleting, WorkspaceDeletingError } from "../db/tenant.js";

export async function answerTenantTeardown(err: unknown, orgId: string | undefined, res: Response): Promise<boolean> {
  if (res.headersSent) return false;
  const deleting = () => err instanceof WorkspaceDeletingError || (orgId !== undefined && workspaceIsDeleting(orgId));
  const answerDeleting = () => {
    res.status(409).json({ error: { code: "workspace_deleting", message: "This workspace is being deleted." } });
    return true;
  };
  if (deleting()) return answerDeleting();
  if (!orgId) return false;
  try {
    // The request may hold a membership or pool from before teardown. The
    // deleting marker is already cleared once the workspace has gone.
    const org = await meta.selectFrom("orgs").select("id").where("id", "=", orgId).executeTakeFirst();
    if (!org) {
      res.status(404).json({ error: { code: "org_not_found", message: "Org not found" } });
      return true;
    }
    if (deleting()) return answerDeleting();
  } catch {
    // A failed status lookup is not evidence that the workspace has gone.
  }
  return false;
}

export const tenantTeardownErrors: ErrorRequestHandler = (err, req, res, next) => {
  void answerTenantTeardown(err, req.tenant?.org.id, res).then(
    (answered) => { if (!answered) next(err); },
    () => next(err),
  );
};
