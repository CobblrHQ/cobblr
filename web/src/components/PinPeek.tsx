// What a tap on a pin shows on a phone, before it leaves the plan (#4564).
//
// A finger has no hover, so on a phone the full name of a tightly packed
// socket was only reachable by opening its record and coming back. A tap now
// opens this card over the plan: the whole name, its size, how many, where it
// is, and Open to go to the record. A second tap on the same pin opens it too.
// A mouse is unchanged: hover shows the name, a click opens the record.
import { ChevronRight, X } from "lucide-react";
import { sizeOf } from "../lib/pinLabels";

export interface PinPeekThing {
  name: string;
  /** Its size from its own fields ("10 mm"); else read off the name. */
  size?: string | null;
  qty?: unknown;
  unit?: unknown;
  /** "holds 3 things" when it is a holder itself. */
  holds?: string | null;
}

/** The card's lines, apart from the name: size, count, place. */
export function peekLines(t: PinPeekThing, placeName: string): string[] {
  const out: string[] = [];
  const size = t.size || sizeOf(t.name);
  if (size) out.push(size);
  const n = typeof t.qty === "number" ? t.qty : typeof t.qty === "string" && t.qty.trim() !== "" ? Number(t.qty) : NaN;
  if (Number.isFinite(n)) {
    const unit = typeof t.unit === "string" && t.unit && t.unit !== "each" ? ` ${t.unit}` : "";
    out.push(`${n % 1 === 0 ? n : Number(n.toFixed(3))}${unit} here`);
  }
  out.push(`in ${placeName}`);
  if (t.holds) out.push(t.holds);
  return out;
}

export function PinPeek({
  thing,
  placeName,
  at,
  onOpen,
  onClose,
}: {
  thing: PinPeekThing;
  placeName: string;
  /** Where the pin is, as fractions of the drawing (0..1). */
  at: { x: number; y: number };
  onOpen: (() => void) | null;
  onClose: () => void;
}) {
  // Below the pin in the top of the drawing, above it lower down; leaning
  // away from whichever side it is near, so the card stays on the plan.
  const below = at.y < 0.55;
  const fromRight = at.x > 0.5;
  return (
    <div
      role="dialog"
      aria-label={thing.name}
      data-testid="pin-peek"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-20 w-56 max-w-[calc(100%-0.5rem)] rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 p-2.5 shadow-lg text-left"
      style={{
        ...(fromRight ? { right: `${(1 - at.x) * 100}%`, marginRight: -8 } : { left: `${at.x * 100}%`, marginLeft: -8 }),
        ...(below ? { top: `calc(${at.y * 100}% + 6px)` } : { bottom: `calc(${(1 - at.y) * 100}% + 22px)` }),
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium leading-snug text-content dark:text-mortar-100 break-words">{thing.name}</div>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 -mt-1 rounded p-1 text-muted hover:text-content">
          <X size={14} />
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted">
        {peekLines(thing, placeName).map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="mt-2 inline-flex min-h-9 w-full items-center justify-center gap-1 rounded-md border border-line dark:border-slate-600 text-sm font-medium text-content hover:border-accent"
        >
          Open <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
