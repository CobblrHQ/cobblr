// /configuration/email — the workspace's own outbound email: the provider it
// mails customers through, from its own address. Nothing is ever sent to a
// customer until this is set up, and then only when a person presses send
// (a shipping notice from an order's Ship button). The same provider fields as
// the notification email channel (email-provider-fields.ts). Below it, the
// workspace's own Twilio account, for automations that text someone outside
// the workspace (#6070), and the switch and limits for those automations.

import { productName } from "@cobblr/platform-web";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Send, Trash2 } from "lucide-react";
import { OnceQuiet, FieldPack, LabeledField, NumberField, SecretInput, fieldNeed, useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError, type AutomationEmailSettings } from "../lib/api";
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
  const sms = useQuery({ queryKey: ["outbound-sms", slug], queryFn: () => api.getOutboundSms(slug), enabled: !!slug && canEdit });
  const log = useQuery({ queryKey: ["outbound-email-log", slug], queryFn: () => api.outboundEmailLog(slug), enabled: !!slug && canEdit && !!status.data?.configured });
  const [form, setForm] = useState<Form>({ provider: "smtp" });
  useEffect(() => {
    if (status.data?.configured && status.data.provider !== "gmail") setForm({ provider: status.data.provider ?? "smtp", ...toForm(status.data.settings) });
  }, [status.data]);
  // Back from Google's consent screen (Connect Gmail): say how it went once.
  const [params, setParams] = useSearchParams();
  const gmailWord = params.get("gmail");
  useEffect(() => {
    if (!gmailWord) return;
    if (gmailWord === "connected") toast.success("Gmail connected. Send yourself a test to see it arrive.");
    else if (gmailWord === "denied") toast.error("Gmail was not connected: Google's screen was closed or declined.");
    else if (gmailWord === "forbidden") toast.error("Only a workspace owner or admin can connect its Gmail.");
    else toast.error("Gmail could not be connected. Try again.");
    setParams((p) => { p.delete("gmail"); return p; }, { replace: true });
  }, [gmailWord, setParams, toast]);

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
  const connectGmail = useMutation({
    mutationFn: () => api.startGmailSender(slug),
    onSuccess: (r) => { window.location.href = r.url; },
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
  const viaGmail = status.data?.provider === "gmail";
  const secretsSet = new Set(status.data?.secretsSet ?? []);
  const visible = EMAIL_PROVIDER_FIELDS.filter((f) => !f.showIf || f.showIf.in.includes(provider));
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <OnceQuiet key={slug} className="space-y-5 max-w-2xl">

      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Mail size={16} className="text-accent" aria-hidden />
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">
            {status.data?.configured ? `Sending from ${status.data.from}${viaGmail ? " (Gmail)" : ""}` : "Not set up"}
          </h2>
        </div>
        {viaGmail && (
          <p className="text-xs text-muted dark:text-slate-400" data-testid="outbound-email-gmail">
            Connected with Google, allowed only to send. Remove it to use another provider.
          </p>
        )}
        {!viaGmail && <FieldPack
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
        />}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line dark:border-slate-700">
          {!viaGmail && (
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50">
              Save
            </button>
          )}
          {!viaGmail && status.data?.gmail_available && (
            <button type="button" onClick={() => connectGmail.mutate()} disabled={connectGmail.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50" data-testid="outbound-email-connect-gmail">
              <Mail size={14} aria-hidden /> Or send from Gmail
            </button>
          )}
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

      <TextMessagesSection slug={slug} />

      <AutomationEmailSection slug={slug} configured={!!status.data?.configured || !!sms.data?.configured} />

      {status.data?.configured && (
        <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
          <h2 className="text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">Sent</h2>
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
    </OnceQuiet>
  );
}

const STATUS_WORDS: Record<AutomationEmailSettings["recent"][number]["status"], string> = {
  sent: "sent",
  held: "held by the daily limit",
  stopped: "not sent: they asked to stop",
  refused: "not sent",
  failed: "failed",
};

/** The workspace's own Twilio account (#6070, slice 3c): how an automation
 *  texts someone outside the workspace. The SID shows again; the token never. */
function TextMessagesSection({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["outbound-sms", slug], queryFn: () => api.getOutboundSms(slug), enabled: !!slug });
  const [sid, setSid] = useState("");
  const [token, setToken] = useState("");
  const [from, setFrom] = useState("");
  const [testTo, setTestTo] = useState("");
  useEffect(() => {
    if (q.data?.configured) {
      setSid(q.data.account_sid ?? "");
      setFrom(q.data.from ?? "");
    }
  }, [q.data]);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["outbound-sms", slug] });
    void qc.invalidateQueries({ queryKey: ["automation-email", slug] });
  };
  const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
  const save = useMutation({
    mutationFn: () => api.saveOutboundSms(slug, { account_sid: sid.trim(), from_number: from.trim(), ...(token.trim() ? { auth_token: token.trim() } : {}) }),
    onSuccess: () => { setToken(""); toast.success("Saved. Text yourself a test to see it arrive."); invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const test = useMutation({
    mutationFn: () => api.testOutboundSms(slug, testTo.trim()),
    onSuccess: (r) => toast.success(r.status === "sent" ? `Test texted to ${testTo.trim()}` : `${testTo.trim()} is a number set aside for examples, so nothing was sent`),
    onError: (e) => toast.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteOutboundSms(slug),
    onSuccess: () => { toast.success("Text messages removed. Automations will not text anyone."); setSid(""); setFrom(""); invalidate(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const d = q.data;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3" data-testid="outbound-sms">
      <div className="flex items-center gap-2">
        <MessageSquare size={16} className="text-accent" aria-hidden />
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100" data-testid="outbound-sms-state">
          {d?.configured ? `Texting from ${d.from}` : "Text messages: not set up"}
        </h2>
      </div>
      <p className="text-xs text-muted dark:text-slate-400">
        Your own Twilio account, for automations that text someone outside the workspace. {productName()} never texts anyone itself.
      </p>
      <FieldPack
        items={[
          {
            need: fieldNeed("account_sid", { control: "text", label: "Account SID", valueLength: sid.length }),
            node: (
              <LabeledField key="sid" label="Account SID">
                <input className="input w-full" value={sid} onChange={(e) => setSid(e.target.value)} placeholder="AC…" data-testid="outbound-sms-sid" />
              </LabeledField>
            ),
          },
          {
            need: fieldNeed("auth_token", { control: "text", label: "Auth Token", valueLength: token.length }),
            node: (
              <LabeledField key="token" label="Auth Token">
                <SecretInput secret what="token" value={token} onChange={(e) => setToken(e.target.value)} placeholder={d?.tokenSet ? "Saved. Leave blank to keep it" : ""} data-testid="outbound-sms-token" />
              </LabeledField>
            ),
          },
          {
            need: fieldNeed("from_number", { control: "text", label: "Send from (your Twilio number)", valueLength: from.length }),
            node: (
              <LabeledField key="from" label="Send from (your Twilio number)">
                <input className="input w-full" type="tel" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="+1 555 010 0100" data-testid="outbound-sms-from" />
              </LabeledField>
            ),
          },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line dark:border-slate-700">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !sid.trim() || !from.trim()} className="px-3 py-2 text-sm rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50" data-testid="outbound-sms-save">
          Save
        </button>
        {d?.configured && (
          <>
            <input className="input w-44 min-w-0" type="tel" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Your phone, +1 …" aria-label="Number to text a test to" data-testid="outbound-sms-test-to" />
            <button type="button" onClick={() => test.mutate()} disabled={test.isPending || !testTo.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-line dark:border-slate-600 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50" data-testid="outbound-sms-test">
              <Send size={14} aria-hidden /> Text a test
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await confirm({ title: "Remove text messages?", message: "Automations will no longer text anyone outside the workspace.", confirmLabel: "Remove", destructive: true })) remove.mutate();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded text-ember-700 dark:text-ember-300 hover:bg-ember-50 dark:hover:bg-ember-900/30 ml-auto"
            >
              <Trash2 size={14} aria-hidden /> Remove
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** Automations that email or text people outside the workspace (#6070): off
 *  until an owner or admin turns it on here, only through the senders above,
 *  within the two daily limits. */
function AutomationEmailSection({ slug, configured }: { slug: string; configured: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["automation-email", slug], queryFn: () => api.getAutomationEmail(slug), enabled: !!slug });
  const save = useMutation({
    mutationFn: (body: { enabled?: boolean; daily_limit?: number; per_wire_daily_limit?: number }) => api.saveAutomationEmail(slug, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["automation-email", slug] }),
  });
  const d = q.data;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3" data-testid="automation-email">
      <h2 className="text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">Automations</h2>
      <label className="flex items-start gap-2 text-sm text-content dark:text-mortar-100">
        <input
          type="checkbox"
          className="mt-1"
          checked={!!d?.enabled}
          disabled={!d || save.isPending || (!configured && !d?.enabled)}
          onChange={(e) => save.mutate({ enabled: e.target.checked })}
          data-testid="automation-email-enabled"
        />
        <span>
          Allow automations to email or text people outside this workspace
          <span className="block text-xs text-muted dark:text-slate-400">
            Someone on your People list who is not a member, when a wire says so (the coffee ran out: ask them to buy more). Only through your own sender above (email, or texts through your Twilio account), never {productName()}'s own. Each message says who set it up and has a link that stops it.
          </span>
        </span>
      </label>
      {!configured && <p className="text-xs text-muted dark:text-slate-400">Set up a sender above first.</p>}
      {d && (
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted dark:text-slate-400">At most a day</span>
            <NumberField value={d.daily_limit} min={1} max={500} integer onChange={(n) => save.mutate({ daily_limit: n })} label="At most a day" testId="automation-email-daily" className="w-20" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted dark:text-slate-400">From one automation, a day</span>
            <NumberField value={d.per_wire_daily_limit} min={1} max={100} integer onChange={(n) => save.mutate({ per_wire_daily_limit: n })} label="From one automation, a day" testId="automation-email-per-wire" className="w-20" />
          </label>
        </div>
      )}
      {save.isError && <p className="text-sm text-ember-700 dark:text-ember-300">{save.error instanceof ApiError ? save.error.message : String(save.error)}</p>}
      {(d?.recent.length ?? 0) > 0 && (
        <ul className="divide-y divide-line dark:divide-slate-800 text-sm">
          {d!.recent.map((r) => (
            <li key={r.id} className="py-1.5 flex flex-wrap items-baseline gap-x-3">
              <span className="text-content dark:text-mortar-100 min-w-0 break-words">
                {r.channel === "text" ? "Text to " : ""}
                {r.to_address || (r.channel === "text" ? "no number" : "no address")}
              </span>
              <span className={"text-xs " + (r.status === "failed" ? "text-ember-700 dark:text-ember-300" : "text-faint")}>
                {STATUS_WORDS[r.status]}{r.reason && r.status !== "sent" ? `: ${r.reason}` : ""}{r.reply === "bought" ? "; they bought it" : r.reply === "got" ? "; they got it" : ""}
              </span>
              <span className="text-xs text-faint ml-auto">{new Date(r.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
