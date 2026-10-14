// Single-SKU bin quick-adjust — the "bin of M3 screws" flow. The bin's QR is
// the only label anywhere (loose parts carry no codes), so scanning it should
// go STRAIGHT to "adding 10 / removing 5" of the one SKU that lives there,
// not to a filing flow. One row, −10 −5 −1 [count] +1 +5 +10: taps move the
// count in the middle, typing over it is a recount, and one Apply commits
// either (undo-able). The count
// shown and written is THIS BIN's row only — Cobblr multi-location keeps one
// row per location, so another bin of the same part is a different row.
import { useState } from "react";
import { useKindLabels } from "../lib/useKindLabels";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ExternalLink, PackagePlus } from "lucide-react";
import { Modal, useImageSrc, useToast, EntityPhoto } from "@cobblr/platform-web";
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
  // "the only book in this bin", by the collection's own noun; the match
  // carries the module's ("part"), which is wrong for a book (2026-09-12).
  const labels = useKindLabels(activeSlug);
  const toast = useToast();
  const navigate = useNavigate();
  const [qty, setQty] = useState(item.qty ?? 0);
  // Session anchor (the author): the count this card OPENED at. Always visible once
  // anything changed, with a one-tap revert — so a fat-fingered apply whose
  // undo toast expired still has a known-good state to return to.
  const [startQty] = useState(item.qty ?? 0);
  // One number in the middle of the row: the count, and what it will be. A tap
  // moves it, typing replaces it. What is typed is a recount (set); what is
  // tapped is a change (delta), so the history says which it was.
  const [draft, setDraft] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  const img = useImageSrc(item.image_path ?? null);

  const shown = draft ?? String(qty);
  const parsed = draft == null ? qty : Number(draft.trim());
  // A recount is a whole number; a tap on a fractional count (2.5 m) keeps
  // its fraction, since the change itself is whole.
  const valid = draft == null || (draft.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && (!typed || Number.isInteger(parsed)));
  const target = valid ? parsed : qty;
  const pending = draft != null && valid && target !== qty;
  const clear = () => {
    setDraft(null);
    setTyped(false);
  };

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
      clear();
      const applied = vars.set != null ? null : (vars.delta ?? 0);
      toast.action(
        vars.set != null
          ? `${r.entity_title}: counted ${r.new_qty} (was ${r.old_qty})`
          : `${applied! > 0 ? "+" : ""}${applied} ${r.entity_title}, now ${r.new_qty} in ${locationName}`,
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
  const apply = () => {
    if (!pending || adjust.isPending) return;
    adjust.mutate(typed ? { set: target } : { delta: target - qty });
  };

  const chip = (n: number) => (
    <button
      key={n}
      type="button"
      disabled={adjust.isPending}
      onClick={() => setDraft(String(Math.max(0, target + n)))}
      aria-label={n > 0 ? `Add ${n}` : `Remove ${-n}`}
      className={`min-h-11 min-w-0 rounded-full text-sm font-semibold border tabular-nums transition disabled:opacity-50 ${
        n > 0
          ? "border-emerald-400/70 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/25"
          : "border-ember-400/70 text-ember-700 dark:text-ember-300 hover:bg-ember-50 dark:hover:bg-ember-900/25"
      }`}
    >
      {n > 0 ? `+${n}` : `−${-n}`}
    </button>
  );

  const body = (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-20 h-20 shrink-0 rounded-md overflow-hidden border border-line dark:border-slate-700">
            <EntityPhoto src={img} alt="" size={80} placeholder={<PackagePlus size={22} className="text-faint" />} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-content dark:text-mortar-100 leading-snug">{item.title}</div>
            {item.subtitle && <div className="text-xs text-muted truncate">{item.subtitle}</div>}
            <div className="text-[11px] uppercase tracking-widest text-muted mt-0.5">
              the only {labels.noun(item.kind)} in this bin
            </div>
          </div>
        </div>

        {/* −10 −5 −1 [count] +1 +5 +10: the count in the middle is what is in
            this place now, and you can type over it for a recount. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div
            data-testid="stock-row"
            className="grid grid-cols-[repeat(3,minmax(0,1fr))_minmax(3.75rem,1.4fr)_repeat(3,minmax(0,1fr))] items-center gap-1"
          >
            {[-10, -5, -1].map(chip)}
            <input
              type="text"
              inputMode="numeric"
              aria-label={`Count in ${locationName}`}
              aria-invalid={!valid}
              value={shown}
              disabled={adjust.isPending}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                setDraft(e.target.value);
                setTyped(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") clear();
              }}
              className={`min-h-11 w-full min-w-0 rounded-md border bg-surface dark:bg-slate-900 text-center text-2xl font-bold tabular-nums text-content dark:text-mortar-100 ${
                valid ? (pending ? "border-accent" : "border-line dark:border-slate-600") : "border-ember-500"
              }`}
            />
            {[1, 5, 10].map(chip)}
          </div>
          <div className="mt-1 text-center text-[11px] uppercase tracking-widest text-muted">
            {!valid ? (
              <span className="text-ember-600 dark:text-ember-300 normal-case tracking-normal">A count is a whole number, 0 or more</span>
            ) : pending ? (
              <>in {locationName}: {qty} now</>
            ) : (
              <>in {locationName}</>
            )}
          </div>

          {pending && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="submit"
                disabled={adjust.isPending}
                className="flex-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2.5 disabled:opacity-40"
              >
                {adjust.isPending
                  ? "Saving…"
                  : typed
                    ? `Set to ${target} (was ${qty})`
                    : target > qty
                      ? `Add ${target - qty} (→ ${target})`
                      : `Remove ${qty - target} (→ ${target})`}
              </button>
              <button
                type="button"
                onClick={clear}
                className="rounded-md border border-line dark:border-slate-600 px-3 py-2.5 text-sm text-muted hover:text-content"
              >
                Cancel
              </button>
            </div>
          )}
        </form>

        {qty !== startQty && !pending && (
          <div className="text-center">
            <button
              type="button"
              disabled={adjust.isPending}
              onClick={() => adjust.mutate({ set: startQty })}
              title="Put the count back to what it was when this card opened"
              className="inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-600 px-2.5 py-0.5 text-[11px] text-muted hover:text-content hover:border-accent transition disabled:opacity-50"
            >
              started at {startQty} · revert
            </button>
          </div>
        )}

        {(onAddSomethingElse || item.detail_url) && (
          <div className="flex items-center justify-end gap-2.5 text-xs">
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
