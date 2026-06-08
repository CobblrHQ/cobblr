// /configuration/tokens — long-lived API tokens for CLI / AI / agent
// access. Plaintext is shown exactly once on mint, with a copy
// button. The list afterward only shows the prefix + metadata.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { ApiError, api, type ApiTokenListItem } from "../lib/api";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";

export function ApiTokensPage() {
  usePageTitle("API tokens");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const tokens = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.listApiTokens(),
  });

  const [mintOpen, setMintOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ plaintext: string; name: string } | null>(null);

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

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          API tokens
        </h1>
        <span className="page-subtitle">
          long-lived bearer tokens for CLI / AI / automation
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setMintOpen(true)}
          className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition flex items-center gap-1"
        >
          <Plus size={12} /> mint token
        </button>
      </div>

      <p className="text-xs text-muted dark:text-slate-400">
        These tokens authenticate as your user account against every cobblr
        endpoint that accepts a Bearer token. Same scope as a browser session,
        but they don't expire unless you set an expiry. Treat them like
        passwords — they grant full access to every workspace you belong to.
      </p>

      {tokens.isLoading && (
        <div className="text-xs text-faint">loading…</div>
      )}
      {tokens.data && tokens.data.items.length === 0 && !mintOpen && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No tokens yet. Mint one above to get started.
        </div>
      )}

      <ul className="space-y-2">
        {tokens.data?.items.map((t) => (
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
                <span className="font-medium text-content dark:text-mortar-100">
                  {t.name}
                </span>
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
          </li>
        ))}
      </ul>

      <MintModal
        open={mintOpen}
        onClose={() => setMintOpen(false)}
        onMinted={(plaintext, name) => {
          setMintOpen(false);
          setRevealed({ plaintext, name });
          void qc.invalidateQueries({ queryKey: ["api-tokens"] });
        }}
      />
      <RevealedModal
        revealed={revealed}
        onClose={() => setRevealed(null)}
      />
    </div>
  );
}

function MintModal({
  open,
  onClose,
  onMinted,
}: {
  open: boolean;
  onClose: () => void;
  onMinted: (plaintext: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<"" | "30" | "90" | "365" | "never">("never");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const toast = useToast();

  const scopeChoices = useQuery({
    queryKey: ["api-token-scopes"],
    queryFn: () => api.apiTokenScopes(),
    staleTime: Infinity,
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
        scopes: scopes.size > 0 ? [...scopes] : undefined,
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
    mint.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="mint api token" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='"claude on macbook"'
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
        <div className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Access
          </span>
          <div className="space-y-1.5">
            {(scopeChoices.data?.items ?? []).map((s) => (
              <label
                key={s.key}
                className="flex items-start gap-2 text-sm text-content dark:text-mortar-200 cursor-pointer"
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
                  className="accent-cobble-500 mt-0.5"
                />
                <span>
                  <span className="font-medium">{s.label}</span>
                  <span className="block text-xs text-muted dark:text-slate-400">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted dark:text-slate-400">
            {scopes.size === 0 ? (
              <>
                <strong>Full access</strong> — same as your browser session
                (every workspace you belong to). Check a scope to mint a{" "}
                <strong>restricted, deny-by-default</strong> token instead.
              </>
            ) : (
              <>
                <strong>Restricted token</strong> — can ONLY do the checked
                scope(s); every other endpoint is 403, even though it carries
                your identity.
              </>
            )}
          </p>
        </div>
        <p className="text-xs text-muted dark:text-slate-400">
          You'll see the token value <strong>exactly once</strong> after
          minting. Copy it before closing the next dialog.
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
            disabled={!name.trim() || mint.isPending}
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
}: {
  revealed: { plaintext: string; name: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  async function copy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      toast.success("Token copied. Save it somewhere safe — it won't be shown again.");
    } catch {
      toast.info(revealed.plaintext, { duration: 30_000 });
    }
  }
  return (
    <Modal
      open={!!revealed}
      onClose={onClose}
      title="token minted"
      subtitle={revealed?.name ?? ""}
      size="md"
    >
      <div className="space-y-4">
        <p className="text-sm text-content dark:text-mortar-100">
          Copy this token now. It'll never be shown again — if you lose it,
          you'll need to mint a new one.
        </p>
        <div className="rounded-md border border-cobble-200 dark:border-cobble-700 bg-cobble-50/40 dark:bg-slate-800 p-3 font-mono text-xs break-all text-content dark:text-mortar-100">
          {revealed?.plaintext}
        </div>
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
