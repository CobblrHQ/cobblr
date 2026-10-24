import type { Request, Response, NextFunction } from "express";
import type { z } from "zod";
import { roleSatisfies, roleRefusal } from "@cobblr/platform-contract/org-roles";
import type { OrgRoleName as OrgRole } from "@cobblr/platform-contract/org-roles";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";

const deleteRefusals: Record<string, string> = {
  digifab_test_plan_versions_plan_id_fkey: "This plan has version history. Keep it for production traceability.",
  digifab_test_runs_plan_id_plan_version_fkey: "This plan version has test runs. Keep it for production traceability.",
  digifab_test_dispositions_run_id_fkey: "This test run has dispositions. Keep it for production traceability.",
  digifab_embroidery_runs_machine_id_fkey: "This machine has embroidery runs. Keep it so their history stays complete.",
  digifab_embroidery_runs_design_id_fkey: "This design has embroidery runs. Keep it so their history stays complete.",
};

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch((error: unknown) => {
      const key = error as { code?: string; constraint?: string; message?: string } | null;
      let message: string | undefined;
      if (req.method === "DELETE") {
        if ((key?.code === "23503" || key?.code === "23001") && key.constraint) message = deleteRefusals[key.constraint];
        else if (key?.code === "P0001" && key.message === "Finished production evidence is immutable") message = "Finished production evidence cannot be deleted. Keep it for traceability.";
      }
      if (message) res.status(409).json({ error: { code: "history_required", message } });
      else next(error);
    });
  };
}

export function badBody(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: { code: "invalid_body", message: invalidBodyMessage(error.issues), details: error.issues },
  });
}

export function requireRole(
  req: Request,
  res: Response,
  ...allowed: OrgRole[]
): boolean {
  const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
  if (!role || !roleSatisfies(role as "owner", allowed)) {
    res.status(403).json({
      error: { code: "forbidden", message: roleRefusal(allowed) },
    });
    return false;
  }
  return true;
}
