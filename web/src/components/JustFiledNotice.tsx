// The notice a one-tap filing leaves on the table it filed into (lib/justFiled.ts).

import { Link, useLocation } from "react-router-dom";
import { CheckCircle, ScanLine, X } from "lucide-react";
import { useJustFiled } from "../lib/justFiled";

export function JustFiledNotice() {
  const { pathname } = useLocation();
  const { note, dismiss } = useJustFiled(pathname);
  if (!note) return null;
  return (
    <div
      data-testid="just-filed"
      className="mb-3 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <CheckCircle size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0 flex-1 text-sm text-content dark:text-mortar-100">
          <div className="font-medium">Filed in {note.label}.</div>
          {note.firstEver && <div className="text-[13px] text-muted dark:text-slate-400">{note.label} is new: find it any time in the menu.</div>}
          {note.installed && <div className="text-[12px] text-muted dark:text-slate-400">{note.installed}</div>}
        </div>
        <button type="button" onClick={dismiss} aria-label="Close" className="shrink-0 p-0.5 text-faint hover:text-content">
          <X size={16} />
        </button>
      </div>
      <div className="mt-2 ml-6 flex flex-wrap items-center gap-2">
        {note.record && (
          <Link
            to={note.record}
            onClick={dismiss}
            className="inline-flex min-h-9 items-center rounded-md bg-cobble-600 px-3 text-[13px] font-semibold text-white hover:bg-cobble-700"
          >
            Open it
          </Link>
        )}
        <Link
          to="/scan/camera"
          onClick={dismiss}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 text-[13px] text-content dark:text-mortar-100"
        >
          <ScanLine size={14} /> Scan another
        </Link>
      </div>
    </div>
  );
}
