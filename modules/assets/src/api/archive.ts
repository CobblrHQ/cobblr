// Putting a thing away and bringing it back. Archived is a date on the row,
// never a delete: the history, the cost, the links and the service log stay,
// and the thing leaves the register, views, search and Needs you until it is
// restored. Each is the other's undo.

import type { Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { AssetsDB } from "../db.js";

async function setArchived(orgId: string, id: string, at: Date | null): Promise<{ name: string; was: Date | null } | null> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
  const before = await db.selectFrom("assets_assets").select(["name", "archived_at"]).where("id", "=", id).executeTakeFirst();
  if (!before) return null;
  if ((before.archived_at === null) === (at === null)) return { name: before.name, was: before.archived_at };
  await db.updateTable("assets_assets").set({ archived_at: at, updated_at: new Date() }).where("id", "=", id).execute();
  await platform().events.emit(at ? "assets.asset.archived" : "assets.asset.restored", { orgId, assetId: id, name: before.name });
  return { name: before.name, was: before.archived_at };
}

export function registerArchiveHandlers(): void {
  platform().actions.registerHandler("assets.archive", async (ctx) => {
    const asset = requireActionEntity(ctx);
    const done = await setArchived(ctx.orgId, asset.id, new Date());
    if (!done) return { ok: false, error: "That asset is not here any more." };
    if (done.was) return { ok: true, skipped: true, summary: `${done.name} was already put away.` };
    return { ok: true, summary: `${done.name} is put away. It keeps its history and comes back with Restore.` };
  });

  platform().actions.registerHandler("assets.restore", async (ctx) => {
    const asset = requireActionEntity(ctx);
    const done = await setArchived(ctx.orgId, asset.id, null);
    if (!done) return { ok: false, error: "That asset is not here any more." };
    if (!done.was) return { ok: true, skipped: true, summary: `${done.name} was not put away.` };
    return { ok: true, summary: `${done.name} is back in the register.` };
  });

  const inverse = (action_id: string) => (result: unknown, ctx: { entity?: { kind: string; id: string } | null }) => {
    const r = result as { ok?: unknown; skipped?: unknown } | null;
    if (r?.ok !== true || r.skipped || !ctx.entity) return null;
    return { action_id, args: {}, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  };
  platform().actions.registerUndo("assets.archive", inverse("assets:restore"));
  platform().actions.registerUndo("assets.restore", inverse("assets:archive"));
}
