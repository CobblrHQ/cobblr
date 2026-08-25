// Long-lived API token manager — list, mint, revoke, shown-once reveal.
// One component, two surfaces (the author, 2026-06-10: operator tooling doesn't
// belong buried in workspace config):
//
//   variant="personal"  — /configuration/tokens (workspace land). Mints
//     FULL-ACCESS tokens (same as a browser session) for CLI / AI / agent
//     use. NO scope checkboxes: the deny-by-default scopes are all
//     platform-operator surfaces (/super-admin/*) — noise for a workspace
//     owner, and a footgun (a scoped token mints fine but 403s for anyone
//     who isn't a platform admin).
//
//   variant="operator"  — the operator console (/admin/tokens). Mints
//     RESTRICTED, deny-by-default tokens (≥1 scope required) for daemons +
//     bots (feedback triage, Discord ingest, announce, eval harnesses), and
//     lists only the scoped fleet.
//
// Tokens are user-level either way — same /me/api-tokens endpoints.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2, RefreshCw } from "lucide-react";
import { ApiError, api, type ApiTokenListItem } from "../lib/api";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";

/** A token being replaced: what to prefill, and what to offer revoking after. */
interface RotateTarget {
  id: string;
  name: string;
  scopes: string[];
  /** Already past its expiry — the cutover panel must not claim it "still works". */
  expired: boolean;
}

export function TokenManager({ variant }: { variant: "personal" | "operator" }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const tokens = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.listApiTokens(),
  });

  const [mintOpen, setMintOpen] = useState(false);
  const [revealed, setRevealed] = useState<
    { plaintext: string; name: string; supersedes: RotateTarget | null } | null
  >(null);
  /** The token being replaced. Scopes and permissions on an EXISTING token are
   *  never editable: its value is already sitting in some daemon's env, so
   *  widening it would change what a credential someone already holds can reach,
   *  and the audit trail would stop being true. Rotation mints a NEW token
   *  instead, prefilled from the old one so the common case (same job, same
   *  grants, fresh secret) is one dialog. */
  const [rotating, setRotating] = useState<RotateTarget | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiToken(id),
    onSuccess: () => {
      toast.success("Token revoked.");
      void qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't revoke.");
    },
  });

  async function handleRevoke(t: ApiTokenListItem) {
    const ok = await confirm({
      title: `Revoke "${t.name}"?`,
      message: "Any client using this token will lose access immediately. This can't be undone.",
      confirmLabel: "Revoke token",
      destructive: true,
    });
    if (ok) revoke.mutate(t.id);
  }

  // The operator surface manages the scoped fleet; the personal surface
  // shows everything you own (incl. any scoped ones, badged) so nothing
  // is ever invisible from "your tokens".
  const items = (tokens.data?.items ?? []).filter((t) =>
    variant === "operator" ? (t.scopes?.length ?? 0) > 0 : true,
  );

  return (
    <div className="space-y-5">
      {/* On /configuration/tokens the layout already draws "API tokens" + its
          description from the registry; repeating them here was the exact
          double-title defect ConfigPageHeader exists to end. The operator
          console has no shared header yet, so that variant keeps its own. */}
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        {variant === "operator" && (
          <>
            <h2 className="font-display text-xl font-extrabold text-content dark:text-mortar-100">
              Operator tokens
            </h2>
            <span className="text-xs text-muted dark:text-slate-400">
              restricted, deny-by-default tokens for daemons + bots
            </span>
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setMintOpen(true)}
          className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition flex items-center gap-1"
        >
          <Plus size={12} /> mint token
        </button>
      </div>

      <p className="text-xs text-muted dark:text-slate-400">
        {variant === "operator" ? (
          <>
            Each token is clamped to its checked scopes - every other endpoint
            is 403, even though it carries your identity. This is where the
            platform's service tokens live (the feedback-triage daemon, the
            Discord support bot, the announce poster, the eval harnesses).
          </>
        ) : (
          <>
            These tokens authenticate as your user account against every cobblr
            endpoint that accepts a Bearer token. Same scope as a browser
            session, but they don't expire unless you set an expiry. Treat them
            like passwords - they grant full access to every workspace you
            belong to.
          </>
        )}
      </p>

      {tokens.isLoading && <div className="text-xs text-faint">loading…</div>}
      {tokens.data && items.length === 0 && !mintOpen && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No tokens yet. Mint one above to get started.
        </div>
      )}

      <ul className="space-y-2">
        {items.map((t) => (
          <li
            key={t.id}
            className={
              "rounded-xl border bg-surface dark:bg-slate-900 p-3 flex items-start gap-3 " +
              (t.revoked_at
                ? "border-line dark:border-slate-700 opacity-60"
                : "border-line dark:border-slate-700")
            }
          >
            <KeyRound size={16} className="text-accent mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-medium text-content dark:text-mortar-100">{t.name}</span>
                {t.revoked_at && (
                  <span className="text-[10px] font-mono uppercase tracking-widest text-ember-500">
                    revoked
                  </span>
                )}
                {t.expires_at && new Date(t.expires_at) < new Date() && !t.revoked_at && (
                  <span className="text-[10px] font-mono uppercase tracking-widest text-ember-500">
                    expired
                  </span>
                )}
                {t.scopes && t.scopes.length > 0 ? (
                  <span
                    className="text-[10px] font-mono uppercase tracking-widest text-cobble-600 dark:text-cobble-400"
                    title={`Restricted token — ${t.scopes.join(", ")}`}
                  >
                    scoped: {t.scopes.join(", ")}
                  </span>
                ) : (
                  <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                    full access
                  </span>
                )}
              </div>
              <div className="text-[11px] font-mono text-faint dark:text-slate-500 mt-0.5">
                {t.token_prefix}… · created {new Date(t.created_at).toLocaleDateString()}
                {t.expires_at && ` · expires ${new Date(t.expires_at).toLocaleDateString()}`}
                {t.last_used_at
                  ? ` · last used ${new Date(t.last_used_at).toLocaleString()}`
                  : " · never used"}
              </div>
            </div>
            {!t.revoked_at && (
              <button
                onClick={() => handleRevoke(t)}
                className="text-faint hover:text-ember-500 transition shrink-0"
                title="Revoke token"
              >
                <Trash2 size={14} />
              </button>
            )}
            {!t.revoked_at && (
              <button
                type="button"
                onClick={() => {
                  setRotating({
                    id: t.id,
                    name: t.name,
                    scopes: t.scopes ?? [],
                    expired: !!t.expires_at && new Date(t.expires_at) < new Date(),
                  });
                  setMintOpen(true);
                }}
                className="text-faint hover:text-accent transition shrink-0"
                title="Rotate - mint a replacement with the same name, then revoke this one"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>

      <MintModal
        variant={variant}
        open={mintOpen}
        rotating={rotating}
        onClose={() => {
          setMintOpen(false);
          setRotating(null);
        }}
        onMinted={(plaintext, name) => {
          setMintOpen(false);
          // Keep the OLD token alive. Revoking it here would cut the running
          // daemon off the instant you minted its replacement, before you had
          // anywhere to paste the new value — the outage would be caused by the
          // rotation itself. It is offered on the reveal screen instead, for
          // after the bot is updated.
          setRevealed({ plaintext, name, supersedes: rotating ?? null });
          setRotating(null);
          void qc.invalidateQueries({ queryKey: ["api-tokens"] });
        }}
      />
      <RevealedModal
        revealed={revealed}
        onClose={() => setRevealed(null)}
        onRevokeOld={(id, name) => {
          // Same confirm as every other revoke: this button sits one mis-click
          // from the freshly-minted value, and killing the old credential is
          // not undoable.
          void (async () => {
            const ok = await confirm({
              title: `Revoke "${name}"?`,
              message: "Anything still using the old token stops working immediately.",
              confirmLabel: "Revoke old token",
              destructive: true,
            });
            if (!ok) return;
            revoke.mutate(id);
            setRevealed(null);
          })();
        }}
      />
    </div>
  );
}

function MintModal({
  variant,
  open,
  rotating,
  onClose,
  onMinted,
}: {
  variant: "personal" | "operator";
  open: boolean;
  rotating?: RotateTarget | null;
  onClose: () => void;
  onMinted: (plaintext: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<"" | "30" | "90" | "365" | "never">("never");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  // Prefill from the token being replaced when the dialog opens. Keyed on
  // open+id so re-opening for a DIFFERENT token refills, while typing inside an
  // open dialog is never clobbered.
  useEffect(() => {
    if (!open) return;
    setName(rotating?.name ?? "");
    setScopes(new Set(rotating?.scopes ?? []));
    setExpiresInDays("never");
  }, [open, rotating?.id]);
  const toast = useToast();

  const scopeChoices = useQuery({
    queryKey: ["api-token-scopes"],
    queryFn: () => api.apiTokenScopes(),
    staleTime: Infinity,
    enabled: variant === "operator",
  });

  const mint = useMutation({
    mutationFn: () => {
      const expires_at =
        expiresInDays === "" || expiresInDays === "never"
          ? undefined
          : new Date(Date.now() + Number(expiresInDays) * 24 * 3600_000).toISOString();
      return api.mintApiToken({
        name: name.trim(),
        expires_at,
        // Rotation must carry the old token's scopes on BOTH variants. The
        // personal surface lists scoped tokens too, and its mint dialog has no
        // scope UI — so gating this on variant meant rotating a restricted
        // daemon token from /configuration/tokens silently minted a FULL-ACCESS
        // replacement with the same name. Widening is the one thing a rotation
        // must never do.
        scopes: scopes.size > 0 && (variant === "operator" || rotating) ? [...scopes] : undefined,
      });
    },
    onSuccess: (r) => {
      onMinted(r.token, r.name);
      setName("");
      setExpiresInDays("never");
      setScopes(new Set());
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't mint token.");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // Operator tokens are restricted BY DEFINITION — an unscoped one is just
    // a personal full-access token wearing the wrong hat.
    if (variant === "operator" && scopes.size === 0) return;
    mint.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        rotating
          ? `rotate ${rotating.name}`
          : variant === "operator"
            ? "mint operator token"
            : "mint api token"
      }
      // The operator variant lists a dozen scopes, each with a paragraph saying
      // exactly what it can and cannot reach. At max-w-md that was a ~2000px
      // column you scrolled blind: you could not survey the options, and the
      // mint button sat well below the fold. The api variant has no scopes and
      // stays small.
      size={variant === "operator" ? "xl" : "sm"}
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={variant === "operator" ? '"feedback-triage daemon"' : '"claude on macbook"'}
            className="input"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Expires
          </span>
          <select
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value as typeof expiresInDays)}
            className="input"
          >
            <option value="never">never</option>
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in 365 days</option>
          </select>
        </label>

        {variant !== "operator" && rotating && rotating.scopes.length > 0 && (
          <p className="text-xs text-muted dark:text-slate-400 rounded-md border border-line dark:border-slate-700 p-2">
            Keeps the same scopes:{" "}
            <span className="font-mono">{rotating.scopes.join(", ")}</span>
          </p>
        )}
        {variant === "operator" ? (
          <div className="block">
            <div className="flex items-baseline justify-between mb-1 gap-3">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                Scopes{" "}
                {scopes.size === 0 && <span className="text-ember-500">(pick at least one)</span>}
              </span>
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                {scopes.size} selected
              </span>
            </div>
            {/* Two columns from sm up, and a cap so a short viewport scrolls the
                LIST rather than pushing the mint button off the dialog. */}
            <div className="grid sm:grid-cols-2 gap-x-5 gap-y-2 max-h-[26rem] overflow-y-auto pr-1">
              {(scopeChoices.data?.items ?? []).map((s) => (
                <label
                  key={s.key}
                  className={
                    "flex items-start gap-2 text-sm text-content dark:text-mortar-200 cursor-pointer rounded-md border p-2 transition min-w-0 " +
                    (scopes.has(s.key)
                      ? "border-cobble-300 dark:border-cobble-700 bg-cobble-50/50 dark:bg-cobble-900/20"
                      : "border-line dark:border-slate-700 hover:bg-subtle/50 dark:hover:bg-slate-800/40")
                  }
                >
                  <input
                    type="checkbox"
                    checked={scopes.has(s.key)}
                    onChange={(e) =>
                      setScopes((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(s.key);
                        else next.delete(s.key);
                        return next;
                      })
                    }
                    className="accent-cobble-500 mt-0.5 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-xs text-muted dark:text-slate-400">{s.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted dark:text-slate-400">
              <strong>Restricted token</strong>  - can ONLY do the checked scope(s); every other
              endpoint is 403, even though it carries your identity. Need a full-access personal
              token instead? Mint it from Configuration → API tokens in a workspace.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted dark:text-slate-400">
            <strong>Full access</strong>  - same as your browser session (every workspace you
            belong to). Treat it like a password.
          </p>
        )}

        <p className="text-xs text-muted dark:text-slate-400">
          You'll see the token value <strong>exactly once</strong> after minting. Copy it before
          closing the next dialog.
        </p>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || (variant === "operator" && scopes.size === 0) || mint.isPending}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50"
          >
            {mint.isPending ? "Minting…" : "Mint"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RevealedModal({
  revealed,
  onClose,
  onRevokeOld,
}: {
  revealed: { plaintext: string; name: string; supersedes?: RotateTarget | null } | null;
  onClose: () => void;
  onRevokeOld?: (id: string, name: string) => void;
}) {
  const toast = useToast();
  async function copy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      toast.success("Token copied. Save it somewhere safe - it won't be shown again.");
    } catch {
      toast.info(revealed.plaintext, { duration: 30_000 });
    }
  }
  return (
    <Modal
      open={!!revealed}
      onClose={onClose}
      title={revealed?.supersedes ? "Replacement minted" : "Token minted"}
      subtitle={revealed?.name ?? ""}
      size="md"
    >
      <div className="space-y-4">
        <p className="text-sm text-content dark:text-mortar-100">
          Copy this token now. It'll never be shown again - if you lose it, you'll need to mint a
          new one.
        </p>
        <div className="rounded-md border border-cobble-200 dark:border-cobble-700 bg-cobble-50/40 dark:bg-slate-800 p-3 font-mono text-xs break-all text-content dark:text-mortar-100">
          {revealed?.plaintext}
        </div>
        {revealed?.supersedes && (
          // The old token is still live, deliberately: this is the cutover
          // window. Paste the new value wherever the daemon reads it, confirm it
          // works, THEN kill the old one. Revoking at mint time would have taken
          // the bot down as a side effect of rotating it.
          <div className="rounded-md border border-line dark:border-slate-700 p-3 space-y-2">
            <p className="text-sm text-content dark:text-mortar-200">
              {revealed.supersedes.expired
                ? "The old token had already expired. Revoke it to keep the list honest."
                : "The old token still works. Update wherever it is used, then revoke it."}
            </p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 truncate">
                {revealed.supersedes.name}
              </span>
              <button
                type="button"
                onClick={() => onRevokeOld?.(revealed.supersedes!.id, revealed.supersedes!.name)}
                className="shrink-0 px-2.5 py-1 rounded-md text-xs font-medium border border-ember-500/40 text-ember-500 hover:bg-ember-500/10 transition"
              >
                Revoke the old one
              </button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button
            onClick={copy}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition flex items-center gap-1.5"
          >
            <Copy size={13} /> Copy
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
