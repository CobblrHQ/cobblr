/** One workspace's folder in the file store. */
export interface WorkspaceFolder {
  orgId: string;
  bytes: number;
  /** The newest write anywhere under it, ms since the epoch. */
  newestAt: number;
}

/** Multi-instance support hooks. A multi-instance module (inventory, assets,
 *  machines, …) registers a counter so the kernel can ask "how many primary
 *  items live in this (org, instance)?" without knowing the module's tables —
 *  used by the nav to hide an auto-created default instance that's empty once
 *  the workspace has named instances. */
/** A workspace's installed instance of a module — the org-scoped, user-named
 *  collection the navbar renders (e.g. machines → "3D Printers" + "Laser
 *  Cutters"). `is_default` marks the module's own auto-created instance
 *  (instance_name === module_name). `item_count` is the module's registered
 *  counter (null if it registered none). Lets a module enumerate what the
 *  workspace ACTUALLY has — enabled, instance-aware — instead of the global
 *  entity-kind registry. */
export interface InstanceInfo {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
  item_count: number | null;
}

/** How a module moves its own records between its own instances. Registering
 *  one is what makes "Move to..." appear for that module: a module that has
 *  not considered its instance-scoped foreign keys simply does not offer the
 *  action, which is the right default. */
export interface InstanceMoverContract {
  /** Flip the instance column for these ids and return the ids actually moved.
   *  MUST be a plain update. Never insert, never delete, never mint an id: the
   *  record keeps its uuid, which is what lets its printed QR label and every
   *  reference to it survive the move.
   *
   *  `db` is the platform's OPEN TRANSACTION on the tenant database, and the
   *  implementation must use it rather than fetching its own handle. Calling
   *  `tenants.getDb()` here would run the update on a different connection,
   *  outside the transaction, so a later failure would roll back the reference
   *  rewrites while leaving the records moved. */
  move(orgId: string, ids: string[], from: string, to: string, db: unknown): Promise<string[]>;
  /** The entity kind a record answers to in a given instance. Only the module
   *  knows its own default-instance rule (inventory's default is
   *  `inventory:part`; every named instance is `<instance>:item`). */
  kindFor(instance: string): string;
  /** The custom-field bag (`metadata`) of each of these records, so the move
   *  preview can say which values would render unlabeled in the target. Read
   *  through the module rather than the generic resolver because that projects
   *  fields through `exposableFields`, which can hide the very custom values
   *  this needs to count. */
  metadataFor(orgId: string, ids: string[]): Promise<Array<Record<string, unknown>>>;
  /** Which instance each of these records is in NOW.
   *
   *  Only the module knows where its own rows keep that, and without it a
   *  caller has to be TOLD the list a record is already in - which is asking a
   *  person to do the computer's arithmetic. "Put these in Tea" says
   *  everything that matters; the records know the rest.
   *
   *  Optional so a mover written before this keeps working: the platform then
   *  says it cannot work the source out and asks for it, rather than guessing. */
  instancesOf?(orgId: string, ids: string[]): Promise<string[]>;
}

export interface PlatformInstances {
  registerItemCounter(
    moduleName: string,
    counter: (orgId: string, instanceName: string) => Promise<number>,
  ): void;
  /** Opt this module into moving records between its instances. */
  registerMover(moduleName: string, mover: InstanceMoverContract): void;
  /** Every instance in the workspace (all enabled modules' default + named
   *  instances), each enriched with its item count. Org-scoped — only what
   *  this workspace has turned on. */
  list(orgId: string): Promise<InstanceInfo[]>;
  /** Shallow-merge a patch into an instance's platform-derived config — the
   *  meta-side `entity_kind_overrides` blob (target "instance",
   *  `<module>:<instance>`) that resolveInstance surfaces on req.instanceConfig.
   *  Read-modify-write, so existing keys (item_noun, qty_unit, the user's stock
   *  override) are preserved. Used for signals the PLATFORM latches on behalf of
   *  a module — e.g. inventory writing `stock_latched: true` the first time an
   *  instance shows stock data, so the sticky stock face survives a drain-to-zero
   *  and instance-kind synthesis can read the verdict without a tenant pool.
   *  See one-record-substrate.md. Creates the override row if absent. */
  patchDerivedConfig(
    orgId: string,
    moduleName: string,
    instanceName: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
  /** One instance's config as its module sees it on a request
   *  (req.instanceConfig): the instance row's config under the presentation
   *  override its bundle wrote (item noun, qty unit, `parent`). For work
   *  outside a request, like a boot heal. Null when there is no such instance. */
  configOf(orgId: string, instanceName: string): Promise<Record<string, unknown> | null>;
}
