// One-shot heal: an asset lent before loans were one platform thing
// (record-loans.md) has a loan, so it shows "With …" on its page, greys what a
// loan turns off, and comes up in every lent-out read.
//
// DONE WHEN: no assets_assets row has metadata.assigned_to set and no
// metadata.loan object. Check prod, staging and dev, then delete this file and
// its registration in api/index.ts.
//
// BORN WITH: assets:lend opens the platform loan as it writes Who has it
// (custody.ts mirrorLoan), and a loan made anywhere writes Who has it back
// (the writer's onLoan).

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { AssetsDB } from "./db.js";

export async function healLoansFromCustody(orgId: string, db: Kysely<AssetsDB>): Promise<number> {
  const rows = await db
    .selectFrom("assets_assets")
    .select(["id", "metadata", "updated_at"])
    .where(sql<boolean>`metadata ->> 'assigned_to' is not null and jsonb_typeof(metadata -> 'loan') is distinct from 'object'`)
    .execute();
  let healed = 0;
  for (const row of rows) {
    const m = (row.metadata ?? {}) as Record<string, unknown>;
    const r = (await platform().actions.invoke("platform:lend", {
      orgId,
      userId: null,
      scope: "workspace",
      event: { name: "assets.heal-loans", payload: {}, actor: { user_id: null, display_name: null, auth_method: "system" }, timestamp: new Date().toISOString(), trigger_type: "schedule" },
      args: {
        entity_kind: "assets:asset",
        ids: [row.id],
        holder_id: m.assigned_to,
        // Lent on the day its Who has it was last written, the best day known.
        since: new Date(row.updated_at as unknown as string).toISOString().slice(0, 10),
        ...(typeof m.due_back === "string" && m.due_back ? { due_back: m.due_back } : {}),
      },
    })) as { ok?: unknown } | null;
    if (r?.ok === true) healed++;
  }
  return healed;
}

export function registerLoansFromCustodyHeal(): void {
  registerHealPass({
    name: "assets.loans-from-custody",
    shim: "modules/assets/src/heal-loans-from-custody.ts",
    module: "assets",
    visit: ({ orgId, db }) => healLoansFromCustody(orgId, db as Kysely<AssetsDB>),
  });
}
