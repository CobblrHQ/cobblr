import type { MoneyTotal } from "@cobblr/platform-contract/money";
import { walkPages } from "../list-pages";
import { primaryBase, request } from "./client";
import type { Edit } from "@cobblr/platform-web";

export interface Asset {
  id: string;
  name: string;
  short_name: string | null;
  manufacturer: string | null;
  model: string | null;
  type: string | null;
  state: string;
  excitement: number;
  quantity: number;
  /** Absent (the key is not there) for a viewer without `assets:view-serials`:
   *  the screen shows the field only when it is present. */
  serial_number?: string | null;
  purchased_at: string | null;
  /** What it cost, in cents. */
  purchase_price_cents?: number | null;
  /** Where it came from. */
  vendor?: string | null;
  /** When it was put away; null or absent while it is in the register. */
  archived_at?: string | null;
  warranty_until: string | null;
  last_service_at: string | null;
  image_path: string | null;
  notes: string | null;
  location_id: string | null;
  flags: unknown[];
  assigned_to_label?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const assetsApi = {

  // assets module (instance? scopes to /instances/:name/items)
  /** The register, every page; `archived` lists what is put away instead.
   *  `archived_count` is how many are put away either way. */
  listAssets: async (slug: string, instance?: string, opts: { archived?: boolean } = {}) => {
    let archived_count = 0;
    let paid_total_cents = 0;
    let money_total: MoneyTotal | undefined;
    const walked = await walkPages<Asset>(async (offset, limit) => {
      const page = await request<{ items: Asset[]; total?: number | null; complete?: boolean; archived_count?: number; paid_total_cents?: number; money_total?: MoneyTotal }>(
        "GET",
        `${primaryBase(slug, "assets/assets", instance)}?${opts.archived ? "archived=1&" : ""}offset=${offset}&limit=${limit}`,
      );
      archived_count = page.archived_count ?? archived_count;
      paid_total_cents = page.paid_total_cents ?? paid_total_cents;
      money_total = page.money_total || money_total;
      return page;
    });
    return { ...walked, archived_count, paid_total_cents, money_total };
  },
  getAsset: (slug: string, id: string, instance?: string) =>
    request<Asset>("GET", `${primaryBase(slug, "assets/assets", instance)}/${id}`),
  createAsset: (slug: string, body: Partial<Asset>, instance?: string) =>
    request<Asset>("POST", primaryBase(slug, "assets/assets", instance), body),
  /** `edit` from editOf: only what changed, and what it was when the form opened (#7925). */
  updateAsset: (slug: string, id: string, edit: Edit<Asset>, instance?: string) =>
    request<Asset>("PATCH", `${primaryBase(slug, "assets/assets", instance)}/${id}`, edit.body, edit.headers),
  deleteAsset: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "assets/assets", instance)}/${id}`),
};
