// A connected mailbox on /me/connections: the Connect step (a consent screen,
// not a form) and the row under a connected one (address, workspace, what it
// reads, when it last looked, Check now, Reconnect).
//
// The connection itself is an ordinary personal connection; this only adds
// the two things a mailbox has that a key does not: a way in that is a
// redirect, and a sync state to show.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Mail, RefreshCw } from "lucide-react";
import { relativeTime, useToast } from "@cobblr/platform-web";
import { ApiError, api, type AiProviderDef, type MailSourceView, type UserConnection } from "../lib/api";

/** The platform's own list, spelled for a person. Mirrors STORE_SENDER_DOMAINS
 *  on the server by family, not by domain, since "amazon.co.uk" beside
 *  "amazon.com" is noise on a card. */
const PLATFORM_SENDERS = "Amazon, UPS, FedEx, USPS, DHL, OnTrac";

export function OAuthConnectPanel({
  provider,
  start,
  orgs,
  onCancel,
}: {
  provider: AiProviderDef;
  start: string;
  orgs: Array<{ id: string; name: string; role: string }>;
  onCancel: () => void;
}) {
  const toast = useToast();
  const owned = orgs.filter((o) => o.role === "owner");
  const [orgId, setOrgId] = useState<string>(owned[0]?.id ?? orgs[0]?.id ?? "");
  const go = useMutation({
    mutationFn: () => api.startOAuthConnect(start, orgId),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div className="space-y-3">
      <div className="rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 text-sm text-content dark:text-mortar-100 space-y-1.5">
        <div className="flex items-center gap-2 font-medium">
          <Mail size={15} className="text-accent" /> Connect {provider.label}
        </div>
        <p className="text-muted text-[13px]">
          Cobblr asks Google for read-only access and then reads mail from stores and carriers only ({PLATFORM_SENDERS}, plus any you add).
          Nothing is labelled, moved or sent, and no message body is kept. The last 7 days are read first, then new mail as it arrives.
        </p>
      </div>
      <label className="block">
        <div className="text-xs text-muted mb-1">Orders and parcels from this mailbox go to</div>
        <select
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.role !== "owner" ? " (the owner approves)" : ""}
            </option>
          ))}
        </select>
        <div className="text-[11px] text-faint mt-1">One workspace per mailbox, so each order lands once.</div>
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
          Cancel
        </button>
        <button
          type="button"
          disabled={!orgId || go.isPending}
          onClick={() => go.mutate()}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50"
        >
          <Mail size={14} /> {go.isPending ? "Opening Google…" : `Connect ${provider.label}`}
        </button>
      </div>
    </div>
  );
}

const STATUS_WORDS: Record<MailSourceView["state"]["status"], { text: string; tone: string }> = {
  ok: { text: "reading", tone: "text-moss-700 dark:text-moss-300" },
  failing: { text: "not answering", tone: "text-amber-700 dark:text-amber-400" },
  needs_reconnect: { text: "stopped: reconnect", tone: "text-ember-600 dark:text-ember-400" },
};

export function MailSourceRow({ connection, orgName }: { connection: UserConnection; orgName: (id: string) => string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ["mail-sources"], queryFn: api.listMailSources, refetchInterval: 30_000 });
  const catalogue = useQuery({ queryKey: ["conn-catalogue"], queryFn: api.connectionCatalogue });
  const me = sources.data?.items.find((s) => s.id === connection.id);
  const provider = catalogue.data?.items.find((p) => p.id === connection.provider_id);
  const check = useMutation({
    mutationFn: () => api.syncMailSource(connection.id),
    onSuccess: (out) => {
      if (out.ran) {
        const n = out.result?.delivered ?? 0;
        toast.success(n === 0 ? "Checked: nothing new from your stores." : `Checked: ${n} new store email${n === 1 ? "" : "s"} read.`);
      } else if (out.reason === "grant_died") {
        toast.error("Google no longer honours the grant. Reconnect to keep reading.");
      } else {
        toast.error(out.error ?? out.reason ?? "The check did not run.");
      }
      void qc.invalidateQueries({ queryKey: ["mail-sources"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const reconnect = useMutation({
    mutationFn: () => api.startOAuthConnect(provider?.connect?.start ?? "/me/mail-sources/gmail/start", me?.org_ids[0] ?? ""),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  if (!me) return null;
  const st = me.state;
  const word = STATUS_WORDS[st.status];
  const extras = me.extra_senders;
  return (
    <div className="mt-1.5 text-[11px] text-muted space-y-0.5">
      <div>
        {me.email ? <span className="font-mono text-content dark:text-mortar-200">{me.email}</span> : "mailbox"}
        {me.org_ids[0] ? <> · feeds <span className="text-content dark:text-mortar-200">{orgName(me.org_ids[0])}</span></> : " · feeds no workspace yet"}
        {" · "}
        <span className={word.tone}>{word.text}</span>
      </div>
      <div>
        Reads mail from: {PLATFORM_SENDERS}
        {extras.length > 0 && <>, and {extras.join(", ")}</>}
        {extras.length === 0 && <span className="text-faint"> (add a store with the pencil)</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{st.last_synced_at ? `last checked ${relativeTime(st.last_synced_at)}` : "not checked yet"}</span>
        <span>{st.messages_seen} store email{st.messages_seen === 1 ? "" : "s"} read</span>
        {st.last_error && st.status !== "ok" && <span className="text-faint truncate max-w-[24rem]" title={st.last_error}>{st.last_error}</span>}
        {st.status === "needs_reconnect" ? (
          <button
            type="button"
            onClick={() => reconnect.mutate()}
            disabled={reconnect.isPending}
            className="inline-flex items-center gap-1 rounded border border-ember-500/50 text-ember-600 dark:text-ember-400 px-2 py-0.5 hover:bg-ember-50 dark:hover:bg-ember-950/30 disabled:opacity-50"
          >
            <Mail size={11} /> Reconnect
          </button>
        ) : (
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-600 px-2 py-0.5 text-faint hover:text-accent disabled:opacity-50"
          >
            <RefreshCw size={11} className={check.isPending ? "animate-spin" : ""} /> {check.isPending ? "Checking…" : "Check now"}
          </button>
        )}
        {/* The whole history, filing nothing (#5462): what the order rules would do, to review before they read live. */}
        <Link to={`/me/connections/mailbox-check/${me.id}`} className="text-accent hover:underline">Check my mailbox</Link>
      </div>
    </div>
  );
}
