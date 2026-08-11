// EditableCell — click-to-edit a single field value in place, for grid/table
// surfaces. The edit-side twin of FieldRenderer: FieldRenderer decides how a
// value DISPLAYS, EditableCell decides how it's EDITED, and both live here so
// every module's table gets the same behaviour instead of each growing its own.
//
// What to edit with is NOT decided here — `cellPlan()` owns that (and routes
// through the same `fieldControl()` the detail panel and create modal share, so
// a field can't get one control on a form and a different one in a grid). This
// file is the interaction: when to open an editor, what commits, what cancels.
//
// Commit discipline, in one place because every editor below obeys it:
// - Nothing commits on a mere change event. Selects fire change per arrow-key
//   on some platforms (Firefox, Windows) while the user is only browsing, and
//   the OS colour picker fires continuously mid-drag — committing there writes
//   values the user never settled on. Commit happens on blur/Enter.
// - A commit only fires for a REAL change, measured against what the editor
//   actually showed when it opened — not against the stored string. A native
//   date/number input silently blanks a stored value it can't represent, and
//   comparing against the stored string would turn a click-in/click-out into
//   a null overwrite of data the input simply couldn't display.
// - Escape always cancels without writing.

import { useRef, useState, type KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { cellPlan, type CellPlan, type EditableCellDef } from "./cellPlan";
import { FieldRenderer, boolTruthy, boolLabel } from "./FieldRenderer";
import { RelationSelect, MemberSelect } from "./CustomFieldsPanel";

export type { EditableCellDef } from "./cellPlan";

interface Props {
  def: EditableCellDef;
  value: unknown;
  /** Commit a new value. The host owns persistence + invalidation. Fires only
   *  when the value actually CHANGED — a click-in/click-out never writes. */
  onCommit: (value: unknown) => void;
  /** Right-align the display (numbers). */
  align?: "left" | "right";
  /** Lock the cell with a reason shown on hover — for a value the host owns
   *  through a different path (e.g. a qty that only moves via an audited
   *  delta). Prefer this over rendering a plain value: it tells the user WHY
   *  the cell won't open. */
  lockedReason?: string;
  /** Host-supplied candidates for a column whose value is a foreign id rather
   *  than a literal — the cell stores `id` and displays `label`.
   *
   *  Why this exists: native FK columns predate field-defs, so some aren't
   *  declared `relation` fields with a `ref_kind` a picker could resolve (a
   *  module-local category list, say). Rather than let each host grow its own
   *  parallel FK editor next to this one, the host hands over the candidates
   *  and the cell still owns the interaction. A declared relation field needs
   *  none of this — it resolves its own candidates from `ref_kind`. */
  options?: { id: string; label: string }[];
  /** What to display for an id the options list can't resolve (still loading,
   *  fetch failed, referenced row missing) — typically the server-joined name
   *  the host's row already carries. Without it the cell would show "—" for a
   *  value that exists, and the editor couldn't represent the current value. */
  fallbackLabel?: string | null;
  /** Custom resting display, for a cell whose content already owns the click —
   *  a name that links to the record, a URL that opens the supplier page. Given
   *  one, the cell renders it beside a pencil instead of making the whole cell
   *  a click target, because a link and an edit target can't share a click. */
  children?: React.ReactNode;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

function assertNever(x: never): never {
  throw new Error(`EditableCell: unhandled plan ${JSON.stringify(x)}`);
}

export function EditableCell({
  def,
  value,
  onCommit,
  align = "left",
  lockedReason,
  options,
  fallbackLabel,
  children,
}: Props) {
  const [editing, setEditing] = useState(false);

  // An id-valued column displays its label, never the raw id. When the options
  // list can't resolve the id (loading / failed / missing row), the host's
  // fallback label keeps the real value visible instead of a lying "—".
  const shown = options
    ? (options.find((o) => o.id === String(value ?? ""))?.label ??
      (isBlank(value) ? null : (fallbackLabel ?? null)))
    : value;

  // The host's own invariant (an audited qty, say) outranks the field's type.
  const plan: CellPlan = lockedReason
    ? { kind: "locked", reason: lockedReason }
    : cellPlan(def);

  const display = (
    <FieldRenderer
      fieldName={def.display_label}
      value={shown}
      renderer={def.renderer ?? undefined}
      type={def.type}
      choices={def.choices}
      unit={def.unit}
      size="inline"
    />
  );

  if (plan.kind === "locked") {
    return (
      <LockedCell align={align} title={plan.reason}>
        {children ?? display}
      </LockedCell>
    );
  }

  // A checkbox is already a one-click control — a click-to-open step in front of
  // it would just be an extra click, which is the whole complaint this solves.
  if (plan.kind === "checkbox") {
    const checked = boolTruthy(value, def.choices);
    return (
      <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCommit(e.target.checked)}
          className="accent-cobble-500 h-4 w-4 cursor-pointer"
          aria-label={def.display_label}
        />
        <span className="text-[11px] text-muted dark:text-slate-400">
          {boolLabel(checked, def.choices)}
        </span>
      </span>
    );
  }

  if (!editing) {
    // The display owns the click, so the pencil carries the edit.
    if (children !== undefined) {
      return (
        <span className="inline-flex items-center gap-1 min-w-0">
          {children}
          <PencilButton label={def.display_label} onOpen={() => setEditing(true)} />
        </span>
      );
    }
    return (
      <Shell align={align} onOpen={() => setEditing(true)} label={def.display_label}>
        {isBlank(shown) ? <span className="text-faint dark:text-slate-600">—</span> : display}
      </Shell>
    );
  }

  const close = () => setEditing(false);
  // Commit only a real change, so tabbing across a row doesn't write every cell.
  const commit = (next: unknown) => {
    close();
    const before = isBlank(value) ? null : value;
    const after = isBlank(next) ? null : next;
    // Blanking a required field is a cancel, not a write — the server rejects
    // the null anyway, and an error toast for a click-through is just noise.
    if (def.required && after === null && before !== null) return;
    if (String(before) !== String(after)) onCommit(after);
  };

  // Host-supplied id candidates. Checked after the locks, so handing a locked
  // field an options list can never talk the cell into an input.
  if (options) {
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <SelectCell
          label={def.display_label}
          value={value}
          items={options.map((o) => ({ value: o.id, label: o.label }))}
          unresolvedLabel={fallbackLabel ?? undefined}
          onCommit={commit}
          onCancel={close}
        />
      </span>
    );
  }

  switch (plan.kind) {
    case "relation":
      return (
        <span onClick={(e) => e.stopPropagation()}>
          <RelationSelect
            refKind={def.ref_kind ?? ""}
            value={value}
            onChange={(v) => commit(v)}
            className="w-full text-sm py-1"
          />
        </span>
      );
    case "member":
      return (
        <span onClick={(e) => e.stopPropagation()}>
          <MemberSelect value={value} onChange={(v) => commit(v)} className="w-full text-sm py-1" />
        </span>
      );
    case "choice":
      return (
        <span onClick={(e) => e.stopPropagation()}>
          <SelectCell
            label={def.display_label}
            value={value}
            items={(def.choices ?? []).map((c) => ({ value: c, label: c }))}
            onCommit={commit}
            onCancel={close}
          />
        </span>
      );
    case "color":
      return (
        <ColorCell value={value} onCommit={commit} onCancel={close} label={def.display_label} />
      );
    case "input":
      return (
        <span onClick={(e) => e.stopPropagation()}>
          <TextCell
            def={def}
            value={value}
            align={align}
            onCommit={commit}
            onCancel={close}
          />
        </span>
      );
    // "locked" / "checkbox" returned above; a new CellPlan kind fails here.
    default:
      return assertNever(plan);
  }
}

/** The resting state of an editable cell: reads as plain text until hovered,
 *  where it picks up a quiet box so the row's editable cells are discoverable
 *  without turning the table into a grid of input boxes. */
function Shell({
  children,
  align,
  onOpen,
  label,
}: {
  children: React.ReactNode;
  align: "left" | "right";
  onOpen: () => void;
  label: string;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Edit ${label}`}
      title={`Edit ${label}`}
      onClick={(e) => {
        // The row is a link to the record — an edit click must not navigate.
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onOpen();
        }
      }}
      className={
        "block w-full cursor-text rounded px-1.5 py-0.5 -mx-1.5 hover:bg-mortar-100/70 dark:hover:bg-slate-800 hover:ring-1 hover:ring-line dark:hover:ring-slate-700 focus:outline-none focus:ring-1 focus:ring-cobble-400 transition " +
        (align === "right" ? "text-right" : "")
      }
    >
      {children}
    </span>
  );
}

/** The edit affordance for a cell whose display is already a click target.
 *  Hidden until the row is hovered so a table of these doesn't read as a wall
 *  of icons, but always in the tab order — and always VISIBLE on a touch
 *  screen, which has no hover to reveal it with. Hosts must put `group/row` on
 *  the hoverable row/card container, or hover never reveals it. */
function PencilButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Edit ${label}`}
      title={`Edit ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="shrink-0 p-0.5 rounded text-faint dark:text-slate-600 opacity-0 [@media(hover:none)]:opacity-100 group-hover/row:opacity-100 focus:opacity-100 hover:text-accent focus:outline-none focus:ring-1 focus:ring-cobble-400 transition"
    >
      <Pencil size={11} />
    </button>
  );
}

/** A cell the user can't edit here, with the reason on hover. Deliberately not
 *  a disabled input: a greyed box implies "you could type if…", while plain
 *  text plus a tooltip says "this value comes from somewhere else". */
function LockedCell({
  children,
  align,
  title,
}: {
  children: React.ReactNode;
  align: "left" | "right";
  title: string;
}) {
  return (
    <span
      title={title}
      className={"block cursor-default " + (align === "right" ? "text-right" : "")}
    >
      {children}
    </span>
  );
}

/** One dropdown editor for both choice lists and id-valued options lists.
 *  Commits on blur/Enter — never on change, which fires per arrow-key on a
 *  closed select in Firefox/Windows while the user is only browsing. A stored
 *  value the items don't list stays visible and selectable (re-picking it is a
 *  no-op), so an unresolvable current value can't be silently overwritten. */
function SelectCell({
  label,
  value,
  items,
  unresolvedLabel,
  onCommit,
  onCancel,
}: {
  label: string;
  value: unknown;
  items: { value: string; label: string }[];
  /** Display for a current value missing from items (id-valued lists). */
  unresolvedLabel?: string;
  onCommit: (v: string | null) => void;
  onCancel: () => void;
}) {
  const current = value == null ? "" : String(value);
  const inList = items.some((i) => i.value === current);
  return (
    <select
      autoFocus
      defaultValue={current}
      onBlur={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
      onKeyDown={(e) => {
        const el = e.target as HTMLSelectElement;
        if (e.key === "Enter") {
          e.preventDefault();
          el.blur();
        }
        if (e.key === "Escape") {
          // Restore first so the blur commit sees the original and no-ops.
          el.value = current;
          el.blur();
          onCancel();
        }
      }}
      className="input w-full text-sm py-1"
      aria-label={label}
    >
      <option value="">—</option>
      {items.map((i) => (
        <option key={i.value} value={i.value}>
          {i.label}
        </option>
      ))}
      {current !== "" && !inList && (
        <option value={current}>{unresolvedLabel ?? `${current} (legacy)`}</option>
      )}
    </select>
  );
}

function TextCell({
  def,
  value,
  align,
  onCommit,
  onCancel,
}: {
  def: EditableCellDef;
  value: unknown;
  align: "left" | "right";
  onCommit: (v: unknown) => void;
  onCancel: () => void;
}) {
  const initial = value == null ? "" : String(value);
  // What the input ACTUALLY showed at mount. A native date/number input blanks
  // a stored value it can't represent (an ISO timestamp, "3 rolls"), so the
  // no-change check must compare against this, not the stored string — else a
  // click-in/click-out would commit the blank and wipe the value.
  const mountValue = useRef<string | null>(null);
  const parse = (raw: string): unknown => {
    if (raw === "") return null;
    if (def.type === "number") return Number(raw);
    // A URL typed without a scheme ("example.com") is what people type; the
    // server's validator requires one, and the display code tolerates both.
    if (def.type === "url" && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) return `https://${raw}`;
    return raw;
  };
  return (
    <input
      autoFocus
      ref={(el) => {
        if (el && mountValue.current === null) mountValue.current = el.value;
      }}
      type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
      step={def.type === "number" ? "any" : undefined}
      defaultValue={initial}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => {
        if (e.target.value === mountValue.current) {
          onCancel();
          return;
        }
        onCommit(parse(e.target.value));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          // Restore first so the blur handler sees the mount value and no-ops.
          (e.target as HTMLInputElement).value = mountValue.current ?? initial;
          (e.target as HTMLInputElement).blur();
          onCancel();
        }
      }}
      aria-label={def.display_label}
      className={"input w-full text-sm py-1 " + (align === "right" ? "text-right" : "")}
    />
  );
}

/** Colour: the OS swatch picker plus a free-text box, so a named colour
 *  ("Peacock") works as well as a hex — same pair the detail panel uses.
 *  The swatch only updates the draft (the OS picker fires change continuously
 *  while dragging; committing there would save an arbitrary mid-drag hue and
 *  unmount the editor under the open picker). The edit commits when focus
 *  leaves the pair for another element, or on Enter. */
function ColorCell({
  value,
  onCommit,
  onCancel,
  label,
}: {
  value: unknown;
  onCommit: (v: unknown) => void;
  onCancel: () => void;
  label: string;
}) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  const t = draft.trim();
  const swatch = /^#?[0-9a-fA-F]{6}$/.test(t) ? (t[0] === "#" ? t : `#${t}`) : "#cccccc";
  return (
    <span
      className="inline-flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        // Focus moving BETWEEN the two inputs isn't leaving; and when the OS
        // picker takes focus, relatedTarget is null — neither may commit, or
        // the editor unmounts under the open picker.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) {
          onCommit(draft.trim());
        }
      }}
    >
      <input
        type="color"
        value={swatch}
        onChange={(e) => setDraft(e.target.value)}
        className="h-6 w-8 shrink-0 rounded border border-line dark:border-slate-600 cursor-pointer bg-transparent p-0.5"
        aria-label={`${label} colour picker`}
      />
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(draft.trim());
          if (e.key === "Escape") onCancel();
        }}
        aria-label={label}
        className="input w-24 text-sm py-1"
      />
    </span>
  );
}
