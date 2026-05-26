// /bricklink — three BrickLink-format ingestion tools for a Lego
// workspace:
//   1. Wanted-list paste — parse a BL XML, see structured items.
//   2. Diff vs inventory — given a parsed wanted-list, bucket each
//      line as have / partial / need / unmatched against
//      inventory:part rows matched to the rebrickable-parts catalog.
//   3. Order CSV import — parse a BL order CSV into structured lines.
//
// All three are stateless on the server side; the user pastes, the
// API parses, the UI renders. A future commit-order action will
// take the parsed CSV lines + write inventory + purchases.

import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Diff, FileText, Upload } from "lucide-react";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

interface ParsedItem {
  item_type: "P" | "S" | "M" | "B" | "G" | "C" | "I" | "O";
  item_id: string;
  color_id: number;
  min_qty: number;
  max_price: number | null;
  condition: "N" | "U" | "A";
  remarks: string | null;
}

interface ParseWantedResponse {
  items: ParsedItem[];
  warnings: string[];
  counts: { items: number; parts: number; sets: number; minifigs: number };
}

interface DiffEntry {
  wanted: ParsedItem;
  status: "have" | "partial" | "need" | "no-catalog-match";
  total_in_stock: number;
  by_color: Record<string, number>;
  part_ids: string[];
  catalog_entry_id: string | null;
  catalog_name: string | null;
  color_satisfied: boolean | null;
}

interface DiffResponse {
  entries: DiffEntry[];
  counts: { have: number; partial: number; need: number; unmatched: number };
}

interface ParsedOrderLine {
  order_id: string | null;
  lot_id: string | null;
  item_id: string;
  item_type: ParsedItem["item_type"];
  color_id: number;
  condition: "N" | "U" | "A";
  qty: number;
  unit_price: number;
  line_total: number;
  description: string | null;
  remarks: string | null;
}

interface ParseOrderResponse {
  lines: ParsedOrderLine[];
  warnings: string[];
  summary: {
    line_count: number;
    parts: number;
    sets: number;
    total: number;
    order_id: string | null;
  };
}

const TYPE_LABEL: Record<ParsedItem["item_type"], string> = {
  P: "Part",
  S: "Set",
  M: "Minifig",
  B: "Book",
  G: "Gear",
  C: "Catalog",
  I: "Instructions",
  O: "Original Box",
};

const STATUS_STYLE: Record<DiffEntry["status"], string> = {
  have: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-700/40",
  partial: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-700/40",
  need: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-300 dark:border-rose-700/40",
  "no-catalog-match": "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700",
};

type Tab = "wanted" | "order";

export function BrickLinkPage() {
  usePageTitle("BrickLink");
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("wanted");

  // Wanted-list state.
  const [xml, setXml] = useState("");
  const [parsedWanted, setParsedWanted] = useState<ParseWantedResponse | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);

  // Order CSV state.
  const [csv, setCsv] = useState("");
  const [parsedOrder, setParsedOrder] = useState<ParseOrderResponse | null>(null);

  const parseWanted = useMutation({
    mutationFn: () =>
      api.request<ParseWantedResponse>(
        "POST",
        `/orgs/${activeSlug}/modules/bricklink-connector/parse-wanted-list`,
        { xml },
      ),
    onSuccess: (data) => {
      setParsedWanted(data);
      setDiff(null);
      const msg = `Parsed ${data.counts.items} items.`;
      data.warnings.length
        ? toast.success(`${msg} ${data.warnings.length} warning${data.warnings.length === 1 ? "" : "s"}.`)
        : toast.success(msg);
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't parse"),
  });

  const runDiff = useMutation({
    mutationFn: () =>
      api.request<DiffResponse>(
        "POST",
        `/orgs/${activeSlug}/modules/bricklink-connector/diff-wanted-list`,
        { items: parsedWanted!.items },
      ),
    onSuccess: (data) => {
      setDiff(data);
      const { have, partial, need, unmatched } = data.counts;
      toast.success(
        `Diff: ${have} have · ${partial} partial · ${need} need · ${unmatched} unmatched`,
      );
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't diff"),
  });

  const parseOrder = useMutation({
    mutationFn: () =>
      api.request<ParseOrderResponse>(
        "POST",
        `/orgs/${activeSlug}/modules/bricklink-connector/parse-order`,
        { csv },
      ),
    onSuccess: (data) => {
      setParsedOrder(data);
      toast.success(
        `Parsed ${data.summary.line_count} line${data.summary.line_count === 1 ? "" : "s"}` +
          (data.summary.order_id ? ` from order ${data.summary.order_id}` : "") +
          ".",
      );
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't parse CSV"),
  });

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          bricklink
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          import wanted lists + order csvs; diff a wanted list against
          your lego inventory. v0.2.
        </span>
      </div>

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
        <TabButton active={tab === "wanted"} onClick={() => setTab("wanted")}>
          Wanted list
        </TabButton>
        <TabButton active={tab === "order"} onClick={() => setTab("order")}>
          Order import
        </TabButton>
      </div>

      {tab === "wanted" && (
        <div className="space-y-5">
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
                Wanted-list XML
              </span>
              <textarea
                value={xml}
                onChange={(e) => setXml(e.target.value)}
                rows={10}
                placeholder={`<INVENTORY>\n  <ITEM>\n    <ITEMTYPE>P</ITEMTYPE>\n    <ITEMID>3001</ITEMID>\n    <COLOR>5</COLOR>\n    <MINQTY>4</MINQTY>\n  </ITEM>\n</INVENTORY>`}
                className="input font-mono text-xs"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => parseWanted.mutate()}
                disabled={parseWanted.isPending || !xml.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-4 py-2 transition disabled:opacity-50"
              >
                <Upload size={14} /> {parseWanted.isPending ? "Parsing…" : "Parse"}
              </button>
              {parsedWanted && (
                <button
                  type="button"
                  onClick={() => runDiff.mutate()}
                  disabled={runDiff.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"
                >
                  <Diff size={14} /> {runDiff.isPending ? "Diffing…" : "Diff vs inventory"}
                </button>
              )}
            </div>
          </div>

          {diff ? (
            <DiffTable diff={diff} />
          ) : parsedWanted ? (
            <ParsedWantedTable result={parsedWanted} />
          ) : null}

          {parsedWanted?.warnings.length ? (
            <WarningsPanel warnings={parsedWanted.warnings} />
          ) : null}
        </div>
      )}

      {tab === "order" && (
        <div className="space-y-5">
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
                Order CSV
              </span>
              <textarea
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                rows={10}
                placeholder={`Order ID,Lot ID,Item No,Item Type,Color ID,Condition,Qty,Each,Order Total,Item Description,Item Remarks\n12345,L1,3001,P,5,U,4,0.05,0.20,"Brick 2x4","Red"`}
                className="input font-mono text-xs"
              />
            </label>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => parseOrder.mutate()}
                disabled={parseOrder.isPending || !csv.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-4 py-2 transition disabled:opacity-50"
              >
                <FileText size={14} /> {parseOrder.isPending ? "Parsing…" : "Parse"}
              </button>
            </div>
          </div>

          {parsedOrder && <ParsedOrderTable result={parsedOrder} />}
          {parsedOrder?.warnings.length ? (
            <WarningsPanel warnings={parsedOrder.warnings} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition " +
        (active
          ? "border-cobble-600 text-cobble-700 dark:text-cobble-400"
          : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-mortar-100")
      }
    >
      {children}
    </button>
  );
}

function ParsedWantedTable({ result }: { result: ParseWantedResponse }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-2 bg-mortar-50/50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
          {result.counts.items} items
        </span>
        {result.counts.parts > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
            {result.counts.parts} parts
          </span>
        )}
        {result.counts.sets > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
            {result.counts.sets} sets
          </span>
        )}
        {result.counts.minifigs > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
            {result.counts.minifigs} minifigs
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-mortar-50/30 dark:bg-slate-800/20">
          <tr>
            <Th>Type</Th>
            <Th>Item</Th>
            <Th>Color</Th>
            <Th align="right">Qty</Th>
            <Th align="right">Max price</Th>
            <Th>Condition</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {result.items.map((item, i) => (
            <tr key={`${item.item_type}-${item.item_id}-${item.color_id}-${i}`}>
              <Td>
                <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
                  {TYPE_LABEL[item.item_type] ?? item.item_type}
                </span>
              </Td>
              <Td mono>{item.item_id}</Td>
              <Td mono dim>
                {item.color_id >= 0 ? item.color_id : "—"}
              </Td>
              <Td mono align="right">
                {item.min_qty}
              </Td>
              <Td mono dim align="right">
                {item.max_price != null ? `$${item.max_price.toFixed(2)}` : "—"}
              </Td>
              <Td dim>{item.condition === "N" ? "New" : item.condition === "U" ? "Used" : "Any"}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffTable({ diff }: { diff: DiffResponse }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-2 bg-mortar-50/50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">diff</span>
        <CountChip n={diff.counts.have} label="have" tone="emerald" />
        <CountChip n={diff.counts.partial} label="partial" tone="amber" />
        <CountChip n={diff.counts.need} label="need" tone="rose" />
        <CountChip n={diff.counts.unmatched} label="unmatched" tone="slate" />
      </div>
      <table className="w-full text-sm">
        <thead className="bg-mortar-50/30 dark:bg-slate-800/20">
          <tr>
            <Th>Status</Th>
            <Th>Type</Th>
            <Th>Item</Th>
            <Th>Catalog name</Th>
            <Th align="right">Want</Th>
            <Th align="right">In stock</Th>
            <Th>Color</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {diff.entries.map((e, i) => (
            <tr key={`${e.wanted.item_id}-${e.wanted.color_id}-${i}`}>
              <Td>
                <span
                  className={
                    "inline-block px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-widest border " +
                    STATUS_STYLE[e.status]
                  }
                >
                  {e.status === "no-catalog-match" ? "no match" : e.status}
                </span>
              </Td>
              <Td>
                <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
                  {TYPE_LABEL[e.wanted.item_type] ?? e.wanted.item_type}
                </span>
              </Td>
              <Td mono>{e.wanted.item_id}</Td>
              <Td dim>{e.catalog_name ?? "—"}</Td>
              <Td mono align="right">
                {e.wanted.min_qty}
              </Td>
              <Td mono align="right">
                {e.total_in_stock}
              </Td>
              <Td mono dim>
                {e.wanted.color_id < 0 ? (
                  "—"
                ) : e.color_satisfied === null ? (
                  String(e.wanted.color_id)
                ) : e.color_satisfied ? (
                  <span className="text-emerald-600">{e.wanted.color_id} ✓</span>
                ) : (
                  <span className="text-amber-600">{e.wanted.color_id} ✗</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParsedOrderTable({ result }: { result: ParseOrderResponse }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-2 bg-mortar-50/50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
          {result.summary.line_count} lines
        </span>
        {result.summary.order_id && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
            order {result.summary.order_id}
          </span>
        )}
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
          ${result.summary.total.toFixed(2)} total
        </span>
        {result.summary.parts > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
            {result.summary.parts} parts
          </span>
        )}
        {result.summary.sets > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
            {result.summary.sets} sets
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-mortar-50/30 dark:bg-slate-800/20">
          <tr>
            <Th>Type</Th>
            <Th>Item</Th>
            <Th>Description</Th>
            <Th>Color</Th>
            <Th align="right">Qty</Th>
            <Th align="right">Each</Th>
            <Th align="right">Total</Th>
            <Th>Condition</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {result.lines.map((line, i) => (
            <tr key={`${line.item_id}-${line.color_id}-${i}`}>
              <Td>
                <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
                  {TYPE_LABEL[line.item_type] ?? line.item_type}
                </span>
              </Td>
              <Td mono>{line.item_id}</Td>
              <Td dim>{line.description ?? "—"}</Td>
              <Td mono dim>
                {line.color_id >= 0 ? line.color_id : "—"}
              </Td>
              <Td mono align="right">{line.qty}</Td>
              <Td mono align="right">${line.unit_price.toFixed(2)}</Td>
              <Td mono align="right">${line.line_total.toFixed(2)}</Td>
              <Td dim>
                {line.condition === "N" ? "New" : line.condition === "U" ? "Used" : "Any"}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CountChip({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: "emerald" | "amber" | "rose" | "slate";
}) {
  if (n === 0) return null;
  const colors = {
    emerald: "text-emerald-700 dark:text-emerald-400",
    amber: "text-amber-700 dark:text-amber-400",
    rose: "text-rose-700 dark:text-rose-400",
    slate: "text-slate-500",
  };
  return (
    <span className={`text-[10px] font-mono uppercase tracking-widest ${colors[tone]}`}>
      {n} {label}
    </span>
  );
}

function WarningsPanel({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/10 p-4 text-xs text-amber-700 dark:text-amber-300 space-y-1">
      <div className="font-mono uppercase tracking-widest text-[10px] text-amber-600 mb-1">
        warnings
      </div>
      {warnings.map((w, i) => (
        <div key={i}>· {w}</div>
      ))}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-slate-400 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  mono,
  dim,
}: {
  children: ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  dim?: boolean;
}) {
  return (
    <td
      className={
        "px-3 py-1.5 text-xs " +
        (align === "right" ? "text-right " : "") +
        (mono ? "font-mono " : "") +
        (dim ? "text-slate-500 " : "text-slate-700 dark:text-mortar-100 ")
      }
    >
      {children}
    </td>
  );
}
