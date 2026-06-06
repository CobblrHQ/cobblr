// /configuration/units — the workspace unit vocabulary.
//
//   • Display mode: shorthand symbol ("340 g"), full word ("340 grams"),
//     or both ("340 g (grams)") — with a live preview.
//   • Built-in units: the canonical catalog, read-only, grouped by category.
//   • Custom units: add your own (a "spool", a "skein"), delete them.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { ApiError, api, type UnitDef, type UnitDisplayMode } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle, formatQuantity } from "@cobblr/platform-web";

const MODES: { value: UnitDisplayMode; label: string; hint: string }[] = [
  { value: "symbol", label: "Shorthand", hint: "340 g" },
  { value: "name", label: "Full word", hint: "340 grams" },
  { value: "both", label: "Both", hint: "340 g (grams)" },
];

const CATEGORIES = ["count", "mass", "length", "area", "volume", "time", "electrical", "digital"] as const;

export function UnitsPage() {
  usePageTitle("Units");
  const { activeSlug: slug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const units = useQuery({
    queryKey: ["core-units", slug],
    queryFn: () => api.listUnits(slug),
    enabled: !!slug,
  });

  const setMode = useMutation({
    mutationFn: (mode: UnitDisplayMode) => api.setUnitDisplayMode(slug, mode),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["core-units", slug] });
      toast.success("Display mode updated.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't update"),
  });

  const all: UnitDef[] = [...(units.data?.builtins ?? []), ...(units.data?.custom ?? [])];
  const mode = units.data?.display_mode ?? "symbol";

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          units
        </h1>
        <span className="page-subtitle">
          the workspace unit vocabulary + how quantities render
        </span>
      </div>

      {/* Display mode */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// display</div>
        <p className="text-sm text-content dark:text-mortar-200">
          How a quantity + unit shows everywhere in this workspace.
        </p>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode.mutate(m.value)}
              disabled={setMode.isPending}
              className={
                "rounded-lg border p-3 text-left transition " +
                (mode === m.value
                  ? "border-accent bg-cobble-50 dark:bg-cobble-900/30"
                  : "border-line dark:border-slate-700 hover:border-cobble-300")
              }
            >
              <div className="text-sm font-medium text-content dark:text-mortar-100">{m.label}</div>
              <div className="font-mono text-xs text-faint dark:text-slate-400 mt-0.5">{m.hint}</div>
            </button>
          ))}
        </div>
        {all.length > 0 && (
          <div className="text-xs text-faint dark:text-slate-500">
            Preview: <span className="font-mono text-content dark:text-mortar-200">{formatQuantity(340, "g", all, mode)}</span>
            {" · "}
            <span className="font-mono text-content dark:text-mortar-200">{formatQuantity(1, "each", all, mode)}</span>
            {" · "}
            <span className="font-mono text-content dark:text-mortar-200">{formatQuantity(2.5, "m", all, mode)}</span>
          </div>
        )}
      </section>

      <AddCustomUnit slug={slug} />

      {/* Custom units */}
      {(units.data?.custom.length ?? 0) > 0 && (
        <UnitList title="your units" rows={units.data!.custom} slug={slug} deletable />
      )}

      {/* Built-ins */}
      <UnitList title="built-in units" rows={units.data?.builtins ?? []} slug={slug} />
    </div>
  );
}

function AddCustomUnit({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [plural, setPlural] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("count");
  const [err, setErr] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.addUnit(slug, { code, symbol, name, plural: plural || undefined, category }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["core-units", slug] });
      toast.success(`Added "${name}".`);
      setCode(""); setSymbol(""); setName(""); setPlural(""); setErr(null);
    },
    onError: (e) => {
      const m = e instanceof ApiError ? e.message : "Couldn't add";
      setErr(m); toast.error(m);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!code || !symbol || !name) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(code)) {
      setErr("code must be lowercase letters, digits, hyphens");
      return;
    }
    add.mutate();
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// add a unit</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Labeled label="Code (a-z 0-9 -)">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="skein" className="input font-mono text-xs" />
        </Labeled>
        <Labeled label="Symbol">
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="sk" className="input" />
        </Labeled>
        <Labeled label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} className="input">
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Labeled>
        <Labeled label="Name (singular)">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="skein" className="input" />
        </Labeled>
        <Labeled label="Plural (optional)">
          <input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="skeins" className="input" />
        </Labeled>
      </div>
      {err && <div className="text-xs text-ember-500">{err}</div>}
      <button
        type="submit"
        disabled={!code || !symbol || !name || add.isPending}
        className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50 flex items-center gap-1.5"
      >
        <Plus size={14} /> Add unit
      </button>
    </form>
  );
}

function UnitList({ title, rows, slug, deletable }: { title: string; rows: UnitDef[]; slug: string; deletable?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const del = useMutation({
    mutationFn: (code: string) => api.deleteUnit(slug, code),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["core-units", slug] });
      toast.success("Removed.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove"),
  });
  const byCat: Record<string, UnitDef[]> = {};
  for (const u of rows) (byCat[u.category] ||= []).push(u);

  return (
    <section className="space-y-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// {title}</div>
      <div className="rounded-xl border border-line dark:border-slate-700 divide-y divide-line dark:divide-slate-800">
        {CATEGORIES.filter((c) => byCat[c]?.length).map((cat) => (
          <div key={cat} className="p-3">
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">{cat}</div>
            <div className="flex flex-wrap gap-1.5">
              {(byCat[cat] ?? []).map((u) => (
                <span key={u.code} className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1 text-xs">
                  <span className="font-mono text-content dark:text-mortar-100">{u.symbol}</span>
                  <span className="text-faint dark:text-slate-400">{u.plural}</span>
                  {deletable && (
                    <button type="button" onClick={() => del.mutate(u.code)} className="text-faint hover:text-ember-500 transition" title="Remove">
                      <Trash2 size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
