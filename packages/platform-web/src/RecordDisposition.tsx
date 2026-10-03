// What became of a thing that is no longer yours, on its own page.
//
// A record that left (sold, given away, thrown out) says so in one line above
// its fields: "Sold 2026-09-12 for $180 to Vince · kept 3 years 2 months",
// with Bring back beside it. A record that is still yours offers "No longer
// mine…", which asks how it left and when. Both run the kernel's actions
// (platform:mark-gone / platform:bring-back), the same ones the assistant
// uses, so the page, a chat and a sheet import all leave a record the same way.
//
// Placed once by the platform; a detail page only says which record it is.

import { useState } from "react";
import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";
import { useQuery } from "@tanstack/react-query";
import { Gift, HandCoins, Undo2 } from "lucide-react";
import { readRecordOffer } from "@cobblr/platform-contract/share-offer";
import { centsFromAmount, formatMoney } from "@cobblr/platform-contract/money";
import { dayHere } from "@cobblr/platform-contract/day";
import {
  DISPOSITIONS,
  DISPOSITION_LABELS,
  readRecordDisposition,
  sayDisposition,
  type Disposition,
} from "@cobblr/platform-contract/disposition";
import { usePlatformWeb } from "./context";
import { Modal } from "./Modal";
import { MoneyInput } from "./MoneyInput";
import { useToast } from "./ToastContext";
import { useRunAction } from "./run-action";

const money = (n: number) => formatMoney(centsFromAmount(n));
const PRICED: ReadonlySet<Disposition> = new Set(["sold", "traded"]);
const HOW_LABEL: Record<Disposition, string> = { ...DISPOSITION_LABELS, scrapped: "thrown out or disposed of" };

export function RecordDisposition({
  kind,
  id,
  onChanged,
  className,
}: {
  kind: string;
  id: string;
  /** The page's own record query, refetched after a change (it leaves or
   *  rejoins the lists, and its header chips follow). */
  onChanged?: () => void;
  className?: string;
}) {
  const { api, orgSlug } = usePlatformWeb();
  // PRESS-ARGS: the form above asks how it left (the one required answer) before mark-gone runs, and bring-back needs only the record this page is.
  const runAction = useRunAction();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["record-disposition", orgSlug, kind, id], queryFn: () => api.lookupEntity(orgSlug, kind, id), staleTime: 30_000 });
  const [asking, setAsking] = useState(false);
  const [giving, setGiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const shares = useQuery({
    queryKey: ["share-offers", orgSlug],
    queryFn: () => api.listShareOffers!(orgSlug),
    enabled: !!api.listShareOffers,
    staleTime: 60_000,
  });
  if (!data) return null;
  const recordMeta = (data.fields as { metadata?: unknown }).metadata ?? data.fields;
  const gone = readRecordDisposition(recordMeta);
  const offered = readRecordOffer(recordMeta);
  const targets = shares.data?.targets ?? [];

  // The door refreshes what the action touched: a workspace action refreshes
  // every query, which is right here, since the record leaves (or rejoins)
  // every list, total and count on screen.
  const changed = () => onChanged?.();
  const run = async (actionId: string, args: Record<string, unknown>) => {
    const r = await runAction({ actionId, entityKind: kind, entityId: id, args: { entity_kind: kind, ids: [id], ...args } });
    const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
    if (!res?.ok) throw Object.assign(new Error(res?.error ?? "That did not go through."), { blocked: (res as { blocked?: unknown } | null)?.blocked });
    return res.summary ?? "Done.";
  };

  if (gone) {
    return (
      <div
        data-testid="record-disposition"
        className={`order-first flex w-full basis-full flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2 text-sm text-content dark:border-slate-600 ${className ?? ""}`}
      >
        <HandCoins size={14} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          {sayDisposition(gone, money)}
          {gone.note && <span className="block text-xs text-muted">{gone.note}</span>}
        </span>
        <button
          type="button"
          disabled={busy}
          data-testid="bring-back"
          onClick={async () => {
            setBusy(true);
            try {
              toast.success(await run("platform:bring-back", {}));
              changed();
            } catch (e) {
              // Refused with a reason (a thing someone else has now, #4736):
              // the refusal sheet says who and what brings it back, where a
              // toast would be gone before it was read.
              const blocked = (e as { blocked?: BlockedAction }).blocked;
              if (blocked && api.raiseBlocked) api.raiseBlocked(blocked);
              else toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600"
        >
          <Undo2 size={12} aria-hidden />
          Bring back
        </button>
      </div>
    );
  }

  if (offered) {
    return (
      <div data-testid="record-offered" className={`order-first flex w-full basis-full flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2 text-sm text-content dark:border-slate-600 ${className ?? ""}`}>
        <Gift size={14} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">Offered to {offered.to}. When they take it, it is marked given away to them.</span>
        {api.withdrawShareOffer && (
          <button
            type="button"
            disabled={busy}
            data-testid="withdraw-offer"
            onClick={async () => {
              setBusy(true);
              try {
                await api.withdrawShareOffer!(orgSlug, offered.offer_id);
                toast.success("Withdrawn.");
                await shares.refetch();
                changed();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600"
          >
            Withdraw
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {targets.length > 0 && (
        <button
          type="button"
          data-testid="give-to"
          onClick={() => setGiving(true)}
          className={`order-last inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600 ${className ?? ""}`}
        >
          <Gift size={12} aria-hidden />
          Give to…
        </button>
      )}
      <Modal open={giving} onClose={() => setGiving(false)} title={`Give ${data.title} to someone`} size="sm">
        {giving && (
          <GiveForm
            targets={targets}
            onCancel={() => setGiving(false)}
            onGive={async (to) => {
              const said = await run("platform:offer-to", { to });
              setGiving(false);
              toast.success(said);
              changed();
            }}
          />
        )}
      </Modal>
      <button
        type="button"
        data-testid="mark-gone"
        onClick={() => setAsking(true)}
        className={`order-last inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600 ${className ?? ""}`}
      >
        <HandCoins size={12} aria-hidden />
        No longer mine…
      </button>
      <Modal open={asking} onClose={() => setAsking(false)} title={`What happened to ${data.title}?`} size="sm">
        {asking && (
          <GoneForm
            onCancel={() => setAsking(false)}
            onSave={async (args) => {
              const said = await run("platform:mark-gone", args);
              setAsking(false);
              toast.success(said, {
                actionLabel: "Undo",
                onAction: async () => {
                  await run("platform:bring-back", {});
                  changed();
                },
              });
              changed();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function GiveForm({ targets, onCancel, onGive }: { targets: Array<{ link_id: string; to: string }>; onCancel: () => void; onGive: (to: string) => Promise<void> }) {
  const [to, setTo] = useState(targets[0]?.link_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = targets.find((t) => t.link_id === to)?.to ?? "them";
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onGive(to);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {targets.length > 1 && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">To</span>
          <select data-testid="give-to-who" className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-content dark:border-slate-600" value={to} onChange={(e) => setTo(e.target.value)}>
            {targets.map((t) => (
              <option key={t.link_id} value={t.link_id}>
                {t.to}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-sm text-content">
        It arrives in {who}'s scan inbox, where they take it, pass, or leave it for later. When they take it, it is marked given away to them here, with its history kept.
      </p>
      {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="submit" disabled={busy || !to} data-testid="give-to-send" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Offering…" : `Offer to ${who}`}
        </button>
      </div>
    </form>
  );
}

function GoneForm({ onCancel, onSave }: { onCancel: () => void; onSave: (args: Record<string, unknown>) => Promise<void> }) {
  const [how, setHow] = useState<Disposition>("sold");
  const [on, setOn] = useState<string>(() => dayHere(new Date()));
  const [price, setPrice] = useState<number | null>(null);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-content dark:border-slate-600";
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave({ how, on, ...(PRICED.has(how) && price !== null ? { price } : {}), ...(to.trim() ? { to } : {}), ...(note.trim() ? { note } : {}) });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">It was</span>
        <select data-testid="gone-how" className={input} value={how} onChange={(e) => setHow(e.target.value as Disposition)}>
          {DISPOSITIONS.map((d) => (
            <option key={d} value={d}>
              {HOW_LABEL[d]}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">On</span>
        <input type="date" className={input} value={on} onChange={(e) => setOn(e.target.value)} />
      </label>
      {PRICED.has(how) && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">For</span>
          <MoneyInput value={price} storage="amount" live onCommit={setPrice} placeholder="Price" ariaLabel="Price" className="w-full" />
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">To</span>
        <input data-testid="gone-to" className={input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="Who has it now (optional)" />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-content">Note</span>
        <input className={input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </label>
      <p className="text-xs text-muted">It leaves your lists and totals. Its history, photos and labels are kept, and Bring back undoes it.</p>
      {error && <p className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="submit" disabled={busy} data-testid="gone-save" className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
