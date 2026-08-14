// Driver packages a workspace declares for its bridges.
//
// Declaring writes a row. It does NOT reach out to a bridge — each one converges
// on its next poll, so this works while a bridge is offline and can never
// half-apply. The copy says so, because "added" that hasn't taken effect yet is
// the thing a user would otherwise read as broken.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, PackagePlus } from "lucide-react";
import { api, type EdgeDriverDeclaration } from "../../lib/api";
import { useToast, useConfirm } from "@cobblr/platform-web";

const SHA_RE = /^[0-9a-f]{64}$/;
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const EMPTY: EdgeDriverDeclaration = { kind: "", version: "", sha256: "", source: "", bridgeId: null };

export function DriverPackages({ slug, hasBridge }: { slug: string; hasBridge: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<EdgeDriverDeclaration>(EMPTY);
  const [adding, setAdding] = useState(false);

  const q = useQuery({
    queryKey: ["edge-driver-declarations", slug],
    queryFn: () => api.getEdgeDriverDeclarations(slug),
    staleTime: 30_000,
  });

  const declare = useMutation({
    mutationFn: (body: EdgeDriverDeclaration) => api.declareEdgeDriver(slug, body),
    onSuccess: (_r, body) => {
      void qc.invalidateQueries({ queryKey: ["edge-driver-declarations", slug] });
      setDraft(EMPTY);
      setAdding(false);
      // Say what actually happened. It is declared; a bridge picks it up when
      // it next checks, and pretending otherwise makes the delay look broken.
      toast.success(`${body.kind} declared. Your bridge installs it on its next check.`);
    },
    onError: (e: Error) => toast.error(e.message || "Could not declare that driver"),
  });

  const remove = useMutation({
    mutationFn: (d: EdgeDriverDeclaration) => api.removeEdgeDriver(slug, d.kind, d.bridgeId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["edge-driver-declarations", slug] }),
    onError: (e: Error) => toast.error(e.message || "Could not remove that driver"),
  });

  const drivers = q.data?.drivers ?? [];

  // Nothing to act on until a bridge exists: a declaration with no bridge is a
  // row nothing will ever read, and an Add button that leads nowhere is worse
  // than an absent section. The page above already says "set one up below".
  //
  // Still shown when drivers ARE declared and no bridge is connected, because
  // a bridge that went away must not take its declarations out of reach —
  // that is exactly when someone needs to remove one.
  if (!hasBridge && drivers.length === 0 && !q.isLoading) return null;

  // Validated here as well as on the server, so the reason is visible next to
  // the field rather than arriving as a toast after a round trip.
  const kindBad = !!draft.kind && !KIND_RE.test(draft.kind);
  const shaBad = !!draft.sha256 && !SHA_RE.test(draft.sha256);
  const canSave =
    KIND_RE.test(draft.kind) && !!draft.version.trim() && SHA_RE.test(draft.sha256) && !!draft.source.trim();

  const head = "text-[10px] font-mono uppercase tracking-widest text-accent";
  const field =
    "w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1 text-xs";

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className={head}>// driver packages</div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            <Plus size={12} aria-hidden />
            Add a driver
          </button>
        )}
      </div>

      {q.isLoading ? (
        <div className="text-xs text-faint italic" aria-busy="true">
          loading…
        </div>
      ) : drivers.length === 0 && !adding ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <PackagePlus size={13} aria-hidden />
            No extra drivers.
          </div>
          <div className="text-[11px] text-faint">
            Your bridge runs its built-in drivers. Add one here to teach it something new, and it installs
            it on its next check.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-800 rounded-lg overflow-hidden">
          {drivers.map((d) => (
            <div key={`${d.kind}:${d.bridgeId ?? ""}`} className="flex items-center gap-2 px-2.5 py-2 text-xs">
              <span className="font-medium text-content dark:text-mortar-100">{d.kind}</span>
              <span className="font-mono text-faint">{d.version}</span>
              {d.bridgeId && <span className="text-faint">· {d.bridgeId}</span>}
              <span className="flex-1" />
              <button
                type="button"
                aria-label={`Remove ${d.kind}`}
                onClick={async () => {
                  // A removal is silent on the bridge until it next checks, so
                  // confirm rather than surprise somebody whose machine keeps
                  // working for another few minutes.
                  if (
                    await confirm({
                      title: `Stop running ${d.kind}?`,
                      message: "Your bridge removes it on its next check, so it keeps working until then.",
                      confirmLabel: "Stop running it",
                      destructive: true,
                    })
                  ) {
                    remove.mutate(d);
                  }
                }}
                className="text-faint hover:text-amber-600"
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="space-y-2 rounded-lg border border-dashed border-line dark:border-slate-700 p-2.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="block text-[10px] uppercase tracking-widest text-faint">Kind</span>
              <input
                className={field}
                value={draft.kind}
                placeholder="prusa-connect"
                onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
              />
              {kindBad && <span className="block text-[10px] text-amber-600">lowercase letters, digits and hyphens</span>}
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] uppercase tracking-widest text-faint">Version</span>
              <input
                className={field}
                value={draft.version}
                placeholder="1.2.0"
                onChange={(e) => setDraft({ ...draft, version: e.target.value })}
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="block text-[10px] uppercase tracking-widest text-faint">Source URL</span>
            <input
              className={field}
              value={draft.source}
              placeholder="https://…/prusa-connect.cjs"
              onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[10px] uppercase tracking-widest text-faint">SHA-256</span>
            <input
              className={`${field} font-mono`}
              value={draft.sha256}
              placeholder="64 hex characters"
              onChange={(e) => setDraft({ ...draft, sha256: e.target.value.trim().toLowerCase() })}
            />
            {shaBad && <span className="block text-[10px] text-amber-600">must be 64 hex characters</span>}
          </label>
          {/* The hash is not paperwork: it is what pins the version, so a source
              that changes under you is refused rather than installed. */}
          <div className="text-[10px] text-faint">
            The hash pins this exact build. If the source changes without the version changing, Cobblr
            refuses it instead of installing it.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canSave || declare.isPending}
              onClick={() => declare.mutate(draft)}
              className="rounded bg-cobble-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {declare.isPending ? "Declaring…" : "Declare"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(EMPTY);
                setAdding(false);
              }}
              className="text-xs text-muted hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
