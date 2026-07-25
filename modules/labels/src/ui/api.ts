// Labels module client. Exposed alongside the UI so other modules
// (inventory's web UI) can import + call it directly.

export interface QueueItem {
  id: string;
  user_id: string | null;
  module_name: string;
  entity_type: string;
  entity_id: string;
  qr_payload: string;
  description: string;
  qty: number;
  created_at: string;
  /** The source entity's current system title, resolved live (instance-aware).
   *  The caption's "revert to system name" target; null when the entity is gone. */
  stock_title?: string | null;
  /** The entity's INSTANCE-AWARE kind name ("3D Printers"), for the row prefix —
   *  so a machine filed under a named instance reads as its instance, not the raw
   *  `machines/machine`. Null falls the row back to `module_name/entity_type`. */
  kind_label?: string | null;
}

export interface Printable {
  description: string;
  qr_svg: string;
  /** Human-readable code drawn in the QR center (m1, p42, …), when assigned. */
  center_code?: string;
  /** Data modules per side of this item's QR symbol (QRCode.create().modules.size).
   *  Set by the preview builder so the physical-scannability read (module size at
   *  the printed dimensions) needs no re-encoding. Optional: producers that don't
   *  compute it leave the verdict hidden. */
  qr_modules?: number;
}

/** A workspace-defined label size. Dimensions in inches; cols/rows/per_sheet are
 *  derived server-side (deriveGrid) and returned for display. */
export interface CustomLabelSize {
  id: string;
  name: string;
  media_w: number;
  media_h: number;
  label_w: number;
  label_h: number;
  margin_t: number;
  margin_l: number;
  col_gap: number;
  row_gap: number;
  cols: number;
  rows: number;
  per_sheet: number;
}

export type FireMode = "manual" | "fill-media" | "count" | "immediate";

/** Per-user accumulate-then-print policy (server-side, CUPS/edge). */
export interface AutoflushConfig {
  enabled: boolean;
  printer_id: string | null;
  size_key: string | null;
  fire_mode: FireMode;
  fire_count: number;
  /** Bluetooth printers fire from the browser (slice 3c); the server skips them. */
  client_fired?: boolean;
}

export interface CustomSizeInput {
  name: string;
  media_w: number;
  media_h: number;
  label_w: number;
  label_h: number;
  margin_t?: number;
  margin_l?: number;
  col_gap?: number;
  row_gap?: number;
}

export interface PrintResponse {
  batch_id: string;
  count: number;
  printables: Printable[];
}

/** A code group: the thing that owns a prefix + number line. */
export interface CodeGroup {
  group_key: string;
  entity_kind: string;
  /** null = the list is opted out of a code (no prefix, letter freed). Blank the
   *  prefix + Save to clear it; type one + Save to re-enable. */
  prefix: string | null;
  label: string | null;
  count: number;
  frozen: boolean;
  /** The owning kind's display name ("Machines"), resolved from the registry. */
  kind_label: string;
  /** This group's own display name: the named instance ("3D Printers"), the
   *  grouping field value, or the kind name when the group is the whole kind. */
  group_label: string;
  /** Effective "draw the code in the QR center" for THIS group (its own override,
   *  else the kind default). Per-group, so 3d printers can differ from cnc. */
  overlay_center: boolean;
  /** True for a list that has no committed row yet: the prefix shown is a
   *  SUGGESTION (derived, not saved). Keep it (it commits on first print), Save it
   *  to lock it in, change it, or clear it to opt the list out before printing. */
  suggested?: boolean;
}

/** One tab in the browser — a labelable, non-empty INSTANCE the workspace
 *  actually has ("3D Printers", "Laser Cutters", "Parts"). `id` is the
 *  instance_name used to fetch its items. */
export interface LabelTab {
  id: string;
  label: string;
  count: number | null;
}

/** One row inside a tab — everything a queue-add needs, plus optional
 *  hierarchy info (`parent_id`/`section`/`position`) populated for kinds that
 *  carry it — locations — so the browser can render the same tree + area /
 *  container split, in the same order, as the real Locations page (via the
 *  shared buildLocationForest). Null for flat kinds. */
export interface LabelableItem {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  image_path: string | null;
  detail_url: string | null;
  parent_id?: string | null;
  section?: string | null;
  depth?: number | null;
  position?: number | null;
}

export class LabelsApi {
  constructor(
    private readonly slug: string,
    private readonly opts: { getToken: () => string | null },
  ) {}

  private base(): string {
    return `/api/v1/orgs/${this.slug}/modules/labels`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new Error(err?.message ?? `HTTP ${res.status}`);
    }
    return parsed as T;
  }

  listQueue = () => this.request<{ items: QueueItem[] }>("GET", "/queue");
  addToQueue = (b: {
    module_name: string;
    entity_type: string;
    entity_id: string;
    qr_payload: string;
    description: string;
    qty?: number;
  }) => this.request<QueueItem>("POST", "/queue", b);
  updateQueueQty = (id: string, qty: number) =>
    this.request<QueueItem>("PATCH", `/queue/${id}`, { qty });
  /** Rename a queued label's printed caption — trim a long title to a short name
   *  that fits the label. */
  renameQueueItem = (id: string, description: string) =>
    this.request<QueueItem>("PATCH", `/queue/${id}`, { description });
  removeFromQueue = (id: string) => this.request<void>("DELETE", `/queue/${id}`);
  print = () => this.request<PrintResponse>("POST", "/print", {});

  /** Workspace-defined label sizes (dimensions in; grid + per_sheet derived). */
  listCustomSizes = () => this.request<{ items: CustomLabelSize[] }>("GET", "/sizes");
  createCustomSize = (b: CustomSizeInput) => this.request<CustomLabelSize>("POST", "/sizes", b);
  deleteCustomSize = (id: string) => this.request<{ deleted: number }>("DELETE", `/sizes/${id}`);

  /** Accumulate-then-print policy (server-side auto-flush, CUPS/edge). */
  getAutoflush = () => this.request<AutoflushConfig>("GET", "/autoflush");
  setAutoflush = (b: AutoflushConfig) => this.request<AutoflushConfig>("PUT", "/autoflush", b);
  /** Bookkeeping for labels the BROWSER printed (Bluetooth): record them in
   *  history, freeze their codes, and drop just those rows from the queue. */
  recordPrinted = (item_ids: string[]) =>
    this.request<{ batch_id: string | null; recorded: number }>("POST", "/print/record", { item_ids });

  /** Browse — the labelable instances the workspace has (tabs) + their rows. */
  listLabelableTabs = () =>
    this.request<{ tabs: LabelTab[] }>("GET", "/browse/instances");
  listLabelableItems = (instanceId: string, opts?: { q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.q) p.set("q", opts.q);
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.offset) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return this.request<{ items: LabelableItem[]; total?: number }>(
      "GET",
      `/browse/instances/${encodeURIComponent(instanceId)}/items${qs ? `?${qs}` : ""}`,
    );
  };

  /** Render the queue to a print-ready PDF (server-side, pdf-lib). `warnings`
   *  flags any label whose center code would crowd the QR past scannable. */
  renderPdf = (size_key: string, item_ids?: string[]) =>
    this.request<{
      pdf_base64: string;
      sheets: number;
      labels: number;
      warnings?: Array<{ kind: string; code: string; reason: string; coveredFraction: number }>;
    }>("POST", "/print/render", { size_key, item_ids });

  // ── human-readable codes ────────────────────────────────────────────
  /** Get-or-assign codes for a batch of entity refs. */
  assignCodes = (refs: Array<{ kind: string; id: string }>) =>
    this.request<{ codes: Record<string, string> }>("POST", "/codes/assign", { refs });
  /** Resolve a typed/scanned code to its entity (tolerant of case + look-alikes). */
  resolveCode = (q: string) =>
    this.request<{ entity_kind: string; entity_id: string; code: string; title: string | null; detail_url: string | null }>(
      "GET",
      `/codes/resolve?q=${encodeURIComponent(q)}`,
    );
  /** The per-kind grain (which field groups codes) + whether the code is drawn
   *  in the QR center for this kind (default true). */
  getCodeConfig = (kind: string) =>
    this.request<{ entity_kind: string; group_field: string; overlay_center: boolean }>(
      "GET",
      `/codes/config?kind=${encodeURIComponent(kind)}`,
    );
  /** Patch a kind's grain and/or its QR-center toggle. Send only what changed. */
  setCodeConfig = (kind: string, patch: { group_field?: string; overlay_center?: boolean }) =>
    this.request<{ entity_kind: string; group_field: string; overlay_center: boolean }>(
      "PATCH",
      "/codes/config",
      { kind, ...patch },
    );
  /** Every code group with its prefix + count, for the management panel. Includes
   *  SUGGESTED groups (suggested:true) for labelable lists that have no code yet. */
  listCodeGroups = () => this.request<{ groups: CodeGroup[] }>("GET", "/codes/groups");
  /** Commit a SUGGESTED group's prefix — create its row before any print, so the
   *  suggestion is locked in. A blank prefix opts the list out of a code. The
   *  group_key encodes entity_kind|group_field|group_value, so we split it back
   *  into the pre-seed body. */
  seedGroup = (groupKey: string, prefix: string) => {
    const [entity_kind, group_field = "instance", group_value = ""] = groupKey.split("|");
    return this.request<{ group_key: string; prefix: string | null }>("POST", "/codes/groups", {
      entity_kind,
      group_field,
      group_value,
      prefix,
    });
  };
  /** Rename a group's prefix. Before anything is printed this rewrites existing
   *  codes; `keepExisting` is the override for a PRINTED group — existing codes
   *  (and their stickers) keep their old code, only new labels use the new prefix. */
  renameCodePrefix = (groupKey: string, prefix: string, keepExisting = false) =>
    this.request<{ group_key: string; prefix: string; kept_existing?: boolean }>(
      "PATCH",
      `/codes/groups/${encodeURIComponent(groupKey)}`,
      keepExisting ? { prefix, keep_existing: true } : { prefix },
    );
  /** Toggle whether THIS group's code prints inside the QR (per group, so two
   *  instances of one kind can differ). */
  setGroupOverlay = (groupKey: string, overlayCenter: boolean) =>
    this.request<{ group_key: string; overlay_center: boolean }>(
      "PATCH",
      `/codes/groups/${encodeURIComponent(groupKey)}/overlay`,
      { overlay_center: overlayCenter },
    );

  // core-print is a sibling module reached over HTTP (no import). Labels
  // renders the PDF; core-print dispatches it to the configured printer.
  private async requestAbs<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 204) return undefined as T;
    const parsed = await res.json().catch(() => null);
    if (!res.ok) throw new Error((parsed as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`);
    return parsed as T;
  }
  /** driver + settings matter here: a "browser-bluetooth" printer cannot be
   *  reached by the server, so this queue prints it from the browser instead,
   *  using the dialect + calibration stored on the connection. */
  listPrinters = () =>
    this.requestAbs<{
      items: Array<{
        id: string;
        name: string;
        is_default: boolean;
        driver: string;
        settings?: Record<string, unknown>;
      }>;
    }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-print/printers`,
    );
  /** Create a printer from the labels page, so a user connects one without leaving
   *  to Configuration. Used by the inline "Pair a Bluetooth printer" flow with
   *  profile-derived settings; the server validates them. core-print owns the
   *  printer registry and is opt-in, so enable it on demand the first time a
   *  workspace connects a printer (idempotent) — printing infra appears exactly
   *  when it is needed, not preemptively on every workspace. */
  createPrinter = async (b: { name: string; driver: string; settings?: Record<string, unknown>; is_default?: boolean }) => {
    await this.requestAbs("POST", `/api/v1/orgs/${this.slug}/modules/core-print/enable`, {});
    return this.requestAbs<{ id: string }>("POST", `/api/v1/orgs/${this.slug}/modules/core-print/printers`, b);
  };
  /** Edit a printer's name / media / layout from the labels page, so a user tunes
   *  the loaded media + "labels across" without a trip to Configuration. */
  updatePrinter = (id: string, b: { name?: string; settings?: Record<string, unknown> }) =>
    this.requestAbs<{ id: string }>("PATCH", `/api/v1/orgs/${this.slug}/modules/core-print/printers/${id}`, b);
  /** The full printer record (settings included) for the inline config panel. */
  getPrinter = (id: string) =>
    this.requestAbs<{ id: string; name: string; driver: string; is_default: boolean; settings?: Record<string, unknown> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-print/printers/${id}`,
    );
  printToPrinter = (printerId: string, body: { document_base64: string; content_type?: string; filename?: string; job_name?: string }) =>
    this.requestAbs<{ jobId: string; state: string }>(
      "POST",
      `/api/v1/orgs/${this.slug}/modules/core-print/printers/${printerId}/print`,
      body,
    );
  /** Forget a saved printer. Behind a confirm in the UI — the deliberate, destructive
   *  action, distinct from switching the session target to System print. */
  deletePrinter = (id: string) =>
    this.requestAbs<void>("DELETE", `/api/v1/orgs/${this.slug}/modules/core-print/printers/${id}`);

  // Queue a label the RIGHT way: mint (or reuse) a QR scan token via
  // the QR token endpoint and queue the full scan_url it hands back, so the label
  // encodes `<base>/qr/<token>` (honouring the workspace's custom label base
  // URL) instead of a bare `/entities/<kind>/<id>` path a phone can't open.
  // The QR endpoints live in this same module's api, reached over HTTP, same as
  // core-print above.
  queueLabelForEntity = async (b: {
    entity_kind: string; // e.g. "core-locations:location"
    entity_id: string;
    description: string;
    qty?: number;
  }): Promise<void> => {
    const q = `entity_kind=${encodeURIComponent(b.entity_kind)}&entity_id=${encodeURIComponent(b.entity_id)}`;
    let scanUrl: string | null = null;
    // Reuse an active token if one exists, to avoid littering the table on
    // repeated prints of the same thing.
    try {
      const list = await this.requestAbs<{ items: Array<{ scan_url: string; revoked_at: string | null }> }>(
        "GET",
        `/api/v1/orgs/${this.slug}/modules/labels/qr/tokens?${q}`,
      );
      scanUrl = list.items.find((t) => !t.revoked_at)?.scan_url ?? null;
    } catch {
      /* fall through to mint */
    }
    if (!scanUrl) {
      const m = await this.requestAbs<{ scan_url: string }>(
        "POST",
        `/api/v1/orgs/${this.slug}/modules/labels/qr/tokens`,
        { entity_kind: b.entity_kind, entity_id: b.entity_id, mode: "navigate", auth: "session" },
      );
      scanUrl = m.scan_url;
    }
    const [moduleName, entityType] = b.entity_kind.split(":");
    await this.addToQueue({
      module_name: moduleName ?? "unknown",
      entity_type: entityType ?? "entity",
      entity_id: b.entity_id,
      qr_payload: scanUrl,
      description: b.description,
      qty: b.qty,
    });
  };

  /** The workspace's custom label base URL (or null), read from the QR settings
   *  over HTTP. Used to rebuild queued labels' URLs live at preview time so a
   *  base-URL change is reflected without re-queuing. */
  qrLabelBaseUrl = () =>
    this.requestAbs<{ label_base_url: string | null }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/labels/qr/settings`,
    ).then((s) => s.label_base_url);
}
