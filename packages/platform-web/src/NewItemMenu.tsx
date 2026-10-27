import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BackdropLayer, PopoverLayer } from "./fixed-layers";
import { useEscapeToClose } from "./useEscapeToClose";
import { useMenuFocus } from "./useMenuFocus";
import { ChevronDown, CopyPlus } from "lucide-react";
import { useFlowHost } from "./context";

export interface TemplateCreateArgs {
  kind?: string;
  instance?: string;
  scanItemId?: string;
  seed?: Record<string, unknown>;
}

export function NewFromTemplateButton({ args = {}, onOpen }: { args?: TemplateCreateArgs; onOpen?: () => void }) {
  const { openFlow } = useFlowHost();
  return (
    <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-content hover:bg-subtle dark:hover:bg-slate-800"
      onClick={() => { onOpen?.(); openFlow("core-templates:create", { ...args }); }}>
      <CopyPlus size={14} /> New from template
    </button>
  );
}

export function NewItemMenu({ children, ...args }: TemplateCreateArgs & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useEscapeToClose(open, panel, close);
  useMenuFocus(open, panel);
  useLayoutEffect(() => {
    if (open) setAnchor(trigger.current?.getBoundingClientRect() ?? null);
  }, [open]);
  return (
    // Never wider than its row: its button's words wrap rather than run past a
    // phone ("New licence or subscription" at 200% text, #8430).
    <div className="inline-flex min-w-0 max-w-full items-center gap-1">
      {children}
      <button
        ref={trigger}
        type="button"
        aria-label="More ways to add"
        title="More ways to add"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="shrink-0 rounded-md border border-line dark:border-slate-600 p-2 text-content hover:bg-subtle dark:hover:bg-slate-800"
      >
        <ChevronDown size={16} />
      </button>
      {/* A popover layer, which keeps itself on the screen: hung from the
          button's right edge as a plain box it started 11 px off a phone's
          left edge, and 58 px at 200% text (#6881). */}
      {open &&
        anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <BackdropLayer className="z-[60]" onClick={close} />
            <PopoverLayer
              ref={panel}
              role="menu"
              aria-label="More ways to add"
              data-testid="new-item-menu"
              style={{ top: anchor.bottom + 4, right: window.innerWidth - anchor.right }}
              className="z-[61] w-max rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 shadow-lg"
            >
              <NewFromTemplateButton args={args} onOpen={close} />
            </PopoverLayer>
          </>,
          document.body,
        )}
    </div>
  );
}
