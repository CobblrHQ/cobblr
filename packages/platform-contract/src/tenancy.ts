/** Tenant-DB accessor for background work that doesn't have a
 *  request context (event handlers, scheduled jobs, etc.). The
 *  returned value is a Kysely instance — typed loosely here so the
 *  platform-contract doesn't need to know about every module's
 *  schema. Callers cast to their own schema type. */
/** What a module may know about a workspace without touching cobblr_meta
 *  itself. Added for the hosted identify scope: the allowance had to answer
 *  "is this workspace the yarn app?" and a module has no other way to ask. */
export interface PlatformOrgInfo {
  /** The workspace calendar zone, fixed independently of a reader travelling. */
  time_zone?: string | null;
  id: string;
  slug: string;
  accent?: string | null;
  /** The managed app this workspace is locked into, or null for a platform
   *  workspace. Mirrors `orgs.app_mode`. */
  app_mode: { app: string; home_path: string; label?: string } | null;
}
export interface PlatformOrgs {
  get(orgId: string): Promise<PlatformOrgInfo | null>;
}

export interface PlatformTenants {
  getDb(orgId: string): Promise<unknown>;
  /** Release this tenant's connection pool — but ONLY if it currently has
   *  no checked-out clients (all connections idle, none waiting). The pool
   *  reopens lazily on the next `getDb`. No-op if the org has no cached pool.
   *
   *  For background jobs that sweep EVERY tenant on a tick (due-soon,
   *  recurrence, expiry): without this, each org's pool stays cached open
   *  with a live connection, so one tick holds one pool per tenant and a
   *  box with many tenants exhausts Postgres `max_connections` ("remaining
   *  connection slots are reserved for SUPERUSER"). Call it after finishing
   *  each org to keep the sweep's peak at ~one tenant pool. The idle guard
   *  makes it safe against concurrent request traffic — a pool a live
   *  request is mid-flight on is left untouched. */
  releaseIdleDb(orgId: string): Promise<void>;
  /** PREFER THIS for cross-tenant sweeps: runs `fn` with the tenant db, then
   *  releases the pool — immediately when nothing else touched it during the
   *  sweep (the common case), else once it has been quiet for the grace
   *  window. A bare getDb + releaseIdleDb pair could never release its own
   *  pool inside the grace window, so a sweep across N tenants held N pools
   *  and exhausted Postgres (staging, 2026-08-07). */
  withDb<T>(orgId: string, fn: (db: unknown) => Promise<T>): Promise<T>;
}

/** Cross-tenant DB access for the (small set of) modules that need
 *  to read or write platform-level tables (entity_action_bindings,
 *  wire_schedule_state, org_modules, etc.). Typed as `unknown` — the
 *  caller casts to a Kysely<schema> using a narrow structural type
 *  for just the tables it touches, same way `PlatformTenants.getDb`
 *  works for tenant DBs.
 *
 *  Modules touching this are limited: scheduler-style ("which wires
 *  fire when?"), platform observability ("what's enabled across all
 *  orgs?"). Day-to-day module work should stay on tenant DBs. */
export interface PlatformDb {
  meta: unknown;
  /** THE partial write to a record's jsonb bag (#3625): an expression to
   *  hand to an UPDATE's `.set({ [column]: … })` that sets the non-null keys
   *  and removes the null ones against the LIVE row, in one statement
   *  (@cobblr/platform-contract/jsonb-merge). Never read the bag, change it
   *  in JS and write it back: a concurrent edit in between is lost. */
  mergeJsonb(column: string, fields: Record<string, unknown>): unknown;
  /** A row's version, to select (`… as row_version`): Postgres's xmin, which
   *  every write to the row changes, by any path. With `atVersion` it makes a
   *  compare-and-set: read the version, decide, write only if it is the same. */
  rowVersion(): unknown;
  /** A WHERE condition: the row is still at this version. */
  atVersion(version: string): unknown;
}
