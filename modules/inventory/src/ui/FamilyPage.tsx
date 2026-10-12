import { ReceivePackage } from "./ReceivePackage";
import { useStockWrites } from "./stock-writes";
import { FilamentCatalog } from "./FilamentCatalog";
import { SpoolmanModal } from "./SpoolmanModal";
// A type collection and its things on one page (Filament: a card per filament
// type, its spools as rows). The two tables stay underneath: a type is a
// record of this collection, a spool a record of the child collection paired
// to it. Nobody has to know that to use the page: "+ Spool" picks or makes the
// type inline, a scan lands a spool under its type, and the raw tables are one
// tap away in the ⋯ menu.
//
// Reads GET /family/all (api/families.ts). What a spool has left changes
// through AmountControl (typed grams for a spool kept in kg, never a fixed
// step), the ledgered stock adjust on the spool's own record, in its own
// collection; its ⋯ marks it empty or removes it (a duplicate, a spool gone).

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { AmountControl, colorSwatch, PopoverLayer, Swatch, swatchFill, useConfirm, useEscapeToClose, useToast, useUnits } from "@cobblr/platform-web";
import { countOf, pluralise, withArticle } from "@cobblr/platform-contract";
import { InventoryProvider, useInventory } from "./context";
import { BulkMoveToPlace } from "./BulkMoveToPlace";
import type { FamilyPayload, FamilyThing, FamilyType } from "./api";

type View = "all" | "material" | "colour" | "low";

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
}



/** The type's colour: the shared swatch (one colour, a gradient or
 *  segments), a dashed ring when it names none. */
function TypeSwatch({ value }: { value: unknown }) {
  return <Swatch value={value} showEmpty className="w-6 h-6 rounded-full" />;
}

/** What a thing's own line says under its name: "empty" once nothing is left
 *  (never the "sealed" it was bought as), its state otherwise, and its size. */
export function thingSubline(t: Pick<FamilyThing, "qty" | "metadata">, place: string | null, named: boolean | undefined, noun: string): string {
  const stated = typeof t.metadata.state === "string" ? t.metadata.state : null;
  const state = t.qty <= 0 ? "empty" : stated;
  // The size is what it held when full ("1 kg spool"), never what is left.
  const size = typeof t.metadata.size === "string" ? `${t.metadata.size} ${noun}` : null;
  return [named ? place : null, state, size].filter(Boolean).join(" · ");
}

function ThingRow({ t, childInstance, childPath, place, highlighted, named, noun }: { t: FamilyThing; childInstance: string; childPath: string; place: string | null; highlighted: boolean; named?: boolean; noun: string }) {
  const { api, orgSlug, getToken } = useInventory();
  const stock = useStockWrites();
  const units = useUnits();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["inventory-family"] });
  const change = async (delta: number) => {
    const out = await stock.stockAdjustIn(childInstance, t.id, delta);
    refresh();
    return Number(out.qty);
  };
  const remove = useMutation({
    mutationFn: () => api.deleteIn(childInstance, t.id),
    onSuccess: () => {
      toast.success(`Removed that ${noun}.`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center" });
  }, [highlighted]);
  const item = "block w-full text-left px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800";
  return (
    <li
      ref={ref}
      data-testid="family-thing"
      className={`px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${highlighted ? "ring-2 ring-accent rounded-md bg-subtle dark:bg-slate-800" : ""}`}
    >
      <Link to={`${childPath}/parts/${t.id}`} className="flex-1 min-w-0 basis-40 text-content dark:text-mortar-100 hover:text-accent">
        <span className="block truncate">{named ? t.name : (place ?? "No place set")}</span>
        <span className="block text-[11px] text-muted dark:text-slate-400 truncate" data-testid="family-thing-sub">
          {thingSubline(t, place, named, noun) || " "}
          {t.material && <span className="block" data-testid="spool-use-summary">{fmt(t.material.used_g)} g used{t.material.remaining_m != null ? ` · ${fmt(t.material.remaining_m)} m left` : ""} · {t.material.jobs === 1 ? "1 linked use" : `${t.material.jobs} linked uses`}</span>}
        </span>
      </Link>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <InventoryProvider orgSlug={orgSlug} getToken={getToken} instance={childInstance} itemNoun={noun}>
          <BulkMoveToPlace
            rows={[{ id: t.id, location_id: t.location_id, location_name: place }]}
            label={place ? "Move to a place…" : "Set place"}
            onMoved={refresh}
          />
        </InventoryProvider>
        {t.metadata.tracked_by ? <span className="text-xs text-muted">{units.format(t.qty, t.unit)} · {t.metadata.tracked_by === "firmware" ? "Firmware reports" : "External tracking"}</span> : <AmountControl qty={t.qty} unit={t.unit} label={t.name} onChange={change} />}
        <PopMenu label={`More for this ${noun}`} size="md">
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={item}
                disabled={t.qty <= 0}
                onClick={() => {
                  close();
                  void change(-t.qty).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
                }}
              >
                Mark empty
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${item} text-ember-700 dark:text-ember-300`}
                onClick={async () => {
                  close();
                  const ok = await confirm({
                    title: `Remove this ${noun}?`,
                    message: `Use this for ${withArticle(noun)} entered twice, or one you no longer have. Its history stays in the activity.`,
                    confirmLabel: `Remove ${noun}`,
                    destructive: true,
                  });
                  if (ok) remove.mutate();
                }}
              >
                Remove this {noun}
              </button>
            </>
          )}
        </PopMenu>
      </span>
    </li>
  );
}

function TypeCard({
  type,
  data,
  childPath,
  places,
  highlight,
  onAdd,
}: {
  type: FamilyType;
  data: FamilyPayload;
  childPath: string;
  places: Map<string, string>;
  highlight: string | null;
  onAdd: (typeId: string) => void;
}) {
  const { basePath } = useInventory();
  const md = type.metadata;
  const noun = data.child_noun ?? "item";
  const unit = type.children[0]?.unit;
  const facts = [type.manufacturer, md.material, md.diameter].filter((x) => typeof x === "string" && x.trim()) as string[];
  const mine = highlight === type.id;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (mine) ref.current?.scrollIntoView({ block: "center" });
  }, [mine]);
  return (
    <section
      ref={ref}
      data-testid="family-card"
      className={`rounded-xl border bg-surface dark:bg-slate-900 ${mine ? "border-accent ring-2 ring-accent" : type.low && type.count ? "border-ember-300 dark:border-ember-700" : "border-line dark:border-slate-700"}`}
    >
      <header className="px-3 pt-3 pb-2 flex items-center gap-3">
        {/* The hex a scan stores beside the colour's name, else the colour itself. */}
        {!data.package_receiving && <TypeSwatch value={swatchFill(md.color_hex) ? md.color_hex : md.color} />}
        <Link to={`${basePath}/parts/${type.id}`} className="flex-1 min-w-0">
          <span className="block font-medium text-content dark:text-mortar-100 truncate">{type.name}</span>
          {facts.length > 0 && <span className="block text-xs text-muted dark:text-slate-400 truncate">{facts.join(" · ")}</span>}
        </Link>
        <span className="text-xs text-muted dark:text-slate-400 text-right shrink-0" data-testid="family-card-sum">
          {countOf(type.count, noun)}
          {type.count > 0 && <span className="block">{fmt(type.remaining)}{unit && unit !== "each" ? ` ${unit}` : ""}</span>}
        </span>
      </header>
      {type.children.length > 0 ? (
        <ul className="divide-y divide-line dark:divide-slate-800 border-t border-line dark:border-slate-800">
          {type.children.map((t) => (
            <ThingRow key={t.id} t={t} childInstance={data.child} childPath={childPath} place={t.location_name ?? (t.location_id ? (places.get(t.location_id) ?? null) : null)} highlighted={highlight === t.id} noun={data.child_noun ?? "item"} />
          ))}
        </ul>
      ) : (
        <p className="px-3 pb-2 text-xs text-muted dark:text-slate-400">No {pluralise(noun)} of this yet.</p>
      )}
      <ToConfirm type={type} noun={noun} />
      <div className="px-3 py-2 border-t border-line dark:border-slate-800">
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => onAdd(type.id)}>
          + {noun[0]!.toUpperCase() + noun.slice(1)}
        </button>
      </div>
    </section>
  );
}

/** A scan counted more of this type than are listed: say so, and let the
 *  person add them or say it was the same one. Never invented on its own. */
function ToConfirm({ type, noun }: { type: FamilyType; noun: string }) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const n = Number(type.metadata.spools_to_confirm ?? 0);
  const settle = useMutation({
    mutationFn: async (add: boolean) => {
      if (add) for (let i = 0; i < n; i++) await api.addToFamily({ type_id: type.id, qty: 1 });
      await api.patchPartMetadata(type.id, { spools_to_confirm: null });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["inventory-family"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  if (!(n > 0)) return null;
  return (
    <div data-testid="family-to-confirm" className="mx-3 mb-2 rounded-lg bg-subtle dark:bg-slate-800 px-3 py-2 text-xs text-content dark:text-mortar-100">
      A scan counted {n === 1 ? `one more ${noun}` : `${n} more ${pluralise(noun)}`} of this than {type.count === 1 ? "is" : "are"} listed. Is there really {n === 1 ? "another" : "that many more"}?
      <span className="mt-1.5 flex gap-2">
        <button type="button" disabled={settle.isPending} onClick={() => settle.mutate(true)} className="h-9 px-3 rounded-md bg-cobble-600 text-white">
          Yes, add {n === 1 ? "it" : "them"}
        </button>
        <button type="button" disabled={settle.isPending} onClick={() => settle.mutate(false)} className="h-9 px-3 rounded-md border border-line dark:border-slate-700">
          No, it was the same one
        </button>
      </span>
    </div>
  );
}

function AddForm({ data, initialType, onDone }: { data: FamilyPayload; initialType: string | null; onDone: () => void }) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const noun = data.child_noun ?? "item";
  const [typeId, setTypeId] = useState(initialType ?? "");
  const [newName, setNewName] = useState("");
  const [qty, setQty] = useState("1");
  const [locationId, setLocationId] = useState("");
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  const add = useMutation({
    mutationFn: () =>
      api.addToFamily({
        ...(typeId === "__new" ? { new_type: { name: newName.trim() } } : { type_id: typeId }),
        qty: Number(qty) || 0,
        location_id: locationId || null,
      }),
    onSuccess: () => {
      toast.success(`Added 1 ${noun}`);
      void qc.invalidateQueries({ queryKey: ["inventory-family"] });
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const ready = typeId === "__new" ? newName.trim().length > 0 : typeId !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) add.mutate();
  };
  const input = "input w-full";
  return (
    <form onSubmit={submit} className="rounded-xl border border-accent bg-surface dark:bg-slate-900 p-3 space-y-2" data-testid="family-add">
      <label className="block text-xs text-muted">
        Type
        <select className={input} value={typeId} onChange={(e) => setTypeId(e.target.value)} autoFocus={!initialType}>
          <option value="">Pick one…</option>
          {data.types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value="__new">A new type…</option>
        </select>
      </label>
      {typeId === "__new" && (
        <label className="block text-xs text-muted">
          New type's name
          <input className={input} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Brand, material and colour" autoFocus />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <label className="block flex-1 basis-24 text-xs text-muted">
          How much{data.child_unit && data.child_unit !== "each" ? ` (${data.child_unit})` : ""}
          <input className={input} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="block flex-[2] basis-40 text-xs text-muted">
          Where
          <select className={input} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">No place</option>
            {locs.data?.items.map((l) => (
              <option key={l.id} value={l.id}>
                {"  ".repeat(l.depth)}
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" className="px-3 py-1.5 text-sm text-muted" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" disabled={!ready || add.isPending} className="px-3 py-1.5 rounded-md text-sm bg-cobble-600 text-white disabled:opacity-40">
          Add {noun}
        </button>
      </div>
    </form>
  );
}

const groupKey = (t: FamilyType, view: View): string => {
  if (view === "material") return (typeof t.metadata.material === "string" && t.metadata.material) || "No material set";
  if (view === "colour") {
    const c = swatchFill(t.metadata.color_hex) ? t.metadata.color_hex : t.metadata.color;
    return colorSwatch(c) ? String(c) : "No colour set";
  }
  return "";
};

/** The ⋯ menu: the two plain tables. Portaled and kept on the screen by the
 *  shared layer, so it never runs off a phone's edge. */
function MoreMenu({ childPath, tablePath, noun, typeNoun }: { childPath: string; tablePath: string; noun: string; typeNoun: string }) {
  const item = "block px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800";
  return (
    <PopMenu label="More options">
      {(close) => (
        <>
          <Link role="menuitem" to={childPath} className={item} onClick={close}>
            All {pluralise(noun)} as a table
          </Link>
          <Link role="menuitem" to={tablePath} className={item} onClick={close}>
            {pluralise(typeNoun[0]!.toUpperCase() + typeNoun.slice(1))} as a table
          </Link>
        </>
      )}
    </PopMenu>
  );
}

/** A ⋯ that opens a small menu on the screen, closing on a tap away or Esc. */
function PopMenu({ label, children, size = "sm" }: { label: string; children: (close: () => void) => ReactNode; size?: "sm" | "md" }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!layer.current?.contains(t) && !trigger.current?.contains(t)) setAt(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [at]);
  useEscapeToClose(!!at, layer, () => setAt(null));
  const close = () => setAt(null);
  return (
    <>
      <button
        title={label}
        ref={trigger}
        type="button"
        onClick={() => setAt((cur) => (cur ? null : trigger.current?.getBoundingClientRect() ?? null))}
        aria-label={label}
        aria-expanded={!!at}
        className={`${size === "md" ? "w-11 h-11" : "w-9 h-9"} grid place-items-center rounded-md border border-line dark:border-slate-700 text-muted`}
      >
        <MoreHorizontal size={16} />
      </button>
      {at &&
        createPortal(
          <PopoverLayer
            ref={layer}
            role="menu"
            flipAbove={at.top}
            style={{ top: at.bottom + 4, left: Math.max(8, at.right - 224), width: 224 }}
            className="z-[70] rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg py-1 text-sm"
          >
            {children(close)}
          </PopoverLayer>,
          document.body,
        )}
    </>
  );
}

export function FamilyPage({ childPath, tablePath }: { childPath: string; tablePath: string }) {
  const { api, instance } = useInventory();
  const qc = useQueryClient();
  const [spoolmanOpen, setSpoolmanOpen] = useState(false);
  const [params] = useSearchParams();
  const highlight = params.get("highlight");
  const [view, setView] = useState<View>("all");
  const [adding, setAdding] = useState<{ type: string | null } | null>(null);
  const q = useQuery({ queryKey: ["inventory-family"], queryFn: () => api.familyAll() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  const places = useMemo(() => new Map((locs.data?.items ?? []).map((l) => [l.id, l.name])), [locs.data]);
  const data = q.data;
  if (!data) return <div className="text-sm text-muted p-4">{q.isError ? "Couldn't load this." : "Loading…"}</div>;
  const noun = data.child_noun ?? "item";
  const typeNoun = data.parent_noun ?? "type";
  const shown = view === "low" ? data.types.filter((t) => t.low) : data.types;
  const groups = new Map<string, FamilyType[]>();
  for (const t of shown) groups.set(groupKey(t, view), [...(groups.get(groupKey(t, view)) ?? []), t]);
  const chip = (v: View, label: string) => (
    <button
      type="button"
      onClick={() => setView(v)}
      aria-pressed={view === v}
      className={`px-2.5 py-1 rounded-full text-xs border ${view === v ? "bg-cobble-600 text-white border-cobble-600" : "border-line dark:border-slate-700 text-muted"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-3" data-testid="family-page">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 min-w-0 text-sm text-muted dark:text-slate-400" data-testid="family-counts">
          {countOf(data.counts.children, noun)} · {countOf(data.counts.types, typeNoun)}
          {data.counts.low ? ` · ${data.counts.low} low` : ""}
          {data.complete === false && data.shown && (
            <span className="block text-xs text-amber-700 dark:text-amber-300" data-testid="family-partial">
              Showing {data.shown.children} of {countOf(data.counts.children, noun)} and {data.shown.types} of {countOf(data.counts.types, typeNoun)}. Every one is in the{" "}
              <Link to={`/instances/${encodeURIComponent(data.child)}`} className="underline">{pluralise(noun)}</Link> and{" "}
              <Link to={`/instances/${encodeURIComponent(data.parent)}`} className="underline">{pluralise(typeNoun)}</Link> tables.
            </span>
          )}
        </span>
        <button type="button" onClick={() => setAdding({ type: null })} className="px-3 py-1.5 rounded-md text-sm bg-cobble-600 text-white">
          + {noun[0]!.toUpperCase() + noun.slice(1)}
        </button>
        {instance === "filament-types" && <button type="button" onClick={() => setSpoolmanOpen(true)} className="rounded border border-line px-3 py-1.5 text-sm">Spoolman</button>}
        <MoreMenu childPath={childPath} tablePath={tablePath} noun={noun} typeNoun={typeNoun} />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="View">
        {chip("all", "All")}
        {!data.package_receiving && chip("material", "By material")}
        {!data.package_receiving && chip("colour", "By colour")}
        {chip("low", "Low")}
      </div>
      {data.package_receiving && <ReceivePackage data={data} />}
      {instance === "filament-types" && <FilamentCatalog />}
      {spoolmanOpen && <SpoolmanModal instance={data.child} onClose={() => setSpoolmanOpen(false)} onSynced={() => { void qc.invalidateQueries({ queryKey: ["inventory-family"] }); }} />}
      {adding && <AddForm data={data} initialType={adding.type} onDone={() => setAdding(null)} />}
      {[...groups.entries()].map(([key, types]) => (
        <div key={key || "all"} className="space-y-2">
          {key && (
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-faint pt-1">
              {view === "colour" && colorSwatch(key) ? <TypeSwatch value={key} /> : null}
              {view === "colour" && colorSwatch(key) ? "" : key}
            </div>
          )}
          {types.map((t) => (
            <TypeCard key={t.id} type={t} data={data} childPath={childPath} places={places} highlight={highlight} onAdd={(id) => setAdding({ type: id })} />
          ))}
        </div>
      ))}
      {shown.length === 0 && <p className="text-sm text-muted">{view === "low" ? "Nothing is low." : `No ${pluralise(typeNoun)} yet. Add ${withArticle(noun)} and name its ${typeNoun}.`}</p>}
      {data.unclaimed.length > 0 && view !== "low" && (
        <section className="rounded-xl border border-dashed border-line dark:border-slate-700 p-3 space-y-1" data-testid="family-unclaimed">
          <div className="text-xs text-muted">
            {countOf(data.unclaimed.length, noun)} with no {typeNoun} yet
          </div>
          <ul className="divide-y divide-line dark:divide-slate-800">
            {data.unclaimed.map((t) => (
              <ThingRow key={t.id} t={t} childInstance={data.child} childPath={childPath} place={t.location_name ?? (t.location_id ? (places.get(t.location_id) ?? null) : null)} highlighted={highlight === t.id} named noun={data.child_noun ?? "item"} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
