// Arrange the machine floor (digifab:arrange-floor): the handler its manifest entry names. Wired in ./index.ts.
// The floor's Arrange (PUT /fleet/layout): only the order tiles show in.
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { LayoutBody, readLayout, writeLayout } from "./fleet.js";

export function registerArrangeFloorAction(): void {
  platform().actions.registerHandler("digifab.arrange-floor", async (ctx) => {
    const items = readJsonArg<unknown>(ctx.args, "items");
    const reset = ctx.args?.reset === true || ctx.args?.reset === "true";
    const parsed = LayoutBody.safeParse({ items: items ?? [] });
    if (!parsed.success || (!parsed.data.items.length && !reset)) {
      return { ok: false, error: "Give the machines in order, each with its connection_id and device_id (as read_fabrication_floor lists them), and row_break true where a row starts." };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const before = await readLayout(db as never);
    const placed = await writeLayout(db as never, parsed.data.items);
    const summary = placed ? `Arranged ${placed} machine${placed === 1 ? "" : "s"} on the floor.` : "The floor is back to its own order.";
    return { ok: true, summary, data: { before } };
  });
  platform().actions.registerUndo("digifab.arrange-floor", (result) => {
    const d = (result as { ok?: unknown; data?: { before?: unknown[] } } | null);
    if (d?.ok !== true || !Array.isArray(d.data?.before)) return null;
    // A floor that had no order goes back to having none, the same as the page's reset.
    return { action_id: "digifab:arrange-floor", args: { items: d.data.before, reset: d.data.before.length === 0 } };
  });
}
