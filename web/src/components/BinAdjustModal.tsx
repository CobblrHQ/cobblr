// Single-SKU bin quick-adjust — the "bin of M3 screws" flow. The bin's QR is
// the only label anywhere (loose parts carry no codes), so scanning it should
// go STRAIGHT to "adding 10 / removing 5" of the one SKU that lives there,
// not to a filing flow. Taps accumulate into a pending delta ("200 → 210"),
// one Apply commits it (undo-able); "Set exact" covers a recount. The count
// shown and written is THIS BIN's row only — Cobblr multi-location keeps one
// row per location, so another bin of the same part is a different row.
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Minus, PackagePlus, Plus } from "lucide-react";
import { Modal, useImageSrc, useToast } from "@cobblr/platform-web";
import { api, ApiError, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function BinAdjustModal({
  locationId,
  locationName,
  item,
  onClose,
  onAddSomethingElse,
  inline,
}: {
  locationId: string;
  locationName: string;
  item: TrackedMatch;
  onClose?: () => void;
  /** "Add something else to this bin" — hands off to the filing flow (the bin
   *  may be becoming multi-SKU); the caller sets it as the active filing bin. */
  onAddSomethingElse?: () => void;
  /** Render as an embedded card (the location detail page) instead of a modal. */
  inline?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const [qty, setQty] = useState(item.qty ?? 0);
  // Session anchor (the author): the count this card OPENED at. Always visible once
  // anything changed, with a one-tap revert — so a fat-fingered apply whose
  // undo toast expired still has a known-good state to return to.
  const [startQty] = useState(item.qty ?? 0);
  const [delta, setDelta] = useState(0);
  const [exactOpen, setExactOpen] = useState(false);
  const [exact, setExact] = useState("");
  const img = useImageSrc(item.image_path ?? null);

  const target = useMemo(() => Math.max(0, qty + delta), [qty, delta]);

  const adjust = useMutation({
    mutationFn: (body: { delta?: number; set?: number }) =>
      api.binAdjust(activeSlug, locationId, {
        kind: item.kind,
        entity_id: item.id,
        instance: item.instance ?? undefined,
        ...body,
      }),
    onSuccess: (r, vars) => {
      setQty(r.new_qty);
      setDelta(0);
      setExactOpen(false);
      const applied = vars.set != null ? null : (vars.delta ?? 0);
      toast.action(
        vars.set != null
          ? `${r.entity_title}: counted ${r.new_qty} (was ${r.old_qty})`
          : `${applied! > 0 ? "+" : ""}${applied} ${r.entity_title} — now ${r.new_qty} in ${locationName}`,
        {
          actionLabel: "Undo",
          duration: 7000,
          onAction: async () => {
            const back = await api.binAdjust(activeSlug, locationId, {
              kind: item.kind,
              entity_id: item.id,
              instance: item.instance ?? undefined,
              set: r.old_qty,
            });
            setQty(back.new_qty);
          },
        },
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const chip = (n: number) => (
    <button
      key={n}
      type="button"
      disabled={adjust.isPending}
      onClick={() => setDelta((d) => d + n)}
      className={`rounded-full px-3 py-1.5 text-sm font-semibold border transition disabled:opacity-50 ${
        n > 0
          ? "border-emerald-400/70 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/25"
          : "border-ember-400/70 text-ember-700 dark:text-ember-300 hover:bg-ember-50 dark:hover:bg-ember-900/25"
      }`}
    >
      {n > 0 ? `+${n}` : n}
    </button>
  );

  const body = (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-20 h-20 shrink-0 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center">
            {img ? (
              <img src={img} alt="" className="w-full h-full object-cover" />
            ) : (
              <PackagePlus size={22} className="text-faint" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-content dark:text-mortar-100 leading-snug">{item.title}</div>
            {item.subtitle && <div className="text-xs text-muted truncate">{item.subtitle}</div>}
            <div className="text-[11px] font-mono uppercase tracking-widest text-muted mt-0.5">
              only {item.noun} in this bin
            </div>
          </div>
        </div>

        {/* The count, with the pending change staged big and obvious. */}
        <div className="text-center py-1">
          <span className="text-4xl font-bold tabular-nums text-content dark:text-mortar-100">{qty}</span>
          {delta !== 0 && (
            <span className={`text-2xl font-semibold tabular-nums ${delta > 0 ? "text-emerald-500" : "text-ember-500"}`}>
              {" "}→ {target}
            </span>
          )}
          <div className="text-[11px] font-mono uppercase tracking-widest text-muted mt-1">in {locationName}</div>
          {qty !== startQty && (
            <button
              type="button"
              disabled={adjust.isPending}
              onClick={() => adjust.mutate({ set: startQty })}
              title="Put the count back to what it was when this card opened"
              className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-600 px-2.5 py-0.5 text-[11px] text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
            >
              started at {startQty} · revert
            </button>
          )}
        </div>

        <div className="flex flex-wrap justify-center gap-1.5">{[1, 5, 10].map(chip)}</div>
        <div className="flex flex-wrap justify-center gap-1.5">{[-1, -5, -10].map(chip)}</div>

        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setDelta((d) => d - 1)}
            className="rounded-full border border-line dark:border-slate-600 p-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800"
            aria-label="Minus one"
          >
            <Minus size={14} />
          </button>
          <span className="text-sm tabular-nums w-14 text-center text-muted">
            {delta > 0 ? `+${delta}` : delta}
          </span>
          <button
            type="button"
            onClick={() => setDelta((d) => d + 1)}
            className="rounded-full border border-line dark:border-slate-600 p-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800"
            aria-label="Plus one"
          >
            <Plus size={14} />
          </button>
        </div>

        <button
          type="button"
          disabled={delta === 0 || adjust.isPending}
          onClick={() => adjust.mutate({ delta })}
          className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2.5 disabled:opacity-40"
        >
          {adjust.isPending
            ? "Saving…"
            : delta === 0
              ? "Tap +/− to adjust"
              : delta > 0
                ? `Add ${delta} (→ ${target})`
                : `Remove ${-delta} (→ ${target})`}
        </button>

        {exactOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(exact);
              if (Number.isInteger(n) && n >= 0) adjust.mutate({ set: n });
            }}
            className="flex items-center gap-2"
          >
            <input
              type="number"
              min={0}
              value={exact}
              onChange={(e) => setExact(e.target.value)}
              placeholder="counted…"
              autoFocus
              className="flex-1 px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 font-mono"
            />
            <button
              type="submit"
              disabled={adjust.isPending || exact === ""}
              className="rounded border border-line dark:border-slate-600 text-sm px-3 py-1.5 text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-40"
            >
              Set
            </button>
          </form>
        ) : (
          <div className="flex items-center justify-between text-xs">
            <button type="button" onClick={() => setExactOpen(true)} className="text-muted hover:text-content">
              Set exact count…
            </button>
            <span className="inline-flex items-center gap-2.5">
              {onAddSomethingElse && (
                <button
                  type="button"
                  title="This bin is getting a second SKU - switch to filing scans into it"
                  onClick={onAddSomethingElse}
                  className="text-accent hover:underline"
                >
                  + Add something else to this bin
                </button>
              )}
              {item.detail_url && (
                <button
                  type="button"
                  onClick={() => navigate(item.detail_url!)}
                  className="inline-flex items-center gap-1 text-muted hover:text-content"
                >
                  Open <ExternalLink size={11} />
                </button>
              )}
            </span>
          </div>
        )}
      </div>
  );
  if (inline) {
    return (
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 max-w-sm">
        {body}
      </div>
    );
  }
  return (
    <Modal open onClose={onClose ?? (() => {})} title={`Bin · ${locationName}`} size="sm">
      {body}
    </Modal>
  );
}
