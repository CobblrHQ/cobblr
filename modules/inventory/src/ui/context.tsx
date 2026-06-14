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
  /** The module instance this UI is scoped to (undefined = default). */
  instance?: string;
  /** Presentation entity kind: `<instance>:item` when scoped, else
   *  "inventory:part". Drives field defs / overrides / saved views / custom
   *  fields so each instance shows ONLY its own fields. */
  entityKind: string;
  /** Singular noun for the add button + create modal ("yarn" → "New yarn").
   *  Falls back to "part". */
  itemNoun: string;
  /** Default unit for new items in this instance (e.g. "skein"). */
  qtyUnit?: string;
  /** When this instance's items belong to a parent "type" in another instance
   *  (e.g. a Spool → its Filament type), the create/edit forms show a parent
   *  picker and write an `instance-of` pairing. Seeded by the bundle. */
  parent?: ParentConfig;
  /** Route base for this UI — `/instances/<instance>` when scoped, else
   *  "/inventory". Row links + detail-close + create-navigate use it so the
   *  detail modal opens within the instance (and shows its fields). */
  basePath: string;
}

export interface ParentConfig {
  /** The instance the parent/type lives in (e.g. "filament-types"). */
  instance: string;
  /** Field label on the form, e.g. "Type". Defaults to "Type". */
  label?: string;
  /** Relationship kind for the pairing. Defaults to "instance-of". */
  relationship_kind?: string;
}

const Ctx = createContext<InventoryCtx | null>(null);

export function InventoryProvider({
  orgSlug,
  getToken,
  instance,
  itemNoun,
  qtyUnit,
  parent,
  children,
}: {
  orgSlug: string;
  getToken: () => string | null;
  instance?: string;
  itemNoun?: string;
  qtyUnit?: string;
  parent?: ParentConfig;
  children: ReactNode;
}) {
  const api = useMemo(
    () => new InventoryApi(orgSlug, { getToken, instance }),
    [orgSlug, getToken, instance],
  );
  const entityKind = instance ? `${instance}:item` : "inventory:part";
  const basePath = instance ? `/instances/${instance}` : "/inventory";
  return (
    <Ctx.Provider
      value={{ orgSlug, getToken, api, instance, entityKind, itemNoun: itemNoun ?? "part", qtyUnit, parent, basePath }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useInventory(): InventoryCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useInventory called outside InventoryProvider");
  return v;
}
