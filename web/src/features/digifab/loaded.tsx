// Loaded filament: the spools on this printer, one per slot. Contributed by
// digifab onto a machine's page through the panel seam.
//
// A printer is a place: a loaded spool is IN it (placement), in a numbered
// slot. Loading a spool into a full slot sends the one there back to its own
// shelf. A finished print takes each filament's grams off the spool in its
// slot, so the job needs no spool picked.
//
// Three ways to load: Load… on a slot (search your things), Scan a spool (the
// camera, for a phone), or a scanner gun: while this page is open, a scanned
// spool label loads it instead of opening its page.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, SearchInput, useToast } from "@cobblr/platform-web";
import { api, ApiError, type DigifabLoaded, type PlatformResolvedEntity } from "../../lib/api";
import { resolveScannedThing, useScanTarget, type ScannedThing } from "../../lib/scanTarget";
import { ScanOneSheet } from "../../components/ScanOneSheet";
import type { EntityDetailPanelCtx } from "../../panels/types";

const SLOT_CHOICES = [1, 2, 3, 4, 5, 6, 8, 12, 16];

function amount(t: PlatformResolvedEntity): string | null {
  const q = Number(t.fields?.qty);
  if (!Number.isFinite(q)) return null;
  const unit = typeof t.fields?.unit === "string" && t.fields.unit !== "each" ? ` ${t.fields.unit}` : "";
  return `${parseFloat(q.toFixed(3))}${unit} left`;
}

export function LoadedSpoolsPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const { slug, entityId: machineId } = ctx;
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["digifab-loaded", slug, machineId];
  const q = useQuery({ queryKey: key, queryFn: () => api.digifabLoaded(slug, machineId) });
  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), staleTime: 300_000 });
  const [picking, setPicking] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);

  const set = (next: DigifabLoaded) => qc.setQueryData(key, next);
  const isThing = (kind: string) => kind === "inventory:part" || kinds.data?.items.find((k) => k.id === kind)?.module_name === "inventory";

  const load = async (thing: ScannedThing, slot?: string): Promise<string> => {
    const out = await api.digifabLoad(slug, machineId, thing.id, slot);
    set(out);
    const name = out.loaded.find((l) => l.slot === out.slot)?.thing.title ?? (thing.label || "it");
    const back = out.returned[0];
    return back
      ? `Loaded ${name} in slot ${out.slot}. ${back.thing.title ?? "The one it replaced"} went back${back.to?.title ? ` to ${back.to.title}` : ""}.`
      : `Loaded ${name} in slot ${out.slot}.`;
  };

  // A scanner gun: a spool's label scanned while this page is open loads it.
  useScanTarget(q.data ? { takes: isThing, take: (t) => load(t) } : null);

  const unload = async (slot: string) => {
    try {
      const out = await api.digifabUnload(slug, machineId, slot);
      set(out);
      toast.success(out.to?.title ? `Back to ${out.to.title}.` : "Taken off the printer.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const scanned = async (code: string, slot: string) => {
    setScanning(null);
    const thing = await resolveScannedThing(slug, code);
    if (!thing || !isThing(thing.kind)) {
      toast.error("That code isn't a spool here.");
      return;
    }
    try {
      toast.success(await load(thing, slot || undefined));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!q.data) return null;
  const { slots, loaded } = q.data;
  const bySlot = new Map(loaded.map((l) => [l.slot, l.thing]));
  const firstEmpty = Array.from({ length: slots }, (_, i) => String(i + 1)).find((s) => !bySlot.has(s)) ?? "1";

  return (
    <section className="rounded-lg border border-line dark:border-slate-700" data-testid="loaded-spools">
      <header className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line dark:border-slate-700">
        <h3 className="flex-1 text-sm font-semibold text-content dark:text-mortar-100">Loaded filament</h3>
        <label className="text-xs text-muted dark:text-slate-400">
          Slots{" "}
          <select
            className="input h-8 py-0 w-16"
            value={slots}
            aria-label="Filament slots"
            onChange={async (e) => {
              try {
                set(await api.digifabSetSlots(slug, machineId, Number(e.target.value)));
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : String(err));
              }
            }}
          >
            {[...new Set([...SLOT_CHOICES, slots])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="h-8 px-3 rounded-md bg-cobble-600 text-white text-xs" onClick={() => setScanning(firstEmpty)}>
          Scan a spool
        </button>
      </header>
      <ul className="divide-y divide-line dark:divide-slate-700">
        {Array.from({ length: slots }, (_, i) => String(i + 1)).map((slot) => {
          const t = bySlot.get(slot);
          return (
            <li key={slot} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid="loaded-slot">
              <span className="w-14 shrink-0 font-mono text-xs text-muted dark:text-slate-400">{slots > 1 ? `Slot ${slot}` : "Loaded"}</span>
              {t ? (
                <>
                  {t.detailUrl ? (
                    <Link to={t.detailUrl} className="flex-1 min-w-0 basis-40 truncate text-content dark:text-mortar-100 hover:text-accent">
                      {t.title}
                    </Link>
                  ) : (
                    <span className="flex-1 min-w-0 basis-40 truncate">{t.title}</span>
                  )}
                  {amount(t) && <span className="font-mono text-xs text-muted dark:text-slate-400">{amount(t)}</span>}
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => setPicking(slot)}>
                    Swap
                  </button>
                  <button type="button" className="text-xs text-muted hover:text-content" onClick={() => void unload(slot)}>
                    Take off
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-faint dark:text-slate-500 italic">Nothing loaded</span>
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => setPicking(slot)}>
                    Load…
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="px-3 py-2 text-[11px] text-muted dark:text-slate-400 border-t border-line dark:border-slate-700">
        A finished print takes each filament's grams off the spool in its slot. With a scanner, scan a spool's label while this page is open to load it.
      </p>
      <PickThing
        open={picking != null}
        slug={slug}
        slot={picking ?? "1"}
        onClose={() => setPicking(null)}
        onPick={async (t) => {
          const slot = picking ?? undefined;
          setPicking(null);
          try {
            toast.success(await load({ kind: t.kind, id: t.id, label: t.title }, slot));
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        }}
        onScan={() => {
          setScanning(picking ?? firstEmpty);
          setPicking(null);
        }}
      />
      <ScanOneSheet
        open={scanning != null}
        title={`Scan a spool for slot ${scanning ?? firstEmpty}`}
        hint="Point the camera at the spool's label."
        onCode={(code) => void scanned(code, scanning ?? "")}
        onClose={() => setScanning(null)}
      />
    </section>
  );
}

function PickThing({ open, slug, slot, onClose, onPick, onScan }: { open: boolean; slug: string; slot: string; onClose: () => void; onPick: (t: PlatformResolvedEntity) => void; onScan: () => void }) {
  const [text, setText] = useState("");
  const found = useQuery({
    queryKey: ["loaded-pick", slug, text],
    queryFn: () => api.listEntities(slug, "inventory:part", text.trim() || undefined),
    enabled: open,
    staleTime: 10_000,
  });
  return (
    <Modal open={open} onClose={onClose} title={`Load slot ${slot}`} size="sm">
      <div className="space-y-2" data-testid="loaded-pick">
        <div className="flex gap-2">
          <SearchInput wrapperClassName="flex-1" autoFocus placeholder="Search your spools" aria-label="Search your spools" value={text} onChange={setText} />
          <button type="button" className="px-3 rounded-md border border-line dark:border-slate-700 text-sm" onClick={onScan}>
            Scan
          </button>
        </div>
        <ul className="max-h-72 overflow-y-auto divide-y divide-line dark:divide-slate-700">
          {(found.data?.items ?? []).slice(0, 50).map((t) => (
            <li key={t.id}>
              <button type="button" className="w-full text-left px-2 py-2 text-sm hover:bg-subtle dark:hover:bg-slate-800" onClick={() => onPick(t)}>
                <span className="block truncate">{t.title}</span>
                {(amount(t) || t.subtitle) && <span className="block text-xs text-muted dark:text-slate-400 truncate">{[amount(t), t.subtitle].filter(Boolean).join(" · ")}</span>}
              </button>
            </li>
          ))}
          {found.data && found.data.items.length === 0 && <li className="px-2 py-3 text-sm text-muted">Nothing matches.</li>}
        </ul>
      </div>
    </Modal>
  );
}
