// A store's order page link, handed over by the email ingest (#5461).
//
//   POST /order-pages   { link, order_number?, order_id?, read_now? }  → { attached, store, order? }
//   GET  /order-pages/summary?order_number=  → { order: OrderPageSummary | null }
//
// The link is sealed before anything else happens to it, and the answer
// names only the store. No route returns a link.

import { Router } from "express";
import { z } from "zod";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { captureAndRead, captureOrderPage, summaryForNumber } from "../order-page/store.js";

export const orderPagesRouter = Router({ mergeParams: true });

const Body = z.object({
  link: z.string().url().max(4000).refine((u) => u.startsWith("https://"), "an https link"),
  order_number: z.string().trim().max(120).nullable().optional(),
  order_id: z.string().uuid().nullable().optional(),
  /** Read the page now (when this instance reads pages) and answer what it
   *  says about the order: its name and lines, never the link. The email
   *  ingest asks, so the receipt is filled from the page with no model. */
  read_now: z.boolean().optional(),
});

// UI-REACH: the email ingest hands the link over; no screen should, since a person never types or sees a sign-in link
// AI-REACH: exempt — the link is a sign-in credential for the person's store account; it comes only from their own order email, and the assistant must never hold or pass one.
orderPagesRouter.post(
  "/order-pages",
  asyncHandler(async (req, res) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const url = new URL(parsed.data.link);
    const input = {
      link: url.href,
      host: url.hostname.replace(/^www\./, ""),
      orderNumber: parsed.data.order_number ?? null,
      orderId: parsed.data.order_id ?? null,
    };
    if (parsed.data.read_now) {
      res.status(201).json(await captureAndRead(tenantDb(req), tenantContext(req).org.id, sessionUser(req).id, input));
      return;
    }
    const out = await captureOrderPage(tenantDb(req), tenantContext(req).org.id, sessionUser(req).id, input);
    res.status(201).json({ attached: out.attached, store: out.store });
  }),
);

const SummaryQuery = z.object({ order_number: z.string().trim().min(1).max(120) });

// UI-REACH: the scan inbox's Read again asks it for an emailed receipt; the order itself shows its page through order_page on GET /orders/:id
// AI-REACH: exempt — what a store's page said about one order, for re-reading the receipt it came with; the assistant reads the order and its lines through the order itself.
orderPagesRouter.get(
  "/order-pages/summary",
  asyncHandler(async (req, res) => {
    const parsed = SummaryQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    res.json({ order: await summaryForNumber(tenantDb(req), tenantContext(req).org.id, parsed.data.order_number) });
  }),
);
