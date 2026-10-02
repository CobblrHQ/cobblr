// A scan inbox's answers to things offered over a share
// (docs/design-decisions/share-spaces.md §6): take, pass or maybe later on a
// row that arrived as an offer, and, in a shared workspace, offering its own
// scans back to the person who shared it. The share itself is the kernel's
// (platform().shares); this only carries a person's press to it.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";

export const offersRouter = Router();

const Decide = z.object({ decision: z.enum(["taken", "passed", "maybe"]), into: z.string().uuid().nullable().optional() });

// AI-REACH: exempt — taking or passing on a thing a person offered you is your own answer to them, pressed on its card.
offersRouter.post(
  "/inbox/:id/offer",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const body = Decide.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "bad_body", message: "decision is taken, passed or maybe" } });
    const r = await platform().shares.decideOffer(tenantContext(req).org.id, String(req.params.id), body.data.decision, {
      userId: sessionUser(req).id,
      into: body.data.into ?? null,
    });
    if (!r.ok) return void res.status(409).json({ error: { code: "cannot_decide", message: r.error } });
    res.json(r);
  }),
);

const OfferBack = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

// AI-REACH: exempt — offering your scans to the person who shared with you is pressed on the inbox, a person's hand-over.
offersRouter.post(
  "/inbox/offer-to-sharer",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const body = OfferBack.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "bad_body", message: "ids are required" } });
    const r = await platform().shares.offerInboxItems(tenantContext(req).org.id, body.data.ids, { userId: sessionUser(req).id });
    if (!r.ok) return void res.status(409).json({ error: { code: "cannot_offer", message: r.error } });
    res.json(r);
  }),
);
