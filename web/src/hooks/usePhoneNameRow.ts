import { useLayoutEffect, useState } from "react";

/** The phone's top bar keeps the workspace name beside its icons while that
 *  leaves the name room for six characters' width. With less (text at 200%,
 *  or a 320 px phone), a name that would be cut takes a row of its own under
 *  the bar, where it has the screen's width (#9502). */
export const NAME_ROOM_EM = 6;

export function nameWantsOwnRow({ room, needed, fontPx }: { room: number; needed: number; fontPx: number }): boolean {
  return needed > room + 0.5 && room < NAME_ROOM_EM * fontPx;
}

/** `r` is the bar's flex row and `n` the element that holds the switcher, a
 *  direct child of it, both from callback refs so a bar drawn after the
 *  workspace loads is still measured. The room is what the name would have on
 *  one row, whichever row it sits on now, so the answer never flips back. */
export function usePhoneNameRow(r: HTMLElement | null, n: HTMLElement | null): boolean {
  const [own, setOwn] = useState(false);
  useLayoutEffect(() => {
    if (!r || !n || typeof ResizeObserver === "undefined") return;
    const phone = window.matchMedia("(max-width: 767.98px)");
    let queued = 0;
    const measure = () => {
      queued = 0;
      const label = n.querySelector<HTMLElement>("button span.truncate");
      const button = n.querySelector<HTMLElement>("button");
      if (!phone.matches || !label || !button) return setOwn(false);
      const cs = getComputedStyle(r);
      const gap = parseFloat(cs.columnGap) || 0;
      const inner = r.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      // A spacer that grows fills whatever the name leaves, so it is counted as nothing but its gap.
      const others = [...r.children].filter((c) => c !== n && c.getClientRects().length > 0) as HTMLElement[];
      const fixed = (c: HTMLElement) => (parseFloat(getComputedStyle(c).flexGrow) > 0 ? 0 : c.getBoundingClientRect().width);
      const taken = others.reduce((sum, c) => sum + fixed(c), 0) + gap * others.length;
      const chrome = button.getBoundingClientRect().width - label.clientWidth;
      const room = inner - taken - chrome;
      const needed = label.scrollWidth;
      setOwn(nameWantsOwnRow({ room, needed, fontPx: parseFloat(getComputedStyle(label).fontSize) || 16 }));
    };
    const update = () => { if (!queued) queued = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(update);
    ro.observe(r);
    ro.observe(document.documentElement);
    const label = n.querySelector("button span.truncate");
    if (label) ro.observe(label);
    const mo = new MutationObserver(update);
    mo.observe(n, { subtree: true, characterData: true, childList: true });
    phone.addEventListener("change", update);
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
      phone.removeEventListener("change", update);
      if (queued) cancelAnimationFrame(queued);
    };
  }, [r, n]);
  return own;
}
