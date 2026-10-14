// The one picker for where a scanned thing is filed (#6527). A split line's
// parent had a native select of the menu alone while its parts had the
// card's menu with their suggestions first, so one screen offered the same
// parts two lists in two orders; and the card's menu could not scroll on a
// phone. Every surface that files a scan into a table opens this, with the
// list destinationChoices orders, and lint:capabilities (scan:one-destination-
// picker) refuses a second one.
//
// The trigger stays the caller's (a pill, a segment, a parent row's picker):
// it is handed a ref, whether the menu is open and a toggle. The menu portals
// to the page, keeps itself on the screen, scrolls its own list, and follows
// its trigger when the page moves under it.
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { CheckCircle } from "lucide-react";
import { BackdropLayer, PopoverLayer, POPOVER_LAYER_CLASS, useEscapeToClose, useOverlayOpenFlag } from "@cobblr/platform-web";

export interface DestinationOption {
  key: string;
  label: string;
  /** Picking it turns its app on when the row is added. */
  installs?: boolean;
}

export interface DestinationTrigger {
  ref: Ref<HTMLButtonElement>;
  open: boolean;
  toggle: () => void;
  /** Spread on the trigger: the listbox it opens, and whether it is open. */
  props: { "aria-haspopup": "listbox"; "aria-expanded": boolean };
}

export function DestinationPicker({
  options,
  value,
  onPick,
  trigger,
  note,
  label = "File into",
  testId,
}: {
  options: readonly DestinationOption[];
  /** The key of the table it goes to now. */
  value: string | null;
  onPick: (key: string) => void;
  trigger: (t: DestinationTrigger) => ReactNode;
  /** A line above the list (what the current choice does). */
  note?: ReactNode;
  label?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number; above: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // The dismiss layer covers the app, so floating chrome yields to it.
  useOverlayOpenFlag(open);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useEscapeToClose(open, menu, close);
  // A page that moves under it (a row finishing above, a layout settling
  // once the overlay flag is up) takes the menu with its trigger, rather
  // than closing it under a finger; only a trigger scrolled off the screen
  // closes it. Its own list scrolling is neither (#6527).
  useEffect(() => {
    if (!open) return;
    const follow = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(`.${POPOVER_LAYER_CLASS}`)) return;
      const r = btn.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) return setOpen(false);
      setAt({ top: r.bottom + 4, left: r.left, above: r.top });
    };
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
    };
  }, [open]);
  // Focus the chosen table without scrolling to it: autoFocus scrolled the
  // page before the layer had moved itself on screen, and the page's scroll
  // closed the menu it had just opened.
  useEffect(() => {
    if (!open) return;
    const el = menu.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu.current?.querySelector<HTMLElement>('[role="option"]');
    el?.focus({ preventScroll: true });
  }, [open, at]);
  const toggle = () => {
    if (open) return close();
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 4, left: r.left, above: r.top });
    setOpen(true);
  };
  return (
    <>
      {trigger({ ref: btn, open, toggle, props: { "aria-haspopup": "listbox", "aria-expanded": open } })}
      {open &&
        at &&
        createPortal(
          <>
            <BackdropLayer className="z-[60]" onClick={(e) => { e.stopPropagation(); close(); }} />
            <PopoverLayer
              ref={menu}
              role="listbox"
              aria-label={label}
              data-testid={testId}
              style={{ top: at.top, left: at.left }}
              flipAbove={at.above}
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const opts = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
                const i = opts.indexOf(document.activeElement as HTMLButtonElement);
                opts[e.key === "ArrowDown" ? Math.min(i + 1, opts.length - 1) : Math.max(i - 1, 0)]?.focus();
              }}
              className="z-[61] w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl"
            >
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-faint">{label}</div>
              {note && <p className="px-3 pb-1.5 text-[11px] leading-snug text-muted border-b border-line dark:border-slate-700 mb-1">{note}</p>}
              {options.map((o) => {
                const on = o.key === value;
                return (
                  <button
                    key={o.key}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPick(o.key);
                      close();
                    }}
                    className={"flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm " + (on ? "font-medium text-accent bg-subtle/60 dark:bg-slate-800/60" : "text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800")}
                  >
                    <CheckCircle size={14} className={on ? "shrink-0" : "shrink-0 opacity-0"} />
                    <span className="min-w-0 truncate">{o.label}</span>
                    {o.installs && <span className="ml-auto shrink-0 text-[11px] text-faint">installs on add</span>}
                  </button>
                );
              })}
            </PopoverLayer>
          </>,
          document.body,
        )}
    </>
  );
}
