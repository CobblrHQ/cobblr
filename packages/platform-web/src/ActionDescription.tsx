import { cloneElement, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { PopoverLayer } from "./fixed-layers";

export function firstActionSentence(description: string) {
  return description.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() || description;
}

export function ActionDescription({ description, children, listed = false }: { description: string; children: ReactElement<HTMLAttributes<HTMLElement>>; listed?: boolean }) {
  const words = firstActionSentence(description);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const rect = open ? anchor.current?.getBoundingClientRect() : null;
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => cancel, []);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (e: globalThis.PointerEvent) => {
      if (e.target instanceof Node && !anchor.current?.contains(e.target)) { setOpen(false); held.current = false; }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  return (
    <span
      ref={anchor}
      className={listed ? "flex w-full min-w-0 items-start gap-3" : "relative inline-flex min-w-0"}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={() => { if (!held.current) setOpen(false); }}
      onFocus={() => setOpen(true)}
      onTouchStart={(e) => {
        cancel();
        held.current = false;
        const touch = e.touches[0];
        if (!touch) return;
        start.current = { x: touch.clientX, y: touch.clientY };
        timer.current = setTimeout(() => { held.current = true; setOpen(true); }, 500);
      }}
      onTouchMove={(e) => {
        const touch = e.touches[0];
        if (touch && start.current && Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) > 10) cancel();
      }}
      onTouchEnd={cancel}
      onTouchCancel={() => { cancel(); held.current = false; setOpen(false); }}
      onContextMenu={(e) => { if (held.current) e.preventDefault(); }}
      onClickCapture={(e) => {
        if (held.current) { e.preventDefault(); e.stopPropagation(); held.current = false; }
        else setOpen(false);
      }}
      onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
      onBlur={() => setOpen(false)}
    >
      {cloneElement(children, { "aria-describedby": open && !listed ? id : undefined, title: words })}
      {listed && <span className="min-w-0 text-xs text-muted dark:text-slate-400">{words}</span>}
      {open && !listed && rect && createPortal(<PopoverLayer id={id} role="tooltip" style={{ left: rect.left, top: rect.bottom + 6, width: 256 }} className="z-[80] max-w-[calc(100vw-2rem)] rounded-md border border-line bg-surface p-2 text-xs normal-case text-content shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-mortar-200">{words}</PopoverLayer>, document.body)}
    </span>
  );
}
