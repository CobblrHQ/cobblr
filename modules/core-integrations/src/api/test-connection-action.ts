// Test a connector (core-integrations:test-connection): the handler its manifest entry names. Wired in ./index.ts.
// The same check as Test on a connector (POST /connectors/:id/test).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { syncConnectorIds } from "../sync/operations.js";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerTestConnectionAction(): void {
  platform().actions.registerHandler("core-integrations.test-connection", async (ctx) => {
    const want = str(ctx.args?.connector);
    if (!want) return { ok: false, error: "Say which connector." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreIntegrationsDB>;
    const sync = await syncConnectorIds(db);
    const rows = (await db.selectFrom("core_integrations_connectors").select(["id", "label", "connector_id", "credentials_enc"]).execute()).filter(
      (r) => !sync.has(r.connector_id),
    );
    const named = rows.filter((r) => r.id === want || r.label.toLowerCase() === want.toLowerCase() || r.connector_id === want.toLowerCase());
    if (named.length > 1) return { ok: false, error: `More than one connector matches "${want}": ${named.map((r) => r.label).join(", ")}. Say which.` };
    const row = named[0];
    if (!row) {
      return { ok: false, error: rows.length ? `No connector called "${want}". There is ${rows.map((r) => r.label).join(", ")}.` : "This workspace has no connectors." };
    }
    const def = platform().integrations.getConnector(row.connector_id);
    if (!def) return { ok: false, error: `${row.label} uses a connector this workspace no longer has.` };
    if (!def.testConnection) return { ok: true, summary: `${row.label} has no test to run.`, data: { connector: row.id, works: null } };
    const creds = await platform().integrations.decryptCredentials(ctx.orgId, row.credentials_enc);
    const out = (await def.testConnection(creds)) as { ok: boolean; error?: string };
    return {
      ok: true,
      summary: out.ok ? `${row.label} answered: the stored credentials work.` : `${row.label} refused: ${out.error ?? "no reason given"}.`,
      data: { connector: row.id, works: out.ok, ...(out.error ? { said: out.error } : {}) },
    };
  });
}
