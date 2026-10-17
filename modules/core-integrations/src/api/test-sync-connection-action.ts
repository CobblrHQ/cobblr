// Test a sync connection (core-integrations:test-sync-connection): the handler its manifest entry names. Wired in ./index.ts.
// The same check as Test on the Integrations page (POST …/connections/:id/test).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { findSyncConnection, testSyncConnection } from "../sync/operations.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function registerTestSyncConnectionAction(): void {
  platform().actions.registerHandler("core-integrations.test-sync-connection", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreIntegrationsDB>;
    const conn = await findSyncConnection(db, str(ctx.args?.connection));
    if ("error" in conn) return { ok: false, error: conn.error };
    const out = await testSyncConnection(db, ctx.orgId, conn.id);
    if (!out.found) return { ok: false, error: `${conn.label} is archived or turned off, so there is nothing to test.` };
    // The verdict is the result: a source that refused is a finding, not a failed action.
    return {
      ok: true,
      summary: out.ok ? `${conn.label} answered: the stored credentials work.` : `${conn.label} refused: ${out.error ?? "no reason given"}.`,
      data: { connection: conn.id, works: out.ok, ...(out.error ? { said: out.error } : {}), ...(out.note ? { note: out.note } : {}) },
    };
  });
}
