// Run one action of a workspace's saved outbound connection: the one door
// behind both the Connections page's Invoke and the connector's built-in
// service (services.md §12), so a Slack post Cobb asks for and one a person
// presses are the same call, logged the same way.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreIntegrationsDB } from "./db.js";

export type SavedInvokeOutcome =
  | { kind: "not_found" }
  | { kind: "disabled" }
  | { kind: "unknown_connector"; connectorId: string }
  | { kind: "done"; connectorId: string; ok: boolean; ms: number; status: number | null; result: unknown; error: string | null };

export async function invokeSavedConnector(
  db: Kysely<CoreIntegrationsDB>,
  orgId: string,
  rowId: string,
  actionId: string,
  args: Record<string, unknown>,
  rendered?: string,
): Promise<SavedInvokeOutcome> {
  const row = await db
    .selectFrom("core_integrations_connectors")
    .select(["connector_id", "credentials_enc", "enabled"])
    .where("id", "=", rowId)
    .executeTakeFirst();
  if (!row) return { kind: "not_found" };
  if (!row.enabled) return { kind: "disabled" };
  const def = platform().integrations.getConnector(row.connector_id);
  if (!def) return { kind: "unknown_connector", connectorId: row.connector_id };
  const creds = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);

  const start = Date.now();
  let ok = false;
  let status: number | null = null;
  let error: string | null = null;
  let result: unknown = null;
  try {
    result = await platform().integrations.invokeConnector(row.connector_id, { orgId, rowId, credentials: creds, args, rendered }, actionId);
    ok = true;
    const maybeStatus = (result as { status?: number } | null)?.status;
    if (typeof maybeStatus === "number") status = maybeStatus;
  } catch (err) {
    error = (err as Error).message;
  }
  const ms = Date.now() - start;
  try {
    await db
      .insertInto("core_integrations_calls")
      .values({
        direction: "outbound",
        connector_id: row.connector_id,
        action_or_event: actionId,
        status,
        ok,
        error,
        request_meta: sql`${JSON.stringify({ args })}::jsonb` as never,
        ms,
      })
      .execute();
  } catch (err) {
    console.error("[core-integrations] audit write failed:", err);
  }
  void platform().events.emit(ok ? "core-integrations.connector.invoked" : "core-integrations.connector.failed", {
    orgId,
    rowId,
    connectorId: row.connector_id,
    actionId,
    ms,
    error,
  });
  return { kind: "done", connectorId: row.connector_id, ok, ms, status, result, error };
}
