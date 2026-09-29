// Every outbound connector action is a built-in service (services.md §12).
//
// A Slack post, a Discord post, a webhook call and a plain HTTP request were
// "do a thing, described by a schema" all along, but only a wire could reach
// them: Cobb and MCP could not see them, and nothing asked a person before
// one ran. As built-ins they are capabilities like any connected service,
// listed by list_services and run under the same consent (effect `writes`:
// it asks by default).
//
// The capability is derived from the connector's own declaration, so a new
// connector is a service the moment it registers: registerOutboundConnector
// is the one way a connector registers (capability row
// integrations:outbound-connector-is-a-service).

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { BuiltInServiceDef, ServiceCapabilityDecl } from "@cobblr/platform-contract/services";
import type { CoreIntegrationsDB } from "./db.js";
import { invokeSavedConnector } from "./invoke-saved.js";

export type OutboundConnectorDef = Parameters<ReturnType<typeof platform>["integrations"]["registerConnector"]>[0];
type ConnectorActionDef = OutboundConnectorDef["actions"][number];

/** `slack` + `post-message` → `slack.post-message`. An action id that already
 *  carries its connector (`slack:post-message`) is not doubled. */
export function connectorCapabilityId(connectorId: string, actionId: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^([0-9])/, "x$1");
  const bare = actionId.startsWith(`${connectorId}:`) ? actionId.slice(connectorId.length + 1) : actionId;
  return `${clean(connectorId)}.${clean(bare)}`;
}

const JSON_TYPE: Record<string, string> = { text: "string", number: "number", boolean: "boolean" };

/** The action's arguments as a JSON Schema, plus which saved connection to
 *  use (a workspace may have two Slack workspaces saved). */
export function connectorInputSchema(def: OutboundConnectorDef, action: ConnectorActionDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    connection_id: {
      type: "string",
      title: `Which saved ${def.label} connection`,
      description: "Optional when the workspace has exactly one.",
    },
  };
  const required: string[] = [];
  for (const [name, spec] of Object.entries(action.argsSchema ?? {})) {
    properties[name] = { type: JSON_TYPE[spec.type] ?? "string", title: spec.label };
    if ((spec as { required?: boolean }).required === true) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { status: { type: ["integer", "null"] }, ms: { type: "number" }, connection: { type: "string" } },
  required: ["ms", "connection"],
};

export function connectorCapability(def: OutboundConnectorDef, action: ConnectorActionDef): Omit<ServiceCapabilityDecl, "options_endpoint"> {
  const title = `${def.label}: ${action.label}`.slice(0, 120);
  return {
    id: connectorCapabilityId(def.id, action.id),
    version: 1,
    title,
    summary: (action.description?.trim() || title).slice(0, 300),
    effect: "writes",
    mode: "sync",
    input_schema: connectorInputSchema(def, action),
    output_schema: OUTPUT_SCHEMA,
  };
}

/** Which saved connection answers: the one named, or the only enabled one. */
export async function pickConnection(db: Kysely<CoreIntegrationsDB>, def: OutboundConnectorDef, named: unknown): Promise<{ id: string; label: string }> {
  let q = db
    .selectFrom("core_integrations_connectors")
    .select(["id", "label"])
    .where("connector_id", "=", def.id)
    .where("enabled", "=", true)
    .where("archived_at", "is", null);
  if (typeof named === "string" && named.trim()) q = q.where("id", "=", named.trim());
  const rows = await q.execute();
  if (rows.length === 1) return rows[0]!;
  if (rows.length === 0) {
    throw new Error(
      typeof named === "string" && named.trim()
        ? `No enabled ${def.label} connection with that id in this workspace.`
        : `This workspace has no ${def.label} connection. Add one under Connections first.`,
    );
  }
  throw new Error(`This workspace has ${rows.length} ${def.label} connections (${rows.map((r) => r.label).join(", ")}); say which one with connection_id.`);
}

/** What a built-in reaches for; the real ones unless a test hands its own. */
export interface ConnectorServiceDeps {
  getDb(orgId: string): Promise<Kysely<CoreIntegrationsDB>>;
  pick: typeof pickConnection;
  invoke: typeof invokeSavedConnector;
}
const REAL_DEPS: ConnectorServiceDeps = {
  getDb: async (orgId) => (await platform().tenants.getDb(orgId)) as Kysely<CoreIntegrationsDB>,
  pick: pickConnection,
  invoke: invokeSavedConnector,
};

export function connectorBuiltIns(def: OutboundConnectorDef, deps: ConnectorServiceDeps = REAL_DEPS): BuiltInServiceDef[] {
  return def.actions.map((action) => {
    const capability = connectorCapability(def, action);
    return {
      id: `core-integrations.${capability.id}`,
      name: def.label,
      capability,
      async run(ctx) {
        const input = (ctx.input && typeof ctx.input === "object" ? ctx.input : {}) as Record<string, unknown>;
        const { connection_id, ...args } = input;
        const db = await deps.getDb(ctx.orgId);
        const conn = await deps.pick(db, def, connection_id);
        const out = await deps.invoke(db, ctx.orgId, conn.id, action.id, args);
        if (out.kind !== "done") throw new Error(`${def.label}: the saved connection could not be used (${out.kind}).`);
        if (!out.ok) throw new Error(out.error ?? `${def.label} failed`);
        return { output: { status: out.status, ms: out.ms, connection: conn.label } };
      },
    };
  });
}

/** The one way an outbound connector registers: as a connector for wires,
 *  and as a built-in service per action for everything else. */
export function registerOutboundConnector(def: OutboundConnectorDef): void {
  platform().integrations.registerConnector(def);
  for (const b of connectorBuiltIns(def)) platform().services.registerBuiltIn(b);
}
