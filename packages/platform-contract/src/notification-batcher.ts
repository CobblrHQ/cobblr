// One message for one burst.
//
// Some things happen to a workspace in bunches. A shop is filed and thirty
// placements land in ten seconds; a task is finished and unblocks eight others
// at once. Code written for ONE of those is correct and reads well, and then a
// real workspace turns it into a stream of notifications nobody reads to the
// end. That happened twice in one morning from two different modules, both of
// which had reasoned carefully about a single item.
//
// The sweep version of this shape is caught at authoring time by
// `lint:dispatch-not-per-row` and fixed by collecting lines in the loop. This
// is the other half: an EVENT HANDLER that is individually correct, has no loop
// to collect in, and is only wrong in aggregate. It cannot see the burst it is
// part of, so something has to hold the beat for it.
//
// WHY IT LIVES IN THE CONTRACT. core-scan needed it first and grew its own; the
// third module needing the same thing (projects, whose task.unblocked fans out
// exactly this way) is the point at which two copies start to drift. The rule
// goes where all of them import it.
//
// The DOMAIN part stays with the module: how several warnings become one good
// sentence is a question only the module can answer, so `compose` is supplied
// by the caller. This owns the beat, the per-workspace grouping and the cap.

/** What a composed burst turns into. `null` from a compose means "say nothing",
 *  which is the honest answer when a batch turns out to be empty. */
export interface ComposedBurst {
  message: string;
  /** Anything at or below `normal` waits for a delivery window; `high` and
   *  above interrupt. Composing lets a batch decide once for the whole group -
   *  one frozen item in an otherwise ordinary batch is what earns the
   *  interruption, and it should not have to send its own message to get it. */
  priority?: "low" | "normal" | "high" | "urgent";
  /** How many things went into it, for the payload. */
  count: number;
  /** Where to send the reader. A batch of ONE is still about one thing and
   *  should open it; a batch spanning several has nowhere honest to point, so
   *  it points nowhere rather than at an arbitrary member of the group.
   *  Composed here rather than at the call site because only the compose knows
   *  whether the batch collapsed to one. */
  link_url?: string;
  /** The entity a batch of one is about, same reasoning as the link. */
  entityType?: string;
  entityId?: string;
}

type Compose<T> = (items: readonly T[]) => ComposedBurst | null;
type Send = (orgId: string, burst: ComposedBurst) => void | Promise<void>;

/**
 * Collect items per workspace and send one message per burst.
 *
 * Deliberately in memory and best-effort: a restart drops what is pending,
 * which is the right trade for a nudge - the alternative is a table and a
 * sweeper for something that is already advisory, and the underlying facts are
 * all still on the event bus and on the records themselves. This governs the
 * MESSAGE, nothing else.
 */
export class NotificationBatcher<T> {
  private readonly pending = new Map<string, T[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly compose: Compose<T>;
  private readonly send: Send;
  /** How long to wait for the rest of the burst to land. Seconds, not the
   *  morning digest: a burst is one action by one person, and the message
   *  should still feel like a response to it. */
  private readonly windowMs: number;
  /** A runaway loop must not build an unbounded list. */
  private readonly maxPerBatch: number;

  // Fields declared and assigned rather than written as constructor parameter
  // properties: this package is buildless, so plain Node loads it by STRIPPING
  // types with no transform, and a parameter property needs one.
  // `lint:node-resolves` fails the build on it.
  constructor(compose: Compose<T>, send: Send, windowMs = 20_000, maxPerBatch = 50) {
    this.compose = compose;
    this.send = send;
    this.windowMs = windowMs;
    this.maxPerBatch = maxPerBatch;
  }

  add(orgId: string, item: T): void {
    const list = this.pending.get(orgId) ?? [];
    if (list.length < this.maxPerBatch) list.push(item);
    this.pending.set(orgId, list);

    // Restart the clock on every arrival. Flushing on the FIRST item would send
    // one message and then a stream of singletons behind it - exactly what this
    // exists to stop.
    const existing = this.timers.get(orgId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => void this.flushNow(orgId), this.windowMs);
    // Never hold the process open for a nudge.
    if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
    this.timers.set(orgId, t);
  }

  /** Send whatever has accumulated for one workspace. Exposed for tests, and
   *  for a shutdown path that would rather send early than not at all. */
  async flushNow(orgId: string): Promise<void> {
    const list = this.pending.get(orgId) ?? [];
    this.pending.delete(orgId);
    const t = this.timers.get(orgId);
    if (t) clearTimeout(t);
    this.timers.delete(orgId);
    const burst = this.compose(list);
    if (burst) await this.send(orgId, burst);
  }

  /** Whether anything is waiting - a test wants to know without flushing. */
  pendingCount(orgId: string): number {
    return this.pending.get(orgId)?.length ?? 0;
  }
}
