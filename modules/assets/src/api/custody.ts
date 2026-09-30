// Who has a thing now, and when it is due back: lending it out and getting it
// back. Both write the two fields the asset already carries (`assigned_to`, a
// People entry, and `due_back`), so the asset page, Needs you (an overdue
// `due_back`) and every reader see the same answer, and both undo to exactly
// what was there before.

import { sql, type Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { AssetsDB } from "../db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Custody = { assigned_to: string | null; due_back: string | null };

async function readCustody(db: Kysely<AssetsDB>, id: string): Promise<(Custody & { name: string }) | null> {
  const row = await db.selectFrom("assets_assets").select(["name", "metadata"]).where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    name: row.name,
    assigned_to: typeof m.assigned_to === "string" ? m.assigned_to : null,
    due_back: typeof m.due_back === "string" ? m.due_back : null,
  };
}

/** Set both fields: a value is written, a null removes the key. Merged into
 *  metadata, never replacing it. */
async function writeCustody(orgId: string, db: Kysely<AssetsDB>, id: string, next: Custody, before: Custody): Promise<void> {
  const set: Record<string, string> = {};
  const drop: string[] = [];
  for (const k of ["assigned_to", "due_back"] as const) {
    if (next[k]) set[k] = next[k]!;
    else drop.push(k);
  }
  await db
    .updateTable("assets_assets")
    .set({
      metadata: sql`(coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(set)}::jsonb) - ${sql.val(drop)}::text[]` as never,
      updated_at: new Date(),
    })
    .where("id", "=", id)
    .execute();
  await platform().events.emit("assets.asset.updated", {
    orgId,
    assetId: id,
    before: { assigned_to: before.assigned_to, due_back: before.due_back },
    after: { assigned_to: next.assigned_to, due_back: next.due_back },
  });
}

export function registerCustodyHandlers(): void {
  platform().actions.registerHandler("assets.lend", async (ctx) => {
    const asset = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as { to?: unknown; due_back?: unknown };
    const to = typeof a.to === "string" ? a.to.trim() : "";
    if (!UUID_RE.test(to)) return { ok: false, error: "Pick who has it from the workspace's People." };
    const due = typeof a.due_back === "string" && a.due_back.trim() ? a.due_back.trim() : null;
    if (due && !DAY_RE.test(due)) return { ok: false, error: "Say when it is due back as a day, like 2026-10-03." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
    const before = await readCustody(db, asset.id);
    if (!before) return { ok: false, error: "That asset is not here any more." };
    await writeCustody(ctx.orgId, db, asset.id, { assigned_to: to, due_back: due }, before);
    return { ok: true, summary: `${before.name} is lent out${due ? `, due back ${due}` : ""}.`, was: { assigned_to: before.assigned_to, due_back: before.due_back } };
  });

  platform().actions.registerHandler("assets.got-back", async (ctx) => {
    const asset = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
    const before = await readCustody(db, asset.id);
    if (!before) return { ok: false, error: "That asset is not here any more." };
    if (!before.assigned_to && !before.due_back) return { ok: true, skipped: true, summary: `${before.name} was not lent out.` };
    await writeCustody(ctx.orgId, db, asset.id, { assigned_to: null, due_back: null }, before);
    return { ok: true, summary: `${before.name} is back.`, was: { assigned_to: before.assigned_to, due_back: before.due_back } };
  });

  platform().actions.registerHandler("assets.set-custody", async (ctx) => {
    const asset = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as { assigned_to?: unknown; due_back?: unknown };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
    const before = await readCustody(db, asset.id);
    if (!before) return { ok: false, error: "That asset is not here any more." };
    const next = {
      assigned_to: typeof a.assigned_to === "string" && a.assigned_to ? a.assigned_to : null,
      due_back: typeof a.due_back === "string" && a.due_back ? a.due_back : null,
    };
    await writeCustody(ctx.orgId, db, asset.id, next, before);
    return { ok: true, summary: `${before.name} is back to how it was.`, was: { assigned_to: before.assigned_to, due_back: before.due_back } };
  });

  // Each one's way back is the custody it replaced.
  const back = (result: unknown, ctx: { entity?: { kind: string; id: string } | null }) => {
    const r = result as { ok?: unknown; skipped?: unknown; was?: { assigned_to?: unknown; due_back?: unknown } } | null;
    if (r?.ok !== true || r.skipped || !r.was || !ctx.entity) return null;
    return {
      action_id: "assets:set-custody",
      args: { assigned_to: typeof r.was.assigned_to === "string" ? r.was.assigned_to : "", due_back: typeof r.was.due_back === "string" ? r.was.due_back : "" },
      entity_kind: ctx.entity.kind,
      entity_id: ctx.entity.id,
    };
  };
  platform().actions.registerUndo("assets.lend", back);
  platform().actions.registerUndo("assets.got-back", back);
  platform().actions.registerUndo("assets.set-custody", back);
}
