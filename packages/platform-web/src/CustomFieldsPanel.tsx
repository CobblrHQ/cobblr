// Renders bundle-installed / module-contributed / org-authored
// field-defs as editable inputs. The host owns persistence — it
// gets an onCommit callback with the field name + new value, and
// decides where to stash it (usually `metadata.<name>` on the
// entity).
//
// type='text' field-defs with a `choices` array render as the one
// choice picker (ChoiceField): a list of the choices and every value
// already used, where what you type is the value and, on a field that
// learns, becomes a choice.

import { AddressPicker } from "./AddressPicker";
import { SecretField } from "./SecretField";
import { ColourInput } from "./ColourInput";
import { useMemo, useState, type FocusEvent } from "react";
import { useFieldDraft } from "./use-field-draft";
import { useQuery } from "@tanstack/react-query";
import { fieldValueProblem } from "@cobblr/platform-contract/entity-metadata";
import { choiceLearns } from "@cobblr/platform-contract/field-choices";
import { usePlatformWeb } from "./context";
import type { PlatformFieldDef } from "./types";
import { fieldControl, fieldInputText, valueFromInput } from "./fieldControl";
import { ChoiceField } from "./ChoiceField";
import { SellerOfferNotice } from "./SellerOfferNotice";
import { MoneyInput, MoneyValueInput } from "./MoneyInput";
import { useMoneyCurrency } from "./MoneyCurrency";
import { fieldCurrency, moneyStorageOf } from "@cobblr/platform-contract/money";
import { formatMeasure, parseMeasure } from "@cobblr/platform-contract/measure";
import { fieldTypeTakesUnit } from "@cobblr/platform-contract/field-vocabulary";
import { FieldPack, fieldPackControlClass } from "./FieldPack";
import { fieldNeed } from "./field-pack";
import { FieldRenderer, boolLabel, boolTruthy } from "./FieldRenderer";
import { noteKey, noteOf } from "./field-note";
import { MarkdownEditor } from "./MarkdownEditor";
import { relativeTime } from "./relativeTime";
import { useUnits } from "./useUnits";
import { Link as RouterLink } from "react-router-dom";
import { FIELD_PROVENANCE_KEY, fieldProvenanceOf, type FieldProvenance } from "@cobblr/platform-contract/acquisition-source";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { PersonSelect } from "./PersonSelect";

interface Props {
  entityKind: string;
  values: Record<string, unknown>;
  onCommit: (name: string, value: unknown) => void;
  className?: string;
  /** When this entity already exists, its id. Lets the panel resolve
   *  COMPUTED field values (rendered server-side) so they display here
   *  the same as on list/views. Omit for a not-yet-saved draft — computed
   *  fields simply show "—" until the entity exists. */
  entityId?: string;
  /** Secondary value source — used when the local `values[name]` is
   *  blank. The typical source is the payload of a catalog entry the
   *  entity matches: e.g. an inventory:part with no local `year` set
   *  falls back to the Rebrickable sets entry's `year` field.
   *
   *  Visually, fallback values are shown in italic + with a "from
   *  {fallbackLabel}" hint so the user knows it's not their own data.
   *  Editing the field commits the value locally — no in-place mutation
   *  of the fallback source. */
  fallbackValues?: Record<string, unknown>;
  fallbackLabel?: string;
  /** Field-def names to suppress entirely — for conditional relevance the host
   *  decides (e.g. a Bambu printer hides hotend/mainboard/firmware/local-IP, a
   *  DIY Klipper shows them). Generic: any host can gate fields on its own
   *  discriminator without a per-field schema change. */
  hideNames?: Set<string>;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

/** A value capture kept that does not fit the field (a word in a number
 *  field, a value not among the dropdown's choices), said under the field
 *  so a person can fix it. Never blocks anything. */
function misfitLine(f: PlatformFieldDef, value: unknown) {
  if (f.type === "computed") return null;
  const p = fieldValueProblem({ name: f.name, type: f.type, choices: f.choices ?? null, learns: choiceLearns(f) }, value);
  if (!p) return null;
  return (
    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-testid="field-misfit">
      Holds “{Array.isArray(value) ? value.join(", ") : String(value)}”, which doesn't fit: {f.display_label} takes {p.expected}.
    </p>
  );
}

export function CustomFieldsPanel({
  entityKind,
  values,
  onCommit,
  className,
  fallbackValues,
  fallbackLabel,
  entityId,
  hideNames,
}: Props) {
  const mainCurrency = useMoneyCurrency();
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({
    queryKey: ["platform-field-defs", orgSlug, entityKind],
    queryFn: () => api.listFieldDefs(orgSlug, entityKind),
    staleTime: 60_000,
  });
  const [showAll, setShowAll] = useState(false);
  // A required field, once filled, cannot be emptied (the server refuses it
  // too). The row goes back to what it holds and says why, rather than
  // sending a write that would fail.
  const [refused, setRefused] = useState<Record<string, number>>({});
  // Sections a person folded away on this sheet. Every section starts open,
  // so nothing a record holds is hidden until someone chooses to hide it.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const fields = useMemo(
    () => (data?.items ?? [])
      .filter((f) => !hideNames?.has(f.name))
      .slice()
      .sort((a, b) => a.position - b.position),
    [data, hideNames],
  );

  // Computed fields are rendered server-side at resolve time, so for a
  // saved entity we fetch the resolved view to display them. Only runs
  // when the kind actually has a computed field AND the entity exists.
  const hasComputed = useMemo(() => fields.some((f) => f.type === "computed"), [fields]);
  const resolved = useQuery({
    queryKey: ["platform-resolved-entity", orgSlug, entityKind, entityId],
    queryFn: () => api.lookupEntity(orgSlug, entityKind, entityId!),
    enabled: !!entityId && hasComputed,
    staleTime: 10_000,
  });
  const computedValues = (resolved.data?.fields ?? {}) as Record<string, unknown>;

  // A kind shared by several modules (e.g. machines:machine, extended
  // by 3d-printers / laser-cutters / cnc-machines) accumulates every
  // specialisation's field-defs. Rendering all of them on every
  // entity means a 3D printer shows empty "focal length" / "tube
  // type" inputs. So: always show fields that have a value, plus any
  // field not contributed by a module (org-authored / bundle fields
  // the user opted into). Empty module-contributed fields collapse
  // behind a toggle.
  // Treat a field with a fallback value as not-empty — keeps catalog-
  // sourced data out of the "collapse if blank" bucket so it's
  // actually visible to the user.
  const hasValueOrFallback = (name: string) =>
    !isBlank(values[name]) || !isBlank(fallbackValues?.[name]);
  const { shown, hidden } = useMemo(() => {
    const shown: PlatformFieldDef[] = [];
    const hidden: PlatformFieldDef[] = [];
    for (const f of fields) {
      // A field the kind's own module declares is part of the record's shape
      // (a task's "Assigned to"), so it shows empty like a native field. Only
      // what ANOTHER module added to the kind (a specialisation) collapses.
      const ownModule = f.source_module === entityKind.split(":")[0];
      if (!f.source_module || ownModule || hasValueOrFallback(f.name)) shown.push(f);
      else hidden.push(f);
    }
    return { shown, hidden };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, values, fallbackValues, entityKind]);

  if (fields.length === 0) return null;
  const visible = showAll ? fields : shown;

  // Group by form-builder section: ungrouped fields first (no heading), then
  // each section (in its saved order) under a heading that folds it away. A
  // section with no visible fields is skipped.
  const sections = (data?.sections ?? []).slice().sort((a, b) => a.position - b.position);
  // A field filed under a section this read did not bring (an older server,
  // a section deleted under it) shows with the ungrouped ones: a heading can
  // go missing, a field never does.
  const known = new Set(sections.map((s) => s.id));
  const sectionOf = (f: PlatformFieldDef) => (f.section_id && known.has(f.section_id) ? f.section_id : null);
  const inSection = (sid: string | null) => visible.filter((f) => sectionOf(f) === sid);
  const ungrouped = inSection(null);
  const grouped = sections.map((s) => ({ s, fs: inSection(s.id) })).filter((g) => g.fs.length > 0);

  // The packer lays the fields out from what each needs and how wide the
  // panel is (field-pack.ts, #3067). This used to be one column on a phone:
  // two columns at 390px left each field 170px wide, which a date input's
  // own minimum width in Safari overran, and every bundle-authored help
  // paragraph wrapped to five lines beside another one. Now a date gets a
  // column it fits, a help paragraph takes the row, and two short selects
  // still share one.
  // Who filled each field. A field an order (or other record) filled says so
  // and opens it; a person's edit to such a field makes it theirs, so the
  // evidence never writes over it again (one way, #3856).
  const stamps = fieldProvenanceOf(values);
  const commitField = (name: string, v: unknown) => {
    const def = fields.find((d) => d.name === name);
    const blank = isBlank(v) || (Array.isArray(v) && v.length === 0);
    if (def?.required && blank && !isBlank(values[name])) {
      setRefused((r) => ({ ...r, [name]: (r[name] ?? 0) + 1 }));
      return;
    }
    if (refused[name]) setRefused((r) => ({ ...r, [name]: 0 }));
    onCommit(name, v);
    const was = stamps[name];
    if (was && was.by !== "person") {
      onCommit(FIELD_PROVENANCE_KEY, { ...stamps, [name]: { by: "person", from: "edit", at: new Date().toISOString() } });
    }
  };
  // An explicit seller field wins over the clarifier (arrivals.md): the
  // picker of where a thing came from writes the seller there.
  const sellerDef = (data?.items ?? []).find((d) => d.field_role === "seller");
  const nativeSeller = (data?.native_roles ?? []).some((r) => r.field_role === "seller");
  const sellerBeside = (f: PlatformFieldDef) =>
    f.field_role === "acquired-from" && sellerDef
      ? {
          name: sellerDef.name,
          label: sellerDef.display_label,
          value: values[sellerDef.name] == null || values[sellerDef.name] === "" ? null : String(values[sellerDef.name]),
          onCommit: (v: string | null) => commitField(sellerDef.name, v),
        }
      : undefined;
  const grid = (fs: PlatformFieldDef[]) => (
    <FieldPack
      items={fs.map((f) => {
        const value = f.type === "computed" ? computedValues[f.name] : values[f.name];
        return {
          need: fieldNeed(f.id, {
            control: fieldControl(f),
            label: f.display_label,
            choices: f.choices,
            help: f.help,
            valueLength: typeof value === "string" ? value.length : 0,
          }),
          node: (
            <div>
            <FieldValueEditor
              key={`${f.id}:${refused[f.name] ?? 0}`}
              def={f}
              value={value}
              fallbackValue={fallbackValues?.[f.name]}
              fallbackLabel={fallbackLabel}
              currency={fieldCurrency(values, f.name, mainCurrency)}
              onCurrencyChange={(currency) => onCommit(`money_currency_${f.name}`, currency)}
              onCommit={(v) => {
                commitField(f.name, v);
                if (f.type !== "money" && moneyStorageOf(f)) onCommit(`money_currency_${f.name}`, fieldCurrency(values, f.name, mainCurrency));
              }}
              evidence={stamps[f.name]}
              note={noteOf(values, f.name)}
              // The kind's own column already answers who sold it: a note
              // stored before still shows and can change, but none is offered.
              onCommitNote={nativeSeller && f.field_role === "acquired-from" && !noteOf(values, f.name) ? undefined : (v) => onCommit(noteKey(f.name), v)}
              kind={entityKind}
              entityId={entityId}
              detailField={sellerBeside(f)}
            />
            {misfitLine(f, value)}
            {(refused[f.name] ?? 0) > 0 && (
              <p role="alert" className="mt-1 text-xs text-ember-600 dark:text-ember-400">
                {f.display_label} is required, so it can't be emptied.
              </p>
            )}
            </div>
          ),
        };
      })}
    />
  );

  return (
    // No "// custom fields" box or header: to the user there's no stock-vs-custom
    // distinction — every field they configured is just a field, grouped under
    // the sections they arranged in the form builder.
    <div className={"space-y-4 " + (className ?? "")}>
      {/* The seller upgrade is asked where the seller notes are written: a
          kind with a where-it-came-from field and no seller field yet. */}
      {fields.some((f) => f.field_role === "acquired-from") && !fields.some((f) => f.field_role === "seller") && !nativeSeller && <SellerOfferNotice kind={entityKind} />}
      {ungrouped.length > 0 && grid(ungrouped)}
      {grouped.map(({ s, fs }) => {
        const open = !folded.has(s.id);
        return (
          <div key={s.id} className="space-y-2" data-testid="field-section">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setFolded((was) => {
                const next = new Set(was);
                if (next.has(s.id)) next.delete(s.id);
                else next.add(s.id);
                return next;
              })}
              className="w-full flex items-center gap-1.5 text-left text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 border-b border-line dark:border-slate-700 pb-1 hover:text-content dark:hover:text-slate-200 transition"
            >
              <span aria-hidden className={"inline-block transition-transform " + (open ? "rotate-90" : "")}>›</span>
              <span className="flex-1">{s.name}</span>
              {!open && <span className="normal-case tracking-normal text-faint dark:text-slate-500">{fs.length} field{fs.length === 1 ? "" : "s"}</span>}
            </button>
            {open && grid(fs)}
          </div>
        );
      })}
      {visible.length === 0 && !showAll && (
        <div className="text-[11px] text-faint dark:text-slate-500 italic">No fields set.</div>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] font-mono uppercase tracking-widest text-accent hover:text-accent transition"
        >
          {showAll ? "− hide empty fields" : `+ ${hidden.length} more field${hidden.length === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

export function FieldValueEditor({
  def,
  value,
  fallbackValue,
  fallbackLabel,
  onCommit,
  evidence,
  note,
  onCommitNote,
  kind,
  entityId,
  detailField,
  draftOnly,
  currency,
  onCurrencyChange,
}: {
  def: PlatformFieldDef;
  draftOnly?: boolean;
  currency?: string;
  onCurrencyChange?: (currency: string) => void;
  value: unknown;
  fallbackValue?: unknown;
  fallbackLabel?: string;
  onCommit: (v: unknown) => void;
  /** Who filled it; a stamp that names a record opens it ("from order"). */
  evidence?: FieldProvenance;
  note?: string | null;
  onCommitNote?: (v: unknown) => void;
  /** The record's kind, for the values already used on its records. */
  kind: string;
  entityId?: string;
  /** A field of its own that rides beside this one (a `seller` beside where
   *  it came from), written by this field's picker instead of the note. */
  detailField?: { name: string; label: string; value: string | null; onCommit: (v: string | null) => void };
}) {
  // One shared decision (see fieldControl) so this panel and the create
  // modal can't disagree on a field's control — the bug where a boolean
  // fell through to a text box showing "false".
  const control = fieldControl(def);
  const inner =
    control === "secret" ? (
      <div role="group" aria-label={def.display_label} className="space-y-1"><div className="block text-sm">{def.display_label}</div><SecretField value={value} field={def.name} kind={kind} recordId={entityId} onCommit={onCommit} /></div>
    ) : control === "computed" ? (
      // Read-only, value derived server-side at resolve time.
      <ComputedRow def={def} value={value} fallbackValue={fallbackValue} />
    ) : control === "server-managed" ? (
      // Read-only, value STAMPED server-side (e.g. core-mobility's away_since).
      // An input here would be a lying control — the server rejects the write.
      <ServerManagedRow def={def} value={value} />
    ) : control === "relation" ? (
      // Reference to another entity — a picker over the def's ref_kind.
      <RelationRow def={def} value={value} onCommit={onCommit} />
    ) : control === "member" || control === "person" ? (
      // A person: a picker by name. Without this branch the row fell through
      // to a text box showing the stored id.
      <PeopleRow def={def} value={value} onCommit={onCommit} kind={control} />
    ) : control === "color" ? (
      // Colour branch — a real swatch picker (type a hex/name OR pick).
      <ColorRow def={def} value={value} onCommit={onCommit} />
    ) : control === "choice" ? (
      // Dropdown branch — a `choices` list, plus the optional one-off clarifier
      // that keeps the long tail (a specific seller) out of the curated list.
      <ChoiceRow
        def={def}
        kind={kind}
        value={value}
        onCommit={onCommit}
        note={note}
        onCommitNote={onCommitNote}
        detailField={detailField}
        draftOnly={draftOnly}
      />
    ) : control === "checkbox" ? (
      // Boolean — a real checkbox, not a text box.
      <BoolRow def={def} value={value} onCommit={onCommit} />
    ) : control === "markdown" ? (
      // Rich text — the Markdown editor (Write/Preview split).
      <MarkdownRow def={def} value={value} onCommit={onCommit} />
    ) : control === "address" ? (
      // Where it happens: the workspace's own places first, free text always.
      <AddressPicker label={def.display_label} value={value} required={!!def.required} onCommit={onCommit} />
    ) : control === "money" ? (
      // An amount: the currency symbol, grouped digits, never cents.
      <MoneyRow def={def} value={value} onCommit={onCommit} currency={currency} onCurrencyChange={onCurrencyChange} />
    ) : (
      // number / date / url / text
      <PlainRow
        def={def}
        value={value}
        fallbackValue={fallbackValue}
        fallbackLabel={fallbackLabel}
        onCommit={onCommit}
      />
    );
  // Where the value came from, when a record said it: "from order" opens the
  // order, so what a thing cost is answered from the thing (#3856).
  const source =
    evidence?.by === "evidence" && evidence.ref ? (
      <RouterLink
        to={openRecordPath(evidence.ref.kind, evidence.ref.id)}
        className="text-[11px] text-muted dark:text-slate-400 hover:text-accent underline decoration-dotted"
        data-testid="field-evidence"
      >
        from {evidence.from ?? "a record"}
      </RouterLink>
    ) : null;
  // The bundle-authored plain-language hint, rendered under any field type so
  // jargon fields (colorway, dye lot…) explain themselves.
  if (!def.help && !source) return inner;
  return (
    <div className="space-y-1">
      {inner}
      {source}
      {def.help && <HelpText text={def.help} />}
    </div>
  );
}

/** A bundle's plain-language hint, one line until asked for.
 *
 *  The hints are good writing and there are a lot of them: ten fields with a
 *  five-line paragraph each was most of a phone-height record modal. The first
 *  line answers "what is this field"; the rest is there on a tap, and stays
 *  open once opened. Short help (a single line anyway) renders as it did. */
export function HelpText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Help stays under its own field, however narrow (the packer never widens
  // a field for its help, #4518): past what a half column holds on one line
  // it folds to that line, tap for all.
  const long = text.length > 40;
  return (
    <p
      className={
        "text-[11px] text-faint dark:text-slate-500 leading-snug " +
        (long && !open ? "line-clamp-1 cursor-pointer" : "")
      }
      onClick={long && !open ? () => setOpen(true) : undefined}
      title={long && !open ? "Show the whole hint" : undefined}
    >
      {text}
    </p>
  );
}

function PlainRow({
  def,
  value,
  fallbackValue,
  fallbackLabel,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  fallbackValue?: unknown;
  fallbackLabel?: string;
  onCommit: (v: unknown) => void;
}) {
  const initial = fieldInputText(def, value);
  const usingFallback = isBlank(value) && !isBlank(fallbackValue);
  const fallbackStr = fallbackValue == null ? "" : String(fallbackValue);
  const { draft, setDraft, committed } = useFieldDraft(initial);
  function commit(e: FocusEvent<HTMLInputElement>) {
    const next = e.target.value;
    if (next === initial) return;
    committed(next);
    onCommit(valueFromInput(def, next));
  }
  // When the field def declares a renderer, show a live preview
  // next to the input so the user sees "0033B2" → blue swatch in
  // real time. The input keeps the raw value; the renderer reads
  // the current draft so the preview updates on every keystroke.
  const showPreview = !!def.renderer && def.renderer !== "text";
  // A declared unit shows as a quiet suffix token on the input row ("mm"),
  // so the person typing knows what the number means.
  const showUnit = !!def.unit && fieldTypeTakesUnit(def.type);
  // What a measured value will be read as, while it is typed: "4k7" = 4.7 kΩ.
  const reading = def.type === "measure" && draft.trim() ? parseMeasure(draft, { unit: def.unit ?? null }) : null;
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
        {usingFallback && (
          <span className="ml-2 italic text-accent normal-case tracking-normal">
            from {fallbackLabel ?? "match"}
          </span>
        )}
      </span>
      <div className={showPreview || showUnit ? "flex items-center gap-2" : ""}>
        <input
          type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
          value={draft}
          placeholder={usingFallback ? fallbackStr : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className={
            "input flex-1 " + fieldPackControlClass + " " +
            (usingFallback
              ? "italic placeholder:text-accent placeholder:not-italic"
              : "")
          }
          data-draft={draft}
        />
        {showUnit && <UnitSuffix unit={def.unit!} />}
        {def.type === "measure" && draft.trim() && (
          <span data-testid="measure-reading" className={"shrink-0 text-xs " + (reading ? "text-muted" : "text-ember-600 dark:text-ember-400")}>
            {reading ? `= ${formatMeasure(reading)}` : "not a value"}
          </span>
        )}
        {showPreview && (
          <FieldRenderer
            fieldName={def.name}
            value={draft || initial || fallbackStr}
            renderer={def.renderer ?? undefined}
            size="inline"
          />
        )}
      </div>
    </label>
  );
}

function MoneyRow({ def, value, onCommit, currency, onCurrencyChange }: { def: PlatformFieldDef; value: unknown; onCommit: (v: unknown) => void; currency?: string; onCurrencyChange?: (currency: string) => void }) {
  const props = { value, storage: moneyStorageOf(def) ?? "amount" as const, ariaLabel: def.display_label, className: fieldPackControlClass };
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      {def.type === "money" ? <MoneyValueInput {...props} onCommit={onCommit} /> : <MoneyInput {...props} currency={currency} onCurrencyChange={onCurrencyChange} onCommit={onCommit} />}
    </label>
  );
}

/** The declared unit as a quiet token next to a number input, honoring the
 *  workspace's symbol/name display preference. */
function UnitSuffix({ unit }: { unit: string }) {
  const units = useUnits();
  return (
    <span className="shrink-0 text-xs text-muted dark:text-slate-400">{units.unit(unit)}</span>
  );
}

/** Read-only display for a computed field. Its value is rendered
 *  server-side at resolve time (so it shows on detail/list/export); here
 *  we just surface it, non-editable, with a quiet "computed" marker so the
 *  user understands why there's no input. */
function ComputedRow({
  def,
  value,
  fallbackValue,
}: {
  def: PlatformFieldDef;
  value: unknown;
  fallbackValue?: unknown;
}) {
  const shown = !isBlank(value) ? value : fallbackValue;
  const str = shown == null ? "" : String(shown);
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-500">worked out, not typed</span>
      </span>
      {/* Plain text, never an input's box: a value nobody can type into must
          not look like a field waiting for one (#3990). */}
      <div data-testid="computed-value" className="py-1 text-sm text-content dark:text-mortar-100 cursor-default select-text">
        {str ? (
          // Honour the field's renderer so a {{ }}-built URL (renderer "url-link")
          // draws as a clickable link, not plain text.
          <FieldRenderer fieldName={def.name} value={str} renderer={def.renderer ?? undefined} type={def.type} unit={def.unit} fieldRole={def.field_role} />
        ) : (
          <span className="text-faint dark:text-slate-600">—</span>
        )}
      </div>
    </label>
  );
}

/** Read-only display for a SERVER-MANAGED field — a value the server owns and
 *  stamps (e.g. a drift timestamp). Dates render as relative time ("3d ago",
 *  hover for the absolute stamp) since "how long" is usually the point of a
 *  server-stamped date. Never an input: the write router rejects client
 *  values, so an editable box would silently revert. */
function ServerManagedRow({ def, value }: { def: PlatformFieldDef; value: unknown }) {
  const str = value == null ? "" : String(value);
  const isDate = def.type === "date";
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        <span className="ml-2 italic text-accent normal-case tracking-normal">auto</span>
      </span>
      <div
        className="input flex-1 bg-mortar-50/60 dark:bg-slate-800/60 text-content dark:text-mortar-100 cursor-default select-text"
        title={isDate && str ? new Date(str).toLocaleString() : undefined}
      >
        {str ? (
          isDate ? (
            relativeTime(str)
          ) : (
            <FieldRenderer fieldName={def.name} value={str} renderer={def.renderer ?? undefined} type={def.type} />
          )
        ) : (
          <span className="text-faint dark:text-slate-600">—</span>
        )}
      </div>
    </label>
  );
}

/** A relation VALUE picker over a referenced kind — a select storing the chosen
 *  entity's id and displaying titles, never uuids. Candidate list comes from
 *  the host adapter's generic listEntities; a host that doesn't wire it gets a
 *  read-only title (resolved via lookupEntity) instead of a picker. Fully
 *  generic — nothing here knows about locations or any specific kind. Exported
 *  so create forms (e.g. inventory's NewPartDialog) share the exact control the
 *  detail panel uses. */
/** Picker for a `member` field: the workspace's people, by display name.
 *
 *  A `member` value is a user id, but nobody should ever SEE a uuid, so the
 *  name is resolved at read time from the members list rather than snapshotted
 *  onto the record — a renamed member then updates everywhere at once. A host
 *  that does not wire `listMembers` gets a read-only cell instead of an empty
 *  dropdown, matching how RelationSelect degrades without `listEntities`.
 *
 *  Someone assigned who has since LEFT the workspace still resolves: they are
 *  simply absent from the list, so the value shows as "Former member" rather
 *  than vanishing and making the record look unassigned. */
export function MemberSelect({
  value,
  onChange,
  label,
  className,
}: {
  value: unknown;
  onChange: (v: string | null) => void;
  /** The field's name, for a screen reader and voice control (#5912). */
  label: string;
  className?: string;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const current = value == null ? "" : String(value);
  const canList = !!api.listMembers;

  const members = useQuery({
    queryKey: ["platform-members", orgSlug],
    queryFn: () => api.listMembers!(orgSlug),
    enabled: canList,
    staleTime: 60_000,
  });
  const items = members.data?.items ?? [];
  const nameOf = (id: string) =>
    items.find((m) => m.user_id === id)?.display_name ?? (id ? "Former member" : "");

  if (!canList) {
    return (
      <div className={"input flex-1 bg-mortar-50/60 dark:bg-slate-800/60 cursor-default " + (className ?? "")}>
        {nameOf(current) || <span className="text-faint dark:text-slate-600">—</span>}
      </div>
    );
  }

  return (
    <select
      aria-label={label}
      value={items.some((m) => m.user_id === current) ? current : ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className={"input " + (className ?? "")}
    >
      {/* Unassigned is a real state, not an absence — see
          household-accountability.md §1. */}
      <option value="">Unassigned</option>
      {current && !items.some((m) => m.user_id === current) && (
        <option value={current}>{nameOf(current)}</option>
      )}
      {items.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.display_name}
        </option>
      ))}
    </select>
  );
}

export function RelationSelect({
  refKind,
  value,
  onChange,
  label,
  className,
}: {
  refKind: string;
  /** The field's name, for a screen reader and voice control (#5912). */
  label: string;
  value: unknown;
  onChange: (v: string | null) => void;
  className?: string;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const current = value == null ? "" : String(value);

  const canList = !!api.listEntities && !!refKind;
  const candidates = useQuery({
    queryKey: ["platform-relation-candidates", orgSlug, refKind],
    queryFn: () => api.listEntities!(orgSlug, refKind),
    enabled: canList,
    staleTime: 30_000,
  });
  const items = candidates.data?.items ?? [];
  // Resolve the current value's title even when it's missing from the candidate
  // list (dangling ref, >limit list, or no listEntities adapter).
  const inList = items.some((e) => e.id === current);
  const fallbackTitle = useQuery({
    queryKey: ["platform-relation-title", orgSlug, refKind, current],
    queryFn: () => api.lookupEntity(orgSlug, refKind, current),
    enabled: !!current && !!refKind && !inList && (candidates.isSuccess || !canList),
    staleTime: 60_000,
    retry: false,
  });

  if (!canList) {
    // No picker available — show the resolved title read-only, never a raw id.
    const title = fallbackTitle.data?.title ?? (current ? "…" : "");
    return (
      <div className={"input flex-1 bg-mortar-50/60 dark:bg-slate-800/60 cursor-default " + (className ?? "")}>
        {title || <span className="text-faint dark:text-slate-600">—</span>}
      </div>
    );
  }

  return (
    <select
      aria-label={label}
      value={current}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className={"input " + (className ?? "")}
    >
      <option value="">—</option>
      {items.map((e) => (
        <option key={e.id} value={e.id}>
          {e.title}
        </option>
      ))}
      {current && !inList && (
        <option value={current}>{fallbackTitle.data?.title ?? "(unavailable)"}</option>
      )}
    </select>
  );
}

/** A relation field row — label + the shared RelationSelect. */
function RelationRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <RelationSelect refKind={def.ref_kind ?? ""} label={def.display_label} value={value} onChange={(v) => onCommit(v)} />
    </label>
  );
}

/** A `member` or `person` field row: label + the picker by name. */
function PeopleRow({
  def,
  value,
  onCommit,
  kind,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
  kind: "member" | "person";
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      {kind === "person" ? (
        <PersonSelect value={value} label={def.display_label} onChange={(v) => onCommit(v)} className="w-full" />
      ) : (
        <MemberSelect value={value} label={def.display_label} onChange={(v) => onCommit(v)} className="w-full" />
      )}
    </label>
  );
}

/** A boolean field — a real checkbox. Tolerant of legacy string values
 *  ("true"/"false") that the old text-box bug may have stored; toggling
 *  commits a proper boolean, so the row self-heals on next edit. */
function BoolRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const checked = boolTruthy(value, def.choices);
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none pt-5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCommit(e.target.checked)}
        className="accent-cobble-500 h-4 w-4"
      />
      <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      {/* The current state in the field's own words (Yes/No, or the bundle/
          user's `choices` labels) so the value reads the same here as it does
          in the table — never raw true/false. */}
      <span className={"text-[11px] " + (checked ? "text-moss-600" : "text-faint dark:text-slate-500")}>
        {boolLabel(checked, def.choices)}
      </span>
    </label>
  );
}

/** A rich-text field — the Markdown editor. Keeps a local draft and commits the
 *  Markdown string on blur (like PlainRow), so the panel doesn't refetch on
 *  every keystroke. */
function MarkdownRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const initial = value == null ? "" : String(value);
  const { draft, setDraft, committed } = useFieldDraft(initial);
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <MarkdownEditor
        value={draft}
        ariaLabel={def.display_label}
        onChange={setDraft}
        onBlur={() => {
          if (draft === initial) return;
          committed(draft);
          onCommit(draft === "" ? null : draft);
        }}
      />
    </label>
  );
}

/** A colour field — native OS swatch picker + a free-text box (so a named
 *  colour like "Peacock" still works). The swatch previews while dragged and
 *  saves once on release (ColourInput); the text box saves on blur. */
function ColorRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const initial = value == null ? "" : String(value);
  const { draft, setDraft, committed } = useFieldDraft(initial);
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <ColourInput
          value={draft}
          label={def.display_label}
          onPreview={setDraft}
          onCommit={(next) => {
            setDraft(next);
            committed(next);
            onCommit(next);
          }}
        />
        <input
          type="text"
          value={draft}
          placeholder="#hex or a colour name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === initial) return;
            committed(draft);
            onCommit(draft.trim() === "" ? null : draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="input flex-1"
        />
      </div>
    </label>
  );
}


function ChoiceRow({
  def,
  kind,
  value,
  onCommit,
  note,
  onCommitNote,
  detailField,
  draftOnly,
}: {
  def: PlatformFieldDef;
  draftOnly?: boolean;
  kind: string;
  value: unknown;
  onCommit: (v: unknown) => void;
  note?: string | null;
  onCommitNote?: (v: unknown) => void;
  detailField?: { name: string; label: string; value: string | null; onCommit: (v: string | null) => void };
}) {
  return (
    <div className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <ChoiceField
        def={def}
        kind={kind}
        value={value}
        onCommit={(v) => onCommit(v)}
        note={note}
        onCommitNote={onCommitNote ? (v) => onCommitNote(v) : undefined}
        detailField={detailField}
        draftOnly={draftOnly}
        className={fieldPackControlClass}
      />
    </div>
  );
}
