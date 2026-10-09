// "Check my mailbox" (#5462): what the order rules would do across a whole
// mailbox, before any of it is filed. Per year and store, how each email was
// decided; the likely misses and false hits to review, each with "Is an
// order" / "Isn't an order", which the next check (and the live read, once
// it is on) remembers for that sender.

import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { downloadBlob, relativeTime, useToast } from "@cobblr/platform-web";
import { ApiError, api, type MailboxCheck, type MailboxCheckItem, type MailboxCheckList } from "../lib/api";
import { mailboxCheckWords, verdictWord } from "./mailboxCheckWords";

const LISTS: Array<{ id: MailboxCheckList; label: string; hint: string }> = [
  { id: "misses", label: "Likely misses", hint: "Gmail calls these purchases, and the rules did not file them." },
  { id: "false-hits", label: "Likely false hits", hint: "Filed on one weak sign alone." },
  { id: "ask-ai", label: "Would ask AI", hint: "Nothing decided these. The check asks no AI; live reading would." },
  { id: "orders", label: "Would file", hint: "Everything the rules would file." },
];

export function MailboxCheckPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const latest = useQuery({
    queryKey: ["mailbox-check", id],
    queryFn: () => api.latestMailboxCheck(id),
    refetchInterval: (q) => ((q.state.data as MailboxCheck | null | undefined)?.status === "running" ? 4000 : false),
  });
  const check = latest.data ?? null;
  const start = useMutation({
    mutationFn: () => api.startMailboxCheck(id, { after: after || null, before: before || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mailbox-check", id] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const stop = useMutation({
    mutationFn: () => api.stopMailboxCheck(id, check!.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mailbox-check", id] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const words = check ? mailboxCheckWords(check) : null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 space-y-5">
      <div>
        <Link to="/me/connections" className="text-xs text-accent hover:underline">Connections</Link>
        <h1 className="text-xl font-semibold text-content">Check my mailbox</h1>
        <p className="text-sm text-muted">
          Runs the order rules over your mailbox and shows what they would do. Nothing is filed and no AI is asked. Only the
          sender, subject, date and decision of each email are kept for this report.
        </p>
      </div>

      <section className="rounded border border-line dark:border-slate-700 p-3 space-y-2" aria-label="Run a check">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col text-xs text-muted">From (optional)<input type="date" value={after} onChange={(e) => setAfter(e.target.value)} className="rounded border border-line bg-surface px-2 py-1 text-sm text-content" /></label>
          <label className="flex flex-col text-xs text-muted">Until (optional)<input type="date" value={before} onChange={(e) => setBefore(e.target.value)} className="rounded border border-line bg-surface px-2 py-1 text-sm text-content" /></label>
          <button type="button" disabled={start.isPending || check?.status === "running"} onClick={() => start.mutate()} className="rounded bg-cobble-600 hover:bg-cobble-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {check?.status === "running" ? "Checking…" : check ? "Check again" : "Check my mailbox"}
          </button>
          {check?.status === "running" && (
            <button type="button" onClick={() => stop.mutate()} className="text-xs text-muted hover:text-content underline">Stop</button>
          )}
        </div>
        {check && words && (
          <div className="text-sm" data-testid="mailbox-check-progress">
            <p className="text-content">{words.progress}</p>
            {words.delta && <p className="text-xs text-muted">{words.delta}</p>}
            {check.last_error && check.status !== "done" && <p className="text-xs text-ember-600 dark:text-ember-400">{check.last_error}</p>}
            <p className="text-xs text-muted">Started {relativeTime(check.started_at)}. {words.decidedBy}</p>
          </div>
        )}
      </section>

      {check && check.seen > 0 && <YearsAndStores id={id} check={check} />}
      {check && check.seen > 0 && <Review id={id} check={check} />}
    </div>
  );
}

function YearsAndStores({ id, check }: { id: string; check: MailboxCheck }) {
  const rows = useQuery({ queryKey: ["mailbox-check-stores", check.id, check.seen], queryFn: () => api.mailboxCheckStores(id, check.id) });
  const byYear = new Map<string, NonNullable<typeof rows.data>["items"]>();
  for (const r of rows.data?.items ?? []) {
    const y = r.year ? String(r.year) : "Undated";
    byYear.set(y, [...(byYear.get(y) ?? []), r]);
  }
  return (
    <section aria-label="By year and store" className="space-y-2">
      <h2 className="text-sm font-semibold text-content">By year and store</h2>
      {[...byYear.entries()].map(([year, stores]) => {
        const sum = (k: "candidates" | "orders" | "shipments" | "not_orders" | "ask_ai") => stores.reduce((n, s) => n + s[k], 0);
        return (
          <details key={year} className="rounded border border-line dark:border-slate-700">
            <summary className="cursor-pointer px-3 py-2 text-sm text-content">
              {year}: {sum("candidates")} emails · {sum("orders")} orders · {sum("shipments")} parcels · {sum("not_orders")} not orders · {sum("ask_ai")} would ask AI
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted"><tr><th className="text-left px-3 py-1">Store</th><th>Emails</th><th>Orders</th><th>Parcels</th><th>Not orders</th><th>Would ask AI</th><th>Markup</th><th>Store platform</th><th>Rules</th><th>Your verdict</th></tr></thead>
                <tbody>
                  {stores.map((s) => (
                    <tr key={s.store} className="border-t border-line dark:border-slate-800 text-center">
                      <td className="text-left px-3 py-1 font-mono">{s.store}</td><td>{s.candidates}</td><td>{s.orders}</td><td>{s.shipments}</td><td>{s.not_orders}</td><td>{s.ask_ai}</td><td>{s.by_schema}</td><td>{s.by_platform}</td><td>{s.by_heuristics}</td><td>{s.by_remembered}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </section>
  );
}

function Review({ id, check }: { id: string; check: MailboxCheck }) {
  const [list, setList] = useState<MailboxCheckList>("misses");
  const [offset, setOffset] = useState(0);
  const qc = useQueryClient();
  const toast = useToast();
  const items = useQuery({ queryKey: ["mailbox-check-items", check.id, list, offset, check.seen], queryFn: () => api.mailboxCheckItems(id, check.id, list, offset) });
  const mark = useMutation({
    mutationFn: ({ item, isOrder }: { item: MailboxCheckItem; isOrder: boolean }) => api.markMailboxCheckItem(id, check.id, item.gmail_id, isOrder),
    onSuccess: (out, { isOrder }) => {
      toast.success(out.remembered_for ? `Remembered: mail from ${out.remembered_for} ${isOrder ? "is" : "isn't"} an order.` : "Saved.");
      void qc.invalidateQueries({ queryKey: ["mailbox-check-items", check.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const exportMarked = async () => {
    const out = await api.markedMailboxCheckItems(id, check.id);
    downloadBlob(new Blob([JSON.stringify(out.items, null, 2)], { type: "application/json" }), `mailbox-check-marked-${check.id.slice(0, 8)}.json`);
  };
  const hint = LISTS.find((l) => l.id === list)?.hint;
  return (
    <section aria-label="Review" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-content mr-2">Review</h2>
        {LISTS.map((l) => (
          <button key={l.id} type="button" onClick={() => { setList(l.id); setOffset(0); }} className={`rounded-full border px-2.5 py-0.5 text-xs ${list === l.id ? "border-accent text-accent" : "border-line text-muted hover:text-content"}`}>
            {l.label}
          </button>
        ))}
        <button type="button" onClick={() => void exportMarked()} className="ml-auto text-xs text-accent hover:underline">Download the ones you marked</button>
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      <ul className="divide-y divide-line dark:divide-slate-800 rounded border border-line dark:border-slate-700">
        {(items.data?.items ?? []).map((it) => (
          <li key={it.gmail_id} className="px-3 py-2 text-sm flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-content">{it.subject ?? "(no subject)"}</p>
              <p className="text-xs text-muted truncate">
                {it.sender ?? "unknown sender"} · {it.received_at ? new Date(it.received_at).toLocaleDateString() : "undated"} · {verdictWord(it)}
                {it.found.orderNumber ? ` · order ${it.found.orderNumber}` : ""}
                {it.found.tracking?.[0] ? ` · ${it.found.tracking[0].number}` : ""}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button type="button" disabled={mark.isPending} onClick={() => mark.mutate({ item: it, isOrder: true })} className={`rounded border px-2 py-0.5 text-xs ${it.person_verdict === "order" ? "border-accent text-accent" : "border-line text-muted hover:text-content"}`}>Is an order</button>
              <button type="button" disabled={mark.isPending} onClick={() => mark.mutate({ item: it, isOrder: false })} className={`rounded border px-2 py-0.5 text-xs ${it.person_verdict === "not-order" ? "border-accent text-accent" : "border-line text-muted hover:text-content"}`}>Isn't an order</button>
            </div>
          </li>
        ))}
        {items.data && items.data.items.length === 0 && <li className="px-3 py-3 text-sm text-muted">Nothing in this list.</li>}
      </ul>
      {items.data && items.data.total > items.data.limit && (
        <div className="flex gap-3 text-xs">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} className="text-accent disabled:text-faint">Newer</button>
          <span className="text-muted">{offset + 1} to {Math.min(offset + 50, items.data.total)} of {items.data.total}</span>
          <button type="button" disabled={offset + 50 >= items.data.total} onClick={() => setOffset(offset + 50)} className="text-accent disabled:text-faint">Older</button>
        </div>
      )}
    </section>
  );
}
