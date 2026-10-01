// A bulk action on the selection bar that opens from the bar itself.
//
// "Move to…" on a list used to open a modal: the page dimmed, the list went
// behind it, and choosing a place meant a dropdown in the middle of the
// screen, far from the button that asked (the owner, 2026-10-01, #4514). A
// bulk action is a short question about the rows still on screen, so it opens
// as a popover anchored to its button on the bar: no dim, the list stays in
// view, a click outside or Esc closes it, and what it does is undone from the
// toast rather than confirmed in a dialog first. Every bulk action on the bar
// that needs an answer opens this way.

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BackdropLayer, PopoverLayer } from "./fixed-layers";
import { useEscapeToClose } from "./useEscapeToClose";

export interface FooterActionPopoverProps {
  /** The button's words on the bar ("Move to…"). */
  label: string;
  icon?: ReactNode;
  /** What the open popover is called, for a screen reader. */
  title: string;
  /** The popover's body. `close` puts it away. */
  children: (close: () => void) => ReactNode;
  /** The popover's width in px; it narrows to a phone's screen on its own. */
  width?: number;
  "data-testid"?: string;
}

export function FooterActionPopover({ label, icon, title, children, width = 320, "data-testid": testId }: FooterActionPopoverProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useEscapeToClose(open, panel, close);
  useLayoutEffect(() => {
    if (open) setAnchor(trigger.current?.getBoundingClientRect() ?? null);
  }, [open]);
  // The first thing to type into, so a keyboard user can search at once.
  useLayoutEffect(() => {
    if (open && anchor) panel.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [open, anchor]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        className={"inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent " + (open ? "bg-subtle dark:bg-slate-800" : "")}
      >
        {icon}
        {label}
      </button>
      {open &&
        anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Invisible: the list stays in view, and a click on it closes the popover. */}
            <BackdropLayer className="z-[60]" onClick={close} />
            <PopoverLayer
              ref={panel}
              role="dialog"
              aria-label={title}
              data-testid={testId ? `${testId}-popover` : undefined}
              // Opens upward from the bar at the foot of the screen; the layer
              // moves itself back on screen if that would run off an edge.
              style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 8, width }}
              className="z-[61] flex max-h-[min(28rem,70vh)] flex-col overflow-hidden rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl"
            >
              {children(close)}
            </PopoverLayer>
          </>,
          document.body,
        )}
    </>
  );
}
