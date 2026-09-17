// /api/v1/orgs/:slug/modules/core-scan
//
//   GET  /duplicates        — pairs of records that look like the same thing
//   POST /duplicates/merge  — make two of them one
//
// Filing learned not to CREATE a duplicate (the tracked_match path in
// inbox.ts). This is for the pairs already sitting in somebody's table, which
// no amount of prevention removes:
//
//   #059  Roma Tomatoes    Kitchen   —              2026-08-25
//   #056  Tomatoes Roma    Kitchen   refrigerated   2026-09-06
//
// Reported with the line that decides the design: "they were parsed separately
// at different times so I didn't recognize the not-identical naming, nor should
// I have to." Finding these by eye is the job being replaced.
//
// The SAME `nameOverlap` the scan matcher uses decides what is a pair, so the
// thing that stops you creating a duplicate and the thing that finds the ones
// you have cannot disagree about what a duplicate is.
//
// Merging is destructive and per-pair on purpose. Everything else here batches;
// this does not, because the one question a person has to answer - which of
// these two do I keep - is genuinely per pair, and there is no honest way to
// answer it for thirty at once.

import { Router } from "express";
import { z } from "zod";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import { scanTargetOfRecord, scanTargetsForOrg } from "../services/scan-target.js";
import { bearer, tenantContext } from "../db.js";
import { INTERNAL_API } from "./inbox.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { looksLikeSameThing, mergePlan } from "../services/merge-records.js";
import { identifierFieldsByKind } from "../services/entity-match.js";
import { identifierCanonical } from "../services/identifier-equals.js";

export const duplicatesRouter = Router({ mergeParams: true });

/** How many records per kind the sweep reads. A workspace with more than this
 *  gets the first page; the pairs it finds are still real, and the next sweep
 *  after a merge sees further. */
const SWEEP_LIMIT = 400;
/** Enough pairs to work through in one sitting. Past this the answer is not a
 *  longer list, it is doing some of them. */
const MAX_PAIRS = 50;

interface DuplicatePair {
  kind: string;
  noun: string;
  /** Both sides, newest first - the survivor a person most likely wants is the
   *  one they have been using, but this never decides that for them. */
  a: { id: string; title: string; qty: number | null; location_id: string | null };
  b: { id: string; title: string; qty: number | null; location_id: string | null };
  /** Significant words the two share, so the reason is visible rather than
   *  asserted ("Roma, Tomatoes"). For an identifier pair, the label and the
   *  value ("ISBN 9780547928227"). */
  shared: string[];
}

/** A named field's value, flat or under `metadata` (a bundle's custom fields
 *  land there). */
const fieldOf = (e: ResolvedEntity, name: string): unknown => {
  const f = e.fields as Record<string, unknown>;
  if (f[name] !== undefined) return f[name];
  const md = f.metadata;
  return md && typeof md === "object" ? (md as Record<string, unknown>)[name] : undefined;
};

const tokensOf = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(Boolean);

const qtyOf = (e: ResolvedEntity, qtyField: string | undefined): number | null => {
  if (!qtyField) return null;
  const raw = (e.fields as Record<string, unknown>)[qtyField];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const locOf = (e: ResolvedEntity): string | null => {
  const v = (e.fields as Record<string, unknown>).location_id;
  return typeof v === "string" && v ? v : null;
};

// ─────────────────────────── GET /duplicates ───────────────────────────

// AI-REACH: exempt reading this is only useful attached to the deciding, and the
// deciding is a person's: which of two records keeps its id, its links and its
// history. Cobb can already list records, so a finder it cannot act on would be
// a question with no answer behind it.
duplicatesRouter.get(
  "/duplicates",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    // listKindsForOrg, NOT listScannable. The scannable registry is
    // process-global and holds only BASE kinds, and a record living in a named
    // instance does not appear in its base kind's list. Groceries, Tea and
    // Spices are instances, so the reported pair is exactly what a
    // listScannable sweep cannot see - it would have found nothing and looked
    // like it worked. listKindsForOrg is org-scoped and synthesizes one
    // `<instance>:item` kind per named instance.
    const allKinds = await platform().entities.listKindsForOrg(ctx.org.id);
    const kinds = allKinds
      .map((rec) => {
        // A synthesized instance record already carries its full kind in `id`
        // ("groceries:item"); a base record carries the bare kind ("part").
        const kind = rec.id.includes(":") ? rec.id : `${rec.module_name}:${rec.id}`;
        // Merge needs a create endpoint and (for counting) a qty field, and
        // both come from the owning MODULE - an instance is a skin over it.
        const scannable = scanTargetOfRecord({ kind, module_name: rec.module_name });
        return scannable
          ? { kind, noun: scannable.noun, qtyField: scannable.qtyField as string | undefined }
          : null;
      })
      .filter((k): k is { kind: string; noun: string; qtyField: string | undefined } => k !== null);
    const pairs: DuplicatePair[] = [];
    // Identifier-ROLE fields per kind (a book's ISBN). Two records carrying the
    // same identifier are the same thing whatever their titles say: "The
    // Hobbit" and "The Hobbit: or, There and Back Again" share one word, which
    // the title rule rightly refuses, and the same ISBN, which settles it.
    const identifierByKind = await identifierFieldsByKind(ctx.org.id);

    for (const k of kinds) {
      let items: ResolvedEntity[];
      try {
        const r = await platform().entities.list(ctx.org.id, k.kind, { limit: SWEEP_LIMIT });
        items = r.items;
      } catch {
        // A kind whose resolver is unhappy must not take the whole sweep down.
        continue;
      }
      const paired = new Set<string>();
      for (const f of identifierByKind.get(k.kind) ?? []) {
        const byValue = new Map<string, ResolvedEntity[]>();
        for (const e of items) {
          const v = identifierCanonical(fieldOf(e, f.name));
          if (!v) continue;
          byValue.set(v, [...(byValue.get(v) ?? []), e]);
        }
        for (const [value, same] of byValue) {
          for (let i = 0; i + 1 < same.length; i++) {
            const a = same[i]!;
            const b = same[i + 1]!;
            paired.add(`${a.id}|${b.id}`);
            pairs.push({
              kind: k.kind,
              noun: k.noun,
              a: { id: a.id, title: a.title, qty: qtyOf(a, k.qtyField), location_id: locOf(a) },
              b: { id: b.id, title: b.title, qty: qtyOf(b, k.qtyField), location_id: locOf(b) },
              shared: [`${f.label} ${value}`],
            });
            if (pairs.length >= MAX_PAIRS) break;
          }
          if (pairs.length >= MAX_PAIRS) break;
        }
      }
      if (pairs.length >= MAX_PAIRS) break;
      // Only within one kind. Two records in different tables are not a
      // duplicate to merge - they are a routing question, and answering it here
      // would move somebody's record between tables without being asked.
      for (let i = 0; i < items.length; i++) {
        const a = items[i]!;
        if (!a.title?.trim()) continue;
        const want = tokensOf(a.title);
        if (want.length === 0) continue;
        for (let j = i + 1; j < items.length; j++) {
          const b = items[j]!;
          if (!b.title?.trim()) continue;
          // The scan matcher's own rule plus a second shared word, because this
          // list ends in a button that deletes one of the two.
          if (paired.has(`${a.id}|${b.id}`) || paired.has(`${b.id}|${a.id}`)) continue;
          const { same, shared } = looksLikeSameThing(a.title, b.title);
          if (!same) continue;
          pairs.push({
            kind: k.kind,
            noun: k.noun,
            a: { id: a.id, title: a.title, qty: qtyOf(a, k.qtyField), location_id: locOf(a) },
            b: { id: b.id, title: b.title, qty: qtyOf(b, k.qtyField), location_id: locOf(b) },
            shared,
          });
          if (pairs.length >= MAX_PAIRS) break;
        }
        if (pairs.length >= MAX_PAIRS) break;
      }
      if (pairs.length >= MAX_PAIRS) break;
    }

    res.json({ pairs, truncated: pairs.length >= MAX_PAIRS });
  }),
);

// ──────────────────────── POST /duplicates/merge ────────────────────────

const MergeBody = z.object({
  kind: z.string().min(1),
  /** The record that survives, with its id, its links and its history. */
  keep_id: z.string().min(1),
  /** The record that is absorbed and then removed. */
  drop_id: z.string().min(1),
});

// AI-REACH: exempt irreversible and per-pair by design. A merge deletes one of
// two records and moves its quantity onto the other; the survivor is a judgement
// only the person holding the shelf can make, and getting it wrong cannot be
// undone from here.
duplicatesRouter.post(
  "/duplicates/merge",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MergeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { kind, keep_id, drop_id } = parsed.data;
    if (keep_id === drop_id) {
      res.status(400).json({
        error: { code: "same_record", message: "a record cannot be merged into itself" },
      });
      return;
    }
    const ctx = tenantContext(req);
    // The workspace's own kinds, instances included: a merge of two grocery
    // records asks with groceries:item, which the base registry never lists.
    const scannable = (await scanTargetsForOrg(ctx.org.id)).find((k) => k.kind === kind);
    if (!scannable) {
      res.status(400).json({ error: { code: "unknown_kind", message: `${kind} is not scannable` } });
      return;
    }

    const [keep, drop] = await Promise.all([
      platform().entities.lookup(ctx.org.id, kind, keep_id).catch(() => null),
      platform().entities.lookup(ctx.org.id, kind, drop_id).catch(() => null),
    ]);
    if (!keep || !drop) {
      res.status(404).json({
        error: { code: "not_found", message: "one of those records is already gone" },
      });
      return;
    }

    // READ AND WRITE THROUGH THE MODULE'S OWN ENDPOINT, not the entity layer.
    //
    // `platform().entities.lookup` projects through `exposableFields`, which is
    // a CURATED SUBSET: inventory deliberately withholds notes, cost,
    // manufacturer and supplier_url from cross-module readers. Merging from
    // that view and then deleting the duplicate would destroy every field the
    // owning module chose not to expose - silently, and exactly the "data loss
    // dressed as a tidy-up" this feature exists to avoid.
    //
    // The module's own CRUD route returns the whole row and accepts the whole
    // patch, under the caller's bearer so the module's validation and events
    // fire. Same pattern, and the same reason, as attach.
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    // A record living in a skinned INSTANCE is not reachable on the bare module
    // route - that filters to the default instance and 404s. The instance slug
    // is parsed from the record's own detail route, the same way the scan
    // matcher gets it for attach.
    const instanceOf = (e: { detailUrl?: string }): string | null =>
      e.detailUrl?.match(/^\/instances\/([^/]+)\/items\//)?.[1] ?? null;
    const pathFor = (id: string, inst: string | null): string =>
      inst
        ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${inst}/items/${id}`
        : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${scannable.createEndpoint}/${id}`;
    const keepPath = pathFor(keep_id, instanceOf(keep));
    const dropPath = pathFor(drop_id, instanceOf(drop));
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const [keepRes, dropRes] = await Promise.all([
      fetch(keepPath, { headers: authHeaders }),
      fetch(dropPath, { headers: authHeaders }),
    ]);
    if (!keepRes.ok || !dropRes.ok) {
      res.status(502).json({
        error: {
          code: "record_unreachable",
          message: `couldn't read both records (${keepRes.status}/${dropRes.status})`,
        },
      });
      return;
    }
    const keepRow = (await keepRes.json()) as Record<string, unknown>;
    const dropRow = (await dropRes.json()) as Record<string, unknown>;

    const plan = mergePlan(keepRow, dropRow, scannable.qtyField ?? null);

    // ORDER, and it is the whole safety story. The survivor is updated FIRST:
    // if that fails, nothing has been destroyed and the pair is exactly as it
    // was. Deleting first would risk losing the duplicate's quantity to a
    // failed update, which is the one outcome with no way back.
    if (Object.keys(plan.patch).length > 0) {
      const up = await fetch(keepPath, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(plan.patch),
      });
      if (!up.ok) {
        res.status(502).json({
          error: {
            code: "merge_failed",
            message: `couldn't update ${keep.title} (${up.status}) - nothing was changed`,
          },
        });
        return;
      }
    }

    const del = await fetch(dropPath, { method: "DELETE", headers: authHeaders });
    if (!del.ok) {
      // The survivor now carries both quantities and the duplicate still
      // exists, which double-counts. Put the survivor back before reporting,
      // so a failed merge leaves the workspace as it found it.
      if (Object.keys(plan.patch).length > 0) {
        const undo: Record<string, unknown> = {};
        for (const k of Object.keys(plan.patch)) undo[k] = keepRow[k] ?? null;
        await fetch(keepPath, {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify(undo),
        }).catch(() => undefined);
      }
      res.status(409).json({
        error: {
          code: "merge_failed",
          message: `couldn't remove ${drop.title} (${del.status}) - nothing was changed`,
        },
      });
      return;
    }

    void platform().events.emit("core-scan.records.merged", {
      orgId: ctx.org.id,
      kind,
      keptId: keep_id,
      droppedId: drop_id,
      droppedTitle: drop.title,
    });

    res.json({
      kept: { id: keep_id, title: keep.title },
      dropped: { id: drop_id, title: drop.title },
      new_qty: plan.newQty,
      prior_qty: plan.priorQty,
      filled: plan.filled,
    });
  }),
);
