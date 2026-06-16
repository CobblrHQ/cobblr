// Thin fetch wrapper for the sales REST surface + a generic part lookup (for
// line items). Routes mount at /api/v1/orgs/:slug/modules/sales/...

export type SalesOrderStatus = "draft" | "confirmed" | "fulfilled" | "shipped" | "closed" | "cancelled";

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
}
export interface CustomerSummary extends Customer {
  order_count: number;
}

export interface SalesOrder {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  order_number: string | null;
  status: SalesOrderStatus;
  order_date: string | null;
  fulfilled_at: string | null;
  shipping_address: string | null;
  notes: string | null;
  created_at: string;
}

export interface SalesOrderItem {
  id: string;
  order_id: string;
  part_id: string | null;
  description: string | null;
  qty: string;
  unit_price: string | null;
}

export interface SalesOrderDetail extends SalesOrder {
  items: SalesOrderItem[];
  total: number;
}

export interface PartOption {
  id: string;
  title: string;
  subtitle?: string;
}

export class SalesApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class SalesApi {
  constructor(private readonly slug: string, private readonly getToken: () => string | null) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    const token = this.getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new SalesApiError(res.status, "non_json", `Non-JSON response (${res.status})`);
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new SalesApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
    }
    return parsed as T;
  }

  private req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return fetch(`/api/v1/orgs/${this.slug}/modules/sales${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => this.parse<T>(r));
  }

  // orders
  listOrders() { return this.req<{ items: SalesOrder[] }>("GET", "/orders"); }
  getOrder(id: string) { return this.req<SalesOrderDetail>("GET", `/orders/${id}`); }
  createOrder(body: Partial<SalesOrder>) { return this.req<SalesOrder>("POST", "/orders", body); }
  updateOrder(id: string, body: Partial<SalesOrder>) { return this.req<SalesOrder>("PATCH", `/orders/${id}`, body); }
  deleteOrder(id: string) { return this.req<void>("DELETE", `/orders/${id}`); }
  fulfillOrder(id: string) { return this.req<{ order: SalesOrder; decremented: Array<{ part_id: string; qty: number }> }>("POST", `/orders/${id}/fulfill`, {}); }
  addItem(orderId: string, body: { part_id?: string | null; description?: string | null; qty: number; unit_price?: number | null }) {
    return this.req<SalesOrderItem>("POST", `/orders/${orderId}/items`, body);
  }
  removeItem(orderId: string, itemId: string) { return this.req<void>("DELETE", `/orders/${orderId}/items/${itemId}`); }

  // customers
  listCustomers() { return this.req<{ items: CustomerSummary[] }>("GET", "/customers"); }
  createCustomer(body: Partial<Customer>) { return this.req<Customer>("POST", "/customers", body); }
  updateCustomer(id: string, body: Partial<Customer>) { return this.req<Customer>("PATCH", `/customers/${id}`, body); }
  deleteCustomer(id: string) { return this.req<void>("DELETE", `/customers/${id}`); }

  /** Generic kernel entity search — inventory parts for the line-item picker. */
  async searchParts(q: string): Promise<PartOption[]> {
    const url = `/api/v1/orgs/${this.slug}/entities/inventory:part?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const res = await fetch(url, { headers: this.headers() });
    const data = await this.parse<{ items: Array<{ id: string; title: string; subtitle?: string }> }>(res);
    return data.items.map((i) => ({ id: i.id, title: i.title, subtitle: i.subtitle }));
  }
}
