// A store's order page link, handed over by the email ingest (#5461).
//
//   POST /order-pages   { link, order_number?, order_id? }  → { attached, store }
//
// The link is sealed before anything else happens to it, and the answer
// names only the store. No route returns a link.

import { Router } from "express";
import { z } from "zod";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { captureOrderPage } from "../order-page/store.js";

export const orderPagesRouter = Router({ mergeParams: true });

const Body = z.object({
  link: z.string().url().max(4000).refine((u) => u.startsWith("https://"), "an https link"),
  order_number: z.string().trim().max(120).nullable().optional(),
  order_id: z.string().uuid().nullable().optional(),
});

// UI-REACH: the email ingest hands the link over; no screen should, since a person never types or sees a sign-in link
// AI-REACH: exempt — the link is a sign-in credential for the person's store account; it comes only from their own order email, and the assistant must never hold or pass one.
orderPagesRouter.post(
  "/order-pages",
  asyncHandler(async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const url = new URL(parsed.data.link);
    const out = await captureOrderPage(tenantDb(req), tenantContext(req).org.id, sessionUser(req).id, {
      link: url.href,
      host: url.hostname.replace(/^www\./, ""),
      orderNumber: parsed.data.order_number ?? null,
      orderId: parsed.data.order_id ?? null,
    });
    res.status(201).json(out);
  }),
);
