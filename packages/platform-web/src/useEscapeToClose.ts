// Esc closes the layer on top, and only that one.
//
// Every dialog listened for Escape on the document and closed itself, so one
// press closed every dialog that was open: Esc in the photo viewer over a
// part's page shut the viewer AND the part (#4319, found on the walk), and a
// confirm over a modal took the modal with it. The layer stack already knows
// which layer is on top; this asks it. lint:escape-closes-the-top-layer holds
// every layer's Escape to this hook.
import { useEffect, useRef, type RefObject } from "react";
import { isShortcut } from "./shortcuts";
import { isTopLayer } from "./layer-stack";

/** While `active`, Escape calls `onClose`, when the layer in `layer` is the
 *  one on top. A key pressed inside a surface marked data-modal-escape-exempt
 *  (the docked Ask Cobb panel, which sits beside dialogs) is not for a layer
 *  opened elsewhere; it IS for one opened from inside that surface (its own
 *  model menu), which is why the opener is remembered. */
export function useEscapeToClose(active: boolean, layer: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  // Who had focus when the layer opened, read while rendering it open (as
  // useDialogFocus does): by the effect, focus may already be inside it.
  const opener = useRef<Element | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current && typeof document !== "undefined") opener.current = document.activeElement;
  wasActive.current = active;
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (!isShortcut(e, "close") || e.defaultPrevented) return;
      const el = layer.current;
      if (!el || !isTopLayer(el)) return;
      const exempt = e.target instanceof HTMLElement ? e.target.closest("[data-modal-escape-exempt]") : null;
      if (exempt && !(opener.current && exempt.contains(opener.current))) return;
      e.preventDefault();
      close.current();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, layer]);
}
