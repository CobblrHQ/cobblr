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
}

export interface PrintResponse {
  batch_id: string;
  count: number;
  printables: Printable[];
}

/** A labelable entity kind — one tab in the browser. */
export interface LabelableKind {
  kind: string;
  label: string;
  icon: string | null;
  count?: number;
}

/** One row inside a tab — everything a queue-add needs, nothing more. */
export interface LabelableItem {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  image_path: string | null;
  detail_url: string | null;
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
  removeFromQueue = (id: string) => this.request<void>("DELETE", `/queue/${id}`);
  print = () => this.request<PrintResponse>("POST", "/print", {});

  /** Browse — the kinds that support labels (the tabs) and their rows. */
  listLabelableKinds = () =>
    this.request<{ kinds: LabelableKind[] }>("GET", "/browse/kinds");
  listLabelableItems = (kind: string, opts?: { q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.q) p.set("q", opts.q);
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.offset) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return this.request<{ items: LabelableItem[]; total?: number }>(
      "GET",
      `/browse/kinds/${encodeURIComponent(kind)}/items${qs ? `?${qs}` : ""}`,
    );
  };

  /** Render the queue to a print-ready PDF (server-side, pdf-lib). */
  renderPdf = (size_key: string, item_ids?: string[]) =>
    this.request<{ pdf_base64: string; sheets: number; labels: number }>(
      "POST",
      "/print/render",
      { size_key, item_ids },
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
}
