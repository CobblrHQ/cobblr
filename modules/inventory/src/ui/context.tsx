// Inventory UI context. Exposes the typed InventoryApi to all
// pages + the raw orgSlug + getToken so cross-module calls (e.g.
// building a LabelsApi client) can share the same auth context.

import {
  createContext, useContext, useMemo,
  type ReactNode,
} from "react";
import { InventoryApi } from "./api";

interface InventoryCtx {
  orgSlug: string;
  getToken: () => string | null;
  api: InventoryApi;
}

const Ctx = createContext<InventoryCtx | null>(null);

export function InventoryProvider({
  orgSlug,
  getToken,
  children,
}: {
  orgSlug: string;
  getToken: () => string | null;
  children: ReactNode;
}) {
  const api = useMemo(() => new InventoryApi(orgSlug, { getToken }), [orgSlug, getToken]);
  return <Ctx.Provider value={{ orgSlug, getToken, api }}>{children}</Ctx.Provider>;
}

export function useInventory(): InventoryCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useInventory called outside InventoryProvider");
  return v;
}
