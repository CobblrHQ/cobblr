import type { Request, Response, NextFunction } from "express";
import { z } from "zod";

export function asyncHandler<R extends Request = Request>(
  handler: (req: R, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req as R, res, next).catch(next);
  };
}

export function badBody(res: Response, err: z.ZodError, message = "Bad request body"): void {
  res.status(400).json({
    error: { code: "invalid_body", message, details: err.issues },
  });
}

/** Substitute {{key}} tokens in a template with values from data.
 *  Missing keys → empty string. No conditionals; we're not building
 *  a real templating language. */
export function renderTemplate(tmpl: string, data: Record<string, unknown>): string {
  return tmpl.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => {
    const v = data[key];
    return v == null ? "" : String(v);
  });
}
