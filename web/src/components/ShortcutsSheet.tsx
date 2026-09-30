// `?` (outside a box you are typing in) opens the list of every key the app
// answers to, read from the one registry the handlers themselves read
// (SHORTCUTS), so what it lists is what is bound (#4227). The command palette
// opens it too, as "Keyboard shortcuts".
import { useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import { Modal, SHORTCUTS, OPEN_SHORTCUTS_EVENT, isShortcut, keyCap, typingIn } from "@cobblr/platform-web";

// An arrow is a glyph some mono fonts draw as a dot; an icon is the same everywhere.
const ARROWS: Record<string, { Icon: typeof ArrowUp; label: string }> = {
  "↑": { Icon: ArrowUp, label: "Up arrow" },
  "↓": { Icon: ArrowDown, label: "Down arrow" },
  "←": { Icon: ArrowLeft, label: "Left arrow" },
  "→": { Icon: ArrowRight, label: "Right arrow" },
};

function Cap({ k }: { k: string }) {
  const arrow = ARROWS[k];
  return (
    <kbd
      aria-label={arrow?.label}
      className="inline-flex min-w-[1.75rem] items-center justify-center rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-content dark:text-mortar-100"
    >
      {arrow ? <arrow.Icon size={13} aria-hidden /> : keyCap(k)}
    </kbd>
  );
}

export function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typingIn(e.target) || !isShortcut(e, "shortcuts")) return;
      e.preventDefault();
      setOpen(true);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
  }, []);

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" size="md">
      <table className="w-full text-sm" data-testid="shortcuts-sheet">
        <tbody className="divide-y divide-line dark:divide-slate-800">
          {SHORTCUTS.map((s) => (
            <tr key={s.id} className="align-top">
              <th scope="row" className="py-2 pr-4 text-left font-normal whitespace-nowrap">
                <span className="inline-flex gap-1">
                  {s.keys.map((k) => (
                    <Cap key={k} k={k} />
                  ))}
                </span>
              </th>
              <td className="py-2">
                <div className="text-content dark:text-mortar-100">{s.does}</div>
                <div className="text-xs text-muted dark:text-slate-400">{s.where}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
