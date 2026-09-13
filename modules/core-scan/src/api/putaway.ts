// Put-away sessions (docs/product/put-away.md §2.2) — the ONE resumable
// execution engine under both tempos.
//
//   POST /putaway/start        { plan_id? , catch_all_location_id? }
//     plan_id set  → PLAN mode: the Guided Organize put-away walk, executing
//                    an applied plan (queue known up front).
//     plan_id null → LIVE mode (Live Sort): open-ended; each scan is routed
//                    to a destination directive at scan time.
//     Idempotent: an active session (same plan, or the caller's active live
//     session) resumes rather than duplicating.
//   POST /putaway/:id/state    { placed_item_ids } — plan mode: walk progress
//     (idempotent replace; only ids actually in the plan are kept).
//   POST /putaway/:id/scan     { inbox_item_id } — live mode: route the item →
//     a DIRECTIVE ("→ Bin 1 · Fasteners" | catch-all). Idempotent per item:
//     re-scanning re-routes an unconfirmed entry (enrichment may have landed
//     a name since), and returns a confirmed one as-is.
//   POST /putaway/:id/confirm  { entry_id, location_id? } — live mode: the one
//     gesture. Stamps the inbox item's target_location_id (override wins),
//     updates the sticky bin + the session's filed map.
//   POST /putaway/:id/undo     { entry_id } — live mode: revert a confirm.
//   POST /putaway/:id/end      → close the session, emit the summary event.
//   GET  /putaway/current      → the caller's active session, for resume chips.
//
// The intake itself is NOT here: a live client scans through the normal
// POST /scan (short enrich_ms budget — the router only needs a coarse
// name/category, full enrichment continues detached) and hands the item id to
// /scan here for routing. Routing is routeItem (putaway-route.ts): census +
// session context, deterministic, blank-beats-wrong — no defensible answer
// degrades to the catch-all, never a guess.
//
// Sessions are ephemeral working state like plans: swept on expiry. In-flight
// pre-migration walks self-heal: the first start imports the plan row's
// legacy walk_state.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { significantTokens } from "../services/suggest-location.js";
import { isJunkName } from "../services/enrich.js";
import { LengthUnitResolver, inboxLongestMm } from "../services/organize-dims.js";
import {
  buildBinCensus,
  routeItem,
  type Census,
  type InteriorMm,
  type SessionRouteContext,
} from "../services/putaway-route.js";
import { walkQueue, type QueueGroup, type LeftOut, type QueuePlan } from "../services/putaway-queue.js";
import { filingBlocker } from "../services/file-through-confirm.js";

export const putawayRouter: Router = Router({ mergeParams: true });

const MAX_ITEMS = 200; // mirrors the plan cap
const LIVE_TTL_MS = 12 * 60 * 60 * 1000; // a live session spans an afternoon, not a week
const LIVE_MAX_ENTRIES = 500;
const CENSUS_STALE_MS = 10 * 60 * 1000; // rebuild the census mid-session after this

interface StoredGroup {
  id: string;
  item_ids: string[];
  destination: { kind: string; location_id?: string };
}

function planItemIds(payload: unknown): Set<string> {
  return new Set(
    (((payload as { groups?: StoredGroup[] }).groups ?? []) as StoredGroup[]).flatMap(
      (g) => g.item_ids,
    ),
  );
}

// ── The walk's queue ─────────────────────────────────────────────────────────
// Every accepted group from every plan still in play whose items are filed
// and not yet placed (services/putaway-queue.ts), read fresh from the items:
// placement is placed_at on the inbox row, so a second plan, a resumed
// session and the resume chip all read one truth. An entities plan walks its
// own refs with the session's marks, since those are not inbox rows.

interface WalkPlanRow {
  id: string;
  payload: unknown;
  applied_group_ids: unknown;
  created_at: Date;
}

export interface AssembledWalk {
  groups: QueueGroup[];
  left_out: LeftOut[];
  remaining: number;
  placed_item_ids: string[];
  item_names: Record<string, string>;
  item_quantities: Record<string, number>;
  item_barcodes: Record<string, string>;
  /** The plans whose groups the walk drew from, pinned first. */
  plan_ids: string[];
}

function toQueuePlan(row: WalkPlanRow): QueuePlan {
  const payload = row.payload as { subject?: string; groups?: Array<StoredGroup & { label?: string; destination: { kind: string; location_id?: string; location_name?: string; location_path?: string } }> };
  return {
    plan_id: row.id,
    subject: payload.subject === "entities" ? "entities" : "inbox",
    applied_group_ids: (row.applied_group_ids as unknown[]).filter((x): x is string => typeof x === "string"),
    groups: (payload.groups ?? []).map((g) => ({ id: g.id, label: g.label ?? "", item_ids: g.item_ids, destination: g.destination })),
  };
}

async function assembleWalk(
  db: ReturnType<typeof tenantDb>,
  pinned: WalkPlanRow | null,
  sessionPlaced: readonly string[],
): Promise<AssembledWalk> {
  const pinnedPlan = pinned ? toQueuePlan(pinned) : null;
  // An entities plan walks alone; an inbox plan walks with every other inbox
  // plan still in play that has something accepted, newest first.
  const rows: WalkPlanRow[] = pinned ? [pinned] : [];
  if (!pinnedPlan || pinnedPlan.subject === "inbox") {
    const others = await db
      .selectFrom("core_scan_organize_plans")
      .select(["id", "payload", "applied_group_ids", "created_at"])
      .where("expires_at", ">", new Date())
      .where(sql`jsonb_array_length(applied_group_ids)`, ">", 0)
      .orderBy("created_at", "desc")
      .orderBy("seq", "desc")
      .limit(20)
      .execute();
    for (const o of others) {
      if (pinned && o.id === pinned.id) continue;
      if (toQueuePlan(o).subject === "inbox") rows.push(o);
    }
  }
  const plans = rows.map(toQueuePlan);
  const names: Record<string, string> = {};
  const quantities: Record<string, number> = {};
  const barcodes: Record<string, string> = {};
  for (const row of rows) {
    const payload = row.payload as { item_names?: Record<string, string | null>; item_barcodes?: Record<string, string> };
    for (const [id, n] of Object.entries(payload.item_names ?? {})) if (n && !names[id]) names[id] = n;
    for (const [id, b] of Object.entries(payload.item_barcodes ?? {})) if (b && !barcodes[id]) barcodes[id] = b;
  }
  const inboxIds = [...new Set(plans.filter((p) => p.subject === "inbox").flatMap((p) => p.groups.flatMap((g) => g.item_ids)))];
  const placed = new Set<string>(sessionPlaced);
  const unfiled = new Map<string, string>();
  const missing = new Set<string>();
  if (inboxIds.length > 0) {
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "status", "placed_at", "suggested_name", "quantity", "barcode_text", "suggested_candidates"])
      .where("id", "in", inboxIds)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of inboxIds) {
      const r = byId.get(id);
      if (!r || r.status === "discarded") {
        missing.add(id);
        continue;
      }
      if (r.placed_at) placed.add(id);
      if (r.status !== "resolved") unfiled.set(id, filingBlocker(r) ?? "still in the inbox");
      if (r.suggested_name) names[id] = r.suggested_name;
      if (r.quantity && Number(r.quantity) > 1) quantities[id] = Number(r.quantity);
      if (r.barcode_text) barcodes[id] = r.barcode_text;
    }
  }
  const q = walkQueue({ plans, placed, unfiled, missing });
  // The session's own placed list is scoped to the plan it was started on
  // (its ticks, as before); the queue's groups hold only what is unplaced,
  // from every plan, so nothing outside the pinned plan needs a mark here.
  const own = new Set((pinnedPlan ?? plans[0])?.groups.flatMap((g) => g.item_ids) ?? []);
  return {
    groups: q.groups,
    left_out: q.left_out,
    remaining: q.remaining,
    placed_item_ids: [...placed].filter((id) => own.has(id)),
    item_names: names,
    item_quantities: quantities,
    item_barcodes: barcodes,
    plan_ids: [...new Set(q.groups.map((g) => g.plan_id))],
  };
}

// ── Live-session state (the session row's jsonb) ─────────────────────────────

export type Directive =
  | {
      kind: "bin";
      location_id: string;
      location_name: string;
      location_path: string;
      sibling_count: number;
      sample_names: string[];
      via: "census" | "session" | "sticky" | "category";
    }
  | { kind: "catch-all"; location_id: string | null; location_name: string | null }
  /** Bin binding (Phase 2, spec §2.4): no existing bin fits, but the session
   *  has a pool of set-up-but-unnamed bins — offer the next one: "→ Bin 3 —
   *  this starts your Fasteners bin". Confirm NAMES the bin (the marker
   *  number stays in the name; the id never changes). */
  | { kind: "bind-offer"; location_id: string; location_name: string; proposed_name: string };

export interface LiveEntry {
  id: string;
  inbox_item_id: string;
  name: string | null;
  quantity: number;
  directive: Directive;
  status: "proposed" | "confirmed";
  confirmed_location_id?: string;
  confirmed_location_name?: string;
  /** Set when the confirm executed a BIND (renamed a pool bin) — undo
   *  restores the prior name and returns the bin to the pool. */
  bind?: { prior_name: string };
}

interface SerializedCensus {
  bins: Census["bins"];
  empty: Census["empty"];
  all: Record<
    string,
    { name: string; path: string; kind: "container" | "area"; interior_mm: InteriorMm | null }
  >;
  truncated: boolean;
  built_at: number;
}

interface LiveState {
  census?: SerializedCensus;
  filed?: Record<string, string[]>; // location_id → titles confirmed there this session
  sticky?: { location_id: string; tokens: string[] } | null;
  entries?: LiveEntry[];
  /** Bins created by setup-bins, waiting to be BOUND (named) by a first
   *  routed family. Ordered — offers draw from the front. */
  bind_pool?: string[];
}

function serializeCensus(c: Census, builtAt: number): SerializedCensus {
  return {
    bins: c.bins,
    empty: c.empty,
    all: Object.fromEntries(c.all),
    truncated: c.truncated,
    built_at: builtAt,
  };
}

function deserializeCensus(s: SerializedCensus): Census {
  return { bins: s.bins, empty: s.empty, all: new Map(Object.entries(s.all)), truncated: s.truncated };
}

/** The name a bind offer proposes for a fresh bin: the item's category when
 *  declared, else its most significant name token — "Fasteners", "Capacitor".
 *  Deterministic; the user sees it before anything is renamed. */
function proposeFamilyName(name: string, category: string | null): string {
  const cat = category?.trim();
  const base =
    cat ||
    significantTokens(name).sort((a, b) => b.length - a.length)[0] ||
    name.trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function routeContext(state: LiveState): SessionRouteContext {
  return {
    filed: new Map(Object.entries(state.filed ?? {})),
    sticky_location_id: state.sticky?.location_id ?? null,
    sticky_tokens: state.sticky?.tokens ?? [],
  };
}

async function saveState(
  db: ReturnType<typeof tenantDb>,
  sessionId: string,
  state: LiveState,
): Promise<void> {
  await db
    .updateTable("core_scan_putaway_sessions")
    .set({ state: sql`${JSON.stringify(state)}::jsonb` as never })
    .where("id", "=", sessionId)
    .execute();
}

/** Load an active (un-ended, unexpired) session or 404/410 the response. */
async function loadActiveSession(
  db: ReturnType<typeof tenantDb>,
  id: string,
  res: Parameters<Parameters<typeof asyncHandler>[0]>[1],
) {
  const session = await db
    .selectFrom("core_scan_putaway_sessions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!session || session.expires_at < new Date() || session.ended_at) {
    res
      .status(404)
      .json({ error: { code: "not_found", message: "session not found, ended, or expired" } });
    return null;
  }
  return session;
}

// ─────────────────────── POST /putaway/start ───────────────────────

const StartBody = z.object({
  /** Set → plan mode (the walk). Absent → live mode (Live Sort). */
  plan_id: z.string().uuid().optional(),
  /** Live mode: the designated "Unsorted" bin for can't-route items. */
  catch_all_location_id: z.string().uuid().nullable().optional(),
});

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
putawayRouter.post(
  "/putaway/start",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);

    // Expired sessions are working state, not history — sweep opportunistically.
    await db
      .deleteFrom("core_scan_putaway_sessions")
      .where("expires_at", "<", new Date())
      .execute();

    // ── LIVE mode ────────────────────────────────────────────────────────────
    if (!parsed.data.plan_id) {
      const me = sessionUser(req).id;
      // Idempotent per user: your active live session resumes.
      const existing = await db
        .selectFrom("core_scan_putaway_sessions")
        .select(["id", "state", "catch_all_location_id"])
        .where("mode", "=", "live")
        .where("created_by_user_id", "=", me)
        .where("ended_at", "is", null)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (existing) {
        const st = existing.state as LiveState;
        res.json({
          session_id: existing.id,
          mode: "live",
          catch_all_location_id: existing.catch_all_location_id,
          entries: st.entries ?? [],
          resumed: true,
        });
        return;
      }
      const census = await buildBinCensus(ctx.org.id);
      const state: LiveState = {
        census: serializeCensus(census, Date.now()),
        filed: {},
        sticky: null,
        entries: [],
      };
      const inserted = await db
        .insertInto("core_scan_putaway_sessions")
        .values({
          mode: "live",
          catch_all_location_id: parsed.data.catch_all_location_id ?? null,
          state: sql`${JSON.stringify(state)}::jsonb` as never,
          created_by_user_id: me,
          expires_at: new Date(Date.now() + LIVE_TTL_MS),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      void platform().events.emit("core-scan.putaway.session-started", {
        orgId: ctx.org.id,
        sessionId: inserted.id,
        mode: "live",
      });
      res.json({
        session_id: inserted.id,
        mode: "live",
        catch_all_location_id: parsed.data.catch_all_location_id ?? null,
        entries: [],
        resumed: false,
      });
      return;
    }

    // ── PLAN mode (the walk) ─────────────────────────────────────────────────
    const plan = await db
      .selectFrom("core_scan_organize_plans")
      .select(["id", "payload", "applied_group_ids", "walk_state", "expires_at"])
      .where("id", "=", parsed.data.plan_id)
      .executeTakeFirst();
    if (!plan || plan.expires_at < new Date()) {
      res.status(404).json({ error: { code: "not_found", message: "plan not found or expired" } });
      return;
    }
    if ((plan.applied_group_ids as unknown[]).length === 0) {
      res.status(422).json({
        error: { code: "nothing_to_walk", message: "Apply at least one group first." },
      });
      return;
    }

    // Idempotent per plan: an active session resumes. Either way the queue is
    // assembled NOW, from every plan in play, so a group accepted after the
    // walk started is walked too and the sheet never shows a stale list.
    const existing = await db
      .selectFrom("core_scan_putaway_sessions")
      .select(["id", "state"])
      .where("plan_id", "=", plan.id)
      .where("ended_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const planRow = { id: plan.id, payload: plan.payload, applied_group_ids: plan.applied_group_ids, created_at: new Date() };
    if (existing) {
      const st = existing.state as { placed_item_ids?: string[] };
      const walk = await assembleWalk(db, planRow, st.placed_item_ids ?? []);
      await db
        .updateTable("core_scan_putaway_sessions")
        .set({ state: sql`${JSON.stringify({ placed_item_ids: walk.placed_item_ids, groups: walk.groups, left_out: walk.left_out })}::jsonb` as never })
        .where("id", "=", existing.id)
        .execute();
      res.json({ session_id: existing.id, mode: "plan", plan_id: plan.id, resumed: true, ...walk });
      return;
    }

    // Fresh session — import legacy walk_state so a walk that was mid-flight
    // when this shipped resumes exactly where it left off.
    const legacy = (plan.walk_state as { placed_item_ids?: string[] }).placed_item_ids ?? [];
    const valid = planItemIds(plan.payload);
    const walk = await assembleWalk(db, planRow, legacy.filter((id) => valid.has(id)));
    const inserted = await db
      .insertInto("core_scan_putaway_sessions")
      .values({
        mode: "plan",
        plan_id: plan.id,
        state: sql`${JSON.stringify({ placed_item_ids: walk.placed_item_ids, groups: walk.groups, left_out: walk.left_out })}::jsonb` as never,
        created_by_user_id: sessionUser(req).id,
        expires_at: plan.expires_at, // a walk lives exactly as long as its plan
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-scan.putaway.session-started", {
      orgId: ctx.org.id,
      sessionId: inserted.id,
      mode: "plan",
      planId: plan.id,
    });
    res.json({ session_id: inserted.id, mode: "plan", plan_id: plan.id, resumed: false, ...walk });
  }),
);

// ─────────────────────── GET /putaway/queue ───────────────────────
// What is accepted and still to be put away, across every plan in play: the
// resume chip's one source. `remaining: 0` means nothing is waiting, whether
// or not a walk ever ran; a plan-mode session still open is named so the
// chip can say "resume" rather than "start". Polled casually.

putawayRouter.get(
  "/putaway/queue",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const db = tenantDb(req);
    let walk = await assembleWalk(db, null, []);
    if (walk.remaining === 0) {
      // Nothing from the inbox: an entities plan ("Organize what you track")
      // mid-walk still deserves its chip. Its marks live on its session.
      const entPlan = await db
        .selectFrom("core_scan_organize_plans")
        .select(["id", "payload", "applied_group_ids", "created_at"])
        .where("expires_at", ">", new Date())
        .where(sql`jsonb_array_length(applied_group_ids)`, ">", 0)
        .where(sql`payload->>'subject'`, "=", "entities")
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (entPlan) {
        const sess = await db
          .selectFrom("core_scan_putaway_sessions")
          .select(["state"])
          .where("plan_id", "=", entPlan.id)
          .where("ended_at", "is", null)
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst();
        walk = await assembleWalk(db, entPlan, (sess?.state as { placed_item_ids?: string[] } | null)?.placed_item_ids ?? []);
      }
    }
    // An open walk wins the plan to pin, so "resume" reopens the same
    // session whichever plan's group happens to come first in the queue now;
    // otherwise the newest plan with something to walk.
    const session =
      walk.remaining > 0
        ? await db
            .selectFrom("core_scan_putaway_sessions")
            .select(["id", "plan_id"])
            .where("mode", "=", "plan")
            .where("ended_at", "is", null)
            .where("expires_at", ">", new Date())
            .orderBy("created_at", "desc")
            .limit(1)
            .executeTakeFirst()
        : null;
    // The open session's queue spans every plan in play, so it is the one to
    // resume whichever plan's group comes first now.
    const planId = session?.plan_id ?? walk.plan_ids[0] ?? null;
    res.json({
      remaining: walk.remaining,
      groups: walk.groups.length,
      plan_id: planId,
      session_id: session?.id ?? null,
      left_out: walk.left_out,
    });
  }),
);

// ─────────────────────── GET /putaway/current ───────────────────────
// The caller's active session (resume chips). `{ session: null }`, not a 404 —
// polled casually.

putawayRouter.get(
  "/putaway/current",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_putaway_sessions")
      .select(["id", "mode", "plan_id", "catch_all_location_id", "state", "created_at"])
      .where("ended_at", "is", null)
      .where("expires_at", ">", new Date())
      .where("created_by_user_id", "=", sessionUser(req).id)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      res.json({ session: null });
      return;
    }
    const st = row.state as LiveState & { placed_item_ids?: string[] };
    res.json({
      session: {
        session_id: row.id,
        mode: row.mode,
        plan_id: row.plan_id,
        catch_all_location_id: row.catch_all_location_id,
        entries: row.mode === "live" ? (st.entries ?? []) : undefined,
        placed_item_ids: row.mode === "plan" ? (st.placed_item_ids ?? []) : undefined,
        created_at: row.created_at,
      },
    });
  }),
);

// ─────────────────────── POST /putaway/:id/setup-bins ───────────────────────
// The zero-hardware on-ramp (spec §2.4): "grab a marker, number your
// containers 1, 2, 3…". Creates N generic "Bin N" locations (numbering
// continues past any existing Bin N), registers them as the session's BIND
// POOL (bind offers draw from it), and can create/reuse an "Unsorted"
// catch-all. QR labels are optional and retrofittable any time from Labels —
// the bin's identity is the location record, never the sticker.

const SetupBinsBody = z.object({
  count: z.number().int().min(0).max(20).default(0),
  parent_id: z.string().uuid().nullable().optional(),
  include_catch_all: z.boolean().default(false),
});

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
putawayRouter.post(
  "/putaway/:id/setup-bins",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = SetupBinsBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const session = await loadActiveSession(db, String(req.params.id), res);
    if (!session) return;
    if (session.mode !== "live") {
      res.status(422).json({ error: { code: "wrong_mode", message: "setup-bins is a live-mode call" } });
      return;
    }
    const writer = await platform().entities.getWriter(ctx.org.id, "core-locations:location");
    if (!writer) {
      res.status(422).json({ error: { code: "no_locations", message: "locations module unavailable" } });
      return;
    }

    // Numbering continues past any existing "Bin N" — the marker on the
    // physical container must match the name forever.
    const locs = await platform()
      .entities.list(ctx.org.id, "core-locations:location", { limit: 1000 })
      .then((r) => r.items)
      .catch(() => []);
    let next = 1;
    for (const l of locs) {
      const m = /^Bin (\d+)\b/.exec(l.title ?? "");
      if (m) next = Math.max(next, Number(m[1]) + 1);
    }

    const state = session.state as LiveState;
    const created: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < parsed.data.count; i++) {
      const name = `Bin ${next + i}`;
      try {
        const id = await writer.create(ctx.org.id, {
          name,
          parent_id: parsed.data.parent_id ?? null,
          kind: "container",
        });
        created.push({ id, name });
      } catch {
        break; // partial success is fine — report what exists
      }
    }
    state.bind_pool = [...(state.bind_pool ?? []), ...created.map((c) => c.id)];

    let catchAllId = session.catch_all_location_id;
    if (parsed.data.include_catch_all && !catchAllId) {
      const existing = locs.find((l) => (l.title ?? "").trim().toLowerCase() === "unsorted");
      if (existing) catchAllId = existing.id;
      else {
        try {
          catchAllId = await writer.create(ctx.org.id, {
            name: "Unsorted",
            parent_id: parsed.data.parent_id ?? null,
            kind: "container",
          });
        } catch {
          /* best-effort — the session just keeps no catch-all */
        }
      }
      if (catchAllId) {
        await db
          .updateTable("core_scan_putaway_sessions")
          .set({ catch_all_location_id: catchAllId })
          .where("id", "=", session.id)
          .execute();
      }
    }

    // New locations exist → the cached census is stale; rebuild so directives
    // (and catch-all names) render the fresh bins immediately.
    state.census = serializeCensus(await buildBinCensus(ctx.org.id), Date.now());
    await saveState(db, session.id, state);
    res.json({
      created,
      catch_all_location_id: catchAllId ?? null,
      bind_pool_size: (state.bind_pool ?? []).length,
    });
  }),
);

// ─────────────────────── POST /putaway/:id/scan ───────────────────────
// Live mode: route an intaken inbox item → a directive. The item was created
// through the normal POST /scan (short enrich_ms); we route on whatever
// name/category it has RIGHT NOW — re-scanning later re-routes if enrichment
// landed more. Blank beats wrong: no defensible bin → the catch-all.

const ScanBody = z.object({
  inbox_item_id: z.string().uuid(),
});

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
putawayRouter.post(
  "/putaway/:id/scan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ScanBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const session = await loadActiveSession(db, String(req.params.id), res);
    if (!session) return;
    if (session.mode !== "live") {
      res.status(422).json({ error: { code: "wrong_mode", message: "scan is a live-mode call" } });
      return;
    }

    const item = await db
      .selectFrom("core_scan_inbox_items")
      .select([
        "id",
        "status",
        "suggested_name",
        "suggested_metadata",
        "quantity",
        "target_location_id",
      ])
      .where("id", "=", parsed.data.inbox_item_id)
      .executeTakeFirst();
    if (!item) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }

    const state = session.state as LiveState;
    const entries = state.entries ?? [];

    // Idempotent per item: a confirmed entry returns as-is; an unconfirmed one
    // re-routes (a re-scan usually means enrichment landed, or dedup bumped qty).
    const prior = entries.find((e) => e.inbox_item_id === item.id);
    if (prior && prior.status === "confirmed") {
      res.json({ entry: { ...prior, quantity: item.quantity ?? prior.quantity }, already_confirmed: true });
      return;
    }

    // Human placements are sacred: an item that already carries a location the
    // session didn't put there is a RE-FIND, not a re-sort.
    if (item.target_location_id && !prior) {
      const loc = await platform()
        .entities.lookup(ctx.org.id, "core-locations:location", item.target_location_id)
        .catch(() => null);
      res.json({
        already_placed: {
          location_id: item.target_location_id,
          location_name: loc?.title ?? null,
          name: item.suggested_name,
        },
      });
      return;
    }

    // Census: rebuild mid-session when stale (new bins/placements appear).
    let census: Census;
    if (!state.census || Date.now() - state.census.built_at > CENSUS_STALE_MS) {
      census = await buildBinCensus(ctx.org.id);
      state.census = serializeCensus(census, Date.now());
    } else {
      census = deserializeCensus(state.census);
    }

    const meta = (item.suggested_metadata ?? {}) as {
      category?: unknown;
      storage_requirement?: unknown;
    };
    const dims = await inboxLongestMm(
      item.suggested_metadata as Record<string, unknown> | null,
      new LengthUnitResolver(ctx.org.id),
    ).catch(() => null);
    const hit = item.suggested_name
      ? routeItem(
          {
            id: item.id,
            name: item.suggested_name,
            category: typeof meta.category === "string" ? meta.category : null,
            longest_mm: dims?.longest_mm ?? null,
            // The item's own answer about how it must be kept, so the router
            // and the storage warning read one fact.
            storage_requirement: meta.storage_requirement,
          },
          census,
          routeContext(state),
        )
      : null;

    // Pool bins that were bound (or deleted) since last save fall out here.
    const pool = (state.bind_pool ?? []).filter((id) => census.all.has(id));
    state.bind_pool = pool;

    let directive: Directive;
    if (hit) {
      const loc = census.all.get(hit.location_id);
      directive = {
        kind: "bin",
        location_id: hit.location_id,
        location_name: loc?.name ?? "",
        location_path: loc?.path ?? loc?.name ?? "",
        sibling_count: hit.sibling_count,
        sample_names: hit.sample_names,
        via: hit.via,
      };
    } else if (item.suggested_name && !isJunkName(item.suggested_name) && pool.length > 0) {
      // No existing bin fits, but the session has fresh bins waiting for a
      // family — offer to BIND the next one ("this starts your Fasteners bin").
      const binId = pool[0]!;
      const loc = census.all.get(binId)!;
      directive = {
        kind: "bind-offer",
        location_id: binId,
        location_name: loc.name,
        proposed_name: proposeFamilyName(
          item.suggested_name,
          typeof meta.category === "string" ? meta.category : null,
        ),
      };
    } else {
      const catchAllId = session.catch_all_location_id;
      const loc = catchAllId ? census.all.get(catchAllId) : null;
      directive = {
        kind: "catch-all",
        location_id: catchAllId ?? null,
        location_name: loc?.name ?? null,
      };
    }

    const entry: LiveEntry = prior
      ? { ...prior, name: item.suggested_name, quantity: item.quantity ?? 1, directive }
      : {
          id: randomUUID(),
          inbox_item_id: item.id,
          name: item.suggested_name,
          quantity: item.quantity ?? 1,
          directive,
          status: "proposed",
        };
    const nextEntries = prior
      ? entries.map((e) => (e.id === prior.id ? entry : e))
      : [...entries, entry];
    if (nextEntries.length > LIVE_MAX_ENTRIES) {
      res.status(422).json({
        error: { code: "session_full", message: "This session hit its cap, end it and start fresh." },
      });
      return;
    }
    state.entries = nextEntries;
    await saveState(db, session.id, state);
    res.json({ entry });
  }),
);

// ─────────────────────── POST /putaway/:id/confirm ───────────────────────
// The ONE gesture. Override (location_id) wins over the directive. Stamps the
// inbox item's target_location_id — commit happens through the normal confirm
// flow later, exactly like the walk (nothing new touches commit).

const ConfirmBody = z.object({
  entry_id: z.string().uuid(),
  location_id: z.string().uuid().optional(),
});

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
putawayRouter.post(
  "/putaway/:id/confirm",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const session = await loadActiveSession(db, String(req.params.id), res);
    if (!session) return;
    if (session.mode !== "live") {
      res.status(422).json({ error: { code: "wrong_mode", message: "confirm is a live-mode call" } });
      return;
    }
    const state = session.state as LiveState;
    const entry = (state.entries ?? []).find((e) => e.id === parsed.data.entry_id);
    if (!entry) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    if (entry.status === "confirmed") {
      res.json({ entry });
      return;
    }

    const locationId = parsed.data.location_id ?? entry.directive.location_id;
    if (!locationId) {
      res.status(422).json({
        error: {
          code: "no_destination",
          message: "No bin to confirm into. Pick one, or set a catch-all bin.",
        },
      });
      return;
    }
    const loc = await platform()
      .entities.lookup(ctx.org.id, "core-locations:location", locationId)
      .catch(() => null);
    if (!loc) {
      res.status(422).json({
        error: { code: "bad_destination", message: "That bin no longer exists. Pick another." },
      });
      return;
    }

    // A confirmed bind-offer NAMES the bin: "Bin 3" becomes "Bin 3 · Fasteners"
    // (the marker number stays in the name; the id never changes) and the bin
    // leaves the pool. An override skips the bind — the pool bin stays fresh.
    let confirmedName = loc.title;
    if (
      entry.directive.kind === "bind-offer" &&
      !parsed.data.location_id &&
      locationId === entry.directive.location_id
    ) {
      const writer = await platform().entities.getWriter(ctx.org.id, "core-locations:location");
      const bound = `${entry.directive.location_name} · ${entry.directive.proposed_name}`;
      if (writer) {
        try {
          await writer.update(ctx.org.id, locationId, { name: bound });
          entry.bind = { prior_name: entry.directive.location_name };
          confirmedName = bound;
          state.bind_pool = (state.bind_pool ?? []).filter((id) => id !== locationId);
          const c = state.census?.all[locationId];
          if (c) c.name = bound;
        } catch {
          /* bind is sugar — the confirm still files into the unnamed bin */
        }
      }
    }

    // Stamp the item (still-pending only; a mid-session commit/discard wins).
    await db
      .updateTable("core_scan_inbox_items")
      .set({ target_location_id: locationId, updated_at: new Date() })
      .where("id", "=", entry.inbox_item_id)
      .where("status", "=", "pending")
      .execute();

    entry.status = "confirmed";
    entry.confirmed_location_id = locationId;
    entry.confirmed_location_name = confirmedName;
    // Session context: the confirmed item is a sibling for everything after it.
    const filed = state.filed ?? {};
    if (entry.name) {
      filed[locationId] = [...(filed[locationId] ?? []), entry.name].slice(-30);
    }
    state.filed = filed;
    state.sticky = {
      location_id: locationId,
      tokens: significantTokens(entry.name),
    };
    await saveState(db, session.id, state);
    void platform().events.emit("core-scan.putaway.item-placed", {
      orgId: ctx.org.id,
      sessionId: session.id,
      inboxItemId: entry.inbox_item_id,
      locationId,
    });
    res.json({ entry });
  }),
);

// ─────────────────────── POST /putaway/:id/undo ───────────────────────

const UndoBody = z.object({ entry_id: z.string().uuid() });

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
putawayRouter.post(
  "/putaway/:id/undo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = UndoBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const session = await loadActiveSession(db, String(req.params.id), res);
    if (!session) return;
    const state = session.state as LiveState;
    const entry = (state.entries ?? []).find((e) => e.id === parsed.data.entry_id);
    if (!entry || entry.status !== "confirmed" || !entry.confirmed_location_id) {
      res.status(404).json({ error: { code: "not_found", message: "no confirmed entry to undo" } });
      return;
    }
    // Un-stamp only if the location is still exactly what this confirm set —
    // a later human edit wins.
    await db
      .updateTable("core_scan_inbox_items")
      .set({ target_location_id: null, updated_at: new Date() })
      .where("id", "=", entry.inbox_item_id)
      .where("status", "=", "pending")
      .where("target_location_id", "=", entry.confirmed_location_id)
      .execute();
    const locId = entry.confirmed_location_id;
    if (entry.bind) {
      // The confirm named this bin — restore the marker name and put it back
      // at the FRONT of the pool (it's still the freshest bin). Best-effort.
      const writer = await platform().entities.getWriter(ctx.org.id, "core-locations:location");
      if (writer) {
        await writer.update(ctx.org.id, locId, { name: entry.bind.prior_name }).catch(() => {});
      }
      const c = state.census?.all[locId];
      if (c) c.name = entry.bind.prior_name;
      state.bind_pool = [locId, ...(state.bind_pool ?? []).filter((id) => id !== locId)];
      delete entry.bind;
    }
    if (entry.name && state.filed?.[locId]) {
      const idx = state.filed[locId].lastIndexOf(entry.name);
      if (idx >= 0) state.filed[locId].splice(idx, 1);
      if (state.filed[locId].length === 0) delete state.filed[locId];
    }
    if (state.sticky?.location_id === locId) state.sticky = null;
    entry.status = "proposed";
    delete entry.confirmed_location_id;
    delete entry.confirmed_location_name;
    await saveState(db, session.id, state);
    res.json({ entry });
  }),
);

// ─────────────────────── POST /putaway/:id/state ───────────────────────
// Plan mode: persist walk progress (which items are physically placed).
// Idempotent replace — the client owns its checklist; only ids actually in
// the plan are kept, so a stale client can't grow the row.

const StateBody = z.object({
  placed_item_ids: z.array(z.string().min(1).max(200)).max(MAX_ITEMS),
});

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
putawayRouter.post(
  "/putaway/:id/state",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = StateBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const session = await loadActiveSession(db, String(req.params.id), res);
    if (!session) return;
    if (session.mode !== "plan" || !session.plan_id) {
      res.status(422).json({ error: { code: "wrong_mode", message: "state is a plan-mode call" } });
      return;
    }
    const plan = await db
      .selectFrom("core_scan_organize_plans")
      .select(["payload"])
      .where("id", "=", session.plan_id)
      .executeTakeFirst();
    const st = session.state as { placed_item_ids?: string[]; groups?: QueueGroup[]; left_out?: LeftOut[] };
    // The session's queue spans every plan in play, so ids from any of them
    // are valid; a session from before queues were stored falls back to its
    // own plan's items.
    const valid = new Set<string>([
      ...(st.groups ?? []).flatMap((g) => g.item_ids),
      ...(st.placed_item_ids ?? []),
      ...(plan ? planItemIds(plan.payload) : []),
    ]);
    const placed = parsed.data.placed_item_ids.filter((id) => valid.has(id));
    // Placement is the item's fact: stamp placed_at on what was just placed
    // and clear it on what was un-ticked, so every plan and the resume chip
    // read the same answer as this walk (#2897). Entity refs are not inbox
    // rows and are skipped by the uuid filter; their marks live on the session.
    const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
    const now = [...placed].filter(isUuid);
    const was = (st.placed_item_ids ?? []).filter(isUuid);
    const unticked = was.filter((id) => !placed.includes(id));
    if (now.length > 0) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({ placed_at: new Date() })
        .where("id", "in", now)
        .where("placed_at", "is", null)
        .execute();
    }
    if (unticked.length > 0) {
      await db.updateTable("core_scan_inbox_items").set({ placed_at: null }).where("id", "in", unticked).execute();
    }
    await db
      .updateTable("core_scan_putaway_sessions")
      .set({ state: sql`${JSON.stringify({ ...st, placed_item_ids: placed })}::jsonb` as never })
      .where("id", "=", session.id)
      .execute();
    res.json({ placed_item_ids: placed });
  }),
);

// ─────────────────────── POST /putaway/:id/end ───────────────────────

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
putawayRouter.post(
  "/putaway/:id/end",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const session = await db
      .selectFrom("core_scan_putaway_sessions")
      .selectAll()
      .where("id", "=", String(req.params.id))
      .executeTakeFirst();
    if (!session) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }

    // The summary — the payoff screen's numbers.
    const st = session.state as LiveState & { placed_item_ids?: string[] };
    let summary: Record<string, unknown>;
    if (session.mode === "live") {
      const entries = st.entries ?? [];
      const confirmed = entries.filter((e) => e.status === "confirmed");
      const byBin = new Map<string, { location_name: string; count: number }>();
      for (const e of confirmed) {
        const cur = byBin.get(e.confirmed_location_id!) ?? {
          location_name: e.confirmed_location_name ?? "",
          count: 0,
        };
        cur.count += 1;
        byBin.set(e.confirmed_location_id!, cur);
      }
      summary = {
        sorted: confirmed.length,
        by_bin: [...byBin.entries()].map(([location_id, v]) => ({ location_id, ...v })),
        stragglers: entries.length - confirmed.length,
      };
    } else {
      summary = { placed_count: (st.placed_item_ids ?? []).length };
    }

    if (!session.ended_at) {
      await db
        .updateTable("core_scan_putaway_sessions")
        .set({ ended_at: new Date() })
        .where("id", "=", session.id)
        .execute();
      void platform().events.emit("core-scan.putaway.session-ended", {
        orgId: ctx.org.id,
        sessionId: session.id,
        mode: session.mode,
        placedCount:
          session.mode === "live"
            ? (st.entries ?? []).filter((e) => e.status === "confirmed").length
            : (st.placed_item_ids ?? []).length,
        durationMs: Date.now() - session.created_at.getTime(),
      });
    }
    res.json({ ended: true, ...summary });
  }),
);
