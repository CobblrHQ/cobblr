// /bricklink — paste a BrickLink wanted-list XML, get back a parsed
// item list. v0.1 ships the parser only; diff-against-inventory is
// v0.2. See modules/bricklink/.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload } from "lucide-react";
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

interface ParseResponse {
  items: ParsedItem[];
  warnings: string[];
  counts: { items: number; parts: number; sets: number; minifigs: number };
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

export function BrickLinkPage() {
  usePageTitle("BrickLink");
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [xml, setXml] = useState("");
  const [result, setResult] = useState<ParseResponse | null>(null);

  const parse = useMutation({
    mutationFn: () =>
      api.request<ParseResponse>(
        "POST",
        `/orgs/${activeSlug}/modules/bricklink-connector/parse-wanted-list`,
        { xml },
      ),
    onSuccess: (data) => {
      setResult(data);
      if (data.warnings.length > 0) {
        toast.success(`Parsed ${data.counts.items} items (${data.warnings.length} warning${data.warnings.length === 1 ? "" : "s"}).`);
      } else {
        toast.success(`Parsed ${data.counts.items} items.`);
      }
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't parse"),
  });

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          bricklink
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          paste a wanted-list xml; parsed items show below. diff against
          inventory + order csv import are v0.2.
        </span>
      </div>

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
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => parse.mutate()}
            disabled={parse.isPending || !xml.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-4 py-2 transition disabled:opacity-50"
          >
            <Upload size={14} /> {parse.isPending ? "Parsing…" : "Parse"}
          </button>
        </div>
      </div>

      {result && (
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
                <th className="text-left text-[10px] font-mono uppercase tracking-widest text-slate-400 px-3 py-2">Type</th>
                <th className="text-left text-[10px] font-mono uppercase tracking-widest text-slate-400 px-3 py-2">Item</th>
                <th className="text-left text-[10px] font-mono uppercase tracking-widest text-slate-400 px-3 py-2">Color</th>
                <th className="text-right text-[10px] font-mono uppercase tracking-widest text-slate-400 px-3 py-2">Qty</th>
                <th className="text-right text-[10px] font-mono uppercase tracking-widest text-slate-400 px-3 py-2">Max price</th>
                <th className="text-left text-[10px] font-mono uppercase tracking-widest text-slate-400 px-3 py-2">Condition</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {result.items.map((item, i) => (
                <tr key={`${item.item_type}-${item.item_id}-${item.color_id}-${i}`}>
                  <td className="px-3 py-1.5 text-xs">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
                      {TYPE_LABEL[item.item_type] ?? item.item_type}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-700 dark:text-mortar-100">
                    {item.item_id}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-500">
                    {item.color_id >= 0 ? item.color_id : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">
                    {item.min_qty}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-500">
                    {item.max_price != null ? `$${item.max_price.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">
                    {item.condition === "N" ? "New" : item.condition === "U" ? "Used" : "Any"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result?.warnings.length ? (
        <div className="rounded-xl border border-amber-200 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/10 p-4 text-xs text-amber-700 dark:text-amber-300 space-y-1">
          <div className="font-mono uppercase tracking-widest text-[10px] text-amber-600 mb-1">
            warnings
          </div>
          {result.warnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
