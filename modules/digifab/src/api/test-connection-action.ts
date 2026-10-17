// Test a machine connection (digifab:test-connection): the handler its manifest entry names. Wired in ./index.ts.
// The same check as Test on a connection (POST /connections/:id/test): it asks
// the manager whether it answers; it sends nothing to a machine.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { testMachineConnection } from "./connections.js";
import { availableDriverKeys } from "../drivers/registry.js";

export function registerTestConnectionAction(): void {
  platform().actions.registerHandler("digifab.test-connection", async (ctx) => {
    const want = typeof ctx.args?.connection === "string" ? ctx.args.connection.trim() : "";
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    // Only connections a machine driver can drive: the store also keeps others (a Spoolman).
    const driveable = new Set(await availableDriverKeys(db));
    const conns = (await platform().devices.connections().list(ctx.orgId)).filter((c) => driveable.has(c.type));
    if (!want) return { ok: false, error: conns.length ? `Say which connection: ${conns.map((c) => c.label).join(", ")}.` : "This workspace has no machine connections." };
    const named = conns.find((c) => c.id === want) ?? conns.find((c) => c.label.toLowerCase() === want.toLowerCase());
    const out = named ? await testMachineConnection(db, ctx.orgId, named.id) : ({ found: false } as const);
    if (!out.found) return { ok: false, error: `No connection called "${want}". There is ${conns.map((c) => c.label).join(", ") || "none"}.` };
    const label = conns.find((c) => c.id === out.id)?.label ?? want;
    const r = out.result as { ok: boolean; detail?: string };
    // The manager's answer is the result: one that refused is a finding, not a failed action.
    return {
      ok: true,
      summary: r.ok ? `${label} answered: the stored credentials work.` : `${label} did not answer: ${r.detail ?? "no reason given"}.`,
      data: { connection: out.id, works: r.ok, ...(r.detail ? { said: r.detail } : {}) },
    };
  });
}
