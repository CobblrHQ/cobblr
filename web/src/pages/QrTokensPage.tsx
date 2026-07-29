// /configuration/qr-tokens — every QR token the workspace has minted.
// Labels' QR half mints these from entity detail pages / the label
// queue, but there was no central place to audit them: what they
// point at, whether they're public, when they expire, and a way to
// revoke a token whose printed label has walked off. This is it.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, QrCode, Ban, Globe } from "lucide-react";
import { ApiError, api, type QrToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";

export function QrTokensPage({ embedded = false }: { embedded?: boolean } = {}) {
  usePageTitle("QR codes");
  const { activeSlug, activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = activeOrg?.role === "owner" || activeOrg?.role === "admin";

  const list = useQuery({
    queryKey: ["qr-tokens", activeSlug],
    queryFn: () => api.listQrTokens(activeSlug),
    enabled: !!activeSlug,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeQrToken(activeSlug, id),
    onSuccess: () => {
      toast.success("Token revoked - scanning it now 404s");
      void qc.invalidateQueries({ queryKey: ["qr-tokens", activeSlug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't revoke"),
  });

  const settings = useQuery({
    queryKey: ["qr-settings", activeSlug],
    queryFn: () => api.getQrSettings(activeSlug),
    enabled: !!activeSlug,
  });
  const setStyle = useMutation({
    mutationFn: (s: "descriptive" | "opaque") => api.setQrTokenStyle(activeSlug, s),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["qr-settings", activeSlug] });
      toast.success("Saved");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });
  const style = settings.data?.token_style ?? "descriptive";

  // Custom label base URL — a stable name the workspace forwards to this
  // instance so printed codes survive a move. Local draft state; committed
  // on Save/blur.
  const savedBase = settings.data?.label_base_url ?? "";
  const [baseDraft, setBaseDraft] = useState(savedBase);
  useEffect(() => {
    setBaseDraft(savedBase);
  }, [savedBase]);
  const saveBase = useMutation({
    mutationFn: (url: string) => api.setQrLabelBaseUrl(activeSlug, url.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["qr-settings", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["qr-tokens", activeSlug] });
      toast.success("Saved");
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Enter a full URL like https://…"),
  });
  const baseDirty = baseDraft.trim().replace(/\/+$/, "") !== savedBase;

  const items = list.data?.items ?? [];
  const active = items.filter((t) => status(t) === "active").length;

  return (
    <div className={embedded ? "space-y-4" : "space-y-4 max-w-3xl mx-auto"}>
      <div className={"flex items-baseline gap-3 " + (embedded ? "" : "border-b border-line dark:border-slate-700 pb-3")}>
        {!embedded && (
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
            QR codes
          </h1>
        )}
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          {active} active · {items.length} total
        </span>
      </div>

      <p className="text-sm text-content dark:text-mortar-200">
        Tokens minted by scanning / printing labels. Each resolves at{" "}
        <code className="font-mono text-xs">/qr/&lt;token&gt;</code>  - either
        navigating to the item or firing an action. Revoke one and its printed
        label stops working immediately.
      </p>

      {/* New-code style: self-describing vs opaque. Existing codes unaffected. */}
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
          New-code style
        </div>
        <div className="flex gap-2">
          {(
            [
              {
                opt: "descriptive",
                title: "Self-describing",
                desc: "Opens with a short type code, like /qr/loc/Xk7Bq2mNp8rL — a phone's link preview hints what the label is before it's tapped.",
              },
              {
                opt: "opaque",
                title: "Opaque",
                desc: "Just the random slug, like /qr/Xk7Bq2mNp8rL — the link reveals nothing about what it points to.",
              },
            ] as const
          ).map(({ opt, title, desc }) => (
            <button
              key={opt}
              type="button"
              onClick={() => style !== opt && setStyle.mutate(opt)}
              disabled={setStyle.isPending}
              aria-pressed={style === opt}
              className={
                "flex-1 basis-0 text-left px-3 py-2 rounded-lg border transition disabled:opacity-60 " +
                (style === opt
                  ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/40"
                  : "border-line dark:border-slate-700 hover:border-cobble-400 dark:hover:border-slate-600")
              }
            >
              <div
                className={
                  "text-xs font-semibold " +
                  (style === opt
                    ? "text-content dark:text-mortar-100"
                    : "text-muted dark:text-slate-300")
                }
              >
                {title}
              </div>
              <div className="text-[11px] leading-snug text-muted dark:text-slate-400 mt-0.5">
                {desc}
              </div>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted dark:text-slate-400 mt-1.5">
          Codes you've already printed keep working either way.
        </p>
      </div>

      {/* Custom label base URL — durable codes that survive leaving this instance. */}
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
          <Globe size={12} /> Label base URL
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="url"
            inputMode="url"
            placeholder={window.location.origin}
            value={baseDraft}
            onChange={(e) => setBaseDraft(e.target.value)}
            disabled={!isAdmin || saveBase.isPending}
            className="flex-1 min-w-[220px] font-mono text-xs px-2.5 py-1.5 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-950 text-content dark:text-mortar-100 disabled:opacity-60"
          />
          {isAdmin && (
            <>
              <button
                type="button"
                onClick={() => baseDirty && saveBase.mutate(baseDraft)}
                disabled={!baseDirty || saveBase.isPending}
                className="text-xs px-2.5 py-1.5 rounded bg-cobble-600 text-white disabled:opacity-40 hover:bg-cobble-700 transition"
              >
                {saveBase.isPending ? "Saving…" : "Save"}
              </button>
              {savedBase && (
                <button
                  type="button"
                  onClick={() => saveBase.mutate("")}
                  disabled={saveBase.isPending}
                  className="text-xs px-2 py-1.5 rounded border border-line dark:border-slate-700 text-muted hover:text-content transition"
                >
                  Clear
                </button>
              )}
            </>
          )}
        </div>
        <p className="text-[11px] text-muted dark:text-slate-400 mt-1.5 leading-relaxed">
          {savedBase ? (
            <>New codes encode <code className="font-mono">{savedBase}/qr/&lt;token&gt;</code>. </>
          ) : (
            <>New codes encode this instance's own address. </>
          )}
          Point a stable name you own - a domain, a{" "}
          <span className="font-mono">DuckDNS</span>, or a{" "}
          <span className="font-mono">Tailscale</span> name - here, and set it to{" "}
          <strong>forward the <code className="font-mono">/qr/…</code> path</strong>{" "}
          to this instance (an HTTP redirect or reverse proxy, not a bare DNS
          record). Then if you ever move - self-host, change domains, leave the
          hosted app - you re-point the forward and every printed code keeps
          working. Already-printed codes are unchanged.
        </p>
      </div>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {!list.isLoading && items.length === 0 && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No QR tokens minted yet. Print a label or hit "QR" on any item's
          detail page.
        </div>
      )}

      <div className="space-y-2">
        {items.map((t) => {
          const st = status(t);
          const scanUrl = t.scan_url;
          return (
            <div
              key={t.id}
              className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3"
              data-testid="qr-card"
              data-token-id={t.id}
              data-status={st}
            >
              <div className="flex items-start gap-2">
                <QrCode size={15} className="text-accent mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm text-content dark:text-mortar-100">
                      {t.entity_kind}
                    </span>
                    <span className="font-mono text-[10px] text-faint">
                      {t.entity_id.slice(0, 8)}
                    </span>
                    <Pill
                      text={t.mode === "action" ? `action${t.action_id ? `:${t.action_id}` : ""}` : "navigate"}
                      tone="cobble"
                    />
                    <Pill
                      text={t.auth}
                      tone={t.auth === "public" ? "amber" : "slate"}
                    />
                    {st !== "active" && (
                      <Pill text={st} tone={st === "revoked" ? "ember" : "slate"} />
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-faint dark:text-slate-500 mt-1 flex flex-wrap gap-x-3">
                    <span>minted {new Date(t.created_at).toLocaleDateString()}</span>
                    {t.expires_at && (
                      <span>expires {new Date(t.expires_at).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(scanUrl);
                      toast.success("Scan URL copied");
                    }}
                    className="text-faint hover:text-accent transition p-1"
                    title="Copy scan URL"
                  >
                    <Copy size={14} />
                  </button>
                  <a
                    href={`/qr/${t.token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-faint hover:text-accent transition p-1"
                    title="Open scan target"
                  >
                    <ExternalLink size={14} />
                  </a>
                  {isAdmin && st === "active" && (
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Revoke this QR token?",
                          message: `Any printed label pointing at ${t.entity_kind} stops resolving immediately.`,
                          confirmLabel: "Revoke",
                          destructive: true,
                        });
                        if (ok) revoke.mutate(t.id);
                      }}
                      className="text-faint hover:text-ember-500 transition p-1"
                      title="Revoke"
                      data-testid="qr-revoke"
                    >
                      <Ban size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function status(t: QrToken): "active" | "revoked" | "expired" {
  if (t.revoked_at) return "revoked";
  if (t.expires_at && new Date(t.expires_at).getTime() < Date.now())
    return "expired";
  return "active";
}

function Pill({
  text,
  tone,
}: {
  text: string;
  tone: "cobble" | "amber" | "slate" | "ember";
}) {
  const cls = {
    cobble: "bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300",
    amber: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
    slate: "bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400",
    ember: "bg-ember-100 dark:bg-ember-900/40 text-ember-700 dark:text-ember-300",
  }[tone];
  return (
    <span
      className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${cls}`}
    >
      {text}
    </span>
  );
}
