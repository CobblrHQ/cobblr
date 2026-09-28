// /pairings — platform primitive for polymorphic relationships.
// "(source_kind, source_id) is related to (target_kind, target_id)
//  as a `relationship_kind`."
//
// Any module / bundle / UI can write here. Replaces the case-by-case
// "I need my own polymorphic-link table" pattern (the projects deps
// table will eventually move onto this).

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";
import { linkWords, recordKindSpellings } from "../platform/record-kind-spellings.js";
import { listOverrides } from "../platform/entity-kind-overrides.js";
import { resolveKind } from "../platform/entities.js";

export const pairingsRouter = Router({ mergeParams: true });

const PairingCreate = z.object({
  source_kind: z.string().min(1).max(80),
  source_id: z.string().min(1).max(120),
  target_kind: z.string().min(1).max(80),
  target_id: z.string().min(1).max(120),
  relationship_kind: z.string().min(1).max(80),
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// GET /pairings?source_kind=&source_id=&target_kind=&target_id=&relationship_kind=
// GET /pairings?record_kind=&record_id=  every link touching one record, both
// directions, whichever spelling of its kind each link was stored under. Each
// row carries `direction`: "out" when the record is the source.
pairingsRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const params = req.query as Record<string, string | undefined>;
    if (params.record_kind && params.record_id) {
      const orgId = req.tenant!.org.id;
      const kinds = await recordKindSpellings(orgId, params.record_kind);
      const id = params.record_id;
      const rows = await meta
        .selectFrom("entity_pairings")
        .selectAll()
        .where("org_id", "=", orgId)
        .where((eb) =>
          eb.or([
            eb.and([eb("source_id", "=", id), eb("source_kind", "in", kinds)]),
            eb.and([eb("target_id", "=", id), eb("target_kind", "in", kinds)]),
          ]),
        )
        .orderBy("created_at", "desc")
        .limit(500)
        .execute();
      res.json({
        items: rows.map((r) => ({ ...r, direction: r.source_id === id && kinds.includes(r.source_kind) ? "out" : "in" })),
      });
      return;
    }
    let q = meta
      .selectFrom("entity_pairings")
      .selectAll()
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy("created_at", "desc")
      .limit(500);
    if (params.source_kind) q = q.where("source_kind", "=", params.source_kind);
    if (params.source_id) q = q.where("source_id", "=", params.source_id);
    if (params.target_kind) q = q.where("target_kind", "=", params.target_kind);
    if (params.target_id) q = q.where("target_id", "=", params.target_id);
    if (params.relationship_kind) q = q.where("relationship_kind", "=", params.relationship_kind);
    const items = await q.execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/** A link a table declares in its bundle (`links` on the instance). */
interface DeclaredLink {
  kind: string;
  label: string;
  inverse: string;
  to: string[];
}

/** A table name in `to` stands for its records' kind. */
const toKind = (t: string): string => (t.includes(":") ? t : `${t}:item`);

// GET /pairings/link-kinds?record_kind=  the links this record can make, in
// words, both ways round: a mod offers "installed on" (to printers) and a
// printer offers "has installed" (to mods, stored the mod's way round). Plus
// the words for every link kind the workspace declares, so any list of links
// reads "installed on Ender 3" rather than a stored key.
//
// AI-REACH: exempt: presentation for the Link dialog; links are made through
// POST /pairings, which is the door an agent uses too.
pairingsRouter.get("/link-kinds", requireAuth, withTenant, async (req, res, next) => {
  try {
    const orgId = req.tenant!.org.id;
    const kind = typeof req.query.record_kind === "string" ? req.query.record_kind : "";
    // The record's own spelling and its module kind, never a sibling table's:
    // a laser cutter does not take the links a 3D printer table declares.
    const mine = kind ? [...new Set([kind, (await resolveKind(orgId, kind)).base])] : [];
    const declared: Array<{ collection: string; link: DeclaredLink }> = [];
    for (const o of await listOverrides(orgId)) {
      if (o.target_kind !== "instance") continue;
      const links = ((o.config ?? {}) as { links?: DeclaredLink[] | null }).links;
      const name = String(o.target_id).split(":")[1];
      if (!name || !Array.isArray(links)) continue;
      for (const link of links) declared.push({ collection: `${name}:item`, link });
    }
    const words: Record<string, { label: string; inverse: string }> = {};
    for (const { link } of declared) words[link.kind] ??= { label: link.label, inverse: link.inverse };
    const offered: Array<{ kind: string; label: string; to: string[]; reverse: boolean }> = [];
    // What to LIST for a target: a module kind lists only the records outside
    // any table, so "any machine" is the module kind and each of its tables.
    const listable = async (to: string[]) => [...new Set((await Promise.all(to.map((t) => (t.includes(":") ? recordKindSpellings(orgId, t) : [toKind(t)])))).flat())];
    for (const { collection, link } of declared) {
      if (collection === kind) offered.push({ kind: link.kind, label: link.label, to: await listable(link.to), reverse: false });
    }
    for (const { collection, link } of declared) {
      const targets = link.to.map(toKind);
      if (targets.some((t) => mine.includes(t))) offered.push({ kind: link.kind, label: link.inverse, to: [collection], reverse: true });
    }
    res.json({ offered, words });
  } catch (err) {
    next(err);
  }
});

pairingsRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PairingCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad pairing payload", details: parsed.error.issues },
      });
      return;
    }
    const d = parsed.data;
    const orgId = req.tenant!.org.id;
    const [sourceKinds, targetKinds] = await Promise.all([recordKindSpellings(orgId, d.source_kind), recordKindSpellings(orgId, d.target_kind)]);
    if (d.source_id === d.target_id && sourceKinds.includes(d.target_kind)) {
      res.status(400).json({ error: { code: "self_link", message: "A thing cannot be linked to itself." } });
      return;
    }
    // The same two records, the same meaning, the same way round: once. A
    // second one shows the link twice on both records and means nothing more.
    // Checked under a lock on the pair, so a double tap cannot slip two in.
    const pairKey = `${orgId}|${d.source_id}|${d.target_id}|${d.relationship_kind}`;
    const outcome = await meta.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${pairKey}))`.execute(trx);
      const already = await trx
        .selectFrom("entity_pairings")
        .select("id")
        .where("org_id", "=", orgId)
        .where("source_id", "=", d.source_id)
        .where("target_id", "=", d.target_id)
        .where("relationship_kind", "=", d.relationship_kind)
        .where("source_kind", "in", sourceKinds)
        .where("target_kind", "in", targetKinds)
        .executeTakeFirst();
      if (already) return { already: already.id } as const;
      const row = await trx
        .insertInto("entity_pairings")
        .values({
          org_id: req.tenant!.org.id,
          source_kind: parsed.data.source_kind,
          source_id: parsed.data.source_id,
          target_kind: parsed.data.target_kind,
          target_id: parsed.data.target_id,
          relationship_kind: parsed.data.relationship_kind,
          notes: parsed.data.notes ?? null,
          metadata: parsed.data.metadata
            ? (sql`${JSON.stringify(parsed.data.metadata)}::jsonb` as unknown as Record<string, unknown>)
            : ({} as Record<string, unknown>),
          created_by: req.session!.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { row } as const;
    });
    if ("already" in outcome) {
      res.status(409).json({ error: { code: "already_linked", message: `These two are already linked (${linkWords(d.relationship_kind)}).`, existing_id: outcome.already } });
      return;
    }
    const inserted = outcome.row;
    await activity.log({
      orgId: req.tenant!.org.id,
      action: "pairing_created",
      ref: { module: null, entityType: "pairing", entityId: inserted.id },
      diff: {
        source_kind: parsed.data.source_kind,
        target_kind: parsed.data.target_kind,
        relationship_kind: parsed.data.relationship_kind,
      },
    });
    res.status(201).json(inserted);
  } catch (err) {
    next(err);
  }
});

const PairingPatch = z.object({
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
pairingsRouter.patch("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = PairingPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues },
      });
      return;
    }
    const updated = await meta
      .updateTable("entity_pairings")
      .set({
        ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
        ...(parsed.data.metadata && {
          metadata: sql`${JSON.stringify(parsed.data.metadata)}::jsonb` as unknown as Record<string, unknown>,
        }),
      })
      .where("id", "=", id)
      .where("org_id", "=", req.tenant!.org.id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "pairing not found" } });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

pairingsRouter.delete("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const deleted = await meta
      .deleteFrom("entity_pairings")
      .where("id", "=", id)
      .where("org_id", "=", req.tenant!.org.id)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "pairing not found" } });
      return;
    }
    await activity.log({
      orgId: req.tenant!.org.id,
      action: "pairing_deleted",
      ref: { module: null, entityType: "pairing", entityId: deleted.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
