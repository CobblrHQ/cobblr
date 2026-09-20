// The rows behind a connected mailbox: the personal connection that holds the
// grant (user_credentials, kind 'mail-source', routed to one workspace the
// way any personal connection is) and the sync state beside it.
//
// Nothing here returns the refresh token except `grantFor`, which the sync
// and the revoke call; a card or a list reads the non-secret fields only.

import { sql } from "kysely";
import { meta } from "../../db/meta.js";
import { listRoutedConnections, storedUserCredentials, listUserCredentials } from "../user-credentials.js";
import { normalizeSenders } from "./allowlist.js";

export const MAIL_SOURCE_KIND = "mail-source";
export const GMAIL_PROVIDER_ID = "gmail";

export interface MailSourceState {
  credential_id: string;
  cursor_at: Date | null;
  last_synced_at: Date | null;
  last_error: string | null;
  status: "ok" | "needs_reconnect" | "failing";
  messages_seen: number;
  stopped_notified_at: Date | null;
}

const EMPTY_STATE = (id: string): MailSourceState => ({
  credential_id: id,
  cursor_at: null,
  last_synced_at: null,
  last_error: null,
  status: "ok",
  messages_seen: 0,
  stopped_notified_at: null,
});

export async function mailSourceState(credentialId: string): Promise<MailSourceState> {
  const row = await meta.selectFrom("mail_source_state").selectAll().where("credential_id", "=", credentialId).executeTakeFirst();
  return row ? { ...row } : EMPTY_STATE(credentialId);
}

export async function mailSourceStates(credentialIds: string[]): Promise<Map<string, MailSourceState>> {
  const out = new Map<string, MailSourceState>();
  if (credentialIds.length === 0) return out;
  const rows = await meta.selectFrom("mail_source_state").selectAll().where("credential_id", "in", credentialIds).execute();
  for (const id of credentialIds) out.set(id, EMPTY_STATE(id));
  for (const r of rows) out.set(r.credential_id, { ...r });
  return out;
}

export async function writeMailSourceState(
  credentialId: string,
  patch: Partial<Omit<MailSourceState, "credential_id">> & { messages_seen_delta?: number },
): Promise<void> {
  const { messages_seen_delta, ...rest } = patch;
  const set: Record<string, unknown> = { ...rest, updated_at: new Date() };
  if (messages_seen_delta) set.messages_seen = sql`mail_source_state.messages_seen + ${messages_seen_delta}`;
  await meta
    .insertInto("mail_source_state")
    .values({ credential_id: credentialId, ...rest, ...(messages_seen_delta ? { messages_seen: messages_seen_delta } : {}) })
    .onConflict((c) => c.column("credential_id").doUpdateSet(set))
    .execute();
}

/** The grant and the non-secret settings of one mailbox, for the sync. Null
 *  when the connection is not the owner's or holds no grant. */
export async function grantFor(
  ownerUserId: string,
  credentialId: string,
): Promise<{ refresh_token: string; email: string | null; extra_senders: string[] } | null> {
  const stored = await storedUserCredentials(ownerUserId, credentialId);
  if (!stored) return null;
  const c = stored.credentials;
  const refresh = typeof c.refresh_token === "string" ? c.refresh_token : "";
  if (!refresh) return null;
  return {
    refresh_token: refresh,
    email: typeof c.email === "string" ? c.email : null,
    extra_senders: normalizeSenders(Array.isArray(c.extra_senders) ? (c.extra_senders as string[]) : typeof c.extra_senders === "string" ? c.extra_senders.split(/[\s,]+/) : []),
  };
}

/** The mailboxes routed INTO a workspace and approved there: what the sweep
 *  visits, and what the workspace's Integrations page lists. */
export interface RoutedMailSource {
  credentialId: string;
  providerId: string;
  ownerUserId: string;
  approved: boolean;
}

export async function mailSourcesRoutedTo(orgId: string): Promise<RoutedMailSource[]> {
  const rows = await listRoutedConnections(orgId, MAIL_SOURCE_KIND);
  return rows.map((r) => ({ credentialId: r.credentialId, providerId: r.providerId, ownerUserId: r.ownerUserId, approved: r.approved }));
}

/** The workspaces with at least one approved mailbox routed in: the sweep's
 *  candidates, one cobblr_meta query per round, so a workspace with none
 *  costs no tenant pool. */
export async function orgsWithMailSources(): Promise<Set<string>> {
  const rows = await meta
    .selectFrom("user_credential_orgs as uco")
    .innerJoin("user_credentials as uc", "uc.id", "uco.credential_id")
    .select("uco.org_id")
    .distinct()
    .where("uc.kind", "=", MAIL_SOURCE_KIND)
    .where("uco.mode", "=", "workspace-default")
    .where("uco.approved_at", "is not", null)
    .execute();
  return new Set(rows.map((r) => r.org_id));
}

/** A person's own mailboxes, for the card: address, workspace, allowlist,
 *  state. Never the grant. */
export interface MyMailSource {
  id: string;
  provider_id: string;
  label: string;
  email: string | null;
  extra_senders: string[];
  org_ids: string[];
  share_status: Record<string, "pending" | "approved" | "active">;
  state: MailSourceState;
}

export async function myMailSources(userId: string): Promise<MyMailSource[]> {
  const all = await listUserCredentials(userId, (providerId, key) => providerId === GMAIL_PROVIDER_ID && key === "refresh_token");
  const mine = all.filter((c) => c.kind === MAIL_SOURCE_KIND);
  const states = await mailSourceStates(mine.map((c) => c.id));
  return mine.map((c) => ({
    id: c.id,
    provider_id: c.provider_id,
    label: c.label,
    email: c.credential_values.email ?? null,
    extra_senders: normalizeSenders((c.credential_values.extra_senders ?? "").split(/[\s,]+/)),
    org_ids: c.routes.map((r) => r.org_id),
    share_status: c.share_status,
    state: states.get(c.id) ?? EMPTY_STATE(c.id),
  }));
}
