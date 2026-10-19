// Bulk work on the inbox: autofile, merging and reassigning sessions, catalog photo backfill, applying a theme.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { storeOrClearCatalogUrl } from "../../services/catalog-store.js";
import { RESTOCK_CHOICES } from "@cobblr/platform-contract/kind-label";
import { planInbox, planStillHolds, summarise, describeSummary, type AutofilePlan } from "../../services/autofile.js";
import { sql } from "kysely";
import { z } from "zod";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { BundleInstaller, fileThroughConfirm } from "../../services/file-through-confirm.js";
import { scanReviewReason } from "@cobblr/platform-contract/scan-triage";
import { bearer, tenantContext, tenantDb } from "../../db.js";
import { withResolvedOffers } from "../../services/resolve-offers.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { isJunkName } from "../../services/enrich.js";
import { refreshCatalogImageByName } from "../../services/enrich-photo.js";
import { restampTrackedMatch } from "../../services/tracked-stamp.js";
import { filingDestination } from "../../services/destination.js";
import { withPersonName } from "../../services/user-name.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
import { INTERNAL_API, destinationTablesFor, liveTablesFor, topCandidateCategory } from "./shared.js";

export const bulkRouter = Router({ mergeParams: true });

// ─────────────────────── POST /inbox/merge-batches ──────────────────
// Fold one scan session into another (two walk-around bursts that are really
// one job): every item in from_batch_id moves to into_batch_id, so the inbox
// shows a single session group and a ?batch review covers both.
const MergeBatchesBody = z.object({
  from_batch_id: z.string().min(1),
  into_batch_id: z.string().min(1),
});
/**
 * File everything that can be filed, in one press.
 *
 * The two halves this joins both existed and were never connected: findTracked
 * matches a scan against things you already track, and attach/add-qty bumps one
 * rather than making a second. "File all" only ever created, so a weekly receipt
 * built a cupboard of duplicates - and a dozen records of the same food means
 * none of them has a history the cadence engine can learn from.
 *
 * DRY RUN BY DEFAULT is not politeness. This touches every pending item at once,
 * and "it attached 40 things to the wrong records" is not something an undo
 * makes better. The caller asks what would happen, shows it, and comes back with
 * confirm.
 */
const AutofileBody = z.object({
  confirm: z.boolean().optional(),
  /** Limit to one receipt/session. Omitted, the whole pending inbox. */
  batch_id: optionalField(z.string()),
  /** Passed to the entity write so a date lands on the right calendar day. */
  timezone: optionalField(z.string()),
  /** On confirm: act ONLY on these items. The sheet sends the ids it showed,
   *  so a run never writes what nobody looked at. The dry run used to return
   *  the first 100 plans while confirm acted on every pending row, so a
   *  130-item inbox previewed 100 and wrote 130 (2026-09-12). */
  item_ids: z.array(z.string().min(1)).max(500).optional(),
  /** On confirm: what the sheet showed for each item. An item whose plan no
   *  longer holds (a match filed from another device in between) is skipped
   *  and reported as changed, rather than acted on under a plan nobody saw. */
  seen: z
    .array(
      z.object({
        item_id: z.string().min(1),
        action: z.enum(["attach", "create", "skip"]),
        to_id: z.string().nullish(),
        destination: z.string().nullish(),
        /** For a row added to a record you already have: what this purchase
         *  means for it, the same answers the card and the detail offer
         *  (useRepurchaseChoices). add = +1; replaced = the old one ran out,
         *  this is what there is now; went_bad = the old one was thrown out. */
        restock: optionalField(z.enum(RESTOCK_CHOICES)),
      }),
    )
    .max(500)
    .optional(),
  /** On confirm: where the "filed as new" pile goes. The per-item confirm
   *  takes the same key; the sheet defaults it to the session's scan area. */
  location_id: z.string().nullish(),
  /** Or a thing that holds things (a Backpack): the new ones go inside it. */
  container: z.object({ kind: z.string().min(1).max(120), id: z.string().min(1).max(200) }).nullish(),
});

// AI-REACH: exempt — a bulk write over the whole pending inbox. An agent should
// file items one at a time through the normal confirm/attach path, where each
// decision is separately visible and separately undoable.
bulkRouter.post(
  "/inbox/autofile",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AutofileBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }

    // One more than the page, so the response can say whether there is more
    // waiting beyond what it planned, rather than a total that quietly reads
    // 200 for a 400-line inbox.
    const PAGE = 200;
    let q = db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("status", "=", "pending")
      .orderBy("created_at", "asc")
      .limit(PAGE + 1);
    if (parsed.data.batch_id) q = q.where("scan_batch_id", "=", parsed.data.batch_id);
    if (parsed.data.confirm && parsed.data.item_ids?.length) q = q.where("id", "in", parsed.data.item_ids);
    const fetched = await q.execute();
    const more = fetched.length > PAGE;
    // An offer to install a table the workspace has since installed is a
    // filing into it, here as on every other reader (resolve-offers.ts): the
    // plan must not promise "Create Yarn" over a Yarn that exists.
    const liveNow = await liveTablesFor(req);
    // The person's name is the name here as on the card (#2982).
    const rows = (more ? fetched.slice(0, PAGE) : fetched).map((r) => withPersonName(withResolvedOffers(r, liveNow)));

    // Match every row FIRST, so the plan is computed against one consistent
    // picture. Doing it row-by-row while also writing would let an earlier
    // create become a later row's "match", which is how one receipt line
    // silently absorbs the next.
    // Filing into a table the workspace does not have yet installs the bundle
    // first, and installing changes what the workspace is made of: owner or
    // admin, the same bar as the install route itself.
    const canInstall = roleSatisfies((req as unknown as { tenant?: { role: string } }).tenant?.role as "owner", ["owner", "admin"]);
    const plans: AutofilePlan[] = [];
    // Where each row goes is the card's answer (services/destination.ts),
    // read once for the page: the plan must file where the person saw it
    // headed, not where the raw route pointed (#3618).
    const tables = await destinationTablesFor(req);
    // Every row matched fresh, by the card's own derivation, before anything
    // is written (services/autofile.ts planInbox, #3726).
    plans.push(
      ...(await planInbox(rows, {
        rematch: (row) => {
          const pre = filingDestination(row, tables, liveNow);
          return restampTrackedMatch(ctx.org.id, db as never, row.id, row, (pre?.fields as Record<string, unknown> | undefined) ?? null, topCandidateCategory(row.suggested_candidates));
        },
        candidate: (row) => filingDestination(row, tables, liveNow) as never,
        review: (row) => scanReviewReason(row),
        tables,
        canInstall,
      })),
    );

    // The plan the sheet shows is the plan confirm acts on: every row it
    // planned. `total` is how many it planned and `more` says there are rows
    // beyond the page, so the sheet can say "the first 200; run again for
    // the rest" instead of a count that looks complete.
    const summary = summarise(plans);
    if (!parsed.data.confirm) {
      res.json({
        dry_run: true,
        summary,
        message: describeSummary(summary),
        plans,
        total: plans.length,
        more,
      });
      return;
    }
    // Changed since you looked: the re-plan disagrees with what was shown.
    const seenById = new Map((parsed.data.seen ?? []).map((x) => [x.item_id, x] as const));
    const changed: Array<{ itemId: string; name: string | null; was: string; now: string }> = [];
    const actionable = plans.filter((plan) => {
      const seen = seenById.get(plan.itemId);
      if (!seen || planStillHolds(seen, plan)) return true;
      changed.push({
        itemId: plan.itemId,
        name: plan.name,
        was: seen.action === "create" && seen.destination ? `${seen.action} into ${seen.destination}` : seen.action,
        now: plan.action === "create" && plan.destination ? `${plan.action} into ${plan.destination}` : plan.action,
      });
      return false;
    });

    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    let attached = 0;
    let created = 0;
    const failures: Array<{ itemId: string; error: string }> = [];

    // A create files through the confirm door (services/file-through-confirm
    // .ts, shared with an accepted put-away group): the table a candidate
    // needs is installed once per bundle on the way, and the instance the
    // install REALLY made is the one filed into, since a bundle that skins a
    // module's default table makes no instance while the candidate still
    // carries the routing token (the receipt of 2026-08-22).
    const door = { baseUrl, slug: ctx.org.slug, authHeaders, canInstall, tables };
    const installer = new BundleInstaller(door);

    for (const plan of actionable) {
      try {
        if (plan.action === "attach") {
          const restock = seenById.get(plan.itemId)?.restock;
          const replacing = restock === "replaced" || restock === "went_bad";
          const r = await apiFetch(
            `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-scan/inbox/${plan.itemId}/attach`,
            {
              method: "POST",
              headers: authHeaders,
              body: JSON.stringify({
                kind: plan.to.kind,
                entity_id: plan.to.id,
                ...(plan.to.instance ? { instance: plan.to.instance } : {}),
                mode: replacing ? "replace" : "add-qty",
                ...(replacing ? { cadence: { resolution: restock === "went_bad" ? "discarded" : "consumed" } } : {}),
                qty: plan.qty,
              }),
            },
          );
          if (!r.ok) throw new Error(`attach ${r.status}`);
          attached++;
        } else if (plan.action === "create") {
          const row = rows.find((x) => x.id === plan.itemId);
          // The candidate carries its own module and kind. planItem refuses an
          // item without them, so there is no default to fall back to - and
          // naming one here would hardcode another module's identity into
          // core-scan, which is what module isolation forbids.
          if (!row) throw new Error("candidate lost its destination");
          const outcome = await fileThroughConfirm(door, installer, row, parsed.data.location_id ?? null, {
            quantity: plan.qty,
            ...(parsed.data.container ? { container: parsed.data.container } : {}),
          });
          if (!outcome.ok) throw new Error(outcome.reason);
          created++;
        }
      } catch (err) {
        // One bad row must not abandon the rest: a half-filed inbox with a named
        // failure is recoverable, a run that stopped at item 4 of 45 is not.
        failures.push({ itemId: plan.itemId, error: (err as Error).message });
      }
    }

    const done = {
      ...summarise(actionable),
      attached,
      created,
      skipped: summarise(actionable).skipped + changed.length,
    };
    if (changed.length) done.reasons["changed since you looked"] = changed.length;
    res.json({
      dry_run: false,
      summary: done,
      message: describeSummary(done, failures.length),
      failures,
      changed,
      installed: installer.installed,
      // What the sheet needs for per-line undo: the items it acted on.
      filed: actionable.filter((p) => p.action !== "skip" && !failures.some((f) => f.itemId === p.itemId)).map((p) => p.itemId),
    });
  }),
);

// AI-REACH: exempt — the scanner screen's bookkeeping of which scanning
// session a scan came in with; the assistant never runs a scanning session
bulkRouter.post(
  "/inbox/merge-batches",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MergeBatchesBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if (parsed.data.from_batch_id === parsed.data.into_batch_id) {
      res.status(400).json({ error: { code: "same_batch", message: "those are the same session" } });
      return;
    }
    const db = tenantDb(req);
    const r = await db
      .updateTable("core_scan_inbox_items")
      .set({ scan_batch_id: parsed.data.into_batch_id, updated_at: new Date() })
      .where("scan_batch_id", "=", parsed.data.from_batch_id)
      .executeTakeFirst();
    res.json({ moved: Number(r.numUpdatedRows ?? 0) });
  }),
);

// ─────────────────────── POST /inbox/reassign-batch ─────────────────
// Move a SPECIFIC set of items into a batch. Undo path for a merge: after
// merge-batches folds session A into B, the client reassigns exactly the
// items it just moved back to A's (still-valid, now-empty) batch id. Unlike
// merge-batches this is item-scoped, not whole-batch — so folding A into B
// and then re-splitting only A's items out is precise even if B had items.
const ReassignBatchBody = z.object({
  item_ids: z.array(z.string().min(1)).min(1),
  batch_id: z.string().min(1),
});
// AI-REACH: exempt — the undo of a session merge on the scanner screen; see
// merge-batches above
bulkRouter.post(
  "/inbox/reassign-batch",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ReassignBatchBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const r = await db
      .updateTable("core_scan_inbox_items")
      .set({ scan_batch_id: parsed.data.batch_id, updated_at: new Date() })
      .where("id", "in", parsed.data.item_ids)
      .executeTakeFirst();
    res.json({ moved: Number(r.numUpdatedRows ?? 0) });
  }),
);

// ──────────────── POST /inbox/backfill-catalog-photos ───────────────
// Fill catalog images for pending items that have a real name but no catalog
// art (image-search by name, same as a re-identify's refresh — honors the
// user-picked-image lock). Detached per item; returns how many were queued.
// AI-REACH: exempt — fans an outside image search out over every pending item
// at once; the assistant looks one item up again, picture and all, through
// change_scan_item (do: rerun)
// UI-SCREEN: /scan (More inbox actions, Fill missing photos)
bulkRouter.post(
  "/inbox/backfill-catalog-photos",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "suggested_name", "suggested_manufacturer"])
      .where("status", "in", ["pending", "enriching"])
      .where("catalog_image_url", "is", null)
      .where("catalog_image_file_id", "is", null)
      .where("suggested_name", "is not", null)
      .limit(30)
      .execute();
    const targets = rows.filter((r) => !isJunkName(r.suggested_name));
    for (const r of targets) {
      // DETACHED: a backfill of catalog pictures; each row keeps its picture until its own lands
      void refreshCatalogImageByName(ctx.org.id, r.id, r.suggested_name!, r.suggested_manufacturer).catch(
        (err) => console.error("[core-scan] backfill catalog photo failed:", (err as Error).message),
      );
    }
    // Heal the OTHER gap: an item that already has a catalog URL but never got a
    // local file (a transient download failure at set-time). Pull the existing
    // URL into core-files — no search needed — so the cover STAYS local and a
    // later confirm never has to re-fetch from source.
    const token = bearer(req);
    let localized = 0;
    if (token) {
      const urlOnly = await db
        .selectFrom("core_scan_inbox_items")
        .select(["id", "catalog_image_url"])
        .where("status", "in", ["pending", "enriching"])
        .where("catalog_image_url", "is not", null)
        .where("catalog_image_file_id", "is", null)
        .limit(30)
        .execute();
      // Stored, or let go with "Couldn't save this one": an address is never
      // left standing as the catalog photo (catalog-store.ts, #4580).
      for (const r of urlOnly) {
        // DETACHED: a backfill storing catalog addresses as files; each row is let go or stored on its own
        void storeOrClearCatalogUrl({ db, orgId: ctx.org.id, itemId: r.id }, r.catalog_image_url!).catch((err) =>
          console.error("[core-scan] backfill localize url failed:", (err as Error).message),
        );
      }
      localized = urlOnly.length;
    }
    res.json({ queued: targets.length, localized });
  }),
);

// POST /inbox/apply-theme — stash the accepted theme onto the pending items:
// pending_tags (attached to the entity at confirm) + a category hint the
// confirm form pre-fills. No entity is created here.
const ApplyThemeBody = z.object({
  tag: optionalField(z.string().min(1).max(60)),
  tag_item_ids: z.array(z.string().uuid()).max(200).default([]),
  category: z.object({ value: z.string().min(1).max(80), item_ids: z.array(z.string().uuid()).max(200) }).optional(),
});
// AI-TOOL: change_scan_item
bulkRouter.post(
  "/inbox/apply-theme",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ApplyThemeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const catIds = new Set(parsed.data.category?.item_ids ?? []);
    const catValue = parsed.data.category?.value;
    const touched = new Set([...(parsed.data.tag ? parsed.data.tag_item_ids : []), ...catIds]);
    let tagged = 0;
    let categorized = 0;
    for (const id of touched) {
      const row = await db.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", id).where("status", "=", "pending").executeTakeFirst();
      if (!row) continue;
      const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
      const overlay: Record<string, unknown> = {};
      if (parsed.data.tag && parsed.data.tag_item_ids.includes(id)) {
        const cur = Array.isArray(meta.pending_tags) ? (meta.pending_tags as string[]) : [];
        if (!cur.includes(parsed.data.tag)) { overlay.pending_tags = [...cur, parsed.data.tag]; tagged++; }
      }
      if (catValue && catIds.has(id)) { overlay.suggested_category = catValue; categorized++; }
      if (Object.keys(overlay).length === 0) continue;
      // jsonb-merge onto the LIVE row so a concurrent matchmaker write can't
      // clobber the tag/category (and we don't clobber IT).
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify(overlay)}::jsonb` as never, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
    }
    res.json({ tagged, categorized });
  }),
);
