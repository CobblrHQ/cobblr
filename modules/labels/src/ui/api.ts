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
}

export interface Printable {
  description: string;
  qr_svg: string;
  /** Human-readable code drawn in the QR center (m1, p42, …), when assigned. */
  center_code?: string;
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
  prefix: string;
  label: string | null;
  count: number;
  frozen: boolean;
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
  removeFromQueue = (id: string) => this.request<void>("DELETE", `/queue/${id}`);
  print = () => this.request<PrintResponse>("POST", "/print", {});

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
  /** Every code group with its prefix + count, for the management panel. */
  listCodeGroups = () => this.request<{ groups: CodeGroup[] }>("GET", "/codes/groups");
  /** Rename a group's prefix (rejected once the group has printed codes). */
  renameCodePrefix = (groupKey: string, prefix: string) =>
    this.request<{ group_key: string; prefix: string }>(
      "PATCH",
      `/codes/groups/${encodeURIComponent(groupKey)}`,
      { prefix },
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
  listPrinters = () =>
    this.requestAbs<{ items: Array<{ id: string; name: string; is_default: boolean }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-print/printers`,
    );
  printToPrinter = (printerId: string, body: { document_base64: string; content_type?: string; filename?: string; job_name?: string }) =>
    this.requestAbs<{ jobId: string; state: string }>(
      "POST",
      `/api/v1/orgs/${this.slug}/modules/core-print/printers/${printerId}/print`,
      body,
    );

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
