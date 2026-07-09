// Guided Organize endpoints (docs/product/guided-organize.md).
//
//   POST /organize/plan   { item_ids? | scan_batch_id? } → a stored plan:
//     groups (label, members, destination, evidence), plus which of the
//     requested items were excluded and why (already filed / needs review).
//   POST /organize/apply  { plan_id, group_ids, overrides? } → per-group
//     accept: creates accepted new bins (through core-locations' registered
//     entity WRITER — the sanctioned cross-module seam), stamps each member
//     item's target_location_id, and records the group as applied. Items then
//     commit through the normal confirm flow; nothing new touches commit.
//
// The plan is a PROPOSAL. Nothing files or gets created until a group is
// explicitly accepted here, human-set locations are never re-planned, and
// apply only ever writes where target_location_id is still null.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { isJunkName } from "../services/enrich.js";
import {
  gatherUnplacedEntities,
  planOrganize,
  splitEntityRef,
  type OrganizeInputItem,
  type OrganizePlan,
} from "../services/organize-plan.js";

export const organizeRouter: Router = Router({ mergeParams: true });

const PLAN_MAX_ITEMS = 200;
const PLAN_TTL_MS = 6 * 60 * 60 * 1000; // 6h — a plan spans a physical session, not a week.

// ─────────────────────── POST /organize/plan ───────────────────────

const PlanBody = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(PLAN_MAX_ITEMS).optional(),
    scan_batch_id: z.string().uuid().optional(),
    /** Phase 3: plan over UNPLACED committed entities instead of the inbox. */
    scope: z.literal("unplaced").optional(),
  })
  .refine((b) => !!b.item_ids || !!b.scan_batch_id || b.scope === "unplaced", {
    message: "item_ids, scan_batch_id, or scope:\"unplaced\" required",
  });

organizeRouter.post(
  "/organize/plan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PlanBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;
    const ctx = tenantContext(req);
    const db = tenantDb(req);

    // Expired plans are working state, not history — sweep opportunistically.
    await db.deleteFrom("core_scan_organize_plans").where("expires_at", "<", new Date()).execute();

    // ── Phase 3: the same planner pointed at unplaced committed entities. ──
    if (body.scope === "unplaced") {
      const gathered = await gatherUnplacedEntities(ctx.org.id);
      if (gathered.items.length === 0) {
        res.status(422).json({
          error: { code: "nothing_to_plan", message: "Everything already has a home." },
        });
        return;
      }
      const plan = await planOrganize(ctx.org.id, gathered.items);
      const payload = {
        ...plan,
        subject: "entities" as const,
        item_names: gathered.names,
        item_barcodes: gathered.barcodes,
        census_truncated: plan.census_truncated || gathered.truncated,
        already_filed_item_ids: [],
        needs_review_item_ids: [],
      };
      const inserted = await db
        .insertInto("core_scan_organize_plans")
        .values({
          payload: sql`${JSON.stringify(payload)}::jsonb` as never,
          created_by_user_id: sessionUser(req).id,
          expires_at: new Date(Date.now() + PLAN_TTL_MS),
        })
        .returning(["id", "expires_at"])
        .executeTakeFirstOrThrow();
      res.json({ plan_id: inserted.id, expires_at: inserted.expires_at, ...payload });
      return;
    }

    let q = db
      .selectFrom("core_scan_inbox_items")
      .select([
        "id",
        "status",
        "suggested_name",
        "suggested_manufacturer",
        "suggested_metadata",
        "target_location_id",
        "target_container_id",
        "quantity",
      ])
      .where("status", "=", "pending")
      .limit(PLAN_MAX_ITEMS + 1);
    q = body.item_ids
      ? q.where("id", "in", body.item_ids)
      : q.where("scan_batch_id", "=", body.scan_batch_id!);
    const rows = await q.execute();
    if (rows.length > PLAN_MAX_ITEMS) {
      res.status(422).json({
        error: {
          code: "too_many_items",
          message: `Organize plans cap at ${PLAN_MAX_ITEMS} items — select fewer.`,
        },
      });
      return;
    }

    // Split the pile: plannable / already filed (human decision stands) /
    // needs review (unidentified — identify first, organize second).
    const plannable: OrganizeInputItem[] = [];
    const alreadyFiled: string[] = [];
    const needsReview: string[] = [];
    for (const r of rows) {
      if (r.target_location_id || r.target_container_id) {
        alreadyFiled.push(r.id);
        continue;
      }
      if (!r.suggested_name || isJunkName(r.suggested_name)) {
        needsReview.push(r.id);
        continue;
      }
      const meta = (r.suggested_metadata ?? {}) as { category?: unknown };
      plannable.push({
        id: r.id,
        name: r.suggested_name,
        manufacturer: r.suggested_manufacturer,
        category: typeof meta.category === "string" ? meta.category : null,
        quantity: r.quantity ?? 1,
      });
    }
    if (plannable.length === 0) {
      res.status(422).json({
        error: {
          code: "nothing_to_plan",
          message:
            alreadyFiled.length > 0
              ? "Everything selected already has a location."
              : "Nothing identified to organize yet — identify items first.",
        },
      });
      return;
    }

    const plan: OrganizePlan = await planOrganize(ctx.org.id, plannable);
    const payload = {
      ...plan,
      subject: "inbox" as const,
      // Display names ride the payload so the walk never depends on the inbox
      // query still holding the item (it may commit/resolve mid-walk).
      item_names: Object.fromEntries(plannable.map((p) => [p.id, p.name])),
      already_filed_item_ids: alreadyFiled,
      needs_review_item_ids: needsReview,
    };
    const inserted = await db
      .insertInto("core_scan_organize_plans")
      .values({
        payload: sql`${JSON.stringify(payload)}::jsonb` as never,
        created_by_user_id: sessionUser(req).id,
        expires_at: new Date(Date.now() + PLAN_TTL_MS),
      })
      .returning(["id", "expires_at"])
      .executeTakeFirstOrThrow();

    res.json({ plan_id: inserted.id, expires_at: inserted.expires_at, ...payload });
  }),
);

// ─────────────────────── POST /organize/apply ───────────────────────

const ApplyBody = z.object({
  plan_id: z.string().uuid(),
  group_ids: z.array(z.string().uuid()).min(1).max(100),
  /** Per-group destination override from the review UI: file into a different
   *  existing location, or create a differently-named/parented new bin. */
  overrides: z
    .array(
      z.object({
        group_id: z.string().uuid(),
        location_id: z.string().uuid().optional(),
        new_location: z
          .object({
            name: z.string().min(1).max(120),
            parent_id: z.string().uuid().nullable().optional(),
          })
          .optional(),
      }),
    )
    .max(100)
    .optional(),
});

interface StoredGroup {
  id: string;
  label: string;
  item_ids: string[];
  destination:
    | { kind: "existing"; location_id: string; location_name?: string; location_path?: string }
    | { kind: "new"; name: string; parent_id: string | null }
    | { kind: "unassigned" };
}

organizeRouter.post(
  "/organize/apply",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ApplyBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;
    const ctx = tenantContext(req);
    const db = tenantDb(req);

    const row = await db
      .selectFrom("core_scan_organize_plans")
      .select(["id", "payload", "applied_group_ids", "expires_at"])
      .where("id", "=", body.plan_id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "plan not found" } });
      return;
    }
    if (row.expires_at < new Date()) {
      res.status(410).json({
        error: { code: "plan_expired", message: "This plan expired — re-plan and review again." },
      });
      return;
    }
    const groups = ((row.payload as { groups?: StoredGroup[] }).groups ?? []) as StoredGroup[];
    // Phase 3: an "entities" plan files committed entities (writer updates),
    // an "inbox" plan (or a pre-Phase-3 row with no subject) stamps inbox rows.
    const subject =
      (row.payload as { subject?: string }).subject === "entities" ? "entities" : "inbox";
    const applied = new Set((row.applied_group_ids as unknown[]).filter((x) => typeof x === "string") as string[]);
    const overrides = new Map((body.overrides ?? []).map((o) => [o.group_id, o] as const));

    const writer = platform().entities.getWriter("core-locations:location");
    const createdLocations: Array<{ id: string; name: string; group_id: string }> = [];
    const filedItemIds: string[] = [];
    const appliedGroupIds: string[] = [];
    const skipped: Array<{ group_id: string; reason: string }> = [];
    // Resolved destination per applied group — written back into the stored
    // payload so the put-away walk (and any later read) sees the ACTUAL bin,
    // including ones minted here (a "new" destination has no id until now).
    const resolved = new Map<string, { location_id: string; location_name: string; location_path: string }>();

    for (const gid of body.group_ids) {
      const group = groups.find((g) => g.id === gid);
      if (!group) {
        skipped.push({ group_id: gid, reason: "unknown group" });
        continue;
      }
      if (applied.has(gid)) {
        skipped.push({ group_id: gid, reason: "already applied" });
        continue;
      }

      // Resolve the destination: override > the plan's own. Unassigned groups
      // apply only when an override names a destination.
      const ovr = overrides.get(gid);
      let locationId: string | null = null;
      let newLocation: { name: string; parent_id: string | null } | null = null;
      if (ovr?.location_id) locationId = ovr.location_id;
      else if (ovr?.new_location) {
        newLocation = { name: ovr.new_location.name, parent_id: ovr.new_location.parent_id ?? null };
      } else if (group.destination.kind === "existing") locationId = group.destination.location_id;
      else if (group.destination.kind === "new") {
        newLocation = { name: group.destination.name, parent_id: group.destination.parent_id };
      }
      if (!locationId && !newLocation) {
        skipped.push({ group_id: gid, reason: "unassigned — pick a destination first" });
        continue;
      }

      let locationName: string | null = null;
      if (locationId) {
        // The destination must still exist — a plan can outlive a deleted bin.
        const loc = await platform()
          .entities.lookup(ctx.org.id, "core-locations:location", locationId)
          .catch(() => null);
        if (!loc) {
          skipped.push({ group_id: gid, reason: "destination location no longer exists" });
          continue;
        }
        locationName = loc.title;
      } else if (newLocation) {
        if (!writer) {
          skipped.push({ group_id: gid, reason: "locations module unavailable" });
          continue;
        }
        // A failed create (e.g. the chosen parent was deleted since planning)
        // skips THIS group — it must never 500 away the groups already applied
        // in this same request before their applied_group_ids record lands.
        try {
          locationId = await writer.create(ctx.org.id, {
            name: newLocation.name,
            parent_id: newLocation.parent_id,
            kind: "container",
          });
        } catch {
          skipped.push({ group_id: gid, reason: "couldn't create the new bin — re-plan and retry" });
          continue;
        }
        createdLocations.push({ id: locationId, name: newLocation.name, group_id: gid });
        locationName = newLocation.name;
      }

      if (subject === "entities") {
        // Move committed entities through each kind's registered WRITER (the
        // same sanctioned seam the sync engine uses — validation + module
        // events fire). An entity that gained a location mid-review (or was
        // deleted) is skipped: the human/most-recent decision wins.
        for (const ref of group.item_ids) {
          const split = splitEntityRef(ref);
          if (!split) continue;
          const w = platform().entities.getWriter(split.kind);
          if (!w) continue;
          const cur = await platform()
            .entities.lookup(ctx.org.id, split.kind, split.id)
            .catch(() => null);
          if (!cur || (typeof cur.fields.location_id === "string" && cur.fields.location_id)) continue;
          try {
            await w.update(ctx.org.id, split.id, { location_id: locationId });
            filedItemIds.push(ref);
          } catch {
            /* per-item best effort — the rest of the group still files */
          }
        }
      } else {
        // Stamp members — only ones still pending AND still unfiled, so a
        // location the user set mid-review (or a confirm that raced us) wins.
        const stamped = await db
          .updateTable("core_scan_inbox_items")
          .set({ target_location_id: locationId, updated_at: new Date() })
          .where("id", "in", group.item_ids)
          .where("status", "=", "pending")
          .where("target_location_id", "is", null)
          .where("target_container_id", "is", null)
          .returning("id")
          .execute();
        filedItemIds.push(...stamped.map((s) => s.id));
      }
      appliedGroupIds.push(gid);
      applied.add(gid);
      const prior = group.destination.kind === "existing" ? group.destination : null;
      resolved.set(gid, {
        location_id: locationId!,
        location_name: locationName ?? prior?.location_name ?? "",
        location_path: prior?.location_path ?? locationName ?? "",
      });
    }

    if (appliedGroupIds.length > 0) {
      // Persist the resolved destinations into the payload so the walk (and a
      // resumed session) reads real bin ids, including just-created ones.
      const payload = row.payload as Record<string, unknown>;
      const nextGroups = groups.map((g) => {
        const r = resolved.get(g.id);
        return r ? { ...g, destination: { kind: "existing" as const, ...r } } : g;
      });
      await db
        .updateTable("core_scan_organize_plans")
        .set({
          payload: sql`${JSON.stringify({ ...payload, groups: nextGroups })}::jsonb` as never,
          applied_group_ids: sql`${JSON.stringify([...applied])}::jsonb` as never,
        })
        .where("id", "=", body.plan_id)
        .execute();
      void platform().events.emit("core-scan.organize.applied", {
        orgId: ctx.org.id,
        planId: body.plan_id,
        groupCount: appliedGroupIds.length,
        itemCount: filedItemIds.length,
        newBinCount: createdLocations.length,
      });
    }

    res.json({
      applied_group_ids: appliedGroupIds,
      filed_item_ids: filedItemIds,
      created_locations: createdLocations,
      skipped,
    });
  }),
);

// ─────────────────── GET /organize/plan/latest ───────────────────
// The most recent unexpired plan, for resuming a put-away walk after a
// reload/tab switch. `{ plan: null }` (not a 404) when there's nothing — the
// scan page polls this casually.

organizeRouter.get(
  "/organize/plan/latest",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_organize_plans")
      .select(["id", "payload", "applied_group_ids", "walk_state", "expires_at"])
      .where("expires_at", ">", new Date())
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      res.json({ plan: null });
      return;
    }
    res.json({
      plan: {
        plan_id: row.id,
        ...(row.payload as Record<string, unknown>),
        applied_group_ids: row.applied_group_ids,
        walk_state: row.walk_state,
        expires_at: row.expires_at,
      },
    });
  }),
);

// ─────────────────── POST /organize/walk-state ───────────────────
// Persist walk progress (which items are physically placed). Idempotent
// replace — the client owns the truth of its own checklist; only ids that are
// actually in the plan are kept, so a stale client can't grow the row.

const WalkStateBody = z.object({
  plan_id: z.string().uuid(),
  // Inbox plans use uuids; entity plans use "<kind>::<uuid>" refs. Either way
  // only ids actually in the plan are kept (filtered below).
  placed_item_ids: z.array(z.string().min(1).max(200)).max(PLAN_MAX_ITEMS),
});

organizeRouter.post(
  "/organize/walk-state",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = WalkStateBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_organize_plans")
      .select(["id", "payload", "expires_at"])
      .where("id", "=", parsed.data.plan_id)
      .executeTakeFirst();
    if (!row || row.expires_at < new Date()) {
      res.status(404).json({ error: { code: "not_found", message: "plan not found or expired" } });
      return;
    }
    const planItemIds = new Set(
      (((row.payload as { groups?: StoredGroup[] }).groups ?? []) as StoredGroup[]).flatMap(
        (g) => g.item_ids,
      ),
    );
    const placed = parsed.data.placed_item_ids.filter((id) => planItemIds.has(id));
    await db
      .updateTable("core_scan_organize_plans")
      .set({ walk_state: sql`${JSON.stringify({ placed_item_ids: placed })}::jsonb` as never })
      .where("id", "=", parsed.data.plan_id)
      .execute();
    res.json({ placed_item_ids: placed });
  }),
);
