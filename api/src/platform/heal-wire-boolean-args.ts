// One-time, idempotent self-heal for wires saved with a boolean argument as a
// string.
// DONE WHEN: the heal rewrites 0 wires on prod + staging + dev consistently
// (no wire stores a boolean argument as "true" or "false"); then delete this
// file and its boot call.
//
// BORN WITH: the bindings routes (a wire's arguments are typed by its action's
// schema as it is saved; this pass types the ones saved before that)
//
// The wire composer saved "Checking it off adds it back to the record's stock"
// as the string "true", and the line the wire made never restocked (#6130).
// Since the fix every door types a boolean argument as it runs, so an old wire
// already fires right; this rewrites its saved JSON, so the composer's
// Advanced view says what the wire does. Cheap: one read of the wires that
// carry arguments and the schemas of their actions, a write only for a wire
// that changes.

import { sql } from "kysely";
import { typedArgs, type ActionArgSpec } from "@cobblr/platform-contract/action-args";
import { meta } from "../db/meta.js";
import { noteHealShim } from "./heal-shim-log.js";

export async function healWireBooleanArgs(): Promise<number> {
  const rows = await meta
    .selectFrom("entity_action_bindings as b")
    .innerJoin("entity_actions as a", "a.id", "b.action_id")
    .select(["b.id", "b.args", "a.args_schema"])
    .where("b.args", "is not", null)
    .execute();
  let healed = 0;
  for (const r of rows) {
    const args = r.args as Record<string, unknown> | null;
    if (!args || typeof args !== "object") continue;
    const typed = typedArgs(r.args_schema as Record<string, ActionArgSpec> | null, args);
    if (typed === args) continue;
    await meta.updateTable("entity_action_bindings").set({ args: sql`${JSON.stringify(typed)}::jsonb` as never }).where("id", "=", r.id).execute();
    healed += 1;
  }
  if (healed) console.log(`[heal-wire-boolean-args] ${healed} wire(s) now store their boolean arguments as booleans`);
  await noteHealShim("api/src/platform/heal-wire-boolean-args.ts", healed);
  return healed;
}
