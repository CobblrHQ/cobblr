// An order line's units as core-scan actions (#5734): the doors the
// assistant and the MCP server take, through invoke_action and its change
// ledger, onto the same operations as the inbox card (line-units-ops.ts).
// Each that can be taken back says how: a counted scan is taken off its
// line, units split off go back in, a line made "different" is made "the
// same" again.

import type { Kysely } from "kysely";
import { platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { selfOrigin } from "@cobblr/platform-contract/self-api";
import type { CoreScanDB } from "../db.js";
import { fillOrderLine, rejoinOrderLine, setLineUnits, splitOffUnits, unfillOrderLine, type LineDoor, type LineOpResult } from "../services/line-units-ops.js";

async function doorFor(ctx: Pick<ActionInvokeContext, "orgId" | "userId">): Promise<LineDoor> {
  const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as Kysely<CoreScanDB>;
  const slug = (await platform().orgs.get(ctx.orgId).catch(() => null))?.slug ?? "";
  // The purchase is kept in step through its own routes, as the person.
  const token = ctx.userId && slug ? await platform().auth.mintSession({ userId: ctx.userId }).catch(() => null) : null;
  return { db, orgId: ctx.orgId, orgSlug: slug, userId: ctx.userId ?? null, token, baseUrl: selfOrigin() };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function outcome(r: LineOpResult, summary: string, data: Record<string, unknown>) {
  return r.ok ? { ok: true, summary, data: { ...data, ids: r.ids, ...(r.received !== undefined ? { received: r.received } : {}) } } : { ok: false, error: r.message };
}

export function registerLineUnitActions(): void {
  platform().actions.registerHandler("core-scan.set-line-units", async (ctx) => {
    const a = (ctx.args ?? {}) as { item_id?: unknown; mode?: unknown };
    const id = str(a.item_id);
    const mode = a.mode === "same" || a.mode === "different" ? a.mode : null;
    if (!id || !mode) return { ok: false, error: "Say which order line, and whether its units are the same or different." };
    const r = await setLineUnits(await doorFor(ctx), id, mode);
    return outcome(r, mode === "different" ? `Split into ${r.ok ? r.ids.length : 0} lines, one for each.` : "One line of the same thing.", { item_id: id, mode });
  });
  platform().actions.registerUndo("core-scan.set-line-units", (result) => {
    const d = (result as { data?: { mode?: string; ids?: string[] } } | null)?.data;
    if (d?.mode !== "different" || !d.ids?.length) return null;
    return { action_id: "core-scan:set-line-units", args: { item_id: d.ids[0], mode: "same" } };
  });

  platform().actions.registerHandler("core-scan.split-off-units", async (ctx) => {
    const a = (ctx.args ?? {}) as { item_id?: unknown; count?: unknown; name?: unknown };
    const id = str(a.item_id);
    const count = Math.round(Number(a.count));
    if (!id || !(count >= 1)) return { ok: false, error: "Say which order line, and how many of it differ." };
    const r = await splitOffUnits(await doorFor(ctx), id, count, str(a.name) || undefined);
    return outcome(r, `Split ${count} off into a line of their own.`, { item_id: id, part_id: r.ok ? r.ids[1] : null });
  });
  platform().actions.registerUndo("core-scan.split-off-units", (result) => {
    const part = (result as { data?: { part_id?: string } } | null)?.data?.part_id;
    return part ? { action_id: "core-scan:rejoin-order-line", args: { item_id: part } } : null;
  });

  platform().actions.registerHandler("core-scan.rejoin-order-line", async (ctx) => {
    const id = str((ctx.args as { item_id?: unknown } | null)?.item_id);
    if (!id) return { ok: false, error: "Say which split-off line to put back." };
    return outcome(await rejoinOrderLine(await doorFor(ctx), id), "Put back into its line.", { item_id: id });
  });

  platform().actions.registerHandler("core-scan.fill-order-line", async (ctx) => {
    const a = (ctx.args ?? {}) as { item_id?: unknown; line_id?: unknown; order_item_id?: unknown };
    const id = str(a.item_id);
    const line = { ...(str(a.line_id) ? { line_id: str(a.line_id) } : {}), ...(str(a.order_item_id) ? { order_item_id: str(a.order_item_id) } : {}) };
    if (!id || (!line.line_id && !line.order_item_id)) return { ok: false, error: "Say which scan, and which order line it is one of." };
    const r = await fillOrderLine(await doorFor(ctx), id, line);
    return outcome(r, r.ok ? `Counted: ${r.received} of ${r.count} received.` : "", { item_id: id });
  });
  platform().actions.registerUndo("core-scan.fill-order-line", (result) => {
    const id = (result as { data?: { item_id?: string } } | null)?.data?.item_id;
    return id ? { action_id: "core-scan:unfill-order-line", args: { item_id: id } } : null;
  });

  platform().actions.registerHandler("core-scan.unfill-order-line", async (ctx) => {
    const id = str((ctx.args as { item_id?: unknown } | null)?.item_id);
    if (!id) return { ok: false, error: "Say which scan to take off its order line." };
    const r = await unfillOrderLine(await doorFor(ctx), id);
    return outcome(r, r.ok ? `Taken off its line: ${r.received} received.` : "", { item_id: id });
  });
}
