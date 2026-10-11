// POST /api/v1/csp-reports: where browsers report a Content-Security-Policy
// refusal (docker/nginx.conf's report-uri, #3300). No session, by design: the
// browser posts it on its own. Answers 204 always, and counts the refusal
// (api/src/platform/csp-reports.ts), rate-limited per address so the endpoint
// costs nothing to anyone who floods it.
import { Router } from "express";
import { makeIpLimiter, overLimit } from "../platform/ip-limiter.js";
import { recordViolations, violationsIn } from "../platform/csp-reports.js";

export const cspReportsRouter = Router();
const limiter = makeIpLimiter(60_000, 60);

// AI-REACH: exempt (a browser's own report of a refused source; nobody, person or agent, acts here)
// UI-REACH: the browser posts it itself, named by the policy's report-uri; no screen should
cspReportsRouter.post("/csp-reports", async (req, res) => {
  if (!overLimit(limiter, req)) {
    const list = violationsIn(req.body);
    if (list.length) await recordViolations(list).catch((err) => console.warn("[csp] could not record a report:", (err as Error).message));
  }
  res.status(204).end();
});
