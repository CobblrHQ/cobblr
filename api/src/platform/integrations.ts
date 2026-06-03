// core-integrations platform service.
//
// Three responsibilities:
//   1. Connector + inbound-handler registry (modules register at
//      load-time; this layer routes to them).
//   2. Per-workspace credential encryption (AES-GCM with a per-org
//      key in cobblr_meta).
//   3. Outbound invocation + inbound dispatch + audit logging.
//
// See docs/modules/core-integrations.md.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { meta } from "../db/meta.js";

// ─────────────────── connector / inbound registry ─────────────────

export interface ConnectorArgsSchema {
  /** Map of arg name → human label + type hint. Drives the wires
   *  UI's args form. */
  [argName: string]: { label: string; type: "text" | "number" | "boolean" };
}

export interface ConnectorAction {
  id: string;                                  // e.g. "slack:post-message"
  label: string;
  description?: string;
  argsSchema?: ConnectorArgsSchema;
}

export interface ConnectorInvokeContext {
  orgId: string;
  connectorId: string;
  rowId: string;                              // tenant's core_integrations_connectors.id
  credentials: Record<string, unknown>;       // decrypted
  args: Record<string, unknown>;
  rendered?: string;                          // template render result if any
  event?: { name: string | null; payload: Record<string, unknown> };
}

export interface OutboundConnector {
  id: string;                                 // "slack" / "discord" / "webhook" / "email"
  label: string;
  describeCredentials: () => Record<string, { label: string; secret: boolean }>;
  actions: ConnectorAction[];
  /** Invoke called by the platform when a wire fires an action this
   *  connector owns. */
  invoke: (ctx: ConnectorInvokeContext, actionId: string) => Promise<unknown>;
  /** Optional health check — returns ok on a successful test ping. */
  testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
}

export interface InboundHandlerContext {
  orgId: string;
  inboundRowId: string;
  config: Record<string, unknown>;
  emit: (eventName: string, payload: unknown) => Promise<void>;
}

export interface InboundHandler {
  id: string;                                 // "stripe" / "github" / "twilio" / "webhook"
  label: string;
  describeWebhookConfig: () => Record<string, { label: string; secret: boolean }>;
  emits: string[];                            // events this handler can emit
  /** Process the inbound request. Return { status, body? } to
   *  shape the HTTP response. */
  handle: (
    req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
    ctx: InboundHandlerContext,
  ) => Promise<{ status: number; body?: unknown }>;
}

const outboundConnectors = new Map<string, OutboundConnector>();
const inboundHandlers = new Map<string, InboundHandler>();

export function registerConnector(c: OutboundConnector): void {
  outboundConnectors.set(c.id, c);
}

export function registerInboundHandler(h: InboundHandler): void {
  inboundHandlers.set(h.id, h);
}

export function getConnector(id: string): OutboundConnector | undefined {
  return outboundConnectors.get(id);
}

export function getInboundHandler(id: string): InboundHandler | undefined {
  return inboundHandlers.get(id);
}

export function listOutboundConnectors(): OutboundConnector[] {
  return Array.from(outboundConnectors.values());
}

export function listInboundHandlers(): InboundHandler[] {
  return Array.from(inboundHandlers.values());
}

// ─────────────────────── credential encryption ────────────────────

const ALGO = "aes-256-gcm";

/** Get or lazily create the per-org master key. The first install of
 *  any connector in a workspace generates the key. The key is
 *  base64-encoded; the actual bytes are 32. */
async function getOrCreateOrgKey(orgId: string): Promise<Buffer> {
  const row = await meta
    .selectFrom("org_encryption_keys")
    .select("key_b64")
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (row) return Buffer.from(row.key_b64, "base64");
  const key = randomBytes(32);
  await meta
    .insertInto("org_encryption_keys")
    .values({ org_id: orgId, key_b64: key.toString("base64") })
    .onConflict((c) => c.column("org_id").doNothing())
    .execute();
  // Re-read in case another request inserted concurrently.
  const after = await meta
    .selectFrom("org_encryption_keys")
    .select("key_b64")
    .where("org_id", "=", orgId)
    .executeTakeFirstOrThrow();
  return Buffer.from(after.key_b64, "base64");
}

export async function encryptCredentials(
  orgId: string,
  plaintext: Record<string, unknown>,
): Promise<string> {
  const key = await getOrCreateOrgKey(orgId);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Pack as: base64(iv | tag | ct)
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export async function decryptCredentials(
  orgId: string,
  ciphertext: string,
): Promise<Record<string, unknown>> {
  const key = await getOrCreateOrgKey(orgId);
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 28) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as Record<string, unknown>;
}
