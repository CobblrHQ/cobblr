// digifab:start-make: another module (an order line, a work order, a wire)
// starts a Make and says what it is for. The same door as the Makes route
// (startMake), so a Make started from a sales line is the same record, with
// the same steps and links, as one started on the Makes page.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { startMake } from "./api/makes.js";

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

let registered = false;

export function registerMakeActions(): void {
  if (registered) return;
  registered = true;
  platform().actions.registerHandler("digifab.start-make", async (ctx) => {
    const args = ctx.args ?? {};
    const name = text(args.name);
    if (!name) return { ok: false, error: "A Make needs a name: what is being made." };
    const sourceKind = text(args.source_kind);
    const sourceId = text(args.source_id);
    if (!!sourceKind !== !!sourceId) return { ok: false, error: "What it is for needs both source_kind and source_id." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const prompt = text(args.prompt);
    const made = await startMake(
      { db, orgId: ctx.orgId, userId: ctx.userId },
      {
        name: name.slice(0, 200),
        prompt: prompt ?? name,
        origin: ctx.event.trigger_type === "user-invoked" ? "page" : "module",
        ...(sourceKind && sourceId ? { source: { kind: sourceKind, id: sourceId } } : {}),
      },
    );
    return { ok: true, makeId: made.id, detailUrl: `/makes/${made.id}` };
  });
}
