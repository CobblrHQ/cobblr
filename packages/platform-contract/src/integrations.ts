// ── sync connectors (mirror external records into Cobblr entities) ──
// The typed runtime the sync engine drives. A declarative / AI-authored
// manifest layer can later compile down to this same shape.

export interface SyncFetchContext {
  orgId: string;
  baseUrl: string;
  credentials: Record<string, unknown>;
  /** SSRF-guarded fetch injected by the engine — use this, not global fetch. */
  fetch: typeof fetch;
}

export interface SyncRecord {
  externalId: string;
  parentExternalId?: string | null;
  fields: Record<string, unknown>;
  deleted?: boolean;
  /** Cross-section references: a target field that points at ANOTHER synced
   *  entity by its external id (e.g. a machine's location_id → a location). The
   *  engine resolves each through that section's id-map to the mirrored Cobblr
   *  entity id before writing — null if that entity hasn't been imported yet. */
  references?: Record<string, { section: string; externalId: string }>;
  /** Image fields to pull across: a target field (e.g. "image_path") → the source
   *  URL/path of an image. The engine fetches each (through the edge bridge),
   *  stores the bytes in core-files, and sets the field to the served file URL.
   *  Relative paths are resolved against the source base. */
  images?: Record<string, string>;
  /** Tag names to attach to the mirrored entity (by name; created if missing).
   *  Additive: a tag absent here is never detached. */
  tags?: string[];
  /** The record is ONE card kept in several places: the source's own rows of
   *  stock (Part-DB's lots), already grouped by place. The record's fields and
   *  location are the card's own row; each of these is another place, written
   *  as a record of the same kind paired `holding-of` to the card. Present
   *  (even empty) means the source speaks for the card's places: a place no
   *  longer listed is retired. Absent means the source says nothing about them. */
  holdings?: SyncHolding[];
  /** Per-record target instance (multi-instance modules) — the section's
   *  `instanceBy` routes each row to an instance by a field value, so ONE section
   *  fans a single endpoint out to several instances. Overrides the section's
   *  static `targetInstance` when set. */
  instance?: string | null;
}

/** One more place a card is kept. */
export interface SyncHolding {
  /** Stable across syncs: the source's id of the first stock row in this place. */
  externalId: string;
  qty: number;
  /** Where it is kept, a reference into another section like `references`. */
  location?: { section: string; externalId: string } | null;
  /** The source's own stock rows that make up this place, for the record's history. */
  rows: string[];
}

export interface SyncEntityType {
  key: string;
  label: string;
  targetKind: string;
  /** Where the source's own id lands on the target record (a column, or a key
   *  inside `metadata`), when the mapping stores it. The engine uses it to
   *  ADOPT a record that already carries that id, one made by hand or by an
   *  assistant before the sync ran, instead of creating a second one (#3836).
   *  A declarative source derives it from its map; absent means no adoption. */
  keyField?: { field: string; metadata: boolean } | null;
  /** The source's display name ("My Shop"), for the activity rows the sync
   *  writes ("via automation “My Shop sync”"). Falls back to the connector id. */
  sourceLabel?: string | null;
  /** For a multi-instance target module: the instance slug to write into (e.g.
   *  "3d-printers"), so imported rows land under that instance's nav entry rather
   *  than the base. The engine passes it to the writer as the `instance` field. */
  targetInstance?: string | null;
  fetchAll: (ctx: SyncFetchContext) => Promise<SyncRecord[]>;
  fetchOne?: (ctx: SyncFetchContext, externalId: string) => Promise<SyncRecord | null>;
  /** Fetch a binary asset (image) from the source through the same transport as
   *  fetchAll — used by the engine to pull `SyncRecord.images` across. Returns the
   *  raw bytes + mime type, or null on any non-2xx / empty body. */
  fetchBinary?: (ctx: SyncFetchContext, urlOrPath: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

export interface SyncWebhookHit {
  entityType: string;
  externalId: string;
  deleted?: boolean;
  record?: SyncRecord;
}

export interface SyncConnector {
  id: string;
  label: string;
  describeCredentials: () => Record<string, { label: string; secret: boolean }>;
  describeConfig?: () => Record<string, { label: string; placeholder?: string }>;
  entityTypes: SyncEntityType[];
  testConnection?: (ctx: SyncFetchContext) => Promise<{ ok: boolean; error?: string }>;
  parseWebhook?: (
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ) => SyncWebhookHit | null;
}

/** What a reconcile WOULD do to one source record, computed without writing —
 *  the unit of an import preview. 'link' = merge into an existing same-name
 *  Cobblr entity instead of creating a duplicate. */
export interface ImportPlanItem {
  externalId: string;
  name: string;
  /** "ask": the source record could be more than one existing record, or one
   *  that is only nearly the same name; nothing is created or linked until a
   *  person says which (`candidates`). */
  action: "create" | "update" | "link" | "unchanged" | "delete" | "ask";
  /** The existing Cobblr entity this row touches (link / update / delete). */
  cobblrId?: string | null;
  /** The mapped source fields this row would WRITE — what data comes over. */
  fields?: Record<string, unknown>;
  /** For link/update/delete: the existing Cobblr entity, so the preview can show
   *  the match both-sides (its name + current fields, when the writer can read). */
  match?: { id: string; name: string; fields?: Record<string, unknown> | null } | null;
  /** For update/link: each field the two sides disagree about and what the
   *  section's rule does with it (sync-merge.ts): write the source's value,
   *  keep Cobblr's, or ask. */
  changes?: Array<{ field: string; ours: unknown; theirs: unknown; decision: "write" | "keep" | "ask" }>;
  /** For ask: the existing records it might be. */
  candidates?: Array<{ id: string; name: string }>;
  /** How many more places this record will be kept in, beside its own row. */
  holdings?: number;
}

export interface ImportPlan {
  entityType: string;
  targetKind: string;
  counts: {
    create: number;
    update: number;
    link: number;
    unchanged: number;
    delete: number;
    total: number;
    /** Source records that could be more than one existing record. */
    ask?: number;
  };
  /** The rule the plan was made under: "cobblr", "source" or "ask". */
  policy?: string;
  items: ImportPlanItem[];
}

export interface InboundHandlerContext {
  orgId: string;
  inboundRowId: string;
  config: Record<string, unknown>;
  /** Emits in the token's workspace. The platform supplies orgId, overriding
   *  any orgId in the handler's event fields. */
  emit: (eventName: string, payload: Record<string, unknown>) => Promise<void>;
}

export interface PlatformIntegrations {
  /** Register an outbound connector. */
  registerConnector(c: {
    id: string;
    label: string;
    describeCredentials: () => Record<string, { label: string; secret: boolean }>;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json"; required?: boolean; oneOf?: string }>;
      undoable?: boolean;
    }>;
    invoke: (
      ctx: {
        orgId: string;
        connectorId: string;
        rowId: string;
        credentials: Record<string, unknown>;
        args: Record<string, unknown>;
        rendered?: string;
        event?: { name: string | null; payload: Record<string, unknown> };
        /** Stable across every try of one send: a connector whose remote dedupes
         *  by a key sends it, so a retry cannot deliver twice. */
        idempotencyKey?: string;
      },
      actionId: string,
    ) => Promise<unknown>;
    testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  }): void;
  /** Register an inbound webhook handler. */
  registerInboundHandler(h: {
    id: string;
    label: string;
    describeWebhookConfig: () => Record<string, { label: string; secret: boolean }>;
    emits: string[];
    handle: (
      req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
      ctx: InboundHandlerContext,
    ) => Promise<{ status: number; body?: unknown }>;
  }): void;
  /** Register a SYNC connector — mirrors external records into a Cobblr
   *  entity kind. The typed runtime the sync engine drives. */
  registerSyncConnector(c: SyncConnector): void;
  /** Resolve a registered sync connector by id (the engine needs its live
   *  fetch fns), or null. */
  getSyncConnector(id: string): SyncConnector | null;
  /** List registered sync connectors for the "Add connection" picker
   *  (metadata only — no live fns). */
  listSyncConnectors(): Array<{
    id: string;
    label: string;
    credentials: Record<string, { label: string; secret: boolean }>;
    config: Record<string, { label: string; placeholder?: string }>;
    entityTypes: Array<{ key: string; label: string; targetKind: string }>;
  }>;
  /** List registered outbound connectors. Used by the connector
   *  catalogue endpoint to render the "Add connector" picker. */
  listConnectors(): Array<{
    id: string;
    label: string;
    credentials: Record<string, { label: string; secret: boolean }>;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json"; required?: boolean; oneOf?: string }>;
      undoable?: boolean;
    }>;
  }>;
  /** List registered inbound handlers. */
  listInboundHandlers(): Array<{
    id: string;
    label: string;
    config: Record<string, { label: string; secret: boolean }>;
    emits: string[];
  }>;
  /** Resolve a registered connector by id, or null. Modules use this
   *  to validate a user-supplied connector_id before persisting. */
  getConnector(id: string): {
    id: string;
    label: string;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json"; required?: boolean; oneOf?: string }>;
      undoable?: boolean;
    }>;
    testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  } | null;
  /** Encrypt credentials with the per-org master key. */
  encryptCredentials(orgId: string, plaintext: Record<string, unknown>): Promise<string>;
  /** Decrypt credentials with the per-org master key. */
  decryptCredentials(orgId: string, ciphertext: string): Promise<Record<string, unknown>>;
  /** Invoke a registered connector. Returns the connector's result,
   *  or throws on failure. Audit logging is the caller's
   *  responsibility — the platform layer is intentionally stateless
   *  here so per-workspace audit rows live in the module's tenant
   *  DB. */
  invokeConnector(
    connectorId: string,
    ctx: {
      orgId: string;
      rowId: string;
      credentials: Record<string, unknown>;
      args?: Record<string, unknown>;
      rendered?: string;
      event?: { name: string | null; payload: Record<string, unknown> };
      idempotencyKey?: string;
    },
    actionId: string,
  ): Promise<unknown>;
  /** Dispatch a request to a registered inbound handler. Used by
   *  the unauthenticated webhook receiver. */
  dispatchInbound(
    handlerId: string,
    req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
    ctx: {
      orgId: string;
      inboundRowId: string;
      config: Record<string, unknown>;
      emit: (eventName: string, payload: unknown) => Promise<void>;
    },
  ): Promise<{ status: number; body?: unknown }>;
}
