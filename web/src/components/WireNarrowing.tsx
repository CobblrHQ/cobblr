// The wire composer's two narrowings (#6070, contract wire-narrowing.ts):
// which change to a stock record's count the wire is about (used, runs out,
// falls below N, falls to its reorder point), and which of the kind's
// records (one record, a category, a tag, a saved view, or all of them).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NumberField, SearchInput } from "@cobblr/platform-web";
import { withArticle } from "@cobblr/platform-contract/plural";
import { api } from "../lib/api";
import type { StockChange, WireRecords } from "@cobblr/platform-contract/wire-narrowing";

const L = "block text-[11px] text-muted dark:text-slate-400 mb-0.5";

export function StockChangePicker({ value, onChange }: { value: StockChange; onChange: (c: StockChange) => void }) {
  const below = value.kind === "below" ? value.n : 1;
  return (
    <label className="mt-2 block">
      <span className={L}>Which change</span>
      <div className="flex flex-wrap items-center gap-2">
        <select
          data-testid="wire-stock-change"
          aria-label="Which change"
          value={value.kind}
          onChange={(e) => {
            const k = e.target.value as StockChange["kind"];
            onChange(k === "below" ? { kind: "below", n: below } : ({ kind: k } as StockChange));
          }}
          className="input text-sm min-w-0 flex-1"
        >
          <option value="any">any change to the count</option>
          <option value="used">some is used (the count goes down)</option>
          <option value="ran-out">it runs out (reaches 0)</option>
          <option value="below">it falls below…</option>
          <option value="reorder-point">it falls to its own reorder point</option>
        </select>
        {value.kind === "below" && (
          <NumberField
            label="Falls below"
            testId="wire-stock-below"
            value={value.n}
            min={1}
            integer
            onChange={(n) => onChange({ kind: "below", n })}
            className="w-20"
          />
        )}
      </div>
      {value.kind !== "any" && value.kind !== "used" && (
        <span className="mt-0.5 block text-[11px] text-faint dark:text-slate-500">Once each time it crosses the line, not again on the next scan below it.</span>
      )}
    </label>
  );
}

type Mode = "all" | keyof WireRecords;

export function WireRecordsPicker({
  slug,
  kind,
  kindNoun,
  value,
  recordLabel,
  onChange,
  onRecordNamed,
}: {
  slug: string;
  kind: string;
  /** The kind's own noun ("pantry item"), for the search box. */
  kindNoun: string;
  value: WireRecords | null;
  /** The chosen record's name, when it came with the composer's prefill. */
  recordLabel?: string | null;
  onChange: (r: WireRecords | null) => void;
  /** The name of the record picked here, for the composer's preview. */
  onRecordNamed?: (name: string) => void;
}) {
  const mode: Mode = value ? ((Object.keys(value)[0] as keyof WireRecords) ?? "all") : "all";
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(recordLabel ?? null);
  const records = useQuery({
    queryKey: ["wire-records-search", slug, kind, q],
    queryFn: () => api.listEntities(slug, kind, q.trim() || undefined),
    enabled: mode === "record" && !!kind,
  });
  const views = useQuery({
    queryKey: ["saved-views", slug, kind],
    queryFn: () => api.listSavedViews(slug, kind),
    enabled: mode === "view" && !!kind,
  });
  const shared = (views.data?.items ?? []).filter((v) => !v.owner_user_id);
  return (
    <div className="mt-2" data-testid="wire-records">
      <span className={L}>Which of them</span>
      <select
        aria-label="Which of them"
        data-testid="wire-records-mode"
        value={mode}
        onChange={(e) => {
          const m = e.target.value as Mode;
          setPicked(null);
          onChange(m === "all" ? null : { [m]: "" } as WireRecords);
        }}
        className="input text-sm"
      >
        <option value="all">all of them</option>
        <option value="record">one record</option>
        <option value="category">those in a category</option>
        <option value="tag">those with a tag</option>
        <option value="view">those a saved view shows</option>
      </select>
      {mode === "record" && (
        <div className="mt-1.5 space-y-1">
          {value?.record && picked ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 truncate" data-testid="wire-record-picked">{picked}</span>
              <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => { setPicked(null); onChange({ record: "" }); }}>
                Change
              </button>
            </div>
          ) : (
            <>
              <SearchInput aria-label="Find the record" value={q} onChange={setQ} placeholder={`Find ${withArticle(kindNoun)} by name`} size="sm" busy={records.isFetching} />
              <ul className="max-h-40 overflow-auto rounded border border-line dark:border-slate-700">
                {(records.data?.items ?? []).slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="block w-full truncate px-2 py-1 text-left text-sm hover:bg-subtle dark:hover:bg-slate-800"
                      onClick={() => { setPicked(r.title); onRecordNamed?.(r.title); onChange({ record: r.id }); }}
                    >
                      {r.title}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {(mode === "category" || mode === "tag") && (
        <input
          aria-label={mode === "category" ? "Category" : "Tag"}
          data-testid={`wire-records-${mode}`}
          value={value?.[mode] ?? ""}
          onChange={(e) => onChange({ [mode]: e.target.value } as WireRecords)}
          placeholder={mode === "category" ? "Category name" : "Tag name"}
          className="input mt-1.5 text-sm"
        />
      )}
      {mode === "view" && (
        <select
          aria-label="Saved view"
          data-testid="wire-records-view"
          value={value?.view ?? ""}
          onChange={(e) => onChange({ view: e.target.value })}
          className="input mt-1.5 text-sm"
        >
          <option value=""> - pick a shared view - </option>
          {shared.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Whether the records narrowing is finished: a mode with its value. */
export function wireRecordsReady(r: WireRecords | null): boolean {
  if (!r) return true;
  return Object.values(r).some((v) => typeof v === "string" && v.trim() !== "");
}
