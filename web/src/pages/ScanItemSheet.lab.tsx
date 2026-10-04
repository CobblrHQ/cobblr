// Every state the item sheet's footer can be in, rendered side by side for
// e2e/sheet-footer-never-clips.mjs, which measures each one in a real
// browser at phone widths and text sizes. Not part of the app: the walk
// imports it through the dev server and mounts it over a blank page.
//
// The labels come from the contract, not from a list kept here: every
// ACTION_* the scan copy exports is a primary this footer may carry, so a
// new action word is walked the day it is added, and the table names are
// the lengths a workspace really has.
import { useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { CheckCircle, Download } from "lucide-react";
import * as copy from "@cobblr/platform-contract/scan-copy";
import { SHEET_ACTION_CLASS, SheetActionLabel, ScanItemSheetFooter } from "./ScanItemSheet";

const TABLES = ["Home Inventory", "Grandmother's sewing notions, buttons and trims"];

const ACTION_WORDS: string[] = [
  ...Object.entries(copy)
    .filter(([k, v]) => k.startsWith("ACTION_") && typeof v === "string")
    .map(([, v]) => v as string),
  ...TABLES.map((t) => copy.actionInstallAdd(t)),
];

export interface SheetFooterLabState {
  name: string;
  formOpen: boolean;
  addLabel?: string;
  primary?: { label: string; busy: boolean };
  slot?: { label: string; install: boolean };
}

export function sheetFooterLabStates(): SheetFooterLabState[] {
  const states: SheetFooterLabState[] = [];
  for (const t of [...TABLES, null]) states.push({ name: `closed: add to ${t ?? "a table"}`, formOpen: false, addLabel: t ? `Add to ${t}…` : "Add to a table…" });
  for (const w of ACTION_WORDS) {
    states.push({ name: `open: primary ${w}`, formOpen: true, primary: { label: w, busy: false } });
    states.push({ name: `open: primary ${w}, busy`, formOpen: true, primary: { label: w, busy: true } });
    states.push({ name: `open: form's ${w}`, formOpen: true, slot: { label: w, install: w.startsWith("Turn on ") } });
  }
  for (const t of TABLES) states.push({ name: `open: installing ${t}`, formOpen: true, slot: { label: `Installing ${t}…`, install: true } });
  return states;
}

function LabFooter({ state }: { state: SheetFooterLabState }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const noop = () => {};
  return (
    <div data-lab-state={state.name} className="border-b-8 border-subtle">
      <ScanItemSheetFooter
        formOpen={state.formOpen}
        addLabel={state.addLabel ?? ""}
        onOpenForm={noop}
        primary={state.primary ? { ...state.primary, onClick: noop } : null}
        onCancel={noop}
        onDiscard={noop}
        discardPending={false}
        setActionSlot={setSlot}
      />
      {slot && state.slot
        ? createPortal(
            <div className="flex flex-row-reverse items-center gap-2">
              <button type="button" className={`${SHEET_ACTION_CLASS} bg-cobble-600`}>
                <SheetActionLabel icon={state.slot.install ? <Download size={14} /> : <CheckCircle size={14} />}>{state.slot.label}</SheetActionLabel>
              </button>
            </div>,
            slot,
          )
        : null}
    </div>
  );
}

/** Mount every state in place of the app: the app's root is hidden, so the
 *  lab is the page and nothing floats over it. */
export function mountSheetFooterLab(): number {
  const app = document.getElementById("root");
  if (app) app.style.display = "none";
  const host = document.createElement("div");
  host.id = "sheet-footer-lab";
  host.className = "min-h-screen bg-surface dark:bg-slate-900";
  document.body.appendChild(host);
  const states = sheetFooterLabStates();
  createRoot(host).render(
    <div>
      {states.map((s) => (
        <LabFooter key={s.name} state={s} />
      ))}
    </div>,
  );
  return states.length;
}
