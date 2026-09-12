// A menu that opens on hover AND on click needs one rule for the click, or
// the two fight: hover opens it as the pointer arrives, the click a moment
// later toggles it shut, and the person sees a menu that "holds nothing".
// That is what "More navigation links" did to the first-time review on
// 2026-09-12, and what it does to every automated browser, since a click is a
// hover first. The rule: a click while the pointer rests on the trigger
// OPENS, never toggles; with no hover in play (touch, keyboard) it toggles.
import { useRef, useState } from "react";

export function useHoverAwareOpen(closeDelayMs = 120) {
  const [open, setOpen] = useState(false);
  const hovering = useRef(false);
  const closeTimer = useRef<number | null>(null);

  function cancelClose() {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }
  /** Pointer arrived: open now, and remember it is resting here. */
  function hoverOpen() {
    hovering.current = true;
    cancelClose();
    setOpen(true);
  }
  /** Pointer left: close after the hover-intent delay, so crossing the gap
   *  between trigger and popover does not snap it shut. */
  function hoverClose() {
    hovering.current = false;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), closeDelayMs);
  }
  /** The click rule. */
  function clickTrigger() {
    setOpen((o) => (hovering.current ? true : !o));
  }
  /** Keep it open while the pointer is over the popover itself. */
  function stayOpen() {
    cancelClose();
    setOpen(true);
  }
  function close() {
    cancelClose();
    setOpen(false);
  }

  return { open, setOpen, hoverOpen, hoverClose, clickTrigger, stayOpen, close, cancelClose };
}
