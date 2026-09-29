// A control whose value moves while it is dragged: a colour swatch, a slider.
//
// The browser fires `input` on every tick of a drag and `change` once, when
// the person lets go. React's onChange is the first of those, so a save wired
// to it wrote once per tick: one drag of a filament's colour saved about 86
// times in a minute, each write with its own activity row (#3942). Here every
// tick moves only what is on screen (`onPreview`), and the value is committed
// once, on release (`onCommit`). A slider moved with the arrow keys commits
// each step, which is one change per press.

import { forwardRef, useCallback, useEffect, useRef, useState, type InputHTMLAttributes } from "react";

export interface DragInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange"> {
  /** Which drag control. Named `control`, not `type`, so a bare
   *  type="color" or type="range" anywhere else is a hand-rolled one
   *  (capabilities: input:drag-saves-once). */
  control: "color" | "range";
  value: string | number;
  /** Every tick of the drag: a live preview, never a save. */
  onPreview?: (value: string) => void;
  /** Once, when the person lets go of the picker or the slider. */
  onCommit: (value: string) => void;
}

export const DragInput = forwardRef<HTMLInputElement, DragInputProps>(function DragInput({ control, value, onPreview, onCommit, ...rest }, ref) {
  const own = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      own.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  // What the control shows mid-drag; it follows `value` whenever no drag is
  // under way, so a save that lands elsewhere is reflected here.
  const [shown, setShown] = useState(String(value));
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setShown(String(value));
  }, [value]);

  const commit = useRef(onCommit);
  commit.current = onCommit;
  // What it held when the drag began. Not the current `value`: a caller that
  // previews by feeding each tick back into `value` has already moved it to
  // where the drag ended, and comparing to that would never save.
  const settled = useRef(String(value));
  if (!dragging.current) settled.current = String(value);
  useEffect(() => {
    const el = own.current;
    if (!el) return;
    // The native change event, not React's onChange (which is `input`).
    const onRelease = () => {
      dragging.current = false;
      setShown(el.value);
      if (el.value !== settled.current) {
        settled.current = el.value;
        commit.current(el.value);
      }
    };
    el.addEventListener("change", onRelease);
    return () => el.removeEventListener("change", onRelease);
  }, []);

  return (
    <input
      ref={setRef}
      {...rest}
      type={control}
      value={shown}
      onInput={(e) => {
        if (!dragging.current) settled.current = String(value);
        dragging.current = true;
        const v = (e.target as HTMLInputElement).value;
        setShown(v);
        onPreview?.(v);
      }}
      // React warns on a controlled input with no onChange; the work is done
      // by onInput (every tick) and the native change listener (release).
      onChange={() => {}}
    />
  );
});
