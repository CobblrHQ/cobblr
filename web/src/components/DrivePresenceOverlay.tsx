// DrivePresenceOverlay — Feature 3 polish: shows WHERE Claude is pointing on the
// driven tab. Renders a cursor (+ optional click ripple + label) at a CSS-selector
// target or raw coordinates, scrolls it into view, and fades after a couple of
// seconds. Pointer-events-none so it never blocks the real UI.

import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import type { DrivePresence } from "../hooks/useBrowserDrive";

export function DrivePresenceOverlay({ presence }: { presence: DrivePresence | null }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!presence) {
      setVisible(false);
      return;
    }
    let x = presence.x ?? 0;
    let y = presence.y ?? 0;
    if (presence.selector) {
      try {
        const el = document.querySelector(presence.selector);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          const r = el.getBoundingClientRect();
          x = r.left + r.width / 2;
          y = r.top + r.height / 2;
        }
      } catch {
        /* invalid selector — fall back to x/y (or 0,0) */
      }
    }
    setPos({ x, y });
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence?.seq]);

  if (!visible || !pos) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[1100]" aria-hidden>
      <div className="absolute transition-all duration-300 ease-out" style={{ left: pos.x, top: pos.y }}>
        {presence?.ripple && (
          <span className="absolute -left-3 -top-3 h-8 w-8 rounded-full bg-cobble-400/50 animate-ping" />
        )}
        <MousePointer2 size={22} className="text-cobble-600 drop-shadow-md" fill="currentColor" />
        {presence?.label && (
          <span className="absolute left-5 top-3 whitespace-nowrap rounded bg-cobble-600 text-white text-xs px-2 py-0.5 shadow-md">
            {presence.label}
          </span>
        )}
      </div>
    </div>
  );
}
