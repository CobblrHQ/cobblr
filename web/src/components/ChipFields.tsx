// A scan item's fields as chips, instead of a column of labelled boxes.
//
// WHY. The confirm form rendered one ~72px labelled block per field, including
// every field the table declares that the scan left empty. A 3D printer is 14 of
// those and the scan fills two, so the page was mostly empty inputs and ran past
// a phone screen and a half ("on mobile they are like another full page just of
// fields", 2026-08-13). As chips a field costs its own width, several share a
// row, and the same item lays out in 3 rows.
//
// The layout arithmetic is in lib/chipPack.ts, tested there. This file owns the
// parts that need a browser: measuring, focus, and editing.
//
// THE EDIT RULES, each one a correction from review:
//
//   opening moves nothing   min-width is pinned to the chip's CURRENT width, so
//                           the chip cannot shrink, and the input opens at the
//                           value's exact measured width. A first attempt froze
//                           `width` outright, which stopped the jump and made you
//                           type into a fixed box, scrolling a string you could
//                           not see.
//   typing grows the chip   width follows a hidden mirror measured in the input's
//                           own font. Past the row it takes a full row and keeps
//                           growing there, so a long value is never scrolled.
//   adding is ONE gesture   tapping an "add a detail" chip promotes it AND opens
//                           it focused. Promoting it to a chip you then have to
//                           tap again is two gestures for one intent.
//   a blank add is undone   ask for a field, type nothing, tap away, and it goes
//                           back on offer rather than sitting there empty.
//
// Non-text fields (select, date) open the same control the form used before —
// the chip replaces the label-and-box chrome, not the input itself.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { packChips, type ChipMeasure } from "../lib/chipPack";

export type ChipFieldType = "text" | "number" | "select" | "date";

export interface ChipFieldDef {
  key: string;
  label: string;
  value: string;
  type?: ChipFieldType;
  choices?: string[] | null;
  placeholder?: string;
  /** Shown as the value when empty and the field is already on the item. */
  emptyHint?: string;
  /** Tapping opens THIS instead of an inline editor. For a field whose control is
   *  a picker rather than a text box (location opens a drawer), the chip is the
   *  trigger and the existing control is untouched. */
  onActivate?: () => void;
  /** Rendered before the value — a location pin, a status dot. */
  icon?: React.ReactNode;
}

interface Props {
  /** For a field whose control is richer than a text box — a colour swatch, a
   *  boolean, anything carrying help prose — return the existing editor and the
   *  chip will host it at full width instead of substituting a plain input.
   *  Reimplementing those in chip form would have quietly dropped the swatch
   *  picker, the checkbox and every field's help text. */
  /** Chip scale of the card's own read-only chips, for sitting in that row. */
  dense?: boolean;
  renderEditor?: (def: ChipFieldDef) => React.ReactNode | null;
  /** Fields with a value, plus any the user has added. */
  fields: ChipFieldDef[];
  /** Declared-but-empty fields, offered below. */
  available: ChipFieldDef[];
  onChange: (key: string, value: string) => void;
  /** A field was taken from `available`; the caller moves it into `fields`. */
  onAdd: (key: string) => void;
  /** An added field was left blank, so it returns to `available`. */
  onDrop: (key: string) => void;
  addLabel?: string;
}

const GAP = 6;

export function ChipFields({ fields, available, onChange, onAdd, onDrop, renderEditor, addLabel = "Add a detail", dense = false }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLSpanElement | null>(null);
  const chipRefs = useRef(new Map<string, HTMLSpanElement>());
  const [editing, setEditing] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [wide, setWide] = useState<Set<string>>(new Set());
  /** Keys added this session, so a blank one can be returned rather than kept. */
  const addedRef = useRef(new Set<string>());
  /** Read inside relayout without making it depend on `editing` and go stale. */
  const editingRef = useRef<string | null>(null);
  editingRef.current = editing;

  // Measure and pack. Runs after layout so widths are real, and only when the
  // set of fields or their values actually changes.
  const relayout = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    // NEVER re-pack mid-edit. The chip being edited is excluded from the
    // measurement (its width is not representative), so packing without it
    // reorders everything else — which is exactly the layout moving under the
    // finger that the pinned min-width exists to prevent. The e2e caught this:
    // the mockup had no re-pack step, so it could not have.
    if (editingRef.current) return;
    const measures: ChipMeasure[] = [];
    for (const f of fields) {
      const el = chipRefs.current.get(f.key);
      if (!el) continue;
      // Measure at natural width: a chip mid-edit is not representative.
      if (el.classList.contains("is-editing")) continue;
      measures.push({ key: f.key, width: el.getBoundingClientRect().width });
    }
    if (measures.length === 0) return;
    const packed = packChips(measures, box.clientWidth, GAP);
    setOrder(packed.order);
    setWide(packed.wide);
  }, [fields]);

  useLayoutEffect(() => {
    relayout();
  }, [relayout, fields.length]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => relayout());
    ro.observe(box);
    return () => ro.disconnect();
  }, [relayout]);

  const ordered = order.length
    ? [...fields].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    : fields;

  return (
    <div className="space-y-2">
      <span
        ref={mirrorRef}
        aria-hidden="true"
        className="absolute -left-[9999px] -top-[9999px] invisible whitespace-pre text-sm"
      />
      <div ref={boxRef} className="flex flex-wrap gap-1.5">
        {ordered.map((f) => (
          <Chip
            dense={dense}
            key={f.key}
            def={f}
            wide={wide.has(f.key)}
            editing={editing === f.key}
            mirror={mirrorRef}
            container={boxRef}
            customEditor={renderEditor?.(f) ?? null}
            register={(el) => {
              if (el) chipRefs.current.set(f.key, el);
              else chipRefs.current.delete(f.key);
            }}
            onOpen={() => setEditing(f.key)}
            onCommit={(next) => {
              setEditing(null);
              if (!next.trim() && addedRef.current.has(f.key)) {
                addedRef.current.delete(f.key);
                onDrop(f.key);
                return;
              }
              if (next !== f.value) onChange(f.key, next);
              requestAnimationFrame(relayout);
            }}
          />
        ))}
        {/* In the card's chip row the "add a field" offers TRAIL the chips - the
            same row, no caption. As their own block under a label they cost two
            lines for a couple of pills, and the row above them stopped short of
            the space they then took. The relayout walks the registered chips,
            not the box's children, so these are not measured as chips. */}
        {dense && available.length > 0 && (
          available.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              addedRef.current.add(f.key);
              onAdd(f.key);
              // The tap that asks for a field is the tap that opens it - into
              // TYPING for a text field, and into its own control for a field
              // that has one. Sending a picker field to the text input instead
              // handed the user a box that wrote a free-text string where an
              // id belonged (Location, 2026-08-22).
              if (f.onActivate) f.onActivate();
              else setEditing(f.key);
            }}
            className="rounded-full bg-subtle/60 dark:bg-slate-800/60 border border-line/70 dark:border-slate-700/70 px-2 py-0.5 text-[11.5px] text-content dark:text-mortar-200 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
          >
            <span className="text-cobble-600 dark:text-cobble-400 font-medium mr-1">+</span>
            {f.label}
          </button>
          ))
        )}
      </div>

      {!dense && available.length > 0 && (
        <>
          <p className="text-[11px] text-muted dark:text-slate-400 pt-0.5">{addLabel}</p>
          <div className="flex flex-wrap gap-1.5">
            {available.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  addedRef.current.add(f.key);
                  onAdd(f.key);
                  // The tap that asks for a field is the tap that opens it - into
                  // TYPING for a text field, and into its own control for a field
                  // that has one. Sending a picker field to the text input instead
                  // handed the user a box that wrote a free-text string where an
                  // id belonged (Location, 2026-08-22).
                  if (f.onActivate) f.onActivate();
                  else setEditing(f.key);
                }}
                className="rounded-full bg-subtle/60 dark:bg-slate-800/60 border border-line/70 dark:border-slate-700/70 px-2.5 py-1 text-[11.5px] text-content dark:text-mortar-200 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
              >
                <span className="text-cobble-600 dark:text-cobble-400 font-medium mr-1">+</span>
                {f.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({
  def,
  wide,
  editing: editingProp,
  mirror,
  container,
  register,
  onOpen,
  onCommit,
  customEditor,
  dense,
}: {
  def: ChipFieldDef;
  dense?: boolean;
  wide: boolean;
  editing: boolean;
  customEditor?: React.ReactNode | null;
  mirror: React.RefObject<HTMLSpanElement | null>;
  container: React.RefObject<HTMLDivElement | null>;
  register: (el: HTMLSpanElement | null) => void;
  onOpen: () => void;
  onCommit: (next: string) => void;
}) {
  // A field that owns a control is NEVER a text box, whatever put it into
  // the editing state. Belt and braces beside the add-button fix: the text
  // input commits through onChange, which for a picker field means writing
  // its label into a custom field and leaving the real id unset.
  const editing = editingProp && !def.onActivate;
  const ref = useRef<HTMLSpanElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const [draft, setDraft] = useState(def.value);
  const [forceWide, setForceWide] = useState(false);
  // The chip's size WHILE IDLE. In the DOM-only prototype these were read at the
  // moment of the click, before the input existed. In React the re-render has
  // already happened by the time a layout effect runs, so measuring then reads
  // the input's own width and the chip grows — which pushed the next chip onto a
  // new row the instant you tapped this one. Record them while idle instead.
  const idleRef = useRef({ chip: 0, value: 0 });

  useEffect(() => {
    if (!editing) setDraft(def.value);
  }, [editing, def.value]);

  useLayoutEffect(() => {
    if (editing) return;
    const chip = ref.current;
    const v = valueRef.current;
    if (chip && v) {
      idleRef.current = {
        chip: chip.getBoundingClientRect().width,
        value: v.getBoundingClientRect().width,
      };
    }
  });

  // On open: pin the floor to the chip's current size and open the input at the
  // value's exact width, so not a pixel moves.
  useLayoutEffect(() => {
    const chip = ref.current;
    if (!chip) return;
    if (!editing) {
      chip.style.minWidth = "";
      setForceWide(false);
      return;
    }
    const { chip: idleChip, value: idleValue } = idleRef.current;
    chip.style.minWidth = `${def.value && idleChip ? idleChip : 170}px`;
    const input = inputRef.current;
    if (input instanceof HTMLInputElement) {
      input.style.width = `${def.value && idleValue ? idleValue : 150}px`;
      input.focus();
      input.select();
    } else {
      inputRef.current?.focus();
    }
  }, [editing, def.value]);

  const grow = (next: string) => {
    const input = inputRef.current;
    const chip = ref.current;
    const box = container.current;
    const m = mirror.current;
    if (!(input instanceof HTMLInputElement) || !chip || !box || !m) return;
    m.textContent = next || " ";
    const chrome = chip.getBoundingClientRect().width - input.getBoundingClientRect().width;
    const want = Math.ceil(m.getBoundingClientRect().width) + 2;
    if (want + chrome > box.clientWidth) {
      setForceWide(true);
      input.style.width = "100%";
    } else {
      setForceWide(false);
      input.style.width = `${want}px`;
    }
  };

  const isSelect = def.type === "select" && def.choices?.length;
  // A rich control owns the whole row: a swatch picker or a checkbox with help
  // beneath it has no business being squeezed into a chip's width.
  const hosting = editing && !!customEditor;
  const shown = def.value || def.emptyHint || "—";

  return (
    <span
      ref={(el) => {
        ref.current = el;
        register(el);
      }}
      onClick={(e) => {
        // The card this sits in has its own click handler (expand / collapse).
        // Without stopping here, tapping a field also toggles the card and the
        // whole form jumps up the page — measured at ~800px before the e2e
        // caught it. The mockup had no parent handler, so it could not.
        e.stopPropagation();
        if (editing) return;
        if (def.onActivate) def.onActivate();
        else onOpen();
      }}
      className={[
        "inline-flex items-baseline max-w-full rounded-lg border cursor-text transition",
        dense ? "gap-1 px-1.5 py-0.5" : "gap-1.5 px-2 py-1",
        editing
          ? "is-editing border-cobble-500 bg-surface dark:bg-slate-900"
          : "border-line/70 dark:border-slate-700/70 bg-subtle/50 dark:bg-slate-800/50 hover:border-cobble-400 dark:hover:border-cobble-600",
        wide || forceWide || hosting ? "w-full" : "",
      ].join(" ")}
      data-chip-field={def.key}
      title={editing ? undefined : `${def.label}: ${def.value || "empty"} — tap to edit`}
    >
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">{def.label}</span>
      {/* text-sm in BOTH states. Dropping it while editing changed the line
          height, which changed the chip height, which moved every chip below —
          the pinned min-width cannot save you from a typography change. */}
      <span ref={valueRef} className={`${dense ? "text-[11.5px]" : "text-sm"} ${editing ? "flex-1 min-w-0" : "truncate"}`}>
        {hosting ? (
          <span
            className="block w-full"
            onBlur={(e) => {
              // Commit when focus leaves the hosted control entirely.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCommit(def.value);
            }}
          >
            {customEditor}
          </span>
        ) : !editing ? (
          <span className={`inline-flex items-center gap-1 ${def.value ? "" : "text-faint italic"}`}>
            {def.icon}
            {shown}
          </span>
        ) : isSelect ? (
          <select
            ref={(el) => {
              inputRef.current = el;
            }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onCommit(draft)}
            className="bg-transparent text-sm outline-none max-w-full"
          >
            <option value="">—</option>
            {def.choices!.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={(el) => {
              inputRef.current = el;
            }}
            type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
            value={draft}
            placeholder={def.placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
              grow(e.target.value);
            }}
            onBlur={() => onCommit(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft(def.value);
                onCommit(def.value);
              }
            }}
            className="bg-transparent border-0 p-0 text-sm outline-none w-full min-w-0"
          />
        )}
      </span>
    </span>
  );
}
