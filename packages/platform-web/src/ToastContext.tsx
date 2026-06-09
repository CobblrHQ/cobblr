// Global toast stack — bottom-right, auto-dismiss for info/success/
// error, sticky for `action` toasts with an inline button.
//
// Usage:
//   const toast = useToast();
//   toast.success("Saved.");
//   toast.error("Couldn't save.");
//   toast.info("Importing 12 parts…");
//   toast.action("Wire fired — view the result?", {
//     actionLabel: "Open",
//     onAction: () => navigate("/projects/123"),
//   });

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, AlertTriangle, X } from "lucide-react";

type Kind = "info" | "success" | "error" | "action";

interface Toast {
  id: number;
  kind: Kind;
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  /** ms; 0 = sticky. Defaults: info 4000, success 5000, error 8000, action 0. */
  duration: number;
}

interface ToastCtx {
  info: (msg: string, opts?: Partial<Omit<Toast, "id" | "kind" | "message">>) => number;
  success: (msg: string, opts?: Partial<Omit<Toast, "id" | "kind" | "message">>) => number;
  error: (msg: string, opts?: Partial<Omit<Toast, "id" | "kind" | "message">>) => number;
  action: (
    msg: string,
    opts: {
      actionLabel: string;
      onAction: () => void | Promise<void>;
      duration?: number;
    },
  ) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((t: Omit<Toast, "id">): number => {
    const id = nextId++;
    setToasts((cur) => [...cur, { ...t, id }]);
    return id;
  }, []);

  const toastApi: ToastCtx = {
    info: (message, opts) => push({ kind: "info", message, duration: 4000, ...opts }),
    success: (message, opts) => push({ kind: "success", message, duration: 5000, ...opts }),
    error: (message, opts) => push({ kind: "error", message, duration: 8000, ...opts }),
    action: (message, opts) =>
      push({
        kind: "action",
        message,
        duration: opts.duration ?? 0,
        actionLabel: opts.actionLabel,
        onAction: opts.onAction,
      }),
    dismiss,
  };

  return (
    <Ctx.Provider value={toastApi}>
      {children}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return {
      info: () => 0, success: () => 0, error: () => 0, action: () => 0, dismiss: () => {},
    };
  }
  return ctx;
}

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (typeof document === "undefined") return null;
  // Portal to <body> + z above modals (Modal backdrop is z-50): a plain fixed
  // div gets TRAPPED behind a modal's backdrop-blur (same stacking issue the
  // overlay-portal rule fixes) — the "token minted/copied" toast came out
  // blurred. Body-portal + z-[100] lifts toasts above any modal.
  return createPortal(
    <div className="fixed right-4 bottom-4 z-[100] flex flex-col gap-2 max-w-[calc(100vw-2rem)] w-80 pointer-events-none">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (toast.duration > 0) {
      timerRef.current = window.setTimeout(() => dismiss(toast.id), toast.duration);
      return () => {
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
      };
    }
    return undefined;
  }, [toast.id, toast.duration, dismiss]);

  async function handleAction() {
    if (!toast.onAction || busy) return;
    setBusy(true);
    try {
      await toast.onAction();
      dismiss(toast.id);
    } finally {
      setBusy(false);
    }
  }

  const palette = paletteFor(toast.kind);
  const Icon = iconFor(toast.kind);

  return (
    <div
      className={
        "pointer-events-auto rounded-xl shadow-lg border px-3 py-2.5 flex items-start gap-2.5 transition " +
        palette.container
      }
      role="status"
      aria-live={toast.kind === "error" ? "assertive" : "polite"}
    >
      <Icon size={16} className={`shrink-0 mt-0.5 ${palette.icon}`} />
      <div className="flex-1 min-w-0">
        <div className={`text-sm leading-snug ${palette.text}`}>{toast.message}</div>
        {toast.kind === "action" && toast.actionLabel && (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={handleAction}
              disabled={busy}
              className="px-2.5 py-1 rounded text-xs font-medium bg-cobble-600 text-mortar-50 hover:bg-cobble-700 disabled:opacity-60"
            >
              {busy ? "Working…" : toast.actionLabel}
            </button>
            <button
              onClick={() => dismiss(toast.id)}
              className="text-xs text-muted hover:text-slate-800 dark:hover:text-slate-200"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      {toast.kind !== "action" && (
        <button
          onClick={() => dismiss(toast.id)}
          className={`shrink-0 ${palette.icon} hover:opacity-75 mt-0.5`}
          title="Dismiss"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function paletteFor(kind: Kind) {
  switch (kind) {
    case "success":
      return {
        container: "bg-moss-50 dark:bg-moss-500/10 border-moss-200 dark:border-moss-500/30",
        icon: "text-moss-600 dark:text-moss-300",
        text: "text-moss-900 dark:text-moss-100",
      };
    case "error":
      return {
        container: "bg-ember-50 dark:bg-ember-500/10 border-ember-200 dark:border-ember-500/30",
        icon: "text-ember-600 dark:text-ember-300",
        text: "text-ember-900 dark:text-ember-100",
      };
    case "action":
      return {
        container: "bg-cobble-50 dark:bg-cobble-500/10 border-cobble-200 dark:border-cobble-500/30",
        icon: "text-accent dark:text-cobble-300",
        text: "text-cobble-900 dark:text-cobble-100",
      };
    case "info":
    default:
      return {
        container: "bg-surface dark:bg-slate-800 border-line dark:border-slate-700",
        icon: "text-muted dark:text-slate-400",
        text: "text-content dark:text-mortar-100",
      };
  }
}

function iconFor(kind: Kind) {
  switch (kind) {
    case "success": return CheckCircle2;
    case "error":   return AlertTriangle;
    case "action":  return Info;
    case "info":
    default:        return Info;
  }
}
