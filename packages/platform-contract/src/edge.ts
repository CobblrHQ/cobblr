// ───────────────────────────── Edge channel seam ─────────────────────────────
// A workspace can have a live OUTBOUND connection from a user-run edge agent
// (the Cobblr edge-bridge dialing the cloud). The agent dials out and holds the
// pipe open, so the cloud reaches a device behind NAT / on a private network /
// tailnet WITHOUT that user exposing a public URL — the inverse of an SSRF-
// guarded fetch. Open core defines the registry + request/response contract;
// the hosted relay server (proprietary overlay) authenticates edge connections
// and registers them here. Consumers (e.g. the "Local AI via edge bridge"
// provider) route a request to a workspace's edge via send().
//
// The registry is keyed by orgId and lives in-process — single-instance only
// for now (the socket lives on whichever api process the agent dialed). Scaling
// out to multiple replicas needs a shared backplane; that swaps THIS impl while
// keeping the seam, so providers + the agent never change.

/** The HTTP methods a relayed call may use. */
export type EdgeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/** Which of a bridge's lanes a call runs in. A bridge caps the slow lanes and
 *  keeps slots for printer status and control, so a burst of service or AI
 *  calls never makes the farm read offline. Unset: derived by `edgeLaneOf`. */
export type EdgeLane = "device" | "control" | "service" | "ai" | "sync";

/** No bridge is there to take the call: none set up, or offline. `message` is
 *  the sentence for the person (it names the bridge and what to check). */
export class EdgeOffline extends Error {
  readonly code = "edge_offline";
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = "EdgeOffline";
    this.key = key;
  }
}

export class EdgeNotRegistered extends Error {
  readonly code = "edge_not_registered";
  constructor() {
    super("This bridge is not registered. Register first.");
    this.name = "EdgeNotRegistered";
  }
}

/** The bridge cannot do what the call needs (it has not reported the feature,
 *  usually because it has not updated itself yet). `feature` names it; a
 *  caller with an older way to do the same thing falls back to it. */
export class EdgeUnsupported extends Error {
  readonly code = "edge_unsupported";
  readonly key: string;
  readonly feature: string;
  constructor(key: string, feature: string, message: string) {
    super(message);
    this.name = "EdgeUnsupported";
    this.key = key;
    this.feature = feature;
  }
}

/** The bridge is online but the call got no answer within its time. */
export class EdgeTimeout extends Error {
  readonly code = "edge_timeout";
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = "EdgeTimeout";
    this.key = key;
  }
}

/** A fetch-shaped call performed by a bridge on its own network. */
export interface EdgeFetchInit {
  privacy?: "personal" | "normal";
  /** The service's base URL on the bridge's network. The call is held to its origin. */
  baseUrl: string;
  path: string;
  method?: EdgeMethod;
  headers?: Record<string, string>;
  /** A JSON value, or a string sent as is. */
  body?: unknown;
  /** This hop's budget. The bridge stops the request to the service when it runs out. */
  timeoutMs?: number;
  lane?: EdgeLane;
  requiredFeatures?: readonly string[];
  /** Send this file as the request body, on the bridge's streamed file channel
   *  (no size limit, sha256 checked on the bridge before it is handed on). */
  bodyFile?: { path: string; sha256: string; size: number };
  /** The answer is a file: it comes back on the file channel, checked against
   *  the sha256 the bridge computed, and the Response body streams from disk.
   *  Its `x-cobblr-sha256` header carries the hash. */
  download?: boolean;
}

/** A relayed call's body or answer that is a file on the blob channel. */
export interface EdgeBlobRef {
  id: string;
  direction: "down" | "up";
  sha256?: string;
  size?: number;
}

export interface EdgeRequest {
  privacy?: "personal" | "normal";
  /** Path on the edge's local target, e.g. "/api/chat". */
  path: string;
  method?: EdgeMethod;
  body?: unknown;
  /** Per-request budget (ms). The relay rejects if the edge doesn't answer. */
  timeoutMs?: number;
  /** Dynamic-config edge bridge: the machine this call targets, carried WITH the
   *  request so the bridge configures the driver on the fly — no static
   *  BRIDGE_CONFIG, no restart. The bridge installs with just a token; machines
   *  are added in Cobblr and ride down with each call. Absent for the AI channel
   *  and for a statically-configured bridge. */
  instance?: { id: string; driver: string; config: Record<string, unknown> };
  /** Generic local-source proxy (sync connectors): instead of a driver, the
   *  bridge performs a plain HTTP request to `baseUrl + path` with `headers` and
   *  returns the result. Lets a hosted sync connector reach a LAN source (e.g.
   *  a private LAN system) over the dial-out relay — the cloud never touches the private
   *  address. Mutually exclusive with `instance`. */
  source?: { baseUrl: string; headers?: Record<string, string> };
  lane?: EdgeLane;
  /** The origin a source call is held to, checked on the bridge as well as here. */
  scope?: string;
  blob?: EdgeBlobRef;
  /** Send this file on the bridge's blob channel (a machine upload, a service
   *  input): `send` offers it, carries only its id, and withdraws the offer
   *  once answered. Throws EdgeUnsupported for a bridge without "blobs". */
  bodyFile?: { path: string; sha256: string; size: number };
}

export interface EdgeResponse {
  status: number;
  body: unknown;
  /** The response headers a caller acts on (content-type, content-length,
   *  etag, retry-after, last-modified), from a bridge that carries them. */
  headers?: Record<string, string>;
}

/** A live edge connection's send function — supplied by the hosted relay when
 *  an agent connects, removed (via the returned unregister fn) when it drops. */
export type EdgeChannelSender = (req: EdgeRequest) => Promise<EdgeResponse>;

/** One queued relay request as delivered to a polling bridge. */
export interface EdgeRelayItem {
  id: string;
  path: string;
  method: EdgeMethod;
  body?: unknown;
  instance?: EdgeRequest["instance"];
  source?: EdgeRequest["source"];
  /** The bridge's own deadline for this call, a little under Cobblr's wait so
   *  its answer (a 504 that says why) arrives before Cobblr gives up. */
  timeoutMs?: number;
  lane: EdgeLane;
  scope?: string;
  blob?: EdgeBlobRef;
  /** "personal": a personal-document read, handed only to a bridge that says
   *  no-redirects and private-transit, and never written to the relay table. */
  privacy?: "personal";
}

/** A connected relay agent, as reported by the pane of glass. */
export interface EdgeAgentInfo {
  /** Named bridge id, or null for the workspace's default bridge. */
  bridge: string | null;
  last_seen_ms: number;
  queued: number;
  in_flight: number;
  /** A long-poll is parked = healthy idle bridge waiting for work. */
  parked: boolean;
}

/** A module that can attach things to an edge bridge. Registered at module api
 *  load; the generic Edge-bridges page renders one card per consumer, so the
 *  kernel page never hardcodes module names. */
export interface EdgeConsumer {
  /** The registering module's name — the page greys the card + offers Enable
   *  when the module isn't enabled in the viewing workspace. */
  module: string;
  label: string;
  description: string;
  /** In-app route where the attach/manage flow lives (e.g. "/digifab"). */
  href: string;
}

/** One of a workspace's bridges, as a person would recognise it. */
export interface EdgeBridgeRecord {
  /** Its channel id; null for the workspace's first (default) bridge. Never
   *  shown to a person: `name` is. */
  bridge: string | null;
  /** What a person calls it (the name typed when it was installed, or set
   *  since); null when it was installed before bridges had names. */
  name: string | null;
  connected: boolean;
  last_seen: string;
  first_seen: string;
  version: string | null;
  hostname: string | null;
  /** The addresses the bridge says it will reach (BRIDGE_ALLOW on the box);
   *  null when it reaches whatever the workspace points it at. */
  allowlist: string[] | null;
  /** Whether Cobblr knows the key it registers with, so it can be cut off. */
  can_disconnect: boolean;
}

export interface PlatformEdge {
  /** Hosted relay: register a live channel for a workspace. Returns an
   *  unregister fn. One channel per workspace — a newer connection replaces an
   *  older one (the relay reaps the stale socket). */
  registerChannel(orgId: string, send: EdgeChannelSender): () => void;
  /** Is there a live edge channel for this workspace right now? */
  /** Async: presence is shared state in cobblr_meta, not this process's memory,
   *  so any api process can answer for any bridge. */
  hasChannel(key: string): Promise<boolean>;
  /** Send a request to the workspace's edge; rejects if none is connected. */
  send(orgId: string, req: EdgeRequest): Promise<EdgeResponse>;
  /** Fetch-shaped call to a service on a bridge's network: the bridge performs
   *  `baseUrl + path` there and the answer comes back as a Response, with its
   *  status, body and headers. Throws `EdgeOffline` when no bridge is there to
   *  take it (after one short retry across a bridge's poll gap) and
   *  `EdgeTimeout` when the bridge took it and nothing came back in time. Every
   *  module that reaches a LAN service through a bridge goes through here. */
  fetch(key: string, init: EdgeFetchInit): Promise<Response>;
  /** The bridge's file channel, GET/HEAD/PUT <relay>/blobs/:id, for the bridge
   *  whose channel is `key`. Every relay door mounts this one handler. */
  serveBlob(key: string, id: string, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void>;

  // ── HTTP relay primitives — the queue mechanics behind the dial-out tunnel.
  // The kernel owns the state; routers (the kernel /orgs/:slug/edge wire and
  // any module-mounted legacy alias) are thin HTTP shims over these, so every
  // path lands on the SAME channels and modules stay isolated. Keys follow
  // edgeChannelKey: `orgId` for the default bridge, `orgId::<name>` for a
  // named one, or a bare userId for a personal (account-scoped) agent.

  /** Announce/refresh a bridge: registers the channel on first touch and
   *  bumps its liveness clock. At /register the bridge's own report rides
   *  along (its version and machine, and the token it installed with, whose
   *  name becomes the bridge's first name). */
  relayTouch(key: string, report?: { version?: string | null; hostname?: string | null; tokenId?: string | null; allow?: string[] | null; features?: string[] | null }): Promise<void>;
  /** Every bridge this workspace has, online or not, by the name a person
   *  recognises. */
  listBridges(orgId: string): Promise<EdgeBridgeRecord[]>;
  /** Rename a bridge; false when this workspace has no such bridge. */
  renameBridge(orgId: string, bridge: string | null, name: string): Promise<boolean>;
  /** Revoke the key a bridge registers with and remove it; null when the
   *  workspace has no such bridge. */
  disconnectBridge(orgId: string, bridge: string | null): Promise<{ alsoCut: string[] } | null>;
  /** Long-poll for the next queued request; resolves null on keep-alive
   *  timeout or when the poller hangs up (pass an abort signal). Throws
   *  EdgeNotRegistered when registration is missing or removed. */
  relayPoll(key: string, opts?: { signal?: AbortSignal; lanes?: EdgeLane[] | null }): Promise<EdgeRelayItem | null>;
  /** Deliver a polled request's result. Returns false if the id is unknown
   *  (already timed out). */
  relayRespond(key: string, r: { id: string; status: number; body?: unknown; headers?: Record<string, string> }): Promise<boolean>;
  /** Connected agents for a workspace (default + named bridges). */
  relayAgents(orgId: string): Promise<EdgeAgentInfo[]>;
  /** One bridge's liveness — `bridge` null = the default channel. */
  relayInfo(orgId: string, bridge?: string | null): Promise<{ connected: boolean; last_seen: number | null }>;

  // ── Consumer registry — modules declare "I can use a bridge" here.
  registerConsumer(c: EdgeConsumer): void;
  listConsumers(): EdgeConsumer[];

  // ── Bridge release — the self-update artifact the bridge downloads.
  getRelease(): { version: string; sha256: string };
  getReleaseBundle(): string;
  /** Registry-free bootstrap: a stock node image fetches this loader from
   *  /release/loader and runs it — it pulls the bundle and self-updates. */
  getReleaseLoader(): string;
}
