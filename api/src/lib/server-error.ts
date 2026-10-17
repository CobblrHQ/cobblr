// The last answer the api gives an error nothing else claimed.
//
// One reference goes in the answer and in the log line, so a 500 met by a
// person or a nightly walk can be matched to the error that caused it; the
// production message hides the real one by design (#6928). The api's log is
// kept across rolls (/var/log/cobblr-roll-logs on the deploy box), and
// scripts/api-log.sh finds a reference there.
//
// A database with no connection to give is busy, not broken: that is a 503
// the caller may retry, never an anonymous 500.
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { isConnectionRefusal } from "../db/connection-budget.js";

export function answerServerError(err: Error, req: Pick<Request, "method" | "originalUrl">, res: Response, production: boolean, log: (line: string, err?: unknown) => void = console.error): void {
  const ref = randomBytes(4).toString("hex");
  if (isConnectionRefusal(err)) {
    log(`[cobblr-api] busy ref=${ref} ${req.method} ${req.originalUrl}: ${err.message}`);
    res.setHeader("Retry-After", "2");
    res.status(503).json({ error: { code: "busy", message: "This server is busy just now. Try again in a moment.", ref } });
    return;
  }
  log(`[cobblr-api] unhandled ref=${ref} ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    // Never a blank message: an error thrown without one (a failed
    // connection's AggregateError) left the person with nothing to read.
    error: { code: "internal", message: production || !err.message?.trim() ? "Something went wrong on our side, and it did not say what. Try again." : err.message, ref },
  });
}
