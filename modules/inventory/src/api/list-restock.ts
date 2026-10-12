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

export function registerListRestock(): void {
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
