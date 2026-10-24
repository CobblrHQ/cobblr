// Who has a thing now, and when it is due back: lending it out and getting it
// back. Both write the two fields the asset already carries (`assigned_to`, a
// People entry, and `due_back`), so the asset page, Needs you (an overdue
// `due_back`) and every reader see the same answer, and both undo to exactly
// what was there before.
//
// The platform's loan (record-loans.md) is the same fact for every kind, so
// the two are kept in step both ways: these actions open or end the loan, and
// a loan made anywhere else (the record page's Lend…, the assistant's
// platform:lend) writes these fields through the writer's onLoan.

import { sql, type Kysely } from "kysely";
import { platform, requireActionEntity, type ActionInvokeContext } from "@cobblr/platform-contract";
import { readRecordLoan, type RecordLoan } from "@cobblr/platform-contract/loan";
import type { AssetsDB } from "../db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Custody = { assigned_to: string | null; due_back: string | null };

async function readCustody(db: Kysely<AssetsDB>, id: string): Promise<(Custody & { name: string; loan: RecordLoan | null }) | null> {
  const row = await db.selectFrom("assets_assets").select(["name", "metadata"]).where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    name: row.name,
    loan: readRecordLoan(m),
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

/** Open, move or end the platform's loan to match the fields just written. */
async function mirrorLoan(ctx: ActionInvokeContext, db: Kysely<AssetsDB>, id: string, next: Custody): Promise<void> {
  const row = await db.selectFrom("assets_assets").select("metadata").where("id", "=", id).executeTakeFirst();
  const open = readRecordLoan(row?.metadata);
  const base = { orgId: ctx.orgId, userId: ctx.userId, event: ctx.event, scope: "workspace" as const };
  const r = next.assigned_to
    ? open?.holder_id === next.assigned_to && open.due_back === next.due_back
      ? null
      : await platform().actions.invoke("platform:lend", { ...base, args: { entity_kind: "assets:asset", ids: [id], holder_id: next.assigned_to, ...(next.due_back ? { due_back: next.due_back } : {}) } })
    : open
      ? await platform().actions.invoke("platform:return", { ...base, args: { entity_kind: "assets:asset", ids: [id] } })
      : null;
  if (r && (r as { ok?: unknown }).ok !== true) console.error(`[assets] the loan on ${id} did not follow Who has it:`, (r as { error?: unknown }).error);
}

export function withCustodyLabel<T extends { metadata: unknown }>(row: T): T & { assigned_to_label?: string } {
  const loan = readRecordLoan(row.metadata);
  return loan && !loan.holder_id ? { ...row, assigned_to_label: loan.holder } : row;
}

/** The writer's onLoan: a loan made anywhere shows in Who has it and Due
 *  back. Typed holders stay on the loan and are displayed from there. */
export async function custodyFromLoan(orgId: string, id: string, loan: { holder_id: string | null; due_back: string | null } | null): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
  const before = await readCustody(db, id);
  if (!before) return;
  const next: Custody = { assigned_to: loan?.holder_id && UUID_RE.test(loan.holder_id) ? loan.holder_id : null, due_back: loan?.due_back ?? null };
  if (next.assigned_to === before.assigned_to && next.due_back === before.due_back) return;
  await writeCustody(orgId, db, id, next, before);
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
    await mirrorLoan(ctx, db, asset.id, { assigned_to: to, due_back: due });
    return { ok: true, summary: `${before.name} is lent out${due ? `, due back ${due}` : ""}.`, was: before };
  });

  platform().actions.registerHandler("assets.got-back", async (ctx) => {
    const asset = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<AssetsDB>;
    const before = await readCustody(db, asset.id);
    if (!before) return { ok: false, error: "That asset is not here any more." };
    if (!before.loan && !before.assigned_to && !before.due_back) return { ok: true, skipped: true, summary: `${before.name} was not lent out.` };
    await writeCustody(ctx.orgId, db, asset.id, { assigned_to: null, due_back: null }, before);
    await mirrorLoan(ctx, db, asset.id, { assigned_to: null, due_back: null });
    return { ok: true, summary: `${before.name} is back.`, was: before };
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
    await mirrorLoan(ctx, db, asset.id, next);
    return { ok: true, summary: `${before.name} is back to how it was.`, was: before };
  });

  // Each one's way back is the custody it replaced.
  const back = (result: unknown, ctx: { entity?: { kind: string; id: string } | null }) => {
    const r = result as { ok?: unknown; skipped?: unknown; was?: { assigned_to?: unknown; due_back?: unknown; loan?: unknown } } | null;
    if (r?.ok !== true || r.skipped || !r.was || !ctx.entity) return null;
    const loan = readRecordLoan({ loan: r.was.loan });
    if (loan) return {
      action_id: "platform:lend",
      args: { entity_kind: ctx.entity.kind, ids: [ctx.entity.id], ...loan },
    };
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
