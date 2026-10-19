import type { AiConnectionTest } from "@cobblr/platform-contract/ai";

/** One provider a user can connect under /me/connections — their own key, or
 *  a service of theirs a bridge reaches. `kind` groups providers by what they
 *  are FOR ("ai-provider", "tracking"); a consumer resolves by kind and never
 *  needs to know which providers exist. */
export interface ConnectionProviderDef {
  id: string;
  kind: string;
  label: string;
  /** The fields to ask for. `secret: true` is write-only — stored encrypted and
   *  never returned, so the edit form shows "set" rather than the value. */
  credentials: Record<string, { label: string; secret: boolean; format?: "uri"; choices?: Array<{ value: string; label: string }> }>;
  /** Position in the picker; lower first, and FIRST IS THE DEFAULT. Optional:
   *  unranked providers sort after the ranked ones in registration order. */
  rank?: number;
  /** One line under the picker, for a kind whose purpose isn't self-evident. */
  blurb?: string;
  /** What Remove changes and what it deliberately leaves alone. The generic
   *  connections page says both before deleting the credential, so a provider
   *  with durable links or copied data can describe their different fates. */
  disconnect?: {
    stops: string;
    keeps: string;
  };
  /** A provider whose credentials come from a consent screen, not a form: a
   *  mailbox, a calendar, anything OAuth. The page renders a Connect button
   *  that opens `start` (a route of the provider's own, which redirects to
   *  the consent screen and stores the grant on the way back); the typed
   *  credential fields are the non-secret ones the card may edit afterwards
   *  (an allowlist, a label), never the grant itself. */
  connect?: {
    kind: "oauth";
    /** API path the Connect button posts to with `{ org_id }`; answers `{ url }`. */
    start: string;
  };
  /** Called with the decrypted credentials before a connection of this
   *  provider is deleted, so a grant is revoked at its issuer and not merely
   *  forgotten here. A failure is logged and the delete proceeds: the
   *  person asked for it gone, and a revoke that cannot reach its issuer is
   *  not a reason to keep the secret. */
  onDelete?: (credentials: Record<string, unknown>) => Promise<void>;
  /** The cheapest call that says whether these credentials work: what a save
   *  and the Test button run, and what becomes the connection's verification
   *  (connection-verification.ts). A kind without one is saved "unverified"
   *  and says so. Credentials arrive decrypted, with `__connection_user_id`
   *  (the owner) so a bridge transit reaches their own bridge. */
  testConnection?: (credentials: Record<string, unknown>, ctx: ConnectionTestContext) => Promise<AiConnectionTest>;
  /** The capability ids this connection can be ranked for, per workspace
   *  ("who does what, in order"). Absent: the kind is ranked only as a whole. */
  capabilities?: (credentials: Record<string, unknown>, ctx: ConnectionTestContext) => Promise<string[]>;
  /** This definition answers for EVERY connection of its kind whose
   *  provider_id no other definition claims (or every one the predicate
   *  accepts). A service is named by its own manifest id, which nobody can
   *  register ahead of time. */
  anyProviderOfKind?: boolean | ((providerId: string) => boolean);
  /** Turn what a person typed into the connection that is stored, before it
   *  is probed or saved: a service reads its manifest here, refuses one that
   *  does not validate (naming the field), and is stored under the manifest's
   *  own id. Also what the form's preview shows. Absent: stored as typed. */
  prepare?: (credentials: Record<string, unknown>, ctx: ConnectionTestContext) => Promise<PreparedConnection>;
}

/** What `ConnectionProviderDef.prepare` made of a connection being added. */
export type PreparedConnection =
  | {
      ok: true;
      /** The provider_id to store (a service: its manifest id). */
      providerId: string;
      /** A label to use when the person gave none. */
      label?: string;
      /** The credentials to probe and store. */
      credentials: Record<string, unknown>;
      /** What the form shows before saving (a service: its name and capabilities). */
      preview?: unknown;
      /** Run once the connection has an id (a service caches its manifest). */
      afterSave?: (credentialId: string) => Promise<void>;
    }
  | {
      ok: false;
      /** 400 for something the person can fix, 502 for a service that did not answer. */
      status: 400 | 502;
      code: string;
      message: string;
      details?: unknown;
    };

/** Who a test or a capability read is for. */
export interface ConnectionTestContext {
  /** The person the connection belongs to. */
  userId: string;
  /** The stored connection, when it is one; absent for credentials being typed. */
  credentialId?: string;
}

/** A personal connection that applies to a call, with the secret decrypted. */
export interface ResolvedConnection {
  credentialId: string;
  providerId: string;
  credentials: Record<string, unknown>;
  label: string;
  /** The user who OWNS this connection. A personal bridge is keyed by user, so
   *  this is what routes a call down THEIR tunnel — even when the caller is
   *  someone else (a shared connection) or nobody (a sweep). */
  ownerUserId: string;
}

/** Personal (user-scoped) connections: a credential its USER owns and routes to
 *  workspaces, rather than one a workspace owns.
 *
 *  AI was the first kind and for a while the only one, so the surface hardcoded
 *  it. Nothing about the routing, the share-approval flow or the precedence
 *  rules was ever AI-specific — so a second kind is a registration, not a
 *  second copy of any of it. */
export interface PlatformConnections {
  /** Offer a provider under /me/connections. Call at module load. */
  registerProvider(p: ConnectionProviderDef): void;
  listProviders(kind?: string): ConnectionProviderDef[];
  getProvider(id: string): ConnectionProviderDef | null;
  /** The connection that applies to (workspace, caller) for this kind, or null
   *  when the user has connected nothing — in which case the caller falls back
   *  to whatever the workspace itself is configured with.
   *
   *  Precedence is the caller's OWN connection first, then one shared into the
   *  workspace and approved by its owner. */
  resolve(kind: string, orgId: string, callerUserId: string | null): Promise<ResolvedConnection | null>;
  /** The connections of this kind routed INTO the workspace, so a workspace
   *  surface can CHOOSE between them. Distinct from resolve(), which answers
   *  "which one serves this call" - this answers "which ones may it name". */
  routedTo(kind: string, orgId: string): Promise<RoutedConnectionSummary[]>;
  /** Run the provider's own probe on these credentials. A provider with no
   *  probe answers `{ ok: true, note }`: nothing was checked, and it says so. */
  testConnection(providerId: string, kind: string | null, credentials: Record<string, unknown>, ctx: ConnectionTestContext): Promise<AiConnectionTest>;
  /** The capability ids a stored connection can be ranked for, from its
   *  provider; [] for a kind ranked only as a whole. */
  capabilities(credentialId: string): Promise<string[]>;
  /** A connection made for a workspace with no person at the form (a heal
   *  moving an older store onto connections). It belongs to the workspace's
   *  first owner, shared into that workspace and live there when nothing of
   *  its kind is, exactly as the owner sharing it themselves would be. Saved
   *  unverified, never probed: a heal must not fail on a device that is off
   *  right now. Idempotent on `originKey`: again, it returns the same one. */
  createWorkspaceConnection(input: {
    orgId: string;
    kind: string;
    providerId: string;
    label: string;
    credentials: Record<string, unknown>;
    originKey: string;
    note?: string;
  }): Promise<{ credentialId: string; created: boolean }>;
}

/** One connection a workspace may name, from PlatformConnections.routedTo. */
export interface RoutedConnectionSummary {
  credentialId: string;
  providerId: string;
  label: string;
  ownerUserId: string;
  approved: boolean;
  active: boolean;
}

/** The single per-tenant egress policy every external-HTTP path routes through —
 *  consistent SSRF posture across sync connectors, device drivers, webhooks, and
 *  module polls (replaces the historic divergent per-module guards). */
export interface PlatformEgress {
  /** SSRF-guarded outbound fetch for a tenant. Link-local/metadata is always
   *  blocked. On a HOSTED instance (COBBLR_HOSTED=true) a private/internal target
   *  is blocked UNLESS a registered allow-provider permits it for this org (the
   *  tenant's own registered edge endpoint); a self-hosted instance allows LAN.
   *  `redirect: "manual"` hands back each redirect, still validated, for a
   *  caller that walks the chain itself carrying a cookie. */
  guardedFetch(orgId: string, input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Register a per-tenant allow-provider — e.g. the edge module exposing the
   *  org's registered bridge endpoints. Returns true to permit a private target. */
  registerAllow(provider: (orgId: string, ip: string, url: URL) => boolean | Promise<boolean>): void;
}

/** Cross-tenant key/value cache in cobblr_meta. For data that is the SAME for
 *  every workspace and is NOT tenant-private — public catalog lookups are the
 *  motivating case: a UPC resolves to the same product for everyone, so on a
 *  multi-tenant host you want to resolve each barcode ONCE globally instead of
 *  re-spending a shared rate-limited API quota per tenant. Never put
 *  tenant-identifying or tenant-private data here. */
export interface PlatformSharedCache {
  /** The stored JSON value, or null if absent or expired. */
  get<T = unknown>(namespace: string, key: string): Promise<T | null>;
  /** Upsert a value. `ttlSeconds` omitted ⇒ never expires (stable reference
   *  data like a resolved product). */
  put(namespace: string, key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /**
   * Forget a key.
   *
   * There was no way to do this — which is a real gap for a cache shared across
   * EVERY workspace. When an entry turns out to be wrong, the only options were to
   * overwrite it with another guess, or leave it poisoning everyone.
   *
   * Eviction is the honest third option: "we no longer believe this." It's what a
   * disproved barcode resolution needs — drop it, let the next scan take a fresh
   * look, and route the correction through the reviewable channel rather than
   * silently making one workspace's photo into the whole instance's truth.
   */
  del(namespace: string, key: string): Promise<void>;
}
