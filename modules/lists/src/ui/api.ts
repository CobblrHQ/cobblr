// Thin fetch wrapper for the lists REST surface. Auth via getToken().
// Routes are mounted at /api/v1/orgs/:slug/modules/lists/...

export interface ListSummary {
  id: string;
  title: string;
  description: string | null;
  item_count: number;
  open_count: number;
  done_count: number;
  created_at: string;
}

export interface ListItem {
  id: string;
  list_id: string;
  title: string;
  note: string | null;
  qty: string | null;
  checked: boolean;
  checked_at: string | null;
  created_at: string;
  /** Set by the add-item wire when a line came from another entity (e.g. an
   *  inventory part that ran low). Drives the "from inventory" provenance badge
   *  and is what closes the buy→restock loop on check-off. */
  metadata?: { source_ref?: { kind?: string; id?: string } } | null;
}

export interface ListDetail {
  id: string;
  title: string;
  description: string | null;
  items: ListItem[];
}

export class ListsApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class ListsApi {
  constructor(private readonly slug: string, private readonly getToken: () => string | null) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`/api/v1/orgs/${this.slug}/modules/lists${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new ListsApiError(res.status, "non_json", `Non-JSON response (${res.status})`);
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new ListsApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
    }
    return parsed as T;
  }

  listLists() {
    return this.req<{ items: ListSummary[] }>("GET", "/lists");
  }
  getList(id: string) {
    return this.req<ListDetail>("GET", `/lists/${id}`);
  }
  createList(body: { title: string; description?: string }) {
    return this.req<ListSummary>("POST", "/lists", body);
  }
  deleteList(id: string) {
    return this.req<void>("DELETE", `/lists/${id}`);
  }
  clearDone(id: string) {
    return this.req<{ cleared: number }>("POST", `/lists/${id}/clear-done`, {});
  }
  addItem(listId: string, body: { title: string; note?: string; qty?: string }) {
    return this.req<ListItem>("POST", "/items", { ...body, list_id: listId });
  }
  toggleItem(id: string, checked: boolean) {
    return this.req<ListItem>("PATCH", `/items/${id}`, { checked });
  }
  removeItem(id: string) {
    return this.req<void>("DELETE", `/items/${id}`);
  }
}
