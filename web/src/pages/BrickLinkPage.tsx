// /bricklink: take the files BrickLink exports, compare a wanted list with the
// workspace's Lego inventory, then hand durable facts to their owners. Lists
// owns saved and shopping lists; Purchases owns imported orders and lines.
// BrickLink only parses its formats and performs the catalog-backed comparison.

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Diff, FileText, ShoppingCart, Upload } from "lucide-react";
import { usePageTitle, usePageWidth, usePasteImage, useToast } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { formatStoredMoney } from "@cobblr/platform-contract/money";

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
  "no-catalog-match": "bg-subtle text-muted border-line dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700",
};

type Tab = "wanted" | "order";

const WANTED_ACCEPT = ".xml,application/xml,text/xml,text/plain";
const ORDER_ACCEPT = ".csv,text/csv,text/plain";

function readFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file"));
    reader.readAsText(file);
  });
}

function lineTitle(item: ParsedItem, catalogName?: string | null): string {
  return catalogName?.trim() || `${TYPE_LABEL[item.item_type]} ${item.item_id}`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export function BrickLinkPage() {
  usePageTitle("BrickLink");
  // A wide table is the page here, so it gets the screen.
  usePageWidth("wide");
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("wanted");
  const wantedArea = useRef<HTMLDivElement>(null);
  const wantedInput = useRef<HTMLInputElement>(null);
  const orderArea = useRef<HTMLDivElement>(null);
  const orderInput = useRef<HTMLInputElement>(null);
  const [wantedName, setWantedName] = useState("BrickLink wanted list");
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ label: string; href: string } | null>(null);

  // Wanted-list state.
  const [xml, setXml] = useState("");
  const [parsedWanted, setParsedWanted] = useState<ParseWantedResponse | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);

  // Order CSV state.
  const [csv, setCsv] = useState("");
  const [parsedOrder, setParsedOrder] = useState<ParseOrderResponse | null>(null);

  const parseWanted = useMutation({
    mutationFn: (source: string) =>
      api.request<ParseWantedResponse>(
        "POST",
        `/orgs/${activeSlug}/modules/bricklink-connector/parse-wanted-list`,
        { xml: source },
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
    mutationFn: (items: ParsedItem[]) =>
      api.request<DiffResponse>(
        "POST",
        `/orgs/${activeSlug}/modules/bricklink-connector/diff-wanted-list`,
        { items },
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
    mutationFn: (source: string) =>
      api.request<ParseOrderResponse>(
        "POST",
        `/orgs/${activeSlug}/modules/bricklink-connector/parse-order`,
        { csv: source },
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

  const showError = (error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : fallback;
    setActionError(message);
    toast.error(message);
  };

  const previewWanted = async (source: string) => {
    if (!source.trim()) return;
    setActionError(null);
    setSaved(null);
    try {
      const parsed = await parseWanted.mutateAsync(source);
      await runDiff.mutateAsync(parsed.items);
    } catch (error) {
      showError(error, "Couldn't read the wanted list");
    }
  };

  const takeWantedFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    try {
      const source = await readFile(file);
      setWantedName(file.name.replace(/\.xml$/i, "") || "BrickLink wanted list");
      setXml(source);
      await previewWanted(source);
    } catch (error) {
      showError(error, "Couldn't read the wanted-list file");
    }
  };

  const takeOrderFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    try {
      const source = await readFile(file);
      setCsv(source);
      setActionError(null);
      setSaved(null);
      await parseOrder.mutateAsync(source);
    } catch (error) {
      showError(error, "Couldn't read the order file");
    }
  };

  usePasteImage(wantedArea, {
    accept: WANTED_ACCEPT,
    enabled: tab === "wanted",
    onFiles: (files) => void takeWantedFiles(files),
    onText: (text) => {
      setXml(text);
      void previewWanted(text);
      return true;
    },
  });
  usePasteImage(orderArea, {
    accept: ORDER_ACCEPT,
    enabled: tab === "order",
    onFiles: (files) => void takeOrderFiles(files),
    onText: (text) => {
      setCsv(text);
      void parseOrder.mutateAsync(text).catch((error) => showError(error, "Couldn't read the order"));
      return true;
    },
  });

  const saveWanted = useMutation({
    mutationFn: async (shopping: boolean) => {
      if (!parsedWanted || !diff) throw new Error("Preview the wanted list first.");
      let list: { id: string; title: string };
      if (shopping) {
        const lists = await api.request<{ items: Array<{ id: string; title: string }> }>("GET", `/orgs/${activeSlug}/modules/lists/lists`);
        list = lists.items.find((item) => item.title.trim().toLowerCase() === "shopping list")
          ?? await api.request<{ id: string; title: string }>("POST", `/orgs/${activeSlug}/modules/lists/lists`, { title: "Shopping list", description: "Things to buy." });
      } else {
        list = await api.request<{ id: string; title: string }>("POST", `/orgs/${activeSlug}/modules/lists/lists`, {
          title: wantedName,
          description: "Imported from a BrickLink wanted list.",
          metadata: { source: "bricklink" },
        });
      }
      const entries = shopping ? diff.entries.filter((entry) => entry.status !== "have") : diff.entries;
      for (const entry of entries) {
        const short = Math.max(1, entry.wanted.min_qty - entry.total_in_stock);
        await api.request("POST", `/orgs/${activeSlug}/modules/lists/items`, {
          list_id: list.id,
          title: lineTitle(entry.wanted, entry.catalog_name),
          qty: String(shopping ? short : entry.wanted.min_qty),
          note: `BrickLink ${entry.wanted.item_id}${entry.wanted.color_id >= 0 ? ` · color ${entry.wanted.color_id}` : ""}`,
          metadata: { source: "bricklink", item_type: entry.wanted.item_type, item_id: entry.wanted.item_id, color_id: entry.wanted.color_id },
        });
      }
      return { id: list.id, count: entries.length, shopping };
    },
    onSuccess: ({ id, count, shopping }) => {
      const label = shopping ? `Added ${plural(count, "line")} to your shopping list` : `Saved ${plural(count, "line")} as a wanted list`;
      setSaved({ label, href: `/lists/${id}` });
      setActionError(null);
      toast.success(label);
    },
    onError: (error) => showError(error, "Couldn't save the list"),
  });

  const importOrder = useMutation({
    mutationFn: async () => {
      if (!parsedOrder) throw new Error("Preview the order first.");
      const order = await api.request<{ id: string }>("POST", `/orgs/${activeSlug}/modules/purchases/orders`, {
        vendor: "BrickLink",
        order_number: parsedOrder.summary.order_id,
        total_cost: parsedOrder.summary.total,
        status: "ordered",
        metadata: { source: "bricklink" },
      });
      for (const line of parsedOrder.lines) {
        await api.request("POST", `/orgs/${activeSlug}/modules/purchases/orders/${order.id}/items`, {
          description: line.description || `${TYPE_LABEL[line.item_type]} ${line.item_id}`,
          qty: line.qty,
          unit_cost: line.unit_price,
          line_amount: line.line_total,
          metadata: { source: "bricklink", item_type: line.item_type, item_id: line.item_id, color_id: line.color_id, condition: line.condition, lot_id: line.lot_id },
        });
      }
      return { id: order.id, count: parsedOrder.lines.length };
    },
    onSuccess: ({ id, count }) => {
      const label = `Imported ${plural(count, "line")} as a purchase`;
      setSaved({ label, href: `/purchases/${id}` });
      setActionError(null);
      toast.success(label);
    },
    onError: (error) => showError(error, "Couldn't import the order"),
  });

  const dropFiles = (event: DragEvent<HTMLDivElement>, take: (files: File[]) => void) => {
    event.preventDefault();
    take(Array.from(event.dataTransfer.files));
  };

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      <div className="border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          BrickLink
        </h1>
        <span className="page-subtitle">Bring your BrickLink wanted lists and orders into Cobblr, and see which parts you already have.</span>
      </div>

      <div className="flex gap-1 border-b border-line dark:border-slate-700">
        <TabButton active={tab === "wanted"} onClick={() => setTab("wanted")}>
          Wanted list
        </TabButton>
        <TabButton active={tab === "order"} onClick={() => setTab("order")}>
          Order import
        </TabButton>
      </div>

      {tab === "wanted" && (
        <div className="space-y-5">
          <div
            ref={wantedArea}
            data-testid="bricklink-wanted-intake"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropFiles(event, (files) => void takeWantedFiles(files))}
            className="rounded-xl border-2 border-dashed border-line hover:border-accent dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-4 transition"
          >
            <div>
              <h2 className="text-[10px] font-mono uppercase tracking-widest text-accent">Wanted list</h2>
              <p className="text-sm text-muted dark:text-slate-400">Upload or drop the file you downloaded from BrickLink, or paste it.</p>
              <a href="https://www.bricklink.com/v2/wanted/list.page" target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">Open your wanted lists on BrickLink</a>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => wantedInput.current?.click()}
                disabled={parseWanted.isPending || runDiff.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"
              >
                <Upload size={14} /> {parseWanted.isPending || runDiff.isPending ? "Reading…" : "Choose wanted-list file"}
              </button>
              <input ref={wantedInput} type="file" accept={WANTED_ACCEPT} className="hidden" onChange={(event) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; void takeWantedFiles(files); }} />
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-accent">Paste instead</summary>
              <label className="mt-3 block">
                <span className="sr-only">Wanted-list file contents</span>
                <textarea value={xml} onChange={(event) => setXml(event.target.value)} rows={6} placeholder="Paste the contents of your downloaded file" className="input font-mono text-base sm:text-sm" />
              </label>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void previewWanted(xml)}
                  disabled={parseWanted.isPending || runDiff.isPending || !xml.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"
                >
                  <Diff size={14} /> {parseWanted.isPending || runDiff.isPending ? "Comparing…" : "Preview"}
                </button>
              </div>
            </details>
          </div>

          {diff ? (
            <>
              <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex flex-wrap items-center gap-3">
                <strong className="text-content dark:text-mortar-100">{plural(diff.entries.length, "part")} · {diff.counts.have} you already have · {diff.counts.need + diff.counts.partial + diff.counts.unmatched} to buy</strong>
                <div className="flex-1" />
                <button type="button" onClick={() => saveWanted.mutate(true)} disabled={saveWanted.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 disabled:opacity-50"><ShoppingCart size={14} />Add to your shopping list</button>
                <button type="button" onClick={() => saveWanted.mutate(false)} disabled={saveWanted.isPending} className="inline-flex items-center gap-1.5 rounded-md border border-line hover:border-accent text-sm font-medium px-3 py-2 disabled:opacity-50">Save as a wanted list</button>
              </div>
              <DiffTable diff={diff} />
            </>
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
          <div ref={orderArea} data-testid="bricklink-order-intake" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropFiles(event, (files) => void takeOrderFiles(files))} className="rounded-xl border-2 border-dashed border-line hover:border-accent dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-4 transition">
            <div><h2 className="text-[10px] font-mono uppercase tracking-widest text-accent">Order import</h2><p className="text-sm text-muted dark:text-slate-400">Upload or drop the order file you downloaded from BrickLink, or paste it. It becomes a Purchase with its lines.</p></div>
            <button type="button" onClick={() => orderInput.current?.click()} disabled={parseOrder.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"><FileText size={14} />{parseOrder.isPending ? "Reading…" : "Choose order file"}</button>
            <input ref={orderInput} type="file" accept={ORDER_ACCEPT} className="hidden" onChange={(event) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; void takeOrderFiles(files); }} />
            <details><summary className="cursor-pointer text-sm text-accent">Paste instead</summary><label className="mt-3 block"><span className="sr-only">Order file contents</span><textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={6} placeholder="Paste the contents of your downloaded order file" className="input font-mono text-base sm:text-sm" /></label><div className="mt-2 flex justify-end"><button type="button" onClick={() => parseOrder.mutate(csv)} disabled={parseOrder.isPending || !csv.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition disabled:opacity-50"><FileText size={14} />{parseOrder.isPending ? "Reading…" : "Preview"}</button></div></details>
          </div>

          {parsedOrder && <><div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex flex-wrap items-center gap-3"><strong className="text-content dark:text-mortar-100">{plural(parsedOrder.summary.line_count, "line")} · {formatStoredMoney(parsedOrder.summary.total, "amount")}</strong><div className="flex-1" /><button type="button" onClick={() => importOrder.mutate()} disabled={importOrder.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 disabled:opacity-50">Import as a Purchase</button></div><ParsedOrderTable result={parsedOrder} /></>}
          {parsedOrder?.warnings.length ? (
            <WarningsPanel warnings={parsedOrder.warnings} />
          ) : null}
        </div>
      )}
      {actionError && <div role="alert" className="rounded-lg border border-ember-300 bg-ember-50 p-3 text-sm text-ember-800 dark:border-ember-700 dark:bg-ember-950/30 dark:text-ember-200">{actionError}</div>}
      {saved && <a href={saved.href} className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-800 hover:underline dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200"><CheckCircle2 size={16} />{saved.label}. Open it.</a>}
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
          ? "border-cobble-600 text-accent dark:text-cobble-400"
          : "border-transparent text-muted hover:text-content dark:hover:text-mortar-100")
      }
    >
      {children}
    </button>
  );
}

function ParsedWantedTable({ result }: { result: ParseWantedResponse }) {
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-2 bg-subtle/50 dark:bg-slate-800/40 border-b border-line dark:border-slate-700 flex items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
          {result.counts.items} items
        </span>
        {result.counts.parts > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
            {result.counts.parts} parts
          </span>
        )}
        {result.counts.sets > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
            {result.counts.sets} sets
          </span>
        )}
        {result.counts.minifigs > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
            {result.counts.minifigs} minifigs
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-subtle/30 dark:bg-slate-800/20">
          <tr>
            <Th>Type</Th>
            <Th>Item</Th>
            <Th>Color</Th>
            <Th align="right">Qty</Th>
            <Th align="right">Max price</Th>
            <Th>Condition</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-800">
          {result.items.map((item, i) => (
            <tr key={`${item.item_type}-${item.item_id}-${item.color_id}-${i}`}>
              <Td>
                <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
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
                {item.max_price != null ? formatStoredMoney(item.max_price, "amount") : "—"}
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-2 bg-subtle/50 dark:bg-slate-800/40 border-b border-line dark:border-slate-700 flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint">diff</span>
        <CountChip n={diff.counts.have} label="have" tone="emerald" />
        <CountChip n={diff.counts.partial} label="partial" tone="amber" />
        <CountChip n={diff.counts.need} label="need" tone="rose" />
        <CountChip n={diff.counts.unmatched} label="unmatched" tone="slate" />
      </div>
      <table className="w-full text-sm">
        <thead className="bg-subtle/30 dark:bg-slate-800/20">
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
        <tbody className="divide-y divide-line dark:divide-slate-800">
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
                <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <div className="px-4 py-2 bg-subtle/50 dark:bg-slate-800/40 border-b border-line dark:border-slate-700 flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
          {result.summary.line_count} lines
        </span>
        {result.summary.order_id && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
            order {result.summary.order_id}
          </span>
        )}
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted">
          {formatStoredMoney(result.summary.total, "amount")} total
        </span>
        {result.summary.parts > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
            {result.summary.parts} parts
          </span>
        )}
        {result.summary.sets > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
            {result.summary.sets} sets
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-subtle/30 dark:bg-slate-800/20">
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
        <tbody className="divide-y divide-line dark:divide-slate-800">
          {result.lines.map((line, i) => (
            <tr key={`${line.item_id}-${line.color_id}-${i}`}>
              <Td>
                <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
                  {TYPE_LABEL[line.item_type] ?? line.item_type}
                </span>
              </Td>
              <Td mono>{line.item_id}</Td>
              <Td dim>{line.description ?? "—"}</Td>
              <Td mono dim>
                {line.color_id >= 0 ? line.color_id : "—"}
              </Td>
              <Td mono align="right">{line.qty}</Td>
              <Td mono align="right">{formatStoredMoney(line.unit_price, "amount")}</Td>
              <Td mono align="right">{formatStoredMoney(line.line_total, "amount")}</Td>
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
    slate: "text-muted",
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
      className={`px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-faint ${
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
        (dim ? "text-muted " : "text-content dark:text-mortar-100 ")
      }
    >
      {children}
    </td>
  );
}
