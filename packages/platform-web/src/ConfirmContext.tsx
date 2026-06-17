// In-app confirmation modal — replacement for window.confirm().
// Promise-based: `await confirm({...})` returns true | false. Only
// used for destructive / irreversible actions. Routine acks go via
// the toast surface.
//
// Usage:
//   const confirm = useConfirm();
//   const ok = await confirm({
//     title: "Delete this wire?",
//     message: "This can't be undone.",
//     confirmLabel: "Delete",
//     destructive: true,
//   });
//   if (!ok) return;

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tints the confirm button ember-red for destructive actions. */
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(Ctx);
  if (!fn) {
    // No-op fallback so components outside the provider don't crash.
    return () => Promise.resolve(false);
  }
  return fn;
}

interface PendingState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);
  const pendingRef = useRef<PendingState | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // Cancel any in-flight prompt so callers always get a result.
      if (pendingRef.current) pendingRef.current.resolve(false);
      setPending({ ...opts, resolve });
    });
  }, []);

  function close(ok: boolean) {
    const p = pendingRef.current;
    if (!p) return;
    p.resolve(ok);
    setPending(null);
  }

  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending]);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending && createPortal(
        <div
          className="fixed inset-0 z-[60] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => close(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-surface dark:bg-slate-900 rounded-xl shadow-2xl border border-line dark:border-slate-700 max-w-sm w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            {pending.title && (
              <h2 className="font-display text-base font-bold text-content dark:text-mortar-100 mb-2">
                {pending.title}
              </h2>
            )}
            <p className="text-sm text-content dark:text-mortar-200 whitespace-pre-wrap">
              {pending.message}
            </p>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => close(false)}
                className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
              >
                {pending.cancelLabel ?? "Cancel"}
              </button>
              <button
                onClick={() => close(true)}
                autoFocus
                className={
                  "px-3 py-1.5 rounded-md text-sm font-medium text-mortar-50 transition " +
                  (pending.destructive
                    ? "bg-ember-600 hover:bg-ember-700"
                    : "bg-slate-700 hover:bg-slate-600")
                }
              >
                {pending.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}
