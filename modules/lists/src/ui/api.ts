// Thin fetch wrapper for the lists REST surface. Auth via getToken().
// Routes are mounted at /api/v1/orgs/:slug/modules/lists/...

import { dayHere } from "@cobblr/platform-contract/day";
import { describeUnreadableBody, noteWorkspaceWrite, waitingWritesToSend, workspaceFetch, type Edit } from "@cobblr/platform-web";
import { dayLabel } from "@cobblr/platform-contract/day";
import { parseLineAmount } from "../line-amount.js";

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
  /** Whether this promise belongs to the signed-in shopper. */
  claimed_by_me?: boolean;
  claimed_by_name: string | null;
  claimed_at: string | null;
  /** Set on the answer to a tick of a line someone else already bought (#8861). */
  already_bought_by?: string;
  created_at: string;
  /** Set by the add-item wire when a line came from another entity (e.g. an
   *  inventory part that ran low). Drives the "from inventory" provenance badge
   *  and is what closes the buy→restock loop on check-off. */
  metadata?: ({ source_ref?: { kind?: string; id?: string }; bought_by?: { id?: string; name?: string | null } | null } & Record<string, unknown>) | null;
  /** What checking this line off will do: the wires that fire on its source
   *  record, from the kernel. Absent on a line with no source, or once checked. */
  on_check?: CheckEffect[];
  /** What the restock will stamp on the record: bought today, good until a
   *  date when the item declares a shelf life. Absent when checking off adds
   *  to a stocked record without dating it. */
  will_date?: WillDate | null;
}

/** What checking the line off will stamp, and what it will leave alone. */
export interface WillDate {
  on: string;
  until: string | null;
  /** Stock already on the record, with the date it keeps; the record's
   *  visible expiry stays the earlier of the two. Absent when it is empty. */
  on_hand?: { qty: number; until: string | null };
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

/** A numeric line quantity ("3", "1.5", "3 boxes"), or null when the line does not say. */
export function lineQuantity(qty: string | null | undefined): number | null {
  return parseLineAmount(qty)?.value ?? null;
}

/** The unit the line's amount is written in ("kg" in "1 kg"), when it names one. */
export function lineUnit(qty: string | null | undefined): string | null {
  return parseLineAmount(qty)?.unit ?? null;
}

export interface ListDetail {
  id: string;
  title: string;
  description: string | null;
  metadata?: Record<string, unknown> | null;
  items: ListItem[];
}

export class ListsApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class ListsApi {
  constructor(private readonly slug: string, private readonly getToken: () => string | null) {}

  /** The items added to a list on this device that an earlier page left
   *  waiting (made offline, then the page reloaded): kept on the device and
   *  sent when it can, so the list shows them waiting until they land (#8675). */
  keptAdds(listId: string): string[] {
    const token = this.getToken();
    const path = `/orgs/${this.slug}/modules/lists/items`;
    return waitingWritesToSend(token ? `Bearer ${token}` : null).flatMap((w) => {
      const body = w.body as { list_id?: unknown; title?: unknown } | undefined;
      return w.method === "POST" && w.path.split("?")[0] === path && body?.list_id === listId && typeof body.title === "string" ? [body.title] : [];
    });
  }

  private async req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const url = `/api/v1/orgs/${this.slug}/modules/lists${path}`;
    const res = await workspaceFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const wrote = method.toUpperCase() !== "GET";
    if (res.status === 204) {
      if (wrote) noteWorkspaceWrite(url, res);
      return undefined as T;
    }
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
    if (wrote) noteWorkspaceWrite(url, res);
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
  /** A list's name or custom fields (merged into what it holds), corrected
   *  where they are read. `edit` from editOf (#7925). */
  updateList(id: string, edit: Edit<{ title?: string; metadata?: Record<string, unknown> }>) {
    return this.req<ListSummary>("PATCH", `/lists/${id}`, edit.body, edit.headers);
  }
  /** A line's words, how many, note or custom fields, corrected where they
   *  are read. `edit` from editOf (#7925). */
  updateItem(id: string, edit: Edit<{ title?: string; qty?: string; note?: string; metadata?: Record<string, unknown> }>) {
    return this.req<ListItem>("PATCH", `/items/${id}`, edit.body, edit.headers);
  }
  getItem(id: string) {
    return this.req<ListItem>("GET", `/items/${id}`);
  }
  removeItem(id: string) {
    return this.req<void>("DELETE", `/items/${id}`);
  }
}

/** "dated today, good until 22 Sep" for the row, or null when nothing is dated. */
export function willDatePhrase(w: WillDate | null | undefined, today = dayHere()): string | null {
  if (!w) return null;
  const on = w.on === today ? "today" : w.on;
  const fresh = w.until ? `dated ${on}, good until ${shortDate(w.until)}` : `dated ${on}`;
  // Some already on hand: the record's date stays the earlier one, and the
  // row says so rather than promising a date the record will not show yet.
  if (!w.on_hand || !(w.on_hand.qty > 0)) return fresh;
  const kept = w.on_hand.until ? `dated ${shortDate(w.on_hand.until)}` : "undated";
  return `${fresh}; ${w.on_hand.qty} already on hand, ${kept}, stays first`;
}

function shortDate(iso: string): string {
  return dayLabel(iso, { day: "numeric", month: "short" });
}
