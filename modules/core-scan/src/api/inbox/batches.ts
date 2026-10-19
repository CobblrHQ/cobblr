// Matching a scan, a session's purchase, and the scan menu.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { pendingPurchaseOf, recordReceiptPurchase } from "../../services/receipt-purchase.js";
import { platform } from "@cobblr/platform-contract";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, requireRole } from "../util.js";
import { traitsHaveUnique } from "../../services/combine-merge.js";
import { assembleScanMenu } from "../../services/matchmaker.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";
import { INTERNAL_API, matchItem } from "./shared.js";

export const batchesRouter = Router({ mergeParams: true });

// ──────────────────────── POST /inbox/:id/match ─────────────────────
// Explicit re-rank (the web's rerun flow, scripts). Intake no longer
// depends on this being called.
// AI-REACH: exempt — a re-rank for scripts and the web's rerun sheet that only
// lists candidates; the assistant runs the whole lookup, ranks included,
// through change_scan_item (do: rerun)
batchesRouter.post(
  "/inbox/:id/match",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const token = bearer(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "missing id" } });
      return;
    }
    if (!token) {
      res.status(401).json({ error: { code: "unauthenticated", message: "missing bearer" } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const candidates = await matchItem({
      orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
      orgSlug: ctx.org.slug,
      token,
      baseUrl,
      itemId: id,
      force: true,
    });
    res.json({ candidates: candidates ?? [] });
  }),
);

// ──────────────────────── POST /batches ────────────────────────────

// AI-REACH: exempt — opens a scanning session on the scanner screen; the
// assistant never runs one
batchesRouter.post(
  "/batches",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const session = sessionUser(req);
    const row = await db
      .insertInto("core_scan_batches")
      .values({ created_by_user_id: session.id })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// ─────────────── POST /batches/:id/record-purchase ───────────────
// A receipt read while Purchases was off: turn Purchases on and record the
// order the read would have made (services/receipt-purchase.ts, #3869).
// Turning a module on is an admin's call, and the module's own enable route
// decides that: a refusal comes back in its own words, never swallowed.

// AI-REACH: exempt the receipt session's own button, pressed from the inbox beside the receipt it records; turning a module on is a person's choice there, not a sentence to the assistant
batchesRouter.post(
  "/batches/:id/record-purchase",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const batch = await db
      .selectFrom("core_scan_batches")
      .select(["id", "pending_purchase", "purchases_order_id"])
      .where("id", "=", String(req.params.id))
      .executeTakeFirst();
    if (!batch) {
      res.status(404).json({ error: { code: "not_found", message: "No such session" } });
      return;
    }
    if (batch.purchases_order_id) {
      res.json({ order_id: batch.purchases_order_id, already: true });
      return;
    }
    const plan = pendingPurchaseOf(batch.pending_purchase);
    if (!plan) {
      res.status(409).json({ error: { code: "nothing_pending", message: "This session has no purchase waiting to be kept." } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const headers = { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" };
    const enabled = await apiFetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/purchases/enable`, { method: "POST", headers, body: "{}" });
    if (!enabled.ok && enabled.status !== 409) {
      const text = await enabled.text();
      let message = "Couldn't turn on Purchases.";
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* non-JSON body */
      }
      res.status(enabled.status).json({ error: { code: "enable_failed", message } });
      return;
    }
    const outcome = await recordReceiptPurchase(db, batch.id, plan, { baseUrl, slug: ctx.org.slug, headers });
    if (!outcome.recorded) {
      res.status(502).json({ error: { code: "record_failed", message: "Purchases is on, but the purchase could not be recorded. Try again." } });
      return;
    }
    res.json({ order_id: outcome.orderId });
  }),
);

// ──────────────────────── GET /menu ─────────────────────────────────
// The workspace "scan menu" — every routable table (enabled instances,
// incl. each module's default) with its field defs. The SAME menu the
// matchmaker prompts with, exposed so the UI's target picker reflects
// the workspace's actual tables ("Yarn", not a hardcoded
// inventory/assets/machines list the web has no business knowing).

batchesRouter.get(
  "/menu",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "unauthenticated", message: "missing bearer" } });
      return;
    }
    const ctx = tenantContext(req);
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const items = await assembleScanMenu(baseUrl, ctx.org.slug, token, ctx.org.id);
    // Stamp which entries are UNIQUE-tracked kinds (declared traits — a vehicle,
    // a machine) so the combine banner can say "the same vehicle — merge details"
    // instead of promising a ×2 that a one-of-a-kind thing must never get.
    try {
      const kinds = await platform().entities.listKindsForOrg(ctx.org.id);
      const uniqueKinds = new Set(kinds.filter((k) => traitsHaveUnique(k.traits ?? null)).map((k) => k.id));
      for (const it of items) if (uniqueKinds.has(it.kind)) it.unique = true;
    } catch {
      /* best-effort — an unstamped menu just keeps the generic combine copy */
    }
    res.json({ items });
  }),
);
