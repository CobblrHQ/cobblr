// The unmissable "you are in someone else's workspace" overlay, shown whenever an
// operator-impersonation session is active (any shell — it's portaled to body and
// reads the per-tab session directly, so it needs no router/provider context).
//
//   • a fixed ring around the ENTIRE viewport — AMBER in read-only, hotter RED when
//     write mode is armed, so the colour itself tells you the mode;
//   • a top bar: who/where, the mode, a live countdown, the "Enable editing" safety
//     toggle (a confirm, never window.confirm), and Exit.
//
// Read-only is enforced server-side (withTenant); this is disclosure + the toggle.
// See docs/modules/operator-impersonation.md.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert, Eye, Pencil, X } from "lucide-react";
import { api } from "../lib/api";
import { useImpersonation, setImpersonationMode, clearImpersonation } from "../lib/impersonation";

const BAR_H = 36;

export function ImpersonationBanner() {
  const imp = useImpersonation();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = !!imp;

  // Push the whole app down so the fixed bar never covers the workspace header.
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.paddingTop;
    document.body.style.paddingTop = `${BAR_H}px`;
    return () => {
      document.body.style.paddingTop = prev;
    };
  }, [active]);

  // 1s tick for the countdown, only while a session is live.
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  const expired = imp ? new Date(imp.expires_at).getTime() - now <= 0 : false;

  // Auto-end the moment the grant expires — clear + return to the console.
  useEffect(() => {
    if (imp && expired) {
      clearImpersonation();
      window.location.assign("/admin");
    }
  }, [imp, expired]);

  if (!imp || expired) return null;

  const write = imp.mode === "write";
  const msLeft = new Date(imp.expires_at).getTime() - now;
  const mins = Math.floor(msLeft / 60000);
  const secs = Math.floor((msLeft % 60000) / 1000);
  const left = mins > 0 ? `${mins}m` : `${secs}s`;

  const setMode = async (mode: "read" | "write") => {
    setBusy(true);
    setError(null);
    try {
      await api.request("PATCH", `/super-admin/impersonations/${imp.session_id}`, { mode });
      setImpersonationMode(mode);
      setConfirmWrite(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change mode");
    } finally {
      setBusy(false);
    }
  };

  const exit = async () => {
    setBusy(true);
    try {
      await api.request("PATCH", `/super-admin/impersonations/${imp.session_id}`, { ended: true });
    } catch {
      /* end is best-effort; the token expires regardless */
    }
    clearImpersonation();
    window.location.assign("/admin");
  };

  const accent = write ? "bg-red-600" : "bg-amber-600";
  const ring = write ? "ring-red-500" : "ring-amber-500";

  return createPortal(
    <>
      <div aria-hidden className={`pointer-events-none fixed inset-0 z-[2000] ring-[3px] ring-inset ${ring}`} />
      <div
        className={`fixed top-0 inset-x-0 z-[2001] flex items-center gap-2 px-3 ${accent} text-white text-[13px] font-medium shadow`}
        style={{ height: BAR_H }}
      >
        <ShieldAlert size={15} className="shrink-0" />
        <span className="truncate">
          Viewing as <b>{imp.target.name}</b> · <b>{imp.workspace.name}</b> ·{" "}
          {write ? <b>EDITING — changes are real</b> : "read-only"} · expires in {left}
        </span>
        <div className="flex-1" />
        {error && <span className="text-white/90 text-[11px] truncate max-w-[200px]">{error}</span>}
        {write ? (
          <button
            onClick={() => setMode("read")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-white/15 hover:bg-white/25 px-2 py-0.5 disabled:opacity-50"
          >
            <Eye size={13} /> Back to read-only
          </button>
        ) : (
          <button
            onClick={() => setConfirmWrite(true)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-white/15 hover:bg-white/25 px-2 py-0.5 disabled:opacity-50"
          >
            <Pencil size={13} /> Enable editing
          </button>
        )}
        <button
          onClick={exit}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded bg-black/25 hover:bg-black/40 px-2 py-0.5 disabled:opacity-50"
        >
          <X size={13} /> Exit
        </button>
      </div>

      {confirmWrite && (
        <div
          className="fixed inset-0 z-[2002] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirmWrite(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-semibold mb-2">
              <Pencil size={16} /> Enable editing?
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              You'll be able to make <b>real changes</b> in <b>{imp.workspace.name}</b> as{" "}
              <b>{imp.target.name}</b>. Every change is attributed to you and logged.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmWrite(false)}
                className="rounded px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={() => setMode("write")}
                disabled={busy}
                className="rounded bg-red-600 hover:bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Enable editing
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
