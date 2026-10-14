// The workspace's record stream: an open page hears that a record it shows was
// written elsewhere and reads it again (#6337). A ticket, minted by a member
// through the ordinary authed door, names the workspace; the stream itself
// carries only which record changed, never its contents, so a tab still reads
// the record through the routes that check what this person may see.

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { openSse, signStreamTicket, verifyStreamTicket } from "../lib/event-stream.js";
import { onRecordChange } from "../platform/record-stream.js";
import { RECORD_STREAM_EVENT } from "@cobblr/platform-contract/record-stream";

export const recordStreamRouter = Router({ mergeParams: true });

const STREAM_AUD = "record-changes";

// AI-REACH: exempt: a browser tab's live refresh channel; an assistant reads
// records directly and has no open page to keep fresh.
// ROLE: any member (it writes nothing: the ticket opens a stream that says only
// which record changed, and every read after it checks what this person may see)
recordStreamRouter.post("/:slug/records/stream-ticket", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ ticket: await signStreamTicket(STREAM_AUD, req.session!.id, { org: req.tenant!.org.id }) });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt: the stream behind the ticket above, for an open tab only.
recordStreamRouter.get("/:slug/records/stream", async (req, res, next) => {
  try {
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
    const who = ticket ? await verifyStreamTicket(STREAM_AUD, ticket) : null;
    if (!who || typeof who.org !== "string") {
      res.status(401).json({ error: { code: "bad_ticket", message: "A valid stream ticket is required." } });
      return;
    }
    const { send, stop } = openSse(res);
    const off = onRecordChange(who.org, (change) => send(RECORD_STREAM_EVENT, change));
    req.on("close", () => {
      stop();
      off();
    });
  } catch (err) {
    next(err);
  }
});
