// /print — snapshot the current queue into a batch + per-item
// prints, then clear the queue. Returns the rendered batch with QR
// SVGs so the client can drop them straight into a print preview.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler } from "./util.js";
import { qrSvg } from "./qr.js";

export const printRouter = Router({ mergeParams: true });

printRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const session = sessionUser(req);
    const ctx = tenantContext(req);

    const items = await db
      .selectFrom("labels_queue")
      .selectAll()
      .where("user_id", "=", session.id)
      .orderBy("created_at")
      .execute();
    if (items.length === 0) {
      res.status(400).json({ error: { code: "empty_queue", message: "Queue is empty" } });
      return;
    }

    // Snapshot in one transaction so a half-cleared queue can't
    // happen if the client retries.
    const batchId = await db.transaction().execute(async (trx) => {
      const batch = await trx
        .insertInto("labels_batches")
        .values({ user_id: session.id, printed_at: new Date() })
        .returning("id")
        .executeTakeFirstOrThrow();
      for (const it of items) {
        await trx
          .insertInto("labels_prints")
          .values({
            batch_id: batch.id,
            module_name: it.module_name,
            entity_type: it.entity_type,
            entity_id: it.entity_id,
            qr_payload: it.qr_payload,
            description: it.description,
            qty: it.qty,
          })
          .execute();
      }
      await trx
        .deleteFrom("labels_queue")
        .where("user_id", "=", session.id)
        .execute();
      return batch.id;
    });

    // Render QR SVGs for each item. Expanded by qty (one printable
    // per copy) so the UI just iterates and prints. SVGs are tiny;
    // doing N renders in a row is fine for queues up to a few
    // hundred items.
    const printables: { description: string; qr_svg: string }[] = [];
    for (const it of items) {
      const svg = await qrSvg(it.qr_payload, { margin: 1 });
      for (let i = 0; i < it.qty; i++) {
        printables.push({ description: it.description, qr_svg: svg });
      }
    }

    platform().events.emit("labels.printed", {
      orgId: ctx.org.id,
      batchId,
      count: printables.length,
    });

    res.json({ batch_id: batchId, count: printables.length, printables });
  }),
);
