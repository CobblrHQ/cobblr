import type { ResolvableProvider, ResolveContext, ResolveOutcome } from "./resolvables.js";
import type { LiveControlDecl } from "@cobblr/platform-contract/module-manifest";

/** The resolvable registry seam. A module registers a provider for a value it
 *  owns (core-scan's QR rules) or asks "what could this value mean" for a
 *  surface. Types live in ./resolvables; the impl is api/src/platform. See
 *  docs/design-decisions/resolvable-registry.md. */
export interface PlatformResolvables {
  /** Register a provider. Idempotent by id; throws if a scan-serving provider is
   *  not an exact matcher (D3). Call at module load. */
  register(provider: ResolvableProvider): boolean;
  /** Run every provider serving `ctx.surface` and let the count decide. */
  resolve(orgId: string, value: string, ctx: ResolveContext): Promise<ResolveOutcome>;
}

/** A live control declaration plus the module that owns it (what the aggregation
 *  hands the Live box). */
export interface LiveControlPublic extends LiveControlDecl {
  module: string;
}

/** The Live box seam (docs/design-decisions/live-controls.md §3). A module
 *  registers the capability signals its live controls gate on; the aggregation
 *  returns, per workspace, the enabled-module live controls whose `requires`
 *  capability the workspace currently satisfies. */
export interface PlatformLive {
  /** Register a capability evaluator (`printer.connected`, `scanner.bridge`, …).
   *  Called per workspace, cheap, cached per aggregation. Idempotent by name. */
  registerCapability(name: string, evaluate: (orgId: string) => Promise<boolean>): void;
  /** The applicable live controls for a workspace (self-hiding = empty array). */
  applicable(orgId: string): Promise<LiveControlPublic[]>;
}

/**
 * A WORKSPACE'S OWN OUTBOUND EMAIL — the one door to somebody who is not a
 * member (a shop's customer), from the workspace's own address through the
 * provider it brought. `notifications` reaches members; this reaches everyone
 * else, and only when the workspace has set it up. Every send is logged by the
 * platform, and names the member who pressed send: there is no automated send
 * to a third party.
 */
export interface PlatformOutboundEmail {
  /** Whether the workspace can send, and from which address. */
  status(orgId: string): Promise<{ configured: boolean; from: string | null }>;
  send(
    orgId: string,
    message: {
      to: string;
      subject: string;
      text: string;
      /** The member who pressed send. */
      sentBy: string;
      attachments?: Array<{ filename: string; contentType: string; content: Uint8Array }>;
      category?: "sales_document";
      replyTo?: string;
      source?: { kind: string; id: string };
    },
  ): Promise<
    | { ok: true; logId: string; messageId: string | null; status: "sent" | "skipped" }
    | { ok: false; logId: string | null; reason: "not_configured" | "no_sender" | "bad_address" | "failed" | "rate_limited"; message: string }
  >;
  /** An AUTOMATION's message to someone on the workspace's People list who
   *  is not a member (#6070): only through this workspace's own sender, only
   *  when an owner or admin has turned it on, within the daily limits, never
   *  to someone who asked to stop this wire's messages, and naming who made
   *  the wire, with the link that stops it. Every attempt is logged. */
  sendAutomated(
    orgId: string,
    message: {
      wireId: string;
      personId: string;
      text: string;
      record?: { kind: string; id: string; title: string | null } | null;
      /** Add a reply page link ("Got it", "Bought it"), signed, for 14 days. */
      replyLink?: boolean;
      /** Email (the default) or a text to the person's phone, through the
       *  workspace's own Twilio account. */
      via?: "email" | "text";
    },
  ): Promise<{ ok: true; status: "sent"; to: string; name: string } | { ok: false; status: "refused" | "held" | "stopped" | "failed"; reason: string }>;
  /** Why an automation cannot message someone outside this workspace (the
   *  owner's switch is off, or there is no sender of its own), or null. */
  automatedRefusal(orgId: string, via?: "email" | "text"): Promise<string | null>;
  /** The sends about one record, newest first. */
  log(
    orgId: string,
    source: { kind: string; id: string },
  ): Promise<Array<{ id: string; to: string; subject: string; sentBy: string | null; status: "sent" | "failed" | "skipped"; messageId: string | null; error: string | null; at: string }>>;
}

export interface DatedMoney {
  value: import("@cobblr/platform-contract/money").Money;
  day: string;
}
export interface PlatformMoney {
  currency(orgId: string): Promise<string>;
  total(orgId: string, values: readonly DatedMoney[], currency?: string): Promise<import("@cobblr/platform-contract/money").MoneyTotal>;
}

/** The Vault (#5242): a door IN only. A part of Cobblr holding a personal
 *  document (an original the assistant was given, a bill of sale read on the
 *  personal path) files it into a folder the person owns; nothing reads a
 *  vault document out through here. */
export interface PlatformVault {
  /** File `bytes` into the person's folder named `folder` (an id or a name),
   *  or their own "Personal documents" folder, made the first time. Refuses a
   *  folder the person does not own. Encrypted before it is stored. */
  file(
    orgId: string,
    userId: string,
    doc: { name: string; mimeType?: string | null; bytes: Uint8Array; folder?: string | null; record?: { kind: string; id: string } | null },
  ): Promise<{ fileId: string; folderId: string; folderName: string }>;
  /** Say which record a document filed for this person belongs to, once it
   *  is known (null unlinks). Only a document in a folder the person owns;
   *  the record then lists it for the people who may open it. */
  link(orgId: string, userId: string, fileId: string, record: { kind: string; id: string } | null): Promise<void>;
  /** Remove a document this person filed, for compensation or Undo. */
  remove(orgId: string, userId: string, fileId: string): Promise<void>;
  /** How many of a record's vault documents this person may open (0 for
   *  anyone not on those folders' lists: never a count of the rest). */
  countFor(orgId: string, userId: string, record: { kind: string; id: string }): Promise<number>;
}

/** Contributed record panels (#6337). A panel that declared `presence: true`
 *  shows on a record its module says has the panel's data; the check is a
 *  cheap read, run when the record's page opens. */
export interface PlatformPanels {
  registerPresence(panelId: string, check: (ctx: { orgId: string; kind: string; id: string; collection: string | null }) => Promise<boolean>): void;
}

/** Module parts (manifest `parts`): whether one is on in a workspace. The
 *  kernel already hides an off part's actions, panels, tools and routes; a
 *  module asks this for its own doors the kernel cannot see (a station for a
 *  part's kind of machine, a sweep over a part's records). */
export interface PlatformParts {
  isOn(orgId: string, module: string, part: string): Promise<boolean>;
}
