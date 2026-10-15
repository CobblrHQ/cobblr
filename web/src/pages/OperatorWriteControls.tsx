import { countOf } from "@cobblr/platform-contract/plural";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { JsonField, Modal, NumberField, useConfirm, useToast } from "@cobblr/platform-web";
import { api } from "../lib/api";

const field = "input w-full";
const primary = "inline-flex min-h-11 items-center justify-center rounded bg-cobble-600 px-3 py-2 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-50";
const secondary = "inline-flex min-h-11 items-center justify-center rounded border border-line px-3 py-2 text-sm text-content hover:bg-subtle dark:border-slate-700 dark:text-mortar-100 disabled:opacity-50";
const words = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function DemoWorkspaceControl() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("Demo workspace");
  const [days, setDays] = useState(7);
  const [unlocks, setUnlocks] = useState("");
  const [blueprint, setBlueprint] = useState<unknown>(null);
  const [seed, setSeed] = useState(false);
  const [validBlueprint, setValidBlueprint] = useState(true);
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api.provisionDemo({ email: email.trim(), name: name.trim(), expiresInDays: days, unlock: words(unlocks), ...(seed && blueprint ? { blueprint } : {}) }),
    onSuccess: (r) => { toast.success(`Demo created: ${r.slug}`); setOpen(false); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't create demo"),
  });
  return <>
    <button type="button" className={secondary} onClick={() => setOpen(true)}>Create demo workspace</button>
    {open && <Modal open title="Create demo workspace" onClose={() => setOpen(false)}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <p className="text-sm text-muted">The account must already exist. The demo expires automatically.</p>
        <label className="block">Account email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} /></label>
        <label className="block">Workspace name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className={field} /></label>
        <label className="block">Days before expiry<NumberField value={days} onChange={setDays} integer min={1} max={30} className={field} /></label>
        <label className="block">Trial unlocks<input value={unlocks} onChange={(e) => setUnlocks(e.target.value)} placeholder="Module names or feature keys, separated by commas" className={field} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={seed} onChange={(e) => setSeed(e.target.checked)} />Seed from a blueprint</label>
        {seed && <JsonField label="Blueprint" value={blueprint} onChange={(v, meta) => { setBlueprint(v); setValidBlueprint(meta.valid); }} rows={6} />}
        <button type="submit" className={primary} disabled={create.isPending || !email.trim() || !name.trim() || (seed && !validBlueprint)}>Create demo</button>
      </form>
    </Modal>}
  </>;
}

export function AccountNoticeControl({ workspaces = [] }: { workspaces?: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState("");
  const [users, setUsers] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const toast = useToast();
  const confirm = useConfirm();
  const ids = [...words(orgs), ...words(users)];
  const valid = ids.length > 0 && ids.every((id) => uuid.test(id)) && subject.trim() && message.trim();
  const send = useMutation({
    mutationFn: () => api.sendAccountNotice({ org_ids: words(orgs), user_ids: words(users), subject: subject.trim(), message: message.trim(), ...(link.trim() ? { link_url: link.trim() } : {}) }),
    onSuccess: (r) => { toast.success(`Notice sent to ${countOf(r.recipients, "recipient")}; ${r.emailed} emailed.`); setOpen(false); setMessage(""); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't send notice"),
  });
  return <>
    <button type="button" className={secondary} onClick={() => setOpen(true)}>Send account notice</button>
    {open && <Modal open title="Send account notice" onClose={() => setOpen(false)}>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (valid && await confirm({ title: "Send this account notice?", message: "This emails every selected person and all members of the selected workspaces, including people who opted out of other email.", confirmLabel: "Send notice" })) send.mutate(); }}>
        <p className="text-sm text-muted">For changes that affect access. Choose a workspace or paste recipient IDs, separated by commas. Duplicate recipients receive one notice.</p>
        {workspaces.length > 0 && <label className="block">Add a workspace<select className={field} value="" onChange={(e) => { if (e.target.value) setOrgs((old) => words(`${old},${e.target.value}`).join(", ")); }}>
          <option value="">Choose a workspace</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select></label>}
        <label className="block">Workspace IDs<textarea value={orgs} onChange={(e) => setOrgs(e.target.value)} className={field} /></label>
        <label className="block">User IDs<textarea value={users} onChange={(e) => setUsers(e.target.value)} className={field} /></label>
        <label className="block">Subject<input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} className={field} /></label>
        <label className="block">Message<textarea required maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} className={field} /></label>
        <label className="block">Link<input type="url" value={link} onChange={(e) => setLink(e.target.value)} className={field} /></label>
        <button type="submit" className={primary} disabled={send.isPending || !valid}>Send notice</button>
      </form>
    </Modal>}
  </>;
}

export function BatchFeedbackControl({ items, onResolved }: { items: Array<{ id: string; message: string }>; onResolved: () => void }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [summary, setSummary] = useState("");
  const [reply, setReply] = useState("");
  const [notify, setNotify] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const resolve = useMutation({
    mutationFn: () => api.resolveFeedbackBatch({ items: selected.map((id) => ({ id, public_summary: summary.trim() })), reply_message: reply.trim(), notify_reporter: notify }),
    onSuccess: (r) => {
      onResolved();
      if (r.missing.length) { setSelected(r.missing); toast.error(`Could not find ${countOf(r.missing.length, "report")}. Refresh the list before trying again.`); return; }
      toast.success("Reports resolved"); setSelected([]); setOpen(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't resolve reports"),
  });
  return <>
    <button type="button" className={secondary} disabled={!items.length} onClick={() => { setSelected([]); setOpen(true); }}>Resolve several reports</button>
    {open && <Modal open title="Resolve several reports" onClose={() => setOpen(false)}>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await confirm({ title: `Resolve ${countOf(selected.length, "report")}?`, message: notify ? "Each reporter receives one combined reply. Each newly resolved report gets its public resolution." : "No reporter reply will be sent. Each newly resolved report gets its public resolution.", confirmLabel: "Resolve reports" })) resolve.mutate(); }}>
        <div className="max-h-64 overflow-y-auto space-y-2">{items.map((item) => <label key={item.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && selected.length >= 50} onChange={(e) => setSelected((old) => e.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id))} /><span className="min-w-0 break-words">{item.message}</span></label>)}</div>
        <label className="block">Resolution summary<textarea required maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} className={field} /></label>
        <p className="text-sm text-muted">This public summary applies to each selected report. Resolve reports separately when they need different summaries.</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Notify reporters with one combined reply each</label>
        {notify && <label className="block">Combined reply<textarea required maxLength={4000} value={reply} onChange={(e) => setReply(e.target.value)} className={field} /></label>}
        <button type="submit" className={primary} disabled={resolve.isPending || !selected.length || !summary.trim() || (notify && !reply.trim())}>Resolve selected reports</button>
      </form>
    </Modal>}
  </>;
}
