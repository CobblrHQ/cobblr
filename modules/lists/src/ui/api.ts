// Thin fetch wrapper for the lists REST surface. Auth via getToken().
// Routes are mounted at /api/v1/orgs/:slug/modules/lists/...

import { describeUnreadableBody } from "@cobblr/platform-web";

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
  /** Who said they'd get this. The name is snapshotted server-side at claim
   *  time so a line stays readable without a membership lookup. */
  claimed_by: string | null;
  claimed_by_name: string | null;
  claimed_at: string | null;
  created_at: string;
  /** Set by the add-item wire when a line came from another entity (e.g. an
   *  inventory part that ran low). Drives the "from inventory" provenance badge
   *  and is what closes the buy→restock loop on check-off. */
  metadata?: { source_ref?: { kind?: string; id?: string } } | null;
  /** What checking this line off will do: the wires that fire on its source
   *  record, from the kernel. Absent on a line with no source, or once checked. */
  on_check?: CheckEffect[];
  /** What the restock will stamp on the record: bought today, good until a
   *  date when the item declares a shelf life. Absent when checking off adds
   *  to a stocked record without dating it. */
  will_date?: { on: string; until: string | null } | null;
}

export interface CheckEffect {
  binding_id: string;
  action_id: string;
  action_label: string | null;
  source_kind: string;
  args: Record<string, unknown> | null;
}

/** The amount a restock effect will add, when one is among the effects. */
export function restockAmount(effects: CheckEffect[] | undefined): number | null {
  for (const e of effects ?? []) {
    const d = e.args?.delta;
    if (/:adjust-stock$/.test(e.action_id) && typeof d === "number" && d > 0) return d;
  }
  return null;
}

/** A numeric line quantity ("3", "3 boxes"), or null when the line does not say. */
export function lineQuantity(qty: string | null | undefined): number | null {
  const m = /^\s*(\d+)/.exec(qty ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
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
    // TEXT first: res.json() CONSUMES the body, so once it throws the one
    // thing that says what went wrong is gone. See describeUnreadableBody.
    const raw = await res.text();
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ListsApiError(res.status, "non_json", describeUnreadableBody(res.status, raw));
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
  toggleItem(id: string, checked: boolean, quantity?: number) {
    return this.req<ListItem>("PATCH", `/items/${id}`, { checked, ...(checked && quantity ? { quantity } : {}) });
  }
  claimItem(id: string, claimed: boolean) {
    return this.req<ListItem>("PATCH", `/items/${id}`, { claimed });
  }
  removeItem(id: string) {
    return this.req<void>("DELETE", `/items/${id}`);
  }
}

/** "dated today, good until 22 Sep" for the row, or null when nothing is dated. */
export function willDatePhrase(w: { on: string; until: string | null } | null | undefined, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!w) return null;
  const on = w.on === today ? "today" : w.on;
  if (!w.until) return `dated ${on}`;
  const d = new Date(`${w.until}T00:00:00Z`);
  const until = Number.isNaN(d.getTime()) ? w.until : d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return `dated ${on}, good until ${until}`;
}
