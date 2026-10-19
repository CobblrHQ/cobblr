/** One owner per named job, across every api process sharing this database.
 *
 *  A module's periodic loop is started by EVERY api process, and this platform
 *  now runs more than one against a single database (the canary channel; a
 *  rolling deploy). An unguarded loop therefore does its side effects twice on
 *  real user data - which is how one workspace's printer posted its progress
 *  to Discord twice, every time, for weeks (2026-08-29).
 *
 *  `run` returns true when THIS process did the work and false when another
 *  process held the job. A false is the normal outcome, never an error.
 *
 *  It prevents CONCURRENT runs, which is not the same as "runs once": the
 *  loser's next tick may find the job free. Work that must not repeat has to
 *  claim what it acts on (compare-and-set the row, delete the bucket) inside
 *  the callback. */
/** What became of a run under the exclusive lock. Not a boolean on purpose:
 *  "someone else held it" is a normal answer for a timer tick and a wrong
 *  one to report as done to a person or a test, and a bare `false` was read
 *  as "nothing to do" (a Sync now that said "sent 0" while a change still
 *  waited). The caller says which it is (lint:exclusive-answer-read). */
export type ExclusiveRun = { ran: true } | { ran: false; heldElsewhere: true };

export interface PlatformExclusive {
  serial<T>(name: string, work: () => Promise<T>): Promise<T>;
  run(name: string, work: () => Promise<void>): Promise<ExclusiveRun>;
}

// ── Cross-tenant sweeps: one walk of the workspaces, one budget ─────────────
//
// Every self-healing or periodic pass used to walk all workspaces on its own
// timer with its own pool discipline; six of them started within minutes of
// boot on a box with 352 workspaces against a 100-connection Postgres and
// refused 811 connections in six hours (#3036). A pass registers here
// instead: the kernel walks the workspaces ONCE for every pass that is due,
// opens a workspace's pool at most once per visit, evicts it on the way out,
// bounds how many are open at a time, and spreads each pass's first visit
// over its cadence so nothing storms at boot.

/** What one visit of one pass reports. */
export interface TenantSweepVisitResult {
  /** This workspace still had a full page waiting: visit it again after
   *  `drainMs` rather than the full cadence. */
  backlog?: boolean;
  /** Stop this pass's walk here for this round (an engine said no; the rest
   *  of the round would be the burst again): no further workspace is
   *  started for it; visits already in flight under the budget finish.
   *  Other passes continue. */
  stop?: boolean;
  /** Anything the pass wants counted; `run()` hands every visit's value
   *  back, so a test or an admin door can total it. */
  [key: string]: unknown;
}

export interface TenantSweepPass {
  /** Unique across the process: `<module>.<pass>`. Also the advisory-lock
   *  name, so two api processes never walk the same pass at once. */
  name: string;
  /** How often each workspace is visited. */
  everyMs: number;
  /** While a visit reported a backlog, the next round comes after this
   *  instead of `everyMs` (a page a minute while there is work). */
  drainMs?: number;
  /** The first round comes this long after the scheduler starts instead of
   *  at a random point inside `everyMs`; for a pass whose first visit cannot
   *  wait a cadence (a boot-time discovery). */
  firstAfterMs?: number;
  /** Only workspaces with this module enabled. */
  module?: string;
  /** A meta-side gate: given the workspaces in scope, the ones worth opening
   *  a pool for this round, or null for all of them. Answering from what the
   *  process already knows costs zero tenant connections on a round with
   *  nothing to do (#3034). `named` is true when the caller asked for these
   *  workspaces by id (an operator or a test running the pass on one
   *  workspace): a gate that skips what it already visited must not skip a
   *  workspace somebody asked for. */
  candidates?: (orgIds: string[], opts: { named: boolean }) => Promise<string[] | null>;
  /** One workspace, its db open (a Kysely instance, cast to the module's
   *  schema). Throwing fails this visit only; the walk continues. */
  visit: (ctx: TenantSweepVisit) => Promise<TenantSweepVisitResult | void>;
  /** What a workspace needs from this pass the moment its `module` is
   *  enabled there, so it is born with it instead of waiting for its first
   *  round (docs/architecture/platform-spec.md §8.1, BORN WITH). Run once by enableModuleForOrg, with
   *  the workspace's db open. Keep it cheap: no network, no long work; set
   *  up state and leave the work to the rounds. Only a pass that names its
   *  `module` has an enable to hook, so a pass without one never runs this.
   *  At boot, reconcileDefaultModules can enable a module before its onBoot
   *  has registered the pass; such a workspace gets the state from the
   *  pass's first round instead, so this holds for enables after boot. */
  onEnable?: (ctx: TenantSweepVisit) => Promise<void>;
}

export interface TenantSweepVisit {
  orgId: string;
  db: unknown;
  now: Date;
}

export interface TenantSweepRunResult {
  /** Workspaces visited by this pass. */
  visited: number;
  /** Visits that threw (logged), and workspaces whose pool could not open. */
  failed: number;
  /** Any visit reported a backlog. */
  backlog: boolean;
  /** The pass stopped its walk early. */
  stopped: boolean;
  /** Every visit's value, in visit order. */
  results: Array<{ orgId: string; result: TenantSweepVisitResult | void }>;
  /** Another api process held the pass's lock; nothing ran. */
  skipped: boolean;
  /** Which workspaces failed and why, the first few: a visit that threw, or
   *  a pool that would not open. `failed` used to be a bare count nothing
   *  read, so a workspace failing every hour was silent for as long as it
   *  liked (#3350); /healthz reports the last round's from here. */
  failures: Array<{ orgId: string; message: string }>;
}

export interface PlatformSweeps {
  /** Register a pass. Idempotent by name (a re-registration replaces). */
  register(pass: TenantSweepPass): void;
  /** Run one pass now, over every workspace in its scope or the ones given,
   *  under its lock: the door for tests and admin routes. */
  run(name: string, opts?: { orgIds?: string[]; now?: Date }): Promise<TenantSweepRunResult>;
}
