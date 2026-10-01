// POST /orgs/:slug/uploads/connection-lost: the page saw an upload's
// connection drop before any answer came (a proxy's own body limit, a phone
// losing signal) and says so. The server never had the file, so without this
// the refusal would be invisible here; with it, it is the same one log line a
// refusal at the door writes (reason connection_lost), so the refusal log can
// size the next decision (a larger limit, resumable uploads).
//
// Facts only, never the file's name or bytes: its size, declared type, and
// the route it was going to, as a pattern.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { logUploadRefused } from "../platform/uploads.js";
import { CONNECTION_LOST_MESSAGE } from "@cobblr/platform-contract/upload";

export const uploadReportsRouter = Router({ mergeParams: true });

const Report = z.object({
  size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  mime_type: z.string().max(200).nullable().optional(),
  /** Where the upload was going: an /api/v1 path, reduced to a pattern here. */
  route: z.string().max(300).regex(/^\/api\/v1\//),
});

// AI-REACH: a page reporting its own dropped upload to the server log; nothing an agent does
// ROLE: any member (whoever uploaded reports their own dropped upload; it writes one log line, never workspace data)
uploadReportsRouter.post("/connection-lost", requireAuth, withTenant, (req, res) => {
  const body = Report.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: { code: "bad_body", message: "A report needs the route the upload was for." } });
    return;
  }
  logUploadRefused(req, {
    reason: "connection_lost",
    sizeBytes: body.data.size_bytes ?? null,
    mimeType: body.data.mime_type ?? null,
    route: body.data.route,
    message: CONNECTION_LOST_MESSAGE,
  });
  res.status(204).end();
});
