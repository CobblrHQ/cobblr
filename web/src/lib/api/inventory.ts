import type { LaserRect } from "./digifab";
import { primaryBase, request } from "./client";
import { dayHere } from "@cobblr/platform-contract/day";
import type { StockDetail, StockView } from "@cobblr/inventory/ui";

/** One record at a place, as the place's own view reads it. */
export interface Stocktake {
  id: string;
  label: string;
  kept: Array<{ id: string; kind: string; title: string }>;
  gone: Array<{ id: string; kind: string; title: string }>;
  /** `unit`: what the amounts are in ("m", "each"), so they read as measures. */
  counted: Array<{ id: string; kind: string; title: string; before: number; after: number; unit: string }>;
  created_at: string;
  undone_at: string | null;
}

export interface StockPlaceRow {
  id: string;
  card_id: string | null;
  name: string;
  instance: string;
  kind: string;
  detail_path: string;
  location_id: string | null;
  location_name: string | null;
  qty: number;
  unit: string;
  min_qty: number | null;
  low: boolean;
  expires_on: string | null;
  lots: Array<{ received_on: string; expires_on: string; qty: number; lot?: string }>;
}
export interface StockAtPlace {
  location_id: string;
  today: string;
  items: StockPlaceRow[];
  low: number;
  expiring: number;
}
export interface StockExpiring {
  today: string;
  within: number;
  places: Array<{
    location_id: string | null;
    location_name: string | null;
    lots: Array<{ part_id: string; card_id: string | null; name: string; instance: string; kind: string; detail_path: string; qty: number; unit: string; lot: string | null; expires_on: string; days: number }>;
  }>;
}
export interface LaserSheet { id: string; name: string; spec: { width_mm: number; height_mm: number; material: string; thickness_mm: number }; revision: number; offcut: boolean; percent_left: number; free_rectangles: LaserRect[] }

export const inventoryApi = {

  // inventory module — just enough to count parts by location (the
  // /locations page needs it). Module-specific UI lives inside the
  // inventory module itself.
  listInventoryParts: (slug: string) =>
    request<{ items: Array<{ id: string; name: string; location_id: string | null }> }>(
      "GET",
      `/orgs/${slug}/modules/inventory/parts`,
    ),
  // A thing kept in several places (#3798): its places move through the
  // holdings door, which writes the ledger and the activity. `instance` is the
  // collection the card lives in ("inventory" for the base one).
  holdingTransfer: (slug: string, instance: string, holdingId: string, body: { to_location_id: string; qty: number; via?: string }) =>
    request<{ from_id: string; to_id: string; qty: number }>(
      "POST",
      `${primaryBase(slug, "inventory/parts", instance === "inventory" ? undefined : instance)}/${holdingId}/transfer`,
      body,
    ),
  holdingAdd: (slug: string, instance: string, cardId: string, body: { location_id: string; qty: number; via?: string }) =>
    request<{ id: string }>("POST", `${primaryBase(slug, "inventory/parts", instance === "inventory" ? undefined : instance)}/${cardId}/holdings`, body),
  holdingsMoveAll: (slug: string, instance: string, cardId: string, body: { to_location_id: string; via?: string }) =>
    request<{ card_id: string; location_id: string; moved: Array<{ from_id: string; from_location_id: string | null; qty: number }>; retired: string[] }>("POST", `${primaryBase(slug, "inventory/parts", instance === "inventory" ? undefined : instance)}/${cardId}/move-all`, body),
  /** What the workspace keeps in files, and its limit (null: none). */
  /** What one place carries, across every collection (inventory's view). */
  /** One tap on a count at a place: the ledgered stock adjust on the record
   *  kept there (its own row, never its card), in whichever collection. */
  stockAdjustAt: (slug: string, instance: string, id: string, delta: number, reason?: string) =>
    request<{ id: string; qty: number | string }>(
      "POST",
      `${primaryBase(slug, "inventory/parts", instance === "inventory" ? undefined : instance)}/${id}/stock-adjust`,
      { delta, ...(reason ? { reason } : {}) },
    ),
  materialCost: (slug: string, kind: string, id: string) => request<{ items: Array<{ id: string; name: string; instance: string; grams: number; cost: { amount: number; currency: string } | null }> }>("GET", `/orgs/${slug}/modules/inventory/material-cost/${encodeURIComponent(kind)}/${id}`),
  /** One stocktake: what it kept, marked gone and counted, and whether it was undone. */
  stocktake: (slug: string, id: string) => request<Stocktake>("GET", `/orgs/${slug}/modules/inventory/stocktakes/${encodeURIComponent(id)}`),
  stockAt: (slug: string, locationId: string) =>
    request<StockAtPlace>("GET", `/orgs/${slug}/modules/inventory/stock/at/${locationId}?today=${dayHere()}`),
  laserSheets: (slug: string, body: { material: string; thickness_mm: number; width_mm: number; height_mm: number; rotate: boolean; offset: number; outline?: boolean }) => request<{ items: LaserSheet[]; total: number }>("GET", `/orgs/${slug}/modules/inventory/sheets/find?${new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))}`),
  listWorkshopStock: (slug: string, query: { q?: string; station?: string; offset?: number; shape?: StockView["shape"]; limit?: number } = {}) =>
    request<{ items: StockView[]; total: number | null; complete: boolean; loaded: Array<{ station: string; slot: string; part_id: string }> }>("GET", `/orgs/${slug}/modules/inventory/stock/shapes?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`),
  workshopStock: (slug: string, id: string) => request<StockDetail>("GET", `/orgs/${slug}/modules/inventory/stock/shapes/${id}`),
  loadWorkshopStock: (slug: string, id: string, body: { station: string; slot: string; loaded: boolean }) => request<unknown>("POST", `/orgs/${slug}/modules/inventory/stock/shapes/${id}/load`, body),
  /** The recounts still open, to choose one for a station to scan into. */
  openRecounts: (slug: string) => request<{ items: Array<{ id: string; label: string; updated_at: string }> }>("GET", `/orgs/${slug}/modules/inventory/recounts`),
};
