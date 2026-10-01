// /customers — CRUD for sales customers + a per-customer order-count rollup.
// Sales orders link via orders.customer_id; the legacy customer_name text is
// dual-written from the customer's name (see orders.ts) so cross-module readers
// + pre-link rows keep working.

import { withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { likeEscape, platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const customersRouter = Router({ mergeParams: true });

const CustomerCreate = z.object({
  name: z.string().min(1).max(200),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(80).nullable().optional(),
  address: z.string().max(2_000).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const CustomerUpdate = CustomerCreate.partial();

/** A page of customers, by name, with how many there are. `q` searches the
 *  name, the email and the phone. */
customersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = readListPage(req.query);
    const term = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    let q = tenantDb(req)
      .selectFrom("sales_customers as c")
      .where("c.instance", "=", instanceOf(req))
      .select((eb) => [
        "c.id", "c.name", "c.email", "c.phone", "c.address", "c.notes",
        "c.metadata", "c.created_at", "c.updated_at",
        eb.selectFrom("sales_orders as o").select(eb.fn.countAll().as("n"))
          .whereRef("o.customer_id", "=", "c.id").as("order_count"),
        sql<string>`count(*) over()`.as(TOTAL_COLUMN),
      ]);
    if (term) {
      const like = `%${likeEscape(term)}%`;
      q = q.where((eb) => eb.or([eb("c.name", "ilike", like), eb("c.email", "ilike", like), eb("c.phone", "ilike", like)]));
    }
    const rows = await q.orderBy("c.name").orderBy("c.id").limit(page.limit).offset(page.offset).execute();
    const answer = pagedAnswer(rows, page);
    res.json({ ...answer, items: answer.items.map((c) => ({ ...c, order_count: Number(c.order_count ?? 0) })) });
  }),
);

customersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const customer = await db
      .selectFrom("sales_customers")
      .selectAll()
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!customer) {
      res.status(404).json({ error: { code: "not_found", message: "customer not found" } });
      return;
    }
    const orders = await db
      .selectFrom("sales_orders")
      .select(["id", "order_number", "status", "order_date", "fulfilled_at"])
      .where("customer_id", "=", customer.id)
      .where("instance", "=", instanceOf(req))
      .orderBy("order_date", "desc")
      .execute();
    res.json({ ...customer, orders, order_count: orders.length });
  }),
);

customersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CustomerCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const row = await db
      .insertInto("sales_customers")
      .values({ ...parsed.data, instance: instanceOf(req), metadata: parsed.data.metadata ?? {} } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("sales.customer.created", { orgId: ctx.org.id, customerId: row.id, userId: session?.id ?? null });
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "customer_created",
      ref: { module: "sales", entityType: "customer", entityId: row.id },
      diff: { name: row.name, instance: instanceOf(req) },
    });
    res.status(201).json(row);
  }),
);

customersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CustomerUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    // The row as it was: the log says what this edit changed (#4517).
    const before = await db.selectFrom("sales_customers").selectAll().where("id", "=", req.params.id!).where("instance", "=", instanceOf(req)).executeTakeFirst();
    const row = await db
      .updateTable("sales_customers")
      // Custom fields MERGE into the live row (withMetadataMerged, #3625).
      .set(withMetadataMerged({ ...parsed.data, updated_at: new Date() } as Record<string, unknown>) as never)
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "customer not found" } });
      return;
    }
    // Renaming a customer re-syncs the legacy customer_name on its orders.
    if (parsed.data.name) {
      await db
        .updateTable("sales_orders")
        .set({ customer_name: parsed.data.name })
        .where("customer_id", "=", req.params.id!)
        .where("instance", "=", instanceOf(req))
        .execute();
    }
    // The request as sent, on the record's history: the one place a value
    // a later write replaced can still be read back (#3625).
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "customer_updated",
      ref: { module: "sales", entityType: "customer", entityId: String(req.params.id) },
      diff: parsed.data as Record<string, unknown>,
      before,
    });
    res.json(row);
  }),
);

customersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const deleted = await db
      .deleteFrom("sales_customers")
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "customer not found" } });
      return;
    }
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "customer_deleted",
      ref: { module: "sales", entityType: "customer", entityId: deleted.id },
      diff: { name: deleted.name },
    });
    res.status(204).end();
  }),
);
