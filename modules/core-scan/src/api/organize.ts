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

import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { isJunkName } from "../services/enrich.js";
import { LengthUnitResolver, inboxLongestMm } from "../services/organize-dims.js";
import {
  gatherEntitiesByRefs,
  gatherUnplacedEntities,
  planOrganize,
  splitEntityRef,
  type OrganizeInputItem,
  type OrganizePlan,
} from "../services/organize-plan.js";

/**
 * The display names a stored plan carries for its own items.
 *
 * BOTH sets, not just the planned one. The READY groups ("already set, just
 * put it away") are built from rows that `plannable` deliberately excludes, so
 * their members used to have no snapshot at all and fell back to whatever the
 * caller's live inbox query happened to hold. A plan showing four groups
 * rendered one of them by name and the other twenty-one items as
 * "(unidentified)" (2026-08-22).
 *
 * The ready groups are exactly what this snapshot was written for: an item
 * that already has its destination is the likeliest one to have left the
 * caller's view.
 *
 * A row with no name at all is left out, so "(unidentified)" still means what
 * it says rather than becoming an empty label.
 */
/**
 * The photo a stored plan carries for each of its items.
 *
 * Same reason as planItemNames, and it was the other half of the same hole: a
 * row whose item has left the caller's view rendered a grey square. Names came
 * back first and the picture did not, which is worse than it sounds - a
 * put-away list is read by picture, and a column of grey squares is unusable
 * even when every name beside it is right.
 *
 * Built from the raw rows, so it covers the planned items and the ready ones
 * without either having to be threaded through separately.
 */
export function planItemPhotos(
  rows: ReadonlyArray<{
    id: string;
    image_file_id?: string | null;
    catalog_image_file_id?: string | null;
  }>,
): Record<string, { image_file_id?: string; catalog_image_file_id?: string }> {
  const out: Record<string, { image_file_id?: string; catalog_image_file_id?: string }> = {};
  for (const r of rows) {
    const entry = {
      ...(r.image_file_id ? { image_file_id: r.image_file_id } : {}),
      ...(r.catalog_image_file_id ? { catalog_image_file_id: r.catalog_image_file_id } : {}),
    };
    // A row with no picture at all stays out rather than storing an empty
    // object for every item in a large plan.
    if (Object.keys(entry).length) out[r.id] = entry;
  }
  return out;
}

export function planItemNames(
  plannable: ReadonlyArray<{ id: string; name: string | null }>,
  readyRows: ReadonlyArray<{ id: string; suggested_name: string | null }>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  // Planned first and unfiltered: the plan-reuse check compares these to the
  // live names, so a null must stay a null there.
  for (const p of plannable) out[p.id] = p.name;
  for (const r of readyRows) if (r.suggested_name) out[r.id] = r.suggested_name;
  return out;
}


export const organizeRouter: Router = Router({ mergeParams: true });

const PLAN_MAX_ITEMS = 200;
const PLAN_TTL_MS = 6 * 60 * 60 * 1000; // 6h — a plan spans a physical session, not a week.

// ─────────────────────── POST /organize/plan ───────────────────────

const PlanBody = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(PLAN_MAX_ITEMS).optional(),
    scan_batch_id: z.string().uuid().optional(),
    /** "unplaced": plan over UNPLACED committed entities instead of the
     *  inbox (Phase 3). "pending": every pending unfiled inbox item — the
     *  "Plan the pile" front door, no selection needed. "refs": plan over a
     *  SPECIFIC set of committed entity refs (the batch-scoped door an action
     *  opens after it produces a pile — a disassemble's spawned parts). */
    scope: z.enum(["unplaced", "pending", "refs"]).optional(),
    /** Composite "<kind>::<uuid>" refs to plan, for scope:"refs". */
    refs: z.array(z.string().min(1).max(200)).min(1).max(2000).optional(),
    /** Free-text ground truth from the human ("these are camping gear") —
     *  folded into the AI call; overrides the model's priors. Ephemeral by
     *  design: the durable way to teach the planner is data (bin names,
     *  placed items), not stored instructions. */
    hint: z.string().trim().max(500).optional(),
    /** Warm the scope:"pending" plan cache (the front-door surfaces fire
     *  this when they show the count) so the CLICK reveals a ready plan
     *  instead of starting one. A warm call with a fresh matching draft is
     *  a no-op. */
    warm: z.boolean().optional(),
    /** Force a recompute past the draft cache — the explicit Re-plan button
     *  (drafts don't see census changes, e.g. locations Cobb just made). */
    fresh: z.boolean().optional(),
    /** Stop carrying the session hint forward (the plan line's "clear"). */
    clear_hint: z.boolean().optional(),
  })
  .refine((b) => !!b.item_ids || !!b.scan_batch_id || !!b.scope, {
    message: "item_ids, scan_batch_id, or scope required",
  })
  .refine((b) => b.scope !== "refs" || (b.refs && b.refs.length > 0), {
    message: "scope:\"refs\" requires a non-empty refs array",
  });

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
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

    // ── The same planner pointed at committed entities: "unplaced" sweeps the
    // whole workspace, "refs" plans a specific pile an action just produced. ──
    if (body.scope === "unplaced" || body.scope === "refs") {
      const gathered =
        body.scope === "refs"
          ? await gatherEntitiesByRefs(ctx.org.id, body.refs!)
          : await gatherUnplacedEntities(ctx.org.id);
      if (gathered.items.length === 0) {
        res.status(422).json({
          error: {
            code: "nothing_to_plan",
            message:
              body.scope === "refs"
                ? "None of those need a home yet."
                : "Everything already has a home.",
          },
        });
        return;
      }
      const plan = await planOrganize(ctx.org.id, gathered.items, body.hint, sessionUser(req).id);
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
        // For the plan's own thumbnails - see planItemPhotos.
        "image_file_id",
        "catalog_image_file_id",
      ])
      .where("status", "=", "pending")
      // scope:"pending" is a one-click CTA — plan the newest cap-full rather
      // than erroring; explicit selections keep the too-many guard.
      .limit(body.scope === "pending" ? PLAN_MAX_ITEMS : PLAN_MAX_ITEMS + 1);
    if (body.item_ids) q = q.where("id", "in", body.item_ids);
    else if (body.scan_batch_id) q = q.where("scan_batch_id", "=", body.scan_batch_id);
    else {
      // scope:"pending" — the whole pending backlog, newest first (the cap
      // keeps the plan bounded). Filed-but-uncommitted rows ride along too:
      // they become READY groups ("all set — just put them away") instead of
      // being invisible; only the unfiled set feeds the planner. id breaks
      // created_at ties (items imported in one batch share a timestamp) so the
      // capped slice is a stable set, matching the inbox list's keyset order.
      q = q.orderBy("created_at", "desc").orderBy("id", "desc");
    }
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
    const lengths = new LengthUnitResolver(ctx.org.id);
    for (const r of rows) {
      if (r.target_location_id || r.target_container_id) {
        alreadyFiled.push(r.id);
        continue;
      }
      if (!r.suggested_name || isJunkName(r.suggested_name)) {
        needsReview.push(r.id);
        continue;
      }
      const meta = (r.suggested_metadata ?? {}) as {
        category?: unknown;
        hint_category?: { domain?: unknown; sub?: unknown };
      };
      // The category feeds the planner's coarse starter-bin roll-up
      // (category-buckets.ts). The barcode/enrichment path writes `category`;
      // the CSV/import path writes `hint_category.{domain,sub}` — honour either
      // so an imported-onboarding workspace gets starter bins too. Prefer the
      // more specific sub, fall back to the domain.
      const category =
        typeof meta.category === "string"
          ? meta.category
          : typeof meta.hint_category?.sub === "string"
            ? (meta.hint_category.sub as string)
            : typeof meta.hint_category?.domain === "string"
              ? (meta.hint_category.domain as string)
              : null;
      // Size (3b): a metadata value that literally carries a length unit
      // ("180 mm") gives the item a declared longest dimension; nothing else
      // does — no guessing from names.
      const dims = await inboxLongestMm(
        r.suggested_metadata as Record<string, unknown> | null,
        lengths,
      );
      plannable.push({
        id: r.id,
        name: r.suggested_name,
        manufacturer: r.suggested_manufacturer,
        category,
        quantity: r.quantity ?? 1,
        ...(dims ? { longest_mm: dims.longest_mm, dims_detail: dims.detail } : {}),
      });
    }
    // All-ready is a fine plan ("this is all set — you gonna do it?"): only
    // 422 when there's truly nothing to show.
    const hasReady = rows.some((r) => alreadyFiled.includes(r.id) && r.target_location_id);
    if (plannable.length === 0 && !hasReady) {
      // The pile is real (it counts toward the "unfiled" banner + the toggle),
      // it's just entirely UNIDENTIFIED — so the Sorting-plan lens has nothing
      // to place. Carry the count so the client can point back to those items
      // ("Review N") instead of dead-ending on a bare error string. This is the
      // exact case a beta tester hit: one scanned skein sat in the inbox, findable in
      // "By session", yet "Sorting plan" said "nothing identified" with no path.
      res.status(422).json({
        error: {
          code: "nothing_to_plan",
          message:
            alreadyFiled.length > 0
              ? "Everything selected already has a location."
              : "Nothing identified to organize yet — identify items first.",
          details: { needs_review_count: needsReview.length },
        },
      });
      return;
    }

    // scope:"pending" (no hint) is CACHEABLE: the front door warms it when it
    // shows the count, so the click reveals a ready plan instead of starting
    // one. A draft is valid while it's young (census drift bound), untouched
    // (nothing applied), and the backlog fingerprint still matches.
    const DRAFT_FRESH_MS = 10 * 60 * 1000;
    // EVERY scope:"pending" plan is stamped with the backlog fingerprint —
    // including hinted ones, so a hint's (better) result BECOMES the standing
    // draft and survives close/reopen. Only the REUSE check skips hinted
    // calls: asking with a hint always reasons fresh.
    const fingerprint =
      body.scope === "pending"
        ? createHash("sha1")
            .update(plannable.map((p) => `${p.id}|${p.name}`).sort().join("\n"))
            .digest("hex")
        : null;
    const candidates =
      body.scope === "pending"
        ? await db
            .selectFrom("core_scan_organize_plans")
            .select(["id", "payload", "applied_group_ids", "created_at", "expires_at"])
            .where("expires_at", ">", new Date())
            // seq (monotonic) breaks created_at ties so "newest first" is exact
            // and stable — draft reuse + hint carry both key off candidates[0]
            // / the first match, and a tie returned in arbitrary order flaked
            // whichever plan won (a hinted plan not surviving close/reopen).
            .orderBy("created_at", "desc")
            .orderBy("seq", "desc")
            .limit(5)
            .execute()
        : [];
    const isDraftable = body.scope === "pending" && !body.hint && !body.fresh;
    if (isDraftable && fingerprint) {
      const draft = candidates.find((c) => {
        const p = c.payload as { draft_fingerprint?: string; draft_hinted?: boolean };
        if (p.draft_fingerprint !== fingerprint) return false;
        if ((c.applied_group_ids as unknown[]).length > 0) return false;
        // A HINTED draft is the human's corrected plan — it holds for the
        // plan's whole lifetime (the fingerprint still invalidates it the
        // moment the backlog changes). Un-hinted drafts stay young so census
        // drift (new bins made elsewhere) can't linger.
        return p.draft_hinted ? true : Date.now() - c.created_at.getTime() < DRAFT_FRESH_MS;
      });
      if (draft) {
        res.json({ plan_id: draft.id, expires_at: draft.expires_at, ...(draft.payload as Record<string, unknown>) });
        return;
      }
    }

    // THE SESSION HINT CARRIES: scanning more items or sending one back
    // changes the fingerprint and forces a recompute — but the human's
    // ground truth (its stored hint) didn't stop being true. When no
    // explicit hint rides this call, reuse the newest plan's stored hint so
    // it survives backlog churn for its working session (plan TTL). Visible
    // + clearable on the plan line; clear_hint stops the carry.
    let effectiveHint = body.hint;
    if (body.scope === "pending" && !effectiveHint && !body.clear_hint) {
      const carried = (candidates[0]?.payload as { hint_text?: string } | undefined)?.hint_text;
      if (typeof carried === "string" && carried.trim()) effectiveHint = carried;
    }

    // INCREMENTAL PRESERVATION: adding items must not destroy the plan you
    // already built for the others. If the newest untouched draft's planned
    // (non-ready) groups cover a SUBSET of the current unfiled items with
    // UNCHANGED names — i.e. you only ADDED items (scanned one more item onto
    // an existing plan) — keep those groups verbatim and plan ONLY
    // the new items. Full recompute would throw the existing grouping away the
    // moment the AI call flakes on the recompute (the heuristic can't know it).
    // Only when not fresh and not an explicit hint (both mean "reason anew").
    interface StoredPlanGroup {
      id: string;
      item_ids: string[];
      ready?: boolean;
      destination: { kind: string };
    }
    const parent =
      body.scope === "pending" && !body.fresh && !body.hint && plannable.length > 0
        ? candidates.find((c) => {
            if ((c.applied_group_ids as unknown[]).length > 0) return false;
            const pl = c.payload as { groups?: StoredPlanGroup[]; item_names?: Record<string, string> };
            const planned = (pl.groups ?? []).filter((g) => !g.ready);
            const plannedIds = planned.flatMap((g) => g.item_ids);
            if (plannedIds.length === 0) return false;
            const nowById = new Map(plannable.map((p) => [p.id, p.name] as const));
            // Every planned item still present with the SAME name (a rename
            // changes grouping, so bail to a full recompute then).
            if (!plannedIds.every((id) => nowById.get(id) === (pl.item_names ?? {})[id])) return false;
            // And there must be genuinely NEW items (otherwise the exact-match
            // reuse above would have returned it).
            return plannable.some((p) => !plannedIds.includes(p.id));
          })
        : undefined;

    let plan: OrganizePlan;
    if (parent) {
      const pl = parent.payload as { groups?: StoredPlanGroup[]; source?: "ai" | "heuristic" };
      const preserved = (pl.groups ?? []).filter((g) => !g.ready) as unknown as OrganizePlan["groups"];
      const preservedIds = new Set(preserved.flatMap((g) => g.item_ids));
      const newItems = plannable.filter((p) => !preservedIds.has(p.id));
      const newPlan =
        newItems.length > 0
          ? await planOrganize(ctx.org.id, newItems, effectiveHint, sessionUser(req).id)
          : { groups: [], census_truncated: false, source: "heuristic" as const };
      plan = {
        groups: [...preserved, ...newPlan.groups],
        census_truncated: newPlan.census_truncated,
        // Keep the parent's label (the preserved grouping is the headline).
        source: pl.source ?? newPlan.source,
      };
    } else {
      plan =
        plannable.length > 0
          ? await planOrganize(ctx.org.id, plannable, effectiveHint, sessionUser(req).id)
          : { groups: [], census_truncated: false, source: "heuristic" };
    }

    // READY groups: items a human (or an accepted plan) already gave a
    // destination, still sitting uncommitted. The plan's job for them is
    // simply "this is all set — you gonna do it?": a DISPLAY card the user
    // completes with an "I did it!" commit (never the walk, never Accept,
    // never re-planned). NOT born applied — that made a background-warmed
    // plan fake a started walk and nag "resume put-away walk". Location-less
    // pre-fills (container targets) stay in the untouched count.
    const readyRows = rows.filter(
      (r) => alreadyFiled.includes(r.id) && r.target_location_id,
    );
    const readyByLoc = new Map<string, typeof readyRows>();
    for (const r of readyRows) {
      const arr = readyByLoc.get(r.target_location_id!) ?? [];
      arr.push(r);
      readyByLoc.set(r.target_location_id!, arr);
    }
    const readyGroups: Array<Record<string, unknown>> = [];
    for (const [locId, members] of readyByLoc) {
      const loc = await platform()
        .entities.lookup(ctx.org.id, "core-locations:location", locId)
        .catch(() => null);
      if (!loc) continue;
      readyGroups.push({
        id: randomUUID(),
        label: loc.title,
        rationale: "Already set, these just need to be physically put away.",
        item_ids: members.map((m) => m.id),
        destination: {
          kind: "existing",
          location_id: locId,
          location_name: loc.title,
          location_path: loc.title,
        },
        ready: true,
      });
    }

    const payload = {
      ...(fingerprint ? { draft_fingerprint: fingerprint } : {}),
      ...(fingerprint && effectiveHint ? { draft_hinted: true, hint_text: effectiveHint } : {}),
      ...plan,
      groups: [...readyGroups, ...plan.groups],
      subject: "inbox" as const,
      // Display names ride the payload so the walk never depends on the inbox
      // query still holding the item (it may commit/resolve mid-walk).
      item_names: planItemNames(plannable, readyRows),
      item_photos: planItemPhotos(rows),
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
        /** Items the user split out of the group ("not related") — they are
         *  not filed and keep their normal triage path. */
        exclude_item_ids: z.array(z.string().min(1).max(200)).max(200).optional(),
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

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
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
        error: { code: "plan_expired", message: "This plan expired, re-plan and review again." },
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
    const resolved = new Map<
      string,
      { location_id: string; location_name: string; location_path: string; item_ids: string[] }
    >();

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
        skipped.push({ group_id: gid, reason: "unassigned. Pick a destination first" });
        continue;
      }
      const excluded = new Set(ovr?.exclude_item_ids ?? []);
      const keptIds = group.item_ids.filter((id) => !excluded.has(id));
      if (keptIds.length === 0) {
        skipped.push({ group_id: gid, reason: "every item was split out of this group" });
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
          skipped.push({ group_id: gid, reason: "couldn't create the new bin, re-plan and retry" });
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
        for (const ref of keptIds) {
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
          .where("id", "in", keptIds)
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
        item_ids: keptIds,
      });
    }

    if (appliedGroupIds.length > 0) {
      // Persist the resolved destinations into the payload so the walk (and a
      // resumed session) reads real bin ids, including just-created ones.
      const payload = row.payload as Record<string, unknown>;
      const nextGroups = groups.map((g) => {
        const r = resolved.get(g.id);
        if (!r) return g;
        const { item_ids, ...dest } = r;
        return { ...g, item_ids, destination: { kind: "existing" as const, ...dest } };
      });
      await db
        .updateTable("core_scan_organize_plans")
        .set({
          payload: sql`${JSON.stringify({ ...payload, groups: nextGroups })}::jsonb` as never,
          // jsonb-replace-ok: the applied set is owned end-to-end by the organize run
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
      // seq tiebreaks same-timestamp plans so "the latest" is deterministic.
      .orderBy("created_at", "desc")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      res.json({ plan: null });
      return;
    }
    // Walk progress now lives on the put-away SESSION (the shared execution
    // engine — docs/product/put-away.md §2.2); the plan row's walk_state is
    // the legacy fallback for a walk that was mid-flight when sessions
    // shipped. Same response shape either way.
    const session = await db
      .selectFrom("core_scan_putaway_sessions")
      .select(["id", "state"])
      .where("plan_id", "=", row.id)
      .where("ended_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    res.json({
      plan: {
        plan_id: row.id,
        ...(row.payload as Record<string, unknown>),
        applied_group_ids: row.applied_group_ids,
        walk_state: session ? session.state : row.walk_state,
        putaway_session_id: session?.id ?? null,
        expires_at: row.expires_at,
      },
    });
  }),
);

// ─────────────────── POST /organize/walk-state ───────────────────
// DEPRECATED (Phase 0 of docs/product/put-away.md): progress now lives on a
// put-away session (api/putaway.ts) and plan/latest reads from it. Kept one
// release for a stale tab loaded before the deploy; remove after.
// Persist walk progress (which items are physically placed). Idempotent
// replace — the client owns the truth of its own checklist; only ids that are
// actually in the plan are kept, so a stale client can't grow the row.

const WalkStateBody = z.object({
  plan_id: z.string().uuid(),
  // Inbox plans use uuids; entity plans use "<kind>::<uuid>" refs. Either way
  // only ids actually in the plan are kept (filtered below).
  placed_item_ids: z.array(z.string().min(1).max(200)).max(PLAN_MAX_ITEMS),
});

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
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
