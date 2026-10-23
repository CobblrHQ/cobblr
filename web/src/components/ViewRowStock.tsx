// The −/+ on a counted row, in every saved view of a collection that counts.
//
// A person looking at their pantry as a board, a list, a table or a gallery
// wanted to take one off the thing they had just used, and had to open it to
// do so; only the vending wall had a tap (#3884). A view is of ONE collection,
// so whether its rows are counted is one answer, the collection's stock face
// (the same fact that puts Use one on a record), read once per view. A row
// without a number to step (a lean catalog record, an item not yet counted)
// gets nothing. The step is the ledgered stock adjust on the record's own
// door, through the shared StockStepper, so a view steps the way a place's
// stock list does.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { withCount, type CountedRow } from "@cobblr/inventory/stock-derived";
import { useStillAsking, useFaces, useFieldPresentation, refreshAfterStockChange, useUnits } from "@cobblr/platform-web";
import { api, type ViewDataResponse } from "../lib/api";
import { fieldVal } from "../lib/view-group-key";
import { StockStepper } from "@cobblr/platform-web";
import { nounOptions, type NounChoiceDecl } from "@cobblr/platform-contract/kind-label";
import type { CountWords } from "@cobblr/platform-contract/plural";

/** The least a row must carry to be stepped. */
export interface StockableRow {
  id: string;
  title: string;
  fields?: Record<string, unknown>;
}

interface RowStock {
  /** Whether this view's collection counts, so a table can give it a column. */
  on: boolean;
  /** The stepper for one row, or nothing when the row has no count to step. */
  stepper: (row: StockableRow) => ReactNode;
}
const NONE: RowStock = { on: false, stepper: () => null };
const RowStockContext = createContext<RowStock>(NONE);

/** The stepper for a row of the view being shown, or nothing. */
export function useRowStock(): RowStock {
  return useContext(RowStockContext);
}

/** Where a collection's counts are stepped, when it counts: the instance whose
 *  door the adjust goes through. Null for anything that is not counted stock,
 *  and null until the answer is known, so nothing appears and then vanishes. */
export function useCountedCollection(slug: string, kind: string): { instance: string; countWords: CountWords[] } | null {
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });
  // The table's own words for what it counts in (Yarn: ball, skein, hank), so
  // a row's count reads "2 balls" and a stored "skeins" reads "1 skein".
  const overrides = useQuery({
    queryKey: ["entity-kind-overrides", slug],
    queryFn: () => api.listOverrides(slug),
    enabled: !!slug,
  });
  const { verdict } = useFaces(kind);
  return useMemo(() => {
    const k = (kinds.data?.items ?? []).find((x) => x.id === kind);
    if (!k || k.module_name !== "inventory") return null;
    if (!verdict?.faces.includes("stock")) return null;
    const instance = k.instance_name ?? "inventory";
    const o = (overrides.data?.items ?? []).find((x) => x.target_kind === "instance" && x.target_id === `inventory:${instance}`);
    const noun = (o?.config as { noun?: NounChoiceDecl } | undefined)?.noun;
    return { instance, countWords: noun?.of === "unit" ? nounOptions(noun) : [] };
  }, [kinds.data, overrides.data, kind, verdict]);
}

/** Whether the answer above is known yet: the kinds, the table's words and,
 *  for an inventory table, its faces have all answered (or failed). */
function useCountedKnown(slug: string, kind: string): boolean {
  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), enabled: !!slug });
  const overrides = useQuery({ queryKey: ["entity-kind-overrides", slug], queryFn: () => api.listOverrides(slug), enabled: !!slug });
  const faces = useFaces(kind);
  // How the table shows its fields decides what a row draws beside its name.
  const fields = useFieldPresentation(kind);
  const k = (kinds.data?.items ?? []).find((x) => x.id === kind);
  const inventory = !!k && k.module_name === "inventory";
  const asking = useStillAsking(kinds, overrides, fields, ...(inventory ? [faces] : []));
  return !asking;
}

export function RowStockProvider({ slug, kind, children }: { slug: string; kind: string; children: ReactNode }) {
  const counted = useCountedCollection(slug, kind);
  // A stepper drawn before the unit vocabulary is known is drawn again (the
  // measured form, then the counted one) and every cell beside it moves.
  const units = useUnits();
  const known = useCountedKnown(slug, kind) && (!counted || units.settled);
  const qc = useQueryClient();
  const stock = useMemo<RowStock>(() => {
    if (!counted) return NONE;
    const stepper = (row: StockableRow) => {
      const raw = fieldVal(row.fields, "qty");
      const qty = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
      if (!Number.isFinite(qty)) return null;
      const step = async (delta: number) => {
        const out = await api.stockAdjustAt(slug, counted.instance, row.id, delta);
        void refreshAfterStockChange(qc, [row.id]);
        const n = Number(out.qty);
        // The row is redrawn now, every figure its count feeds (Available,
        // low) with it, through the rules the list endpoint uses; the view
        // refetches when next asked, not on every tap of a wall of rows.
        qc.setQueriesData<InfiniteData<ViewDataResponse>>({ queryKey: ["view-data", slug] }, (data) =>
          data?.pages
            ? {
                ...data,
                pages: data.pages.map((pg) => ({
                  ...pg,
                  items: pg.items.map((it) =>
                    it.id === row.id && it.fields && "qty" in it.fields
                      ? { ...it, fields: withCount(it.fields as Record<string, unknown> & CountedRow, n) }
                      : it,
                  ),
                })),
              }
            : data,
        );
        void qc.invalidateQueries({ queryKey: ["view-data", slug], refetchType: "none" });
        return n;
      };
      return <StockStepper qty={qty} unit={(fieldVal(row.fields, "unit") as string | null | undefined) ?? null} countWords={counted.countWords} onStep={step} label={row.title} size="sm" />;
    };
    return { on: true, stepper };
  }, [counted, slug, qc]);
  // The rows wait for the answer: drawn before it, each counted row grew its
  // −/+ and its words a moment later, and every row below moved 28 to 88 px
  // under a finger (#7788).
  if (!known) return <div className="text-xs text-faint">loading…</div>;
  return <RowStockContext.Provider value={stock}>{children}</RowStockContext.Provider>;
}
