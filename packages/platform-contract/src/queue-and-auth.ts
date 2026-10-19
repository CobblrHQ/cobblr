import type { AuthEmailMessage, AuthEmailSender } from "@cobblr/platform-contract/auth-email";
import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";

export interface PlatformQueue {
  enqueue(p: {
    orgId: string;
    queue: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
    /** What this job is: while one with the same key on the same queue is
     *  queued or running, enqueueing again returns it instead of a second. */
    idempotencyKey?: string;
  }): Promise<string>;
  registerWorker(
    queue: string,
    handler: (job: {
      id: string;
      orgId: string;
      payload: Record<string, unknown>;
      attempts: number;
    }) => Promise<void> | void,
  ): void;
  /** "Does this org already have a non-finished job on this queue?"
   *  Returns the set of org_ids (out of the input set) that have at
   *  least one job in the given statuses on the named queue. Used
   *  by recurring-job seeders to avoid double-queuing on boot — a
   *  cleaner replacement for hand-rolled `SELECT … FROM
   *  core_queue_jobs` against another module's tables. */
  hasPendingJob(args: {
    orgIds: string[];
    queue: string;
    statuses?: Array<"queued" | "running" | "done" | "failed">;
  }): Promise<Set<string>>;
}

/** Authorization helpers exposed to modules. Today only one: a
 *  user-has-capability check for per-action grants. Modules that
 *  want a route gated by a specific verb (e.g. `inventory:create-
 *  part`) ask `platform().auth.userHasCapability(...)`. Admins/owners
 *  pass implicitly; members/guests need an explicit grant in
 *  workspace_capability_grants. See
 *  docs/modules/member-portal-and-permissions.md. */
export interface PlatformAuth {
  /** Checks workspace membership against the same ranked roles as REST guards. */
  userHasRole(args: { orgId: string; userId: string; minRole: import("./org-roles.js").OrgRoleName }): Promise<boolean>;
  /** May this person run `actionId` here: their role in the workspace, then
   *  userHasCapability, the question the action's route asks. For a handler's
   *  own check, so its door and its page agree (#6672). */
  userMayRun(args: { orgId: string; userId: string; actionId: string }): Promise<boolean>;
  userHasCapability(args: {
    orgId: string;
    userId: string;
    role: string;
    actionId: string;
  }): Promise<boolean>;
  /** The refusal, explained: what `userHasCapability` said no to, in words,
   *  with whether asking is a remedy for this person and who would decide.
   *  A capability gate puts this on its 403 as `error.blocked`, so the one
   *  blocked-action sheet in the app can offer the ask (blocked-action.ts).
   *  Kernel-owned; a module never writes its own refusal sentence. */
  describeBlockedCapability(args: {
    orgId: string;
    userId: string;
    role: string;
    actionId: string;
  }): Promise<BlockedAction>;
  /** The same explanation for any set of remedies: a table in an app that is
   *  off (`module`), a bundle to install (`install`), a capability. For a
   *  refusal that is not a capability gate, so it still carries the ask
   *  instead of a dead end (#3610). */
  describeBlock(args: {
    orgId: string;
    userId: string;
    role: string;
    remedies: ReadonlyArray<{ kind: "capability" | "install" | "module"; key: string }>;
    doing?: string;
  }): Promise<BlockedAction>;
  /** Mint a SHORT-LIVED, capability-scoped token carrying `userId`'s
   *  own identity + an `app:<slug>` audience (H1 Tier B). It verifies
   *  as a normal session, so it acts AS the member — bounded by their
   *  capabilities + field-read-scope; it can never exceed them. The
   *  App Player uses it to mediate reads for a sandboxed custom
   *  frontend, so the untrusted bundle never holds the real session.
   *  `editKinds` are the record kinds the app declares it edits: the only
   *  kinds a kernel record verb (platform:update-fields) runs on under it. */
  mintAppToken(args: {
    userId: string;
    appSlug: string;
    editKinds: readonly string[];
  }): Promise<{ token: string; expires_in: number }>;
  /** Mint a NORMAL member session JWT for `userId` — a full session (NOT
   *  app-scoped), as if they had logged in. For TRUSTED in-process callers that
   *  have already authenticated a real member through another channel and need
   *  to act AS them against the internal API: an inbound integration (a verified
   *  Slack message, a forwarded receipt email) routing a capture into the
   *  member's workspace. Mirrors what core's receipt-ingest does directly; this
   *  seam exposes it to the trusted overlay. In-process only (platform seams are
   *  never HTTP-reachable); the resulting session is still bounded by the
   *  member's role + capabilities at every endpoint it hits. */
  mintSession(args: { userId: string }): Promise<string>;
  /** How the CURRENT request was made: its auth method, how it acts (the
   *  in-app assistant, an assistant over MCP) and the API token's name. For a
   *  door that records who added a thing (the inbox's "Added by Claude").
   *  Null outside a request. */
  requestSource(): Promise<{
    auth_method: "session" | "api_token" | "system";
    via: string | null;
    token_name: string | null;
    /** The assistant the request comes from, through any door, including the
     *  api calling itself on its behalf; null for a person's own request. */
    assistant?: string | null;
  } | null>;
  /** Register the platform-level auth-email sender (verify / reset / magic
   *  link). A self-hoster wires their own; the overlay injects a managed
   *  sender. Open core registers none — magic-link falls back to the inline
   *  dev link, reset to admin-managed. A sender the instance configured
   *  itself (COBBLR_AUTH_EMAIL_PROVIDER) is not replaced by an overlay's unless
   *  COBBLR_AUTH_EMAIL_ALLOW_OVERRIDE=true; any replacement is logged with both
   *  names. `name` labels this sender in that log and in /auth/config. */
  registerEmailSender(sender: AuthEmailSender, opts?: { name?: string }): void;
  /** True if an auth-email sender is registered (so the auth routes know
   *  whether real delivery is available vs. the dev-link fallback). */
  hasEmailSender(): boolean;
  /** Deliver an auth email through the registered sender. No-op (returns
   *  false) if none is registered. */
  sendEmail(msg: AuthEmailMessage): Promise<boolean>;
}
