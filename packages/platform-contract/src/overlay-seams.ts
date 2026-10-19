// ─────────────────────── Hosted-overlay extension seams ─────────────────────
// Open core registers NONE of these → a self-hosted instance runs free and
// unrestricted. The proprietary cloud overlay registers implementations at boot
// (plan gating, usage metering, lifecycle/verification, abuse rate-limiting,
// object storage). See cloud/docs/cloud-offering-roadmap.md.

export interface EntitlementCtx {
  orgId: string;
  /** Dotted feature key, e.g. "workspaces.create", "members.add",
   *  "modules.enable", "sandbox.install", "files.store". */
  feature: string;
  /** Units requested (default 1) — e.g. bytes for files.store. */
  quantity?: number;
  /** Units the workspace already holds of the same thing (the bytes of its
   *  stored files, for files.upload), so a guard can judge a running total
   *  rather than one request at a time. Absent when the caller cannot say. */
  used?: number;
  userId?: string;
}
export type EntitlementGuard = (
  ctx: EntitlementCtx,
) => Promise<{ allow: boolean; reason?: string }>;
export interface PlatformEntitlements {
  /** Hosted overlay registers the plan guard (last wins). */
  registerGuard(g: EntitlementGuard): void;
  /** Core / modules ask whether a plan-limited action is allowed. No guard
   *  registered → always allowed; a guard that throws fails open. */
  check(ctx: EntitlementCtx): Promise<{ allow: boolean; reason?: string }>;
}

export interface MeterEvent {
  orgId?: string;
  /** e.g. "ai.tokens", "files.bytes_stored", "members.added". */
  kind: string;
  quantity: number;
  meta?: Record<string, unknown>;
}
export type MeterSink = (e: MeterEvent) => void;
export interface PlatformMetering {
  registerSink(s: MeterSink): void;
  /** Emit a billable/observable event. No sink → dropped. Never throws. */
  record(e: MeterEvent): void;
}

// ── Product telemetry seam ───────────────────────────────────────────────────
// Sparse, high-signal product events (a wall somebody hit, an adoption
// milestone such as the first scan) — the numbers the operator reads to learn
// whether people are getting anywhere. NOT the activity log (that is the
// mutation audit and shows in the user's own feed) and NOT metering (that is
// billing). Rule of thumb: if the event would not change what gets built next
// week, do not track it.
export interface TelemetryEvent {
  orgId: string;
  userId?: string | null;
  /** e.g. "scan_captured", "label_printed", "validation_rejected". */
  event: string;
  detail?: Record<string, unknown>;
}
export interface PlatformTelemetry {
  /** One row per occurrence. Best-effort, fire-and-forget, never throws. */
  track(e: TelemetryEvent): void;
  /** At most one row per workspace + user + event + UTC day, so a burst of
   *  the same thing (a Live Sort session, a batch print) is one fact: "they
   *  did this today". The right call for funnel milestones. */
  trackDaily(e: TelemetryEvent): void;
  /** Add `n` (default 1) to a workspace's count of `metric` for today (UTC).
   *  For things that happen many times and are only ever asked "how many":
   *  an identification served, a scan. Best-effort, never throws. */
  count(e: { orgId: string; metric: string; n?: number }): void;
}

export interface SignupLifecycleCtx { userId: string; email: string; orgId: string }
export interface AccountDeleteCtx { userId: string; email: string }
export interface LifecycleHooks {
  onSignup?: (ctx: SignupLifecycleCtx) => Promise<void> | void;
  onAccountDelete?: (ctx: AccountDeleteCtx) => Promise<void> | void;
}
export interface PlatformAccounts {
  registerLifecycleHooks(h: LifecycleHooks): void;
  /** The day it is WHERE THIS PERSON IS, for a module that is about to claim
   *  one ("dated today", "expires today"). From the zone they stated in their
   *  communication preferences; `said` (a day their client sent) wins; a
   *  person who never said gets the day that has arrived everywhere, which is
   *  late for somebody rather than early for anybody (#3351). The rule itself
   *  is `@cobblr/platform-contract/day`; this only knows where they are. */
  dayFor(userId: string | null | undefined, opts?: { said?: unknown; now?: Date }): Promise<string>;
  /** The names people go by in a workspace, for a module that recorded WHO
   *  did something ("Sam took 1") and must say it. Read at display time, so a
   *  rename shows everywhere at once, never a copy taken when it happened.
   *  Only members of `orgId`: an id that is not (someone who has left) is
   *  simply absent, and the caller says so in its own words. */
  displayNames(orgId: string, userIds: readonly string[]): Promise<Record<string, string>>;
  /** The account behind one entry on the workspace's People list (what a
   *  `person` field stores), or null: someone listed by name who has no
   *  account, or has left. What a module needs to notify the person a record
   *  names ("assigned to Robin") without reading the platform's tables. */
  userForPerson(orgId: string, personId: string): Promise<string | null>;
  /** A member's own entry on the People list (made if missing): what "mine"
   *  means for a record whose `person` field names who it is for. */
  personForUser(orgId: string, userId: string): Promise<string | null>;
  /** The person this request acts for, or null outside one (a wire on a
   *  timer, a boot pass, a sync). The same actor the activity log records,
   *  so a module that writes its own history names the same person. */
  currentUserId(): string | null;
}
