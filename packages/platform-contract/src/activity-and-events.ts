import type { Disposition } from "@cobblr/platform-contract/disposition";
import type { EntityRef } from "@cobblr/platform-contract/placement";

// ──────────────────────── Platform runtime ────────────────────────
//
// Modules don't import from the api workspace directly — that'd
// couple them to the platform implementation. Instead, the api
// registers an implementation of the Platform interface at boot
// via setPlatform(), and modules read it via platform().
//
// Surface starts small (activity + events). It will grow as
// connectors hit real needs.

export interface ActivityRef {
  /** Module name, or `null` for platform-level events. */
  module: string | null;
  entityType: string;
  entityId: string;
}

export interface ActivityLogParams {
  orgId: string;
  userId: string | null;
  action: string;
  ref: ActivityRef;
  diff?: unknown;
  /** The record as it was before this write. Given with a patch `diff`, the
   *  log works out what really changed, old → new, custom fields included
   *  (`changes`, activity-changes.ts). Every `*_updated` write passes it
   *  (lint:history-knows-what-changed). */
  before?: unknown;
  /** HOW the write was made, when the caller knows better than the request
   *  context: a sync names itself ("automation", "<connection> sync"), so a
   *  record it creates is not a row with no actor (#3836). */
  via?: { kind: ActivityViaKind; label?: string | null } | null;
}

/** HOW a write was made, beside who made it. The one list: the api's request
 *  context and every module read it from here. `surface` is a place in the
 *  app that is not a record's own page (a floor plan, a shelf drawing), its
 *  label the words the activity shows ("via floor plan"). */
/** `share`: a friend's edit, made in a share space and applied here (its
 *  label is their name). */
export type ActivityViaKind = "mcp" | "assistant" | "automation" | "label" | "surface" | "share" | "sync";

export class RecordRestoreRefused extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export interface DeletionSnapshot {
  image: Record<string, unknown>;
  related?: unknown;
}

export interface DeletionParticipant {
  snapshot(orgId: string, ref: EntityRef, snapshot?: DeletionSnapshot): Promise<unknown>;
  restore(orgId: string, ref: EntityRef, image: unknown): Promise<void>;
  purge?(orgId: string, ref: EntityRef, image: unknown): Promise<void>;
}

export interface DeletedRecordImage {
  id: string;
  image: Record<string, unknown>;
  details: unknown;
  deletedBy: string | null;
  deletedAt: Date;
}

export interface PlatformDeletedRecords {
  exclusive<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<T>;
  capture<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<T>;
  keep(orgId: string, kind: string, id: string, image: Record<string, unknown>, details?: unknown, deletedBy?: string | null, deletedAt?: Date): Promise<string>;
  get(orgId: string, kind: string, id: string): Promise<DeletedRecordImage | null>;
  forget(orgId: string, kind: string, id: string): Promise<void>;
  restore(orgId: string, kind: string, id: string, deletionId?: string): Promise<boolean>;
  registerParticipant(name: string, participant: DeletionParticipant): void;
  registerLifecycle(kind: string, lifecycle: { restore(orgId: string, id: string): Promise<void>; purge(orgId: string, id: string): Promise<boolean> }): void;
}

/** The one door for a thing that is no longer the person's (sold, given away,
 *  gone) and the way back. A module reaches it here so its batches land the
 *  same way the record's own Mark gone does. */
export interface PlatformDispositions {
  /** All or nothing: refuses before writing when the kind cannot retire or a
   *  record is missing. `quiet` leaves out the per-record activity line, for a
   *  caller that writes one line for the whole batch. */
  markGone(
    orgId: string,
    userId: string | null,
    kind: string,
    ids: readonly string[],
    details: { how: Disposition; on?: string | null; price?: number | null; to?: string | null; note?: string | null },
    opts?: { quiet?: boolean },
  ): Promise<{ ok: true; done: Array<{ id: string; title: string }> } | { ok: false; error: string }>;
  bringBack(
    orgId: string,
    userId: string | null,
    kind: string,
    ids: readonly string[],
    opts?: { quiet?: boolean },
  ): Promise<{ ok: true; done: Array<{ id: string; title: string }> } | { ok: false; error: string }>;
}

export interface HistoryWriter {
  /** The owning module's row table, for predicates applied before paging. */
  table?: string;
  snapshotDeletion?(orgId: string, id: string): Promise<DeletionSnapshot | null>;
  restoreDeletion?(orgId: string, snapshot: DeletionSnapshot): Promise<void>;
  snapshot(orgId: string, id: string): Promise<Record<string, unknown> | null>;
  restore(orgId: string, image: Record<string, unknown>): Promise<void>;
}

export interface PlatformActivity {
  registerHistoryWriter(kind: string, writer: HistoryWriter): void;
  log(p: ActivityLogParams): Promise<void>;
  /** The rows of one bulk write (an import), one INSERT per chunk: each
   *  record's History gets its line, and the feeds show only the write's own
   *  summary entry, which the caller logs as usual (#5963). */
  logMany(p: { orgId: string; userId?: string | null; rows: ReadonlyArray<{ action: string; ref: ActivityLogParams["ref"]; diff?: Record<string, unknown> }> }): Promise<void>;
  /** The name each record of a kind was CREATED with, from its creation entry
   *  in the log, for the records whose creation name matches `pattern` (a
   *  case-insensitive regex). For a heal that needs to know what a record
   *  first said, since a heal's own rewrite is not an entry (#6303). A record
   *  whose entry is gone (retention) is not in the answer. */
  createdNamesMatching(orgId: string, p: { module: string; entityType: string; pattern: string; limit?: number }): Promise<Array<{ entityId: string; name: string }>>;
}

export type EventHandler = (payload: unknown) => void | Promise<void>;

export interface EventDelivery {
  /** Stable operation identity; consumers that move stock deduplicate it. */
  id: string;
  completed: readonly string[];
  acknowledge(key: string): Promise<void>;
  /** A recipient refused for good: its action answered `final: true`, so the
   *  same call cannot succeed until a person acts (the record it names is
   *  gone). Set, the delivery is told here and goes on to the next recipient,
   *  so the caller can hand the question to a person instead of retrying it
   *  forever (#7407). Unset, a final refusal fails the delivery like any
   *  other. */
  refused?(key: string, message: string): Promise<void>;
}

export interface PlatformEvents {
  /** Emit an event. Returns a Promise that resolves once every direct
   *  subscriber registered via on() has run, in order, and then any
   *  wires (user-configured entity_action_bindings) for the event have
   *  finished firing. A caller can:
   *    • `await emit(...)` — read-after-write for subscribers AND
   *      wires; the response goes out after both have applied. Do this
   *      when anything after you depends on what a handler does: a
   *      ledger row an undo will void, a count a page will refetch.
   *    • `emit(...)` (no await) — fire-and-forget; both still run, the
   *      caller just doesn't wait. For notifications only.
   *  Normally failures are logged. With a durable delivery, failures reject,
   *  completed recipients are skipped and successes are acknowledged. The
   *  caller persists the delivery with its business change and retries it;
   *  recipients must tolerate replay after a commit before acknowledgement. */
  emit(eventName: string, payload: unknown, delivery?: EventDelivery): Promise<void>;
  /** Subscribe a handler to an event. The module name is captured
   *  for diagnostics — failures get logged with which module's
   *  handler threw. Handlers run inline when the event is emitted, so
   *  an awaiting emitter sees their effect; a handler whose work is slow
   *  (a network call, a render) schedules that work itself with
   *  setImmediate and returns, so the emitter is not made to wait. */
  on(eventName: string, module: string, handler: EventHandler): void;
}
