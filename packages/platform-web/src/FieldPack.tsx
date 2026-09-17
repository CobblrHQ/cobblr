// The grid every form of fields renders through (#3067): field-pack.ts
// decides the rows from each field's need and the measured width; this
// component measures and draws them. A cell is `min-w-0` so a native
// control inside it can never claim more than its column (the iOS date
// input that ran under its neighbour), and a control is styled to shrink
// (fieldPackControlClass below) rather than to keep an intrinsic width.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { packFields, GAP_PX, type FieldNeed, type PackOptions } from "./field-pack";

export interface FieldPackItem {
  need: FieldNeed;
  node: ReactNode;
}

/** The classes a native control inside a pack carries so it fits its cell:
 *  full width, no intrinsic minimum, and on WebKit no platform appearance,
 *  which is what lets an iOS date input honour a width at all. */
export const fieldPackControlClass = "w-full min-w-0 max-w-full appearance-none";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A grid of fields packed by what each needs. `width` overrides the
 * measurement (tests, a server render); otherwise the container is measured
 * and re-measured as it resizes. Before the first measurement a phone's
 * width is assumed, so the first paint on a phone is already right.
 *
 * An item may be `null`/`false`: a field a preset hides or a face turns
 * off contributes no cell, so a caller writes `cond ? item : null` in the
 * list rather than a wrapper that would leave an empty cell behind.
 */
export function FieldPack({
  items,
  className,
  width,
  assumedWidth = 361,
  gapPx = GAP_PX,
  minColPx,
  maxCols,
  testId,
}: {
  items: readonly (FieldPackItem | null | false | undefined)[];
  className?: string;
  width?: number;
  assumedWidth?: number;
  gapPx?: number;
  minColPx?: number;
  maxCols?: number;
  testId?: string;
} & PackOptions) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useIsoLayoutEffect(() => {
    if (width !== undefined) return;
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setMeasured((prev) => (prev !== null && Math.abs(prev - w) < 1 ? prev : w));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  const w = width ?? measured ?? assumedWidth;
  const present = items.filter((i): i is FieldPackItem => !!i);
  const packing = packFields(present.map((i) => i.need), w, { gapPx, minColPx, maxCols });
  return (
    <div
      ref={ref}
      data-testid={testId ?? "field-pack"}
      data-pack-cols={packing.cols}
      className={"grid min-w-0 " + (className ?? "")}
      style={{ gridTemplateColumns: `repeat(${packing.cols}, minmax(0, 1fr))`, gap: `${gapPx}px` }}
    >
      {/* Cells are matched to items by position (the packer keeps order),
          never by key: two fields that share a key (a table's own
          "category" beside a form's native one) must each keep their own
          control, not both draw the last one. */}
      {packing.cells.map((c, i) => (
        <div key={`${c.key}#${i}`} data-pack-key={c.key} data-pack-span={c.span} className="flex min-w-0 flex-col justify-end" style={{ gridColumn: `span ${c.span} / span ${c.span}` }}>
          {present[i]?.node}
        </div>
      ))}
    </div>
  );
}
