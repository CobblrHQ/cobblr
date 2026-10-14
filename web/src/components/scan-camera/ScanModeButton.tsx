// The scan camera's one Mode button (#6438): it names the mode a scan will
// use, and opens a short menu that says what each one does. It replaced three
// pills (Move, Sort, Count) for one setting the owner could not read without
// an explanation. Self-contained, so it sits in the top bar or the bottom-left
// slot with one line: its menu opens below it, or above when there is no room.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Check, Hash, Plus, Zap, type LucideIcon } from "lucide-react";
import { PopoverLayer, useEscapeToClose } from "@cobblr/platform-web";
import { SCAN_MODES, scanModeLabel, type ScanMode } from "./scanMode";

const ICON: Record<ScanMode, LucideIcon> = { add: Plus, move: ArrowLeftRight, count: Hash, sort: Zap };
const ON: Record<ScanMode, string> = {
  add: "bg-black/50 text-white hover:bg-black/70",
  move: "bg-emerald-500 text-white",
  count: "bg-amber-500 text-white",
  sort: "bg-cobble-600 text-white",
};

const MENU_WIDTH = 288;

export function ScanModeButton({ mode, onChoose }: { mode: ScanMode; onChoose: (mode: ScanMode) => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const open = rect !== null;
  const setOpen = (o: boolean) => setRect(o ? (button.current?.getBoundingClientRect() ?? null) : null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  useEscapeToClose(open, menu, () => setOpen(false));
  const Icon = ICON[mode];
  return (
    <div className="shrink-0">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Scan mode: ${scanModeLabel(mode)}`}
        title="What a scan does: tap to choose"
        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs ${ON[mode]}`}
      >
        <Icon size={13} /> {scanModeLabel(mode)}
      </button>
      {rect &&
        createPortal(
        <PopoverLayer
          ref={menu}
          role="menu"
          aria-label="Scan mode"
          flipAbove={rect.top}
          style={{ left: rect.right - MENU_WIDTH, top: rect.bottom + 8, width: MENU_WIDTH }}
          className="z-[80] rounded-xl bg-slate-900/95 p-1.5 text-white shadow-xl ring-1 ring-white/10"
        >
          {SCAN_MODES.map((m) => {
            const MIcon = ICON[m.mode];
            const current = m.mode === mode;
            return (
              <button
                key={m.mode}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                onClick={() => {
                  setOpen(false);
                  if (!current) onChoose(m.mode);
                }}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left ${current ? "bg-white/10 dark:bg-white/10" : "hover:bg-white/5 dark:hover:bg-white/5"}`}
              >
                <MIcon size={15} className="mt-0.5 shrink-0 text-white/70" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-xs text-white/65">{m.line}</span>
                </span>
                {current && <Check size={15} className="mt-0.5 shrink-0 text-emerald-400" />}
              </button>
            );
          })}
        </PopoverLayer>,
        document.body,
      )}
    </div>
  );
}
