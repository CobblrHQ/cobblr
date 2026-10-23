// A line put on a list to buy again restocks its record when it is checked
// off (#6062).
//
// "Add to list" on a part running low makes a line that says so
// (`restocks`), and the check-off event carries it. Without the Groceries
// bundle nothing listened, so the line read like a restock in the guide and
// was only a checklist: the washers stayed at 2. The consent is the gesture
// that made the line, never a workspace-wide wire an update could switch on.
// Where a wire already restocks the kind (the Groceries bundle's), it does
// the restock and this steps aside, so one check-off restocks once.
import { platform } from "@cobblr/platform-contract";
import { actionActed } from "@cobblr/platform-contract/action-result";
import { sql, type Kysely } from "kysely";
import type { InventoryDB } from "../db.js";

interface CheckedPayload {
  orgId?: string;
  itemId?: string;
  checked?: boolean;
  partId?: string;
  sourceRef?: { kind?: string; id?: string };
  quantity?: number;
  restocks?: boolean;
  actorId?: string | null;
}

const isRestock = (e: { action_id: string; args: Record<string, unknown> | null }) =>
  /:adjust-stock$/.test(e.action_id) && typeof e.args?.delta === "number" && (e.args.delta as number) > 0;

/** The one live item a typed title names, or null when it names none or two. */
async function partNamed(db: Kysely<InventoryDB>, title: string): Promise<string | null> {
  const named = await db
    .selectFrom("inventory_parts")
    .select("id")
    .where(sql<boolean>`lower(btrim(name)) = lower(${title.trim()})`)
    .where("archived", "=", false)
    .limit(2)
    .execute();
  return named.length === 1 ? named[0]!.id : null;
}

export function registerListRestock(): void {
  // A line typed by hand whose title names exactly one item is that item's
  // line: ticking it restocks it, and the line says so before it is ticked.
  // Typing it is the consent, as pressing Add to list is; a title that names
  // nothing, or two things, stays plain words.
  platform().events.on("lists.item.added", "inventory", async (raw) => {
    const ev = raw as { orgId?: string; itemId?: string };
    if (!ev.orgId || !ev.itemId) return;
    try {
      const line = await platform().entities.lookup(ev.orgId, "lists:item", ev.itemId);
      const title = typeof line?.title === "string" ? line.title.trim() : "";
      const behind = (line?.fields as { metadata?: { source_ref?: { id?: string } } } | undefined)?.metadata?.source_ref?.id;
      if (!title || behind) return;
      const db = (await platform().tenants.getDb(ev.orgId)) as Kysely<InventoryDB>;
      const part = await partNamed(db, title);
      if (!part) return;
      const kind = await platform().entities.resolvedKindForEntity(ev.orgId, "inventory:part", part);
      const linked = await platform().actions.invoke("lists:link-item", {
        orgId: ev.orgId,
        userId: null,
        scope: "workspace",
        args: { item_id: ev.itemId, kind, id: part },
        event: { name: "lists.item.added", payload: raw as Record<string, unknown>, actor: { user_id: null, display_name: null, auth_method: "system" }, timestamp: new Date().toISOString(), trigger_type: "event" },
      });
      if (!actionActed(linked)) console.info(`[inventory] a typed line was not linked: ${JSON.stringify(linked).slice(0, 200)}`);
    } catch (err) {
      platform().health.notePassFailure("inventory.list-link-typed-line", ev.orgId, err);
      console.error("[inventory] a typed line was not linked to the item it names:", (err as Error).message);
    }
  });

  // A line corrected into another thing is no longer the record its old words
  // named: "Original milk" changed to "Substitute oat milk" restocked the milk
  // that was not bought (#7866). The line follows its new words: the one item
  // they name, or no item, never the old one. A correction that still names
  // the record it points at (a capital, a stray space) is left alone.
  platform().events.on("lists.item.renamed", "inventory", async (raw) => {
    const ev = raw as { orgId?: string; itemId?: string; to?: string; sourceRef?: { kind?: string; id?: string } };
    if (!ev.orgId || !ev.itemId) return;
    try {
      const behind = ev.sourceRef;
      if (!behind?.id || !behind.kind) return;
      if ((await platform().entities.baseKindOf(ev.orgId, behind.kind)) !== "inventory:part") return;
      const title = (ev.to ?? "").trim();
      const db = (await platform().tenants.getDb(ev.orgId)) as Kysely<InventoryDB>;
      const stays = await db
        .selectFrom("inventory_parts")
        .select("id")
        .where("id", "=", behind.id)
        .where(sql<boolean>`lower(btrim(name)) = lower(${title})`)
        .executeTakeFirst();
      if (stays) return;
      const part = title ? await partNamed(db, title) : null;
      const kind = part ? await platform().entities.resolvedKindForEntity(ev.orgId, "inventory:part", part) : "";
      const moved = await platform().actions.invoke("lists:link-item", {
        orgId: ev.orgId,
        userId: null,
        scope: "workspace",
        args: part ? { item_id: ev.itemId, kind, id: part, relink: true } : { item_id: ev.itemId, unlink: true },
        event: { name: "lists.item.renamed", payload: raw as Record<string, unknown>, actor: { user_id: null, display_name: null, auth_method: "system" }, timestamp: new Date().toISOString(), trigger_type: "event" },
      });
      if (!actionActed(moved)) console.info(`[inventory] a corrected line was not re-pointed: ${JSON.stringify(moved).slice(0, 200)}`);
    } catch (err) {
      platform().health.notePassFailure("inventory.list-relink-corrected-line", ev.orgId, err);
      console.error("[inventory] a corrected line was not re-pointed at the item it now names:", (err as Error).message);
    }
  });

  // Taking a tick back takes the restock back: the shelf is as it was before
  // the line was ticked, however the restock was made (a wire or the line's own
  // consent). Ticking again starts a fresh purchase.
  platform().events.on("lists.item.unchecked", "inventory", async (raw) => {
    const ev = raw as CheckedPayload;
    if (!ev.orgId || !ev.partId || !ev.itemId) return;
    try {
      // Whether there is anything to take back is decided on the stock write's
      // own transaction (`takeBack`), never read here first: a tick that is
      // still being recorded would be missed.
      const r = await platform().actions.invoke("inventory:adjust-stock", {
        orgId: ev.orgId,
        userId: ev.actorId ?? null,
        scope: "entity",
        entity: { kind: ev.sourceRef?.kind ?? "inventory:part", id: ev.partId },
        args: { partId: ev.partId, takeBack: true, reason: "Unticked, taken back off the list", sourceKind: "lists:item", sourceId: ev.itemId },
        event: {
          name: "lists.item.unchecked",
          payload: raw as Record<string, unknown>,
          actor: { user_id: ev.actorId ?? null, display_name: null, auth_method: ev.actorId ? "session" : "system" },
          timestamp: new Date().toISOString(),
          trigger_type: "event",
        },
      });
      // Nothing to take back (a line that never restocked) is declined, not a miss.
      if (!actionActed(r) && (r as { skipped?: unknown }).skipped !== true) console.info(`[inventory] an unticked line was not taken back off the stock: ${JSON.stringify(r).slice(0, 200)}`);
    } catch (err) {
      platform().health.notePassFailure("inventory.list-unrestock", ev.orgId, err);
      console.error("[inventory] an unticked line was not taken back off the stock:", (err as Error).message);
    }
  });

  platform().events.on("lists.item.checked", "inventory", async (raw) => {
    const ev = raw as CheckedPayload;
    if (!ev.orgId || !ev.checked || ev.restocks !== true || !ev.partId || !ev.itemId) return;
    const kind = ev.sourceRef?.kind ?? "inventory:part";
    const wired = await platform().wires.effectsOf(ev.orgId, "lists.item.checked", kind);
    if (wired.some(isRestock)) return;
    const quantity = typeof ev.quantity === "number" && ev.quantity > 0 ? ev.quantity : 1;
    try {
      const r = await platform().actions.invoke("inventory:adjust-stock", {
        orgId: ev.orgId,
        userId: ev.actorId ?? null,
        scope: "entity",
        entity: { kind, id: ev.partId },
        args: {
          partId: ev.partId,
          delta: quantity,
          restock: true,
          reason: "Restocked, checked off the list",
          // Once per line: checking it off, back on and off again is still
          // one purchase.
          once: true,
          reversible: true,
          sourceKind: "lists:item",
          sourceId: ev.itemId,
        },
        event: {
          name: "lists.item.checked",
          payload: raw as Record<string, unknown>,
          actor: { user_id: ev.actorId ?? null, display_name: null, auth_method: ev.actorId ? "session" : "system" },
          timestamp: new Date().toISOString(),
          trigger_type: "event",
        },
      });
      // A re-check of the same line is declined on purpose (once per line);
      // anything else that did not restock is said, not taken as done.
      if (!actionActed(r)) console.info(`[inventory] a checked-off line was not restocked: ${JSON.stringify(r).slice(0, 200)}`);
    } catch (err) {
      platform().health.notePassFailure("inventory.list-restock", ev.orgId, err);
      console.error("[inventory] a checked-off line did not restock:", (err as Error).message);
    }
  });
}
