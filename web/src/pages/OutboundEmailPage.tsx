// /configuration/email — the workspace's own outbound email: the provider it
// mails customers through, from its own address. Nothing is ever sent to a
// customer until this is set up, and then only when a person presses send
// (a shipping notice from an order's Ship button). The same provider fields as
// the notification email channel (email-provider-fields.ts).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Send, Trash2 } from "lucide-react";
import { FieldPack, LabeledField, SecretInput, fieldNeed, useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError } from "../lib/api";
import { EMAIL_PROVIDER_FIELDS, EMAIL_SECRET_KEYS } from "../lib/email-provider-fields";

type Form = Record<string, string>;

function toForm(settings: Record<string, unknown>): Form {
  const f: Form = {};
  for (const [k, v] of Object.entries(settings)) {
    if (v === true) f[k] = "true";
    else if (v != null && v !== false) f[k] = String(v);
  }
  return f;
}

function toBody(form: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const provider = form.provider || "smtp";
  for (const f of EMAIL_PROVIDER_FIELDS) {
    if (f.showIf && !f.showIf.in.includes(provider)) continue;
    const v = form[f.key] ?? (f.key === "provider" ? provider : "");
    if (v === "") continue;
    out[f.key] = f.type === "number" ? Number(v) : f.type === "checkbox" ? v === "true" : v;
  }
  return out;
}

export function OutboundEmailPage() {
  usePageTitle("Email");
  const { activeSlug: slug, activeOrg } = useActiveOrg();
  // role-gate: exact — mirrors the server's owner/admin gate on /outbound-email.
  const canEdit = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const status = useQuery({ queryKey: ["outbound-email", slug], queryFn: () => api.getOutboundEmail(slug), enabled: !!slug && canEdit });
  const log = useQuery({ queryKey: ["outbound-email-log", slug], queryFn: () => api.outboundEmailLog(slug), enabled: !!slug && canEdit && !!status.data?.configured });
  const [form, setForm] = useState<Form>({ provider: "smtp" });
  useEffect(() => {
    if (status.data?.configured) setForm({ provider: status.data.provider ?? "smtp", ...toForm(status.data.settings) });
  }, [status.data]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["outbound-email", slug] });
    void qc.invalidateQueries({ queryKey: ["outbound-email-log", slug] });
  };
  const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
  const save = useMutation({
    mutationFn: () => api.saveOutboundEmail(slug, toBody(form)),
    onSuccess: () => { toast.success("Saved. Send yourself a test to see it arrive."); invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const test = useMutation({
    mutationFn: () => api.testOutboundEmail(slug),
    onSuccess: (r) => { toast.success(r.status === "sent" ? `Test sent to ${r.to}` : `${r.to} cannot receive mail, so nothing was sent`); invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteOutboundEmail(slug),
    onSuccess: () => { toast.success("Outbound email removed. Nothing will be emailed to customers."); setForm({ provider: "smtp" }); invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });

  if (!canEdit) {
    return <p className="text-sm text-faint">Workspace owners and admins set up how this workspace sends email.</p>;
  }

  const provider = form.provider || "smtp";
  const secretsSet = new Set(status.data?.secretsSet ?? []);
  const visible = EMAIL_PROVIDER_FIELDS.filter((f) => !f.showIf || f.showIf.in.includes(provider));
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <div className="space-y-5 max-w-2xl">

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Mail size={16} className="text-accent" aria-hidden />
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">
            {status.data?.configured ? `Sending from ${status.data.from}` : "Not set up"}
          </h2>
        </div>
        <FieldPack
          items={visible.map((f) => ({
            need: fieldNeed(f.key, {
              control: f.type === "select" ? "choice" : f.type === "checkbox" ? "checkbox" : "text",
              label: f.label,
              choices: f.options?.map((o) => o.label),
              help: f.helpText,
              valueLength: (form[f.key] ?? "").length,
            }),
            node: (
              <LabeledField key={f.key} label={f.label} as={f.type === "checkbox" ? "div" : "label"}>
                {f.type === "select" ? (
                  <select className="input w-full" value={form[f.key] ?? f.default ?? ""} onChange={(e) => set(f.key, e.target.value)}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : f.type === "checkbox" ? (
                  <label className="flex items-center gap-2 text-sm h-9">
                    <input type="checkbox" checked={form[f.key] === "true"} onChange={(e) => set(f.key, e.target.checked ? "true" : "")} />
                    <span>{form[f.key] === "true" ? "Yes" : "No"}</span>
                  </label>
                ) : EMAIL_SECRET_KEYS.includes(f.key) ? (
                  <SecretInput
                    secret
                    what={/token/i.test(f.label) ? "token" : /key/i.test(f.label) ? "API key" : "password"}
                    value={form[f.key] ?? ""}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={secretsSet.has(f.key) ? "Saved. Leave blank to keep it" : f.placeholder}
                  />
                ) : (
                  <input className="input w-full" type={f.type ?? "text"} value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.key === "from" ? "orders@example.com" : f.placeholder} />
                )}
                {f.helpText && <div className="text-[11px] text-faint mt-0.5">{f.helpText}</div>}
              </LabeledField>
            ),
          }))}
        />
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50">
            Save
          </button>
          {status.data?.configured && (
            <>
              <button type="button" onClick={() => test.mutate()} disabled={test.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50">
                <Send size={14} aria-hidden /> Send me a test
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (await confirm({ title: "Remove outbound email?", message: "Customers will no longer be emailed from this workspace. You can still copy a shipping notice and send it yourself.", confirmLabel: "Remove", destructive: true })) remove.mutate();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded text-ember-700 dark:text-ember-300 hover:bg-ember-50 dark:hover:bg-ember-900/30 ml-auto"
              >
                <Trash2 size={14} aria-hidden /> Remove
              </button>
            </>
          )}
        </div>
      </section>

      {status.data?.configured && (
        <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
          <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">Sent</h2>
          {(log.data?.items ?? []).length === 0 && <p className="text-sm text-faint">Nothing sent yet.</p>}
          <ul className="divide-y divide-line dark:divide-slate-800">
            {(log.data?.items ?? []).map((r) => (
              <li key={r.id} className="py-2 text-sm flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-content dark:text-mortar-100 min-w-0 break-words">{r.subject}</span>
                <span className="text-xs text-muted">to {r.to}</span>
                <span className={"text-xs " + (r.status === "failed" ? "text-ember-700 dark:text-ember-300" : "text-faint")}>
                  {r.status === "sent" ? "sent" : r.status === "skipped" ? "not deliverable, skipped" : `failed: ${r.error ?? ""}`}
                </span>
                <span className="text-xs text-faint ml-auto">{new Date(r.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
