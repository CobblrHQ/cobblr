import { productName } from "@cobblr/platform-web";
import type { ConnectionVerification } from "@cobblr/platform-contract/connection-verification";
import { ApiError, request } from "./client";
import type { AiConnectionTest } from "@cobblr/platform-contract";
import type { ServiceCapabilityView, ServiceJob, ServiceRun } from "@cobblr/platform-contract/services";

/** Automations that email people outside the workspace (#6070). */
export interface AutomationEmailSettings {
  enabled: boolean;
  daily_limit: number;
  per_wire_daily_limit: number;
  recent: Array<{ id: string; channel: "email" | "text"; to_address: string; body: string | null; reply: "got" | "bought" | null; reply_token: string | null; status: "sent" | "held" | "stopped" | "refused" | "failed"; reason: string | null; created_at: string }>;
}

/** The workspace's own Twilio account, for texts to people outside it (#6070). */
export interface OutboundSmsStatus {
  configured: boolean;
  from: string | null;
  account_sid: string | null;
  tokenSet: boolean;
  updatedAt: string | null;
}

export interface OutboundEmailStatus {
  configured: boolean;
  provider: "smtp" | "mailgun" | "resend" | "postmark" | "gmail" | null;
  /** This server has a Google client, so Connect Gmail can be offered. */
  gmail_available?: boolean;
  from: string | null;
  settings: Record<string, unknown>;
  secretsSet: string[];
  updatedAt: string | null;
}

export interface OutboundEmailLogRow {
  id: string;
  to: string;
  subject: string;
  sent_by: string | null;
  source_kind: string | null;
  source_id: string | null;
  status: "sent" | "failed" | "skipped";
  message_id: string | null;
  error: string | null;
  at: string;
}

export interface AiProviderDef {
  locality?: "local" | "cloud";
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean; format?: "uri"; choices?: Array<{ value: string; label: string }> }>;
  capabilities: Record<string, { models: string[]; defaultModel?: string }>;
  /** What each model is called and costs, for any picker a person reads:
   *  "Gemini Flash Lite - 500 free a day" rather than an id. */
  modelNotes?: Record<string, { label: string; note?: string; short?: string }>;
  /** What this provider is FOR. Absent on the per-workspace AI catalogue, which
   *  is AI by definition; the personal catalogue at /me/connections carries
   *  every kind and always sets it. */
  kind?: string;
  /** One line under the picker, for a kind whose purpose isn't self-evident. */
  blurb?: string;
  /** What removing the connection stops and what remains in Cobblr. */
  disconnect?: { stops: string; keeps: string };
  /** How a person GETS these credentials: numbered steps with links, shown above the
   *  fields. Mirrors AiProviderSetup in the platform contract; the server serialises it
   *  onto the catalogue. Absent for a provider that needs no credentials. */
  setup?: {
    summary: string;
    steps: Array<{ text: string; href?: string }>;
    caveat?: string;
  };
  /** A provider connected through a consent screen rather than a form: the
   *  page renders a Connect button that posts `{ org_id }` to `start`. */
  connect?: { kind: "oauth"; start: string };
}

/** One of my connected mailboxes (a `mail-source` connection) with the state
 *  the sync leaves beside it. Never the grant. */
/** A "Check my mailbox" run (#5462). */
export interface MailboxCheck {
  id: string;
  status: "running" | "done" | "stopped" | "failed";
  query: string;
  seen: number;
  pages: number;
  started_at: string;
  finished_at: string | null;
  last_error: string | null;
  /** By verdict: order, shipment, not-order, ask-ai. */
  totals: Record<string, number>;
  /** By what decided it: schema.org, platform, heuristics, remembered, none. */
  by: Record<string, number>;
  previous: { id: string; totals: Record<string, number> } | null;
}

export interface MailboxCheckStoreRow {
  year: number | null;
  store: string;
  candidates: number;
  orders: number;
  shipments: number;
  not_orders: number;
  ask_ai: number;
  by_schema: number;
  by_platform: number;
  by_heuristics: number;
  by_remembered: number;
}

export type MailboxCheckList = "misses" | "false-hits" | "ask-ai" | "orders" | "all";

export interface MailboxCheckItem {
  gmail_id: string;
  received_at: string | null;
  sender: string | null;
  sender_domain: string | null;
  subject: string | null;
  purchases_label: boolean;
  verdict: "order" | "shipment" | "not-order" | "ask-ai";
  decided_by: string;
  strength: string | null;
  platform: string | null;
  found: { orderNumber?: string | null; tracking?: Array<{ number: string; carrier: string | null }>; merchant?: string | null; expected?: string | null };
  person_verdict: "order" | "not-order" | null;
}

export interface MailSourceView {
  id: string;
  provider_id: string;
  label: string;
  email: string | null;
  extra_senders: string[];
  org_ids: string[];
  share_status: Record<string, "pending" | "approved" | "active">;
  state: {
    cursor_at: string | null;
    last_synced_at: string | null;
    last_error: string | null;
    status: "ok" | "needs_reconnect" | "failing";
    messages_seen: number;
    stopped_notified_at: string | null;
  };
}

/** A mailbox feeding a workspace, as the workspace sees it: whose, how fresh. */
export interface WorkspaceMailSource {
  id: string;
  provider_id: string;
  owner_user_id: string;
  owner_name: string | null;
  approved: boolean;
  mine: boolean;
  status: "ok" | "needs_reconnect" | "failing";
  last_synced_at: string | null;
  messages_seen: number;
}

/** How the personal-connections page introduces each kind. An unlisted kind
 *  still works — it just gets its raw id as a heading instead of prose. */
/** A service as its manifest describes it, for the Add a service form. */
export interface ServicePreview {
  id: string;
  name: string;
  version: string;
  publisher: string | null;
  docs_url: string | null;
  requires: string[];
  manifest_version: string;
  capabilities: Array<{ id: string; title: string; summary: string; effect: import("@cobblr/platform-contract/services").ServiceEffect; mode: "async" | "sync" }>;
}

export const CONNECTION_KIND_LABELS: Record<string, { title: string; blurb: string }> = {
  "ai-provider": {
    title: "AI",
    blurb: "Your own key, or the local-AI edge bridge.",
  },
  "parcel-tracking": {
    title: "Parcel tracking",
    blurb: "Follow your own deliveries with your own tracking account.",
  },
  service: {
    title: "Services",
    blurb: "Something that does work for you, that you installed yourself: a slicer, a design service.",
  },
  "mail-source": {
    title: "Mail",
    blurb: `A mailbox ${productName()} reads for store and carrier mail, so orders and parcels track themselves.`,
  },
};

export type ConnRouteMode = "my-calls" | "workspace-default";
export type ConnRouteScope = "sole_member" | "owner" | "all_mine" | "explicit";

/** Per-workspace routing for a connection: which workspace + its mode. A
 *  workspace with no route is "Off". */
export interface ConnRoute {
  org_id: string;
  mode: ConnRouteMode;
  /** The one that serves this workspace when you have several routed there. */
  primary?: boolean;
}

export interface UserConnection {
  id: string;
  provider_id: string;
  /** Which catalogue this came from ('ai-provider', 'tracking', …), so the
   *  page groups a user's connections by what they are for. */
  kind: string;
  label: string;
  route_mode: ConnRouteMode;
  route_scope: ConnRouteScope;
  auto_enable_new: boolean;
  org_ids: string[];
  /** Per-workspace routing (workspace + mode). */
  routes: ConnRoute[];
  /** For 'workspace-default' (Share) routes: owner-approval state per org_id —
   *  'pending' | 'approved' | 'active'. Lets the sharer see whether an offer is
   *  live yet. Absent org_id = a 'my-calls' route. */
  share_status: Record<string, "pending" | "approved" | "active">;
  /** Which credential keys are set (names only — never the secret values). */
  credential_keys: string[];
  /** Values of the NON-SECRET credential fields (base_url, choices, model …), so
   *  the edit form can pre-fill them. Secret fields are never included. */
  credential_values: Record<string, string>;
  /** Depends on the user's personal edge agent (the edge-bridge provider, or a
   *  URL provider with bridge transit) — drives the live status indicators. */
  uses_edge: boolean;
  /** What the last probe said about the key; null for a row never checked. */
  verification?: ConnectionVerification | null;
  created_at: string;
  updated_at: string;
}

export interface UserConnectionInput {
  provider_id: string;
  label?: string;
  credentials?: Record<string, unknown>;
  route_mode?: ConnRouteMode;
  route_scope?: ConnRouteScope;
  auto_enable_new?: boolean;
  org_ids?: string[];
  /** Per-workspace routing (preferred over org_ids). */
  routes?: ConnRoute[];
  /** Save a key the probe rejected anyway, marked unverified: the person's
   *  say-so after the save answered 409 key_invalid. */
  confirm_unverified?: boolean;
}

export interface IntegrationConnector {
  id: string;
  connector_id: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface IntegrationConnectorDef {
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean; choices?: Array<{ value: string; label: string }> }>;
  actions: Array<{
    id: string;
    label: string;
    description?: string;
    argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" }>;
  }>;
}

export interface InboundHandlerDef {
  id: string;
  label: string;
  config: Record<string, { label: string; secret: boolean }>;
  emits: string[];
}

export interface InboundToken {
  id: string;
  connector_id: string;
  token: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  last_hit_at: string | null;
  hit_count: number;
  created_at: string;
}

export interface SyncConnectorDef {
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean; choices?: Array<{ value: string; label: string }> }>;
  config: Record<string, { label: string; placeholder?: string }>;
  entityTypes: Array<{ key: string; label: string; targetKind: string }>;
}

// An installed declarative sync-source manifest (a row in sync_source_defs).
export interface SyncSourceDef {
  id: string;
  source_id: string;
  name: string;
  manifest: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncStateRow {
  connector_row_id: string;
  entity_type: string;
  enabled: boolean;
  cadence_min: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_synced_count: number | null;
  next_run_at: string | null;
  /** Null until the first import is approved (then live sync is active). */
  import_approved_at: string | null;
  /** What the section does when the source and Cobblr disagree about a field:
   *  "cobblr" (the default), "source" or "ask". */
  conflict_policy?: SyncConflictPolicy;
  /** What the last run asked the person about. */
  last_conflicts?: { conflicts: SyncConflictNote[]; ambiguous: SyncAmbiguousNote[] };
}

export type SyncConflictPolicy = "cobblr" | "source" | "ask";
export interface SyncConflictNote {
  record: string;
  external_id: string;
  field: string;
  cobblr: unknown;
  source: unknown;
}
export interface SyncAmbiguousNote {
  record: string;
  external_id: string;
  candidates: Array<{ id: string; name: string }>;
}

export interface SyncRunResult {
  created: number;
  updated: number;
  linked: number;
  tombstoned: number;
  total: number;
  /** Source tags that could not be attached (counted, never swallowed). */
  tagsFailed?: number;
  /** Fields where Cobblr's value was kept over a different one at the source. */
  kept?: number;
  conflicts?: SyncConflictNote[];
  ambiguous?: SyncAmbiguousNote[];
}

// An import preview — what a reconcile WOULD do, computed without writing.
export interface ImportPlanItem {
  externalId: string;
  name: string;
  action: "create" | "update" | "link" | "unchanged" | "delete" | "ask";
  cobblrId?: string | null;
  /** The mapped source fields this row would write (what data comes over). */
  fields?: Record<string, unknown>;
  /** For link/update/delete: the existing Cobblr entity (name + current fields). */
  match?: { id: string; name: string; fields?: Record<string, unknown> | null } | null;
  /** Each field the two sides disagree about, and what the section's rule does with it. */
  changes?: Array<{ field: string; ours: unknown; theirs: unknown; decision: "write" | "keep" | "ask" }>;
  /** For ask: the records here it might be. */
  candidates?: Array<{ id: string; name: string }>;
  /** How many more places this record will be kept in, beside its own row. */
  holdings?: number;
}
export interface ImportPlan {
  entityType: string;
  targetKind: string;
  policy?: SyncConflictPolicy;
  counts: { create: number; update: number; link: number; unchanged: number; delete: number; total: number; ask?: number };
  items: ImportPlanItem[];
}

export interface SyncConnection {
  id: string;
  connector_id: string;
  label: string;
  config: { base_url: string; transport?: "direct" | "edge"; bridge?: string | null };
  enabled: boolean;
  /** Set = in the Archived history section (not deleted); null = in the list. */
  archived_at?: string | null;
  created_at: string;
  syncs?: SyncStateRow[];
}

export interface SyncConnectionDetail extends SyncConnection {
  entity_types: Array<{ key: string; label: string; targetKind: string }>;
  syncs: SyncStateRow[];
  webhook_path: string | null;
}

export interface IntegrationCall {
  id: string;
  direction: "outbound" | "inbound";
  connector_id: string;
  action_or_event: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  request_meta: Record<string, unknown> | null;
  ms: number | null;
  occurred_at: string;
}
export type { ServiceCapabilityView, ServiceJob, ServiceRun, ServiceRunStep, ServiceRunWait } from "@cobblr/platform-contract/services";

export const integrationsApi = {
  // The workspace's own outbound email (Configuration → Email): how it mails a
  // customer from its own address. Owner/admin.
  getOutboundEmail: (slug: string) => request<OutboundEmailStatus>("GET", `/orgs/${slug}/outbound-email`),
  saveOutboundEmail: (slug: string, config: Record<string, unknown>) =>
    request<OutboundEmailStatus>("PUT", `/orgs/${slug}/outbound-email`, config),
  deleteOutboundEmail: (slug: string) => request<void>("DELETE", `/orgs/${slug}/outbound-email`),
  /** Google's consent screen for sending from a Gmail account (send scope only). */
  startGmailSender: (slug: string) => request<{ url: string }>("POST", `/orgs/${slug}/outbound-email/gmail/start`, {}),
  testOutboundEmail: (slug: string) => request<{ ok: true; to: string; status: "sent" | "skipped" }>("POST", `/orgs/${slug}/outbound-email/test`, {}),
  outboundEmailLog: (slug: string) => request<{ items: OutboundEmailLogRow[] }>("GET", `/orgs/${slug}/outbound-email/log`),
  /** Whether automations may email people outside the workspace, its daily
   *  limits, and what they tried lately (#6070). Owner/admin. */
  getAutomationEmail: (slug: string) => request<AutomationEmailSettings>("GET", `/orgs/${slug}/outbound-email/automations`),
  saveAutomationEmail: (slug: string, body: { enabled?: boolean; daily_limit?: number; per_wire_daily_limit?: number }) =>
    request<Omit<AutomationEmailSettings, "recent">>("PUT", `/orgs/${slug}/outbound-email/automations`, body),
  getOutboundSms: (slug: string) => request<OutboundSmsStatus>("GET", `/orgs/${slug}/outbound-email/sms`),
  saveOutboundSms: (slug: string, body: { account_sid?: string; auth_token?: string; from_number?: string }) =>
    request<OutboundSmsStatus>("PUT", `/orgs/${slug}/outbound-email/sms`, body),
  deleteOutboundSms: (slug: string) => request<void>("DELETE", `/orgs/${slug}/outbound-email/sms`),
  testOutboundSms: (slug: string, to: string) => request<{ ok: true; status: "sent" | "skipped" }>("POST", `/orgs/${slug}/outbound-email/sms/test`, { to }),
  myOAuthGrants: () =>
    request<{
      items: Array<{
        id: string;
        client_name: string | null;
        redirect_host: string | null;
        access: "look" | "change";
        org_name: string;
        org_slug: string;
        created_at: string;
        last_used_at: string | null;
      }>;
    }>("GET", "/me/oauth-grants"),
  revokeOAuthGrant: (id: string) => request<void>("DELETE", `/me/oauth-grants/${id}`),

  // Personal (user-scoped) connections — BYO AI creds routed to your workspaces.
  listConnections: () =>
    request<{ items: UserConnection[] }>("GET", "/me/connections"),
  connectionCatalogue: () =>
    request<{ items: AiProviderDef[] }>("GET", "/me/connections/catalogue"),
  /** Check personal credentials without saving them (twin of testAiCredentials). */
  testConnection: (body: { provider_id: string; kind?: string; credentials: Record<string, string> }) =>
    request<AiConnectionTest>("POST", "/me/connections/test", body),
  /** What a connection would be before it is saved: a service's name and
   *  what it offers, read from its manifest, or the field the manifest gets
   *  wrong (400 invalid_manifest, `details`). Nothing is stored. */
  previewConnection: (body: { provider_id: string; credentials: Record<string, string> }) =>
    request<{ provider_id: string; label: string | null; preview: ServicePreview | null }>("POST", "/me/connections/preview", body),
  addConnection: (body: UserConnectionInput) =>
    request<{ id: string; verification?: ConnectionVerification }>("POST", "/me/connections", body),
  updateConnection: (id: string, body: Partial<UserConnectionInput>) =>
    request<{ verification?: ConnectionVerification } | void>("PATCH", `/me/connections/${id}`, body),
  /** The Test button: probe the stored key again; the row's state follows. */
  testStoredConnection: (id: string) =>
    request<{ verification: ConnectionVerification }>("POST", `/me/connections/${id}/test`, {}),
  deleteConnection: (id: string) =>
    request<void>("DELETE", `/me/connections/${id}`),
  /** A consent-screen provider: the URL to send the browser to. `start` is
   *  the provider's own route from the catalogue (`connect.start`). */
  startOAuthConnect: (start: string, org_id: string) =>
    request<{ url: string; redirect_uri: string }>("POST", start, { org_id }),
  listMailSources: () => request<{ configured: boolean; items: MailSourceView[] }>("GET", "/me/mail-sources"),
  /** Check now: read the mailbox this moment rather than at the next round. */
  syncMailSource: (id: string) =>
    request<{ ran: boolean; reason?: string; error?: string; result?: { delivered: number; listed: number; fetched: number } }>("POST", `/me/mail-sources/${id}/sync`, {}),
  /** The mailboxes feeding a workspace, for its Integrations page. */
  // "Check my mailbox" (#5462): the order rules run over the whole mailbox, filing nothing.
  startMailboxCheck: (id: string, range: { after?: string | null; before?: string | null } = {}) =>
    request<MailboxCheck>("POST", `/me/mail-sources/${id}/checks`, range),
  latestMailboxCheck: (id: string) => request<MailboxCheck | null>("GET", `/me/mail-sources/${id}/checks/latest`),
  mailboxCheckStores: (id: string, check: string) => request<{ items: MailboxCheckStoreRow[] }>("GET", `/me/mail-sources/${id}/checks/${check}/stores`),
  mailboxCheckItems: (id: string, check: string, list: MailboxCheckList, offset = 0) =>
    request<{ items: MailboxCheckItem[]; total: number; limit: number; offset: number }>("GET", `/me/mail-sources/${id}/checks/${check}/items?list=${list}&limit=50&offset=${offset}`),
  markMailboxCheckItem: (id: string, check: string, gmailId: string, isOrder: boolean) =>
    request<{ ok: boolean; remembered_for: string | null }>("POST", `/me/mail-sources/${id}/checks/${check}/items/${encodeURIComponent(gmailId)}/verdict`, { is_order: isOrder }),
  markedMailboxCheckItems: (id: string, check: string) => request<{ items: unknown[] }>("GET", `/me/mail-sources/${id}/checks/${check}/marked`),
  stopMailboxCheck: (id: string, check: string) => request<MailboxCheck>("POST", `/me/mail-sources/${id}/checks/${check}/stop`, {}),
  workspaceMailSources: (slug: string) => request<{ items: WorkspaceMailSource[] }>("GET", `/orgs/${slug}/mail-sources`),
  /** The order of MY connections in a workspace, first to last. Only meaningful
   *  when more than one of mine is routed there; without it the newest edit
   *  quietly wins. `capability` narrows the order to one kind of work. */
  setConnectionOrder: (body: { org_id: string; credential_ids: string[]; capability?: string | null }) =>
    request<{ ok: true }>("POST", "/me/connections/order", body),
  esphomeCommand: (slug: string, connection: string, input: Record<string, unknown>) => request<ServiceJob>("POST", `/orgs/${slug}/services/jobs`, { capability: "device.esphome.command", via: { credential_id: connection }, input }),

  // ─── Browser driving (Feature 3) ──────────────────────────────────
  driveGrant: (slug: string) =>
    request<{ mode: "off" | "navigate" | "navigate_observe" }>("GET", `/orgs/${slug}/drive/grant`),
  setDriveGrant: (slug: string, mode: "off" | "navigate" | "navigate_observe") =>
    request<{ mode: string }>("PUT", `/orgs/${slug}/drive/grant`, { mode }),
  driveTabTicket: (slug: string) =>
    request<{ ticket: string }>("POST", `/orgs/${slug}/drive/tab/ticket`),
  driveTabAccept: (slug: string, browser_id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/drive/tab/accept`, { browser_id }),
  driveTabRelease: (slug: string, browser_id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/drive/tab/release`, { browser_id }),
  driveTabTelemetry: (slug: string, browser_id: string, events: unknown[]) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/drive/tab/telemetry`, { browser_id, events }),
  driveStatus: (slug: string) =>
    request<{ driver: boolean; tabs: number; active: string | null }>(
      "GET",
      `/orgs/${slug}/drive/status`,
    ),
  /** A machine's Printing profile (Services §14.3) and the filament types a
   *  preset hint can be set for on it. */
  /** A capability's live choices from the connected service (Services §3),
   *  or null when nothing connected does it. */
  getServiceCapabilityOptions: async (slug: string, capability: string): Promise<unknown | null> => {
    try {
      const r = await request<{ options: unknown | null }>("GET", `/orgs/${slug}/services/capabilities/${encodeURIComponent(capability)}?if_any=1`);
      return r.options ?? null;
    } catch (e) {
      // 404-is: an-older-api: an api older than if_any still answers 404 for a capability nothing connected does
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  /** What has been handed over through this workspace's shares, and who it
   *  can hand things to from here. */
  ownConnections: (slug: string) => request<import("@cobblr/platform-web").OwnConnections>("GET", `/orgs/${slug}/own-connections`),

  // core-integrations — outbound + inbound connectors. See
  // docs/modules/core-integrations.md.
  listConnectorCatalogue: (slug: string) =>
    request<{ items: IntegrationConnectorDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/connectors/catalogue`,
    ),
  listConnectors: (slug: string) =>
    request<{ items: IntegrationConnector[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/connectors`,
    ),
  createConnector: (
    slug: string,
    body: {
      connector_id: string;
      label: string;
      credentials: Record<string, unknown>;
      config?: Record<string, unknown>;
    },
  ) =>
    request<IntegrationConnector>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/connectors`,
      body,
    ),
  updateConnector: (
    slug: string,
    id: string,
    body: {
      label?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    request<IntegrationConnector>(
      "PATCH",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}`,
      body,
    ),
  deleteConnector: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}`,
    ),
  testConnector: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}/test`,
    ),
  invokeConnector: (
    slug: string,
    id: string,
    body: { action_id: string; args?: Record<string, unknown>; rendered?: string },
  ) =>
    request<{ ok: boolean; ms?: number; result?: unknown; queued?: boolean; run_at?: string; because?: "pace" | "retry"; error?: string | null }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}/invoke`,
      body,
    ),
  resendIntegrationCall: (slug: string, callId: string) =>
    request<{ ok: boolean; queued?: boolean; run_at?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/connectors/calls/${callId}/resend`,
      {},
    ),
  listIntegrationCalls: (slug: string, limit = 50) =>
    request<{ items: IntegrationCall[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/connectors/calls?limit=${limit}`,
    ),
  listInboundHandlers: (slug: string) =>
    request<{ items: InboundHandlerDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens/handlers`,
    ),
  listInboundTokens: (slug: string) =>
    request<{ items: InboundToken[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens`,
    ),
  createInboundToken: (
    slug: string,
    body: { connector_id: string; label: string; config?: Record<string, unknown> },
  ) =>
    request<InboundToken>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens`,
      body,
    ),
  revokeInboundToken: (slug: string, id: string) =>
    request<InboundToken>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens/${id}/revoke`,
    ),
  deleteInboundToken: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens/${id}`,
    ),

  // core-integrations sync connectors — mirror an external system's records
  // into a Cobblr entity kind (live webhook + reconcile poll).
  listSyncConnectors: (slug: string) =>
    request<{ items: SyncConnectorDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync/connectors`,
    ),
  // Installed declarative sync-source manifests (the user-installable "drivers").
  listSyncSources: (slug: string) =>
    request<{ installed: SyncSourceDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync-sources`,
    ),
  installSyncSource: (slug: string, manifest: Record<string, unknown>) =>
    request<SyncSourceDef>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync-sources`,
      manifest,
    ),
  uninstallSyncSource: (slug: string, sourceId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/sync-sources/${encodeURIComponent(sourceId)}`,
    ),
  listSyncConnections: (slug: string) =>
    request<{ items: SyncConnection[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync/connections`,
    ),
  createSyncConnection: (
    slug: string,
    body: { connector_id: string; label: string; base_url?: string; credentials: Record<string, unknown>; transport?: "direct" | "edge"; bridge?: string | null; target_instances?: Record<string, string> },
  ) =>
    request<SyncConnection & { webhook_path: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections`,
      body,
    ),
  getSyncConnection: (slug: string, id: string) =>
    request<SyncConnectionDetail>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}`,
    ),
  updateSyncConnection: (
    slug: string,
    id: string,
    body: { label?: string; base_url?: string; credentials?: Record<string, unknown>; enabled?: boolean },
  ) =>
    request<{ ok: boolean }>(
      "PATCH",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}`,
      body,
    ),
  deleteSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean }>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}`,
    ),
  archiveSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/archive`,
    ),
  unarchiveSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/unarchive`,
    ),
  testSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string; note?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/test`,
    ),
  configureSync: (slug: string, id: string, entityType: string, body: { enabled: boolean; cadence_min?: number }) =>
    request<{ ok: boolean }>(
      "PUT",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}`,
      body,
    ),
  runSync: (slug: string, id: string, entityType: string) =>
    request<{ ok: boolean; result?: SyncRunResult; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/run`,
    ),
  previewSyncImport: (slug: string, id: string, entityType: string) =>
    request<{ ok: boolean; plan?: ImportPlan; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/preview`,
    ),
  /** What the section does when the source and Cobblr disagree about a field. */
  setSyncPolicy: (slug: string, id: string, entityType: string, conflict_policy: SyncConflictPolicy) =>
    request<{ ok: boolean; conflict_policy: SyncConflictPolicy }>(
      "PUT",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/policy`,
      { conflict_policy },
    ),
  /** A person's answer to what a run asked about: a source record is this
   *  record (link) or new (create); a field is kept as Cobblr has it or taken. */
  resolveSyncAsked: (
    slug: string,
    id: string,
    entityType: string,
    body: { external_id: string; action: "link" | "create" | "keep" | "take"; cobblr_id?: string; field?: string },
  ) =>
    request<{ ok: boolean; action: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/resolve`,
      body,
    ),
  runSyncImport: (slug: string, id: string, entityType: string) =>
    request<{ ok: boolean; result?: SyncRunResult; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/import`,
    ),
  // The caller's per-workspace receipt-forwarding address (null/unconfigured
  // when the operator hasn't wired up the receipts@ Email Worker).
  getReceiptAddress: (slug: string) =>
    request<{ configured: boolean; address: string | null; order_address?: string | null; receipt_name?: string | null; order_name?: string | null }>(
      "GET",
      `/orgs/${slug}/receipt-address`,
    ),
  /** Mail the person their own receipts (or orders) address, FROM that
   *  address, so their mail client learns its name (#5462). */
  emailMyAddress: (slug: string, which: "receipts" | "orders" = "receipts") =>
    request<{ sent: boolean; to: string; name: string }>("POST", `/orgs/${slug}/receipt-address/email-me`, { which }),
  // Services (#4034): what this person can call here, in order, and the
  // workspace's say over each capability.
  listServiceCapabilities: (slug: string) =>
    request<{ items: ServiceCapabilityView[] }>("GET", `/orgs/${slug}/services/capabilities`),
  getServicePolicies: (slug: string) =>
    request<{ items: Array<{ capability: string; policy: "always_ask" | "run" | "off" }> }>("GET", `/orgs/${slug}/services/policies`),
  setServicePolicy: (slug: string, capability: string, policy: "default" | "always_ask" | "run" | "off") =>
    request<{ capability: string; policy: string }>("PUT", `/orgs/${slug}/services/policies/${encodeURIComponent(capability)}`, { policy }),
  // Services (S9): a run is the chain of jobs one started; its steps and what
  // each waits on.
  getServiceRun: (slug: string, id: string) => request<ServiceRun>("GET", `/orgs/${slug}/services/runs/${encodeURIComponent(id)}`),
  listServiceRuns: (slug: string) => request<{ items: ServiceRun[] }>("GET", `/orgs/${slug}/services/runs`),
  // Services (#4034): one job, and the three things a person does to it.
  getServiceJob: (slug: string, id: string) =>
    request<ServiceJob>("GET", `/orgs/${slug}/services/jobs/${encodeURIComponent(id)}`),
  confirmServiceJob: (slug: string, id: string) =>
    request<ServiceJob>("POST", `/orgs/${slug}/services/jobs/${encodeURIComponent(id)}/confirm`, {}),
  answerServiceJob: (slug: string, id: string, input: unknown) =>
    request<ServiceJob>("POST", `/orgs/${slug}/services/jobs/${encodeURIComponent(id)}/input`, { input }),
  getServiceJobTrigger: (slug: string, id: string) =>
    request<{ trigger: { label: string; event: string; until: string; armed: boolean } | null }>("GET", `/orgs/${slug}/services/jobs/${encodeURIComponent(id)}/trigger`),
  withdrawServiceJobTrigger: (slug: string, id: string) =>
    request<{ trigger: null }>("DELETE", `/orgs/${slug}/services/jobs/${encodeURIComponent(id)}/trigger`),
  cancelServiceJob: (slug: string, id: string) =>
    request<ServiceJob>("POST", `/orgs/${slug}/services/jobs/${encodeURIComponent(id)}/cancel`, {}),
};
