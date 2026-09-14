// The item tools of an inbox card's ⋯ menu, offered by relevance (#3006).
//
// Every row used to list every tool: Split into items, Read as a receipt,
// Turn into a bin, Empty box and Item in box on a barcode-identified laser
// engraver. The row's `tool_hints` (the platform contract's scanToolRelevance,
// served on every row) say which could apply: `likely` tools render where
// they always did; `possible` and `no` fold behind one "More tools" row, each
// with the reason it is folded, so every capability stays reachable and
// nothing unrequested is read first. A desktop has the room for the fold; the
// phone item screen drops `no` and folds `possible` from the same hints.
import { useState, type ReactNode } from "react";
import { ChevronDown, MapPin, ReceiptText, Scissors } from "lucide-react";
import { SCAN_TOOLS, type ScanTool, type ScanToolHints } from "@cobblr/platform-contract/scan-tools";
import { MenuHead, MenuItem, MenuSep } from "./HeaderMenu";

export interface ScanToolMenuProps {
  hints: ScanToolHints | null | undefined;
  /** The row is pending; a filed row offers none of these. */
  pending: boolean;
  /** The row has a picture: Split and Read as a receipt need one. */
  hasPicture: boolean;
  /** The workspace has locations: Turn into a bin needs somewhere to be. */
  hasLocations: boolean;
  boxState: "empty-box" | "item-in-box" | null;
  busy: { split?: boolean; receipt?: boolean; boxState?: boolean };
  onSplit: () => void;
  onReceipt: () => void;
  onMakeBin: () => void;
  onBoxState: (state: "empty-box" | "item-in-box" | null) => void;
  /** The menu's other rows (retake, add a photo, fix the name), rendered
   *  between the likely tools and the fold so the fold stays last. */
  children?: ReactNode;
}

/** With no hints at all (an older api), every tool is offered as before. */
const LIKELY = { relevance: "likely" as const, reason: "" };

export function ScanToolMenu(p: ScanToolMenuProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  if (!p.pending) return null;
  const hintOf = (t: ScanTool) => p.hints?.[t] ?? LIKELY;
  // A tool the row cannot use at all (no picture to split, no locations to
  // put a bin in) is not offered anywhere; that is a capability gate, not a
  // relevance one.
  const available: Record<ScanTool, boolean> = {
    receipt: p.hasPicture,
    split: p.hasPicture,
    bin: p.hasLocations,
    box_state: true,
  };
  const inline = SCAN_TOOLS.filter((t) => available[t] && hintOf(t).relevance === "likely");
  const folded = SCAN_TOOLS.filter((t) => available[t] && hintOf(t).relevance !== "likely");

  const render = (t: ScanTool, reason: string | null) => {
    switch (t) {
      case "split":
        return (
          <MenuItem
            key="split"
            icon={<Scissors size={14} />}
            label={p.busy.split ? "AI is splitting…" : "Split into items"}
            hint={reason ?? "Several different things in one photo"}
            disabled={!!p.busy.split}
            onClick={p.onSplit}
          />
        );
      case "receipt":
        return (
          <MenuItem
            key="receipt"
            icon={<ReceiptText size={14} />}
            label={p.busy.receipt ? "Reading the receipt…" : "Read as a receipt"}
            hint={reason ?? "This photo is a receipt: split into its lines, reviewed before filing"}
            disabled={!!p.busy.receipt}
            onClick={p.onReceipt}
          />
        );
      case "bin":
        return (
          <MenuItem
            key="bin"
            icon={<MapPin size={14} />}
            label="Turn into a bin…"
            hint={reason ?? "This IS a container: make it a location you can scan into"}
            onClick={p.onMakeBin}
          />
        );
      case "box_state":
        return (
          <div key="box" data-testid="box-state-tools">
            <MenuHead>Box state{reason ? <span className="normal-case font-normal tracking-normal"> · {reason}</span> : null}</MenuHead>
            <MenuItem
              icon={<span className="text-[13px]">📦</span>}
              label="Empty box"
              hint="The box is here; the item isn't"
              state={p.boxState === "empty-box" ? "on" : undefined}
              disabled={!!p.busy.boxState}
              onClick={() => p.onBoxState(p.boxState === "empty-box" ? null : "empty-box")}
            />
            <MenuItem
              icon={<span className="text-[13px]">📦</span>}
              label="Item in box"
              hint="Still packaged — the box rides along"
              state={p.boxState === "item-in-box" ? "on" : undefined}
              disabled={!!p.busy.boxState}
              onClick={() => p.onBoxState(p.boxState === "item-in-box" ? null : "item-in-box")}
            />
          </div>
        );
    }
  };

  return (
    <>
      {inline.map((t) => render(t, null))}
      {inline.length > 0 && p.children ? <MenuSep /> : null}
      {p.children}
      {folded.length > 0 && (
        <>
          <MenuSep />
          {/* One row folds every tool the row gave no reason for. The reason a
              tool is folded is the line under it once opened: "not a
              container", "one unit seen". */}
          <button
            type="button"
            role="menuitem"
            aria-expanded={moreOpen}
            data-testid="more-tools"
            onClick={() => setMoreOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-faint dark:text-slate-500 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            <ChevronDown size={13} className={`shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
            <span>
              More tools <span className="text-[11px]">({folded.length} unlikely for this one)</span>
            </span>
          </button>
          {moreOpen && folded.map((t) => render(t, hintOf(t).reason || null))}
        </>
      )}
    </>
  );
}
