// A choice field, bound: the combobox fed with the field's choices and every
// value already used on the kind's records, committing through the host, and
// remembering what a person typed when the field learns.
//
// The value write is the host's own (every record page already has one); the
// learning is platform:learn-choice, a member's write the field makes itself,
// never the assistant's. Its toast's Undo takes both back: the choice off the
// list and the record's previous value. A value a parser read never comes
// through here, so it is never learned (arrivals.md).
//
// The detail beside the value ("eBay · detroitaxle") is the field's `_note`
// clarifier, offered where it means something (offersClarifier), or a field
// of its own when the kind has one (the `seller` role): the host passes it as
// `detail`, and the picker writes there instead of the note.

import { compareChoices } from "@cobblr/platform-contract/choice-order";
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { choiceLearns } from "@cobblr/platform-contract/field-choices";
import { usePlatformWeb } from "./context";
import { useToast } from "./ToastContext";
import { ChoiceCombobox, matchChoice, type ChoiceDetail, type ChoiceOption } from "./ChoiceCombobox";
import { canCarryNote, offersClarifier } from "./field-note";
import { refreshAfterAction, useRunAction } from "./run-action";
import { useQueryClient } from "@tanstack/react-query";
import type { UsedValueBody } from "./types";

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** What the picker needs of a field definition (the platform's, or a
 *  module's own copy of it). */
export interface ChoiceFieldDef {
  name: string;
  display_label: string;
  type: string;
  choices?: string[] | null;
  entity_kind: string;
  bundle_id?: string | null;
  source_module?: string | null;
  field_role?: string | null;
  learns?: boolean | null;
}

export interface ChoiceFieldProps {
  def: ChoiceFieldDef;
  /** The kind the record is (an instance's `<name>:item`, else the def's). */
  kind?: string;
  value: unknown;
  onCommit: (v: string | null) => void | Promise<void>;
  /** The record's clarifier for this field, and how to write it. */
  note?: string | null;
  onCommitNote?: (v: string | null) => void | Promise<void>;
  /** A field of its own for the detail (a `seller` field), which wins over the note. */
  detailField?: { name: string; label: string; value: string | null; onCommit: (v: string | null) => void | Promise<void> };
  autoFocus?: boolean;
  onCancel?: () => void;
  className?: string;
  live?: boolean;
  placeholder?: string;
  draftOnly?: boolean;
}

function asOptions(list: readonly UsedValueBody[] | undefined): ChoiceOption[] {
  return (list ?? []).map((u) => ({ value: u.value, uses: u.uses, lastUsed: u.lastUsed }));
}

export function ChoiceField({ def, kind, value, onCommit, note, onCommitNote, detailField, autoFocus, onCancel, className, live, placeholder, draftOnly }: ChoiceFieldProps) {
  const { api, orgSlug } = usePlatformWeb();
  // PRESS-ARGS: learn-choice and its forget step take entity_kind, field and value, all from this field and the value just typed.
  const run = useRunAction();
  const qc = useQueryClient();
  const toast = useToast();
  const recordKind = kind ?? def.entity_kind;
  const current = value == null || value === "" ? null : String(value);
  const showsNote = !detailField && !!onCommitNote && offersClarifier(def, note);
  const detailKey = detailField?.name ?? null;

  const used = useQuery({
    queryKey: ["field-values", orgSlug, recordKind, def.name, detailKey, showsNote],
    queryFn: () => api.fieldValues!(orgSlug, recordKind, def.name, { detail: detailKey, note: showsNote }),
    enabled: !!api.fieldValues,
    staleTime: 30_000,
    meta: { kinds: [recordKind] },
  });

  const options = useMemo<ChoiceOption[]>(
    () => [...asOptions(used.data?.values), ...(def.choices ?? []).map((c) => ({ value: c }))],
    [used.data, def.choices],
  );

  // The value before this edit, for Undo. A live box commits every keystroke,
  // so `current` is already the typed text by the time the edit settles.
  const settled = useRef(current);
  useEffect(() => {
    if (!live) settled.current = current;
  }, [current, live]);

  const commit = async (v: string | null, final: boolean) => {
    await onCommit(v);
    if (!final || draftOnly) return;
    const before = settled.current;
    settled.current = v;
    // A person's new value, on a field that learns: remembered, and undoable.
    if (!v || !choiceLearns(def) || (def.choices ?? []).some((c) => key(c) === key(v))) return;
    try {
      const outcome = await run({
        actionId: "platform:learn-choice",
        entityKind: "",
        entityId: "",
        args: { entity_kind: recordKind, field: def.name, value: v },
      }, { undo: "shown-here" });
      const learned = (outcome.result as { data?: { learned?: boolean } } | null)?.data?.learned === true;
      refreshAfterAction(qc, [recordKind, def.entity_kind]);
      void qc.invalidateQueries({ queryKey: ["platform-field-defs"] });
      if (!learned) return;
      const steps = (Array.isArray(outcome.undo) ? outcome.undo : outcome.undo ? [outcome.undo] : []) as Array<{ action_id?: string; args?: Record<string, unknown> }>;
      toast.action(`"${v}" is now a choice for ${def.display_label}`, {
        actionLabel: "Undo",
        onAction: async () => {
          await onCommit(before);
          for (const s of steps) {
            if (s.action_id) await run({ actionId: s.action_id, entityKind: "", entityId: "", args: s.args ?? {} }, { undo: "is-undo" });
          }
          refreshAfterAction(qc, [recordKind, def.entity_kind]);
          void qc.invalidateQueries({ queryKey: ["platform-field-defs"] });
        },
      });
    } catch (err) {
      // The value is written; only remembering it failed. Say so, keep the value.
      toast.error(`Saved, but "${v}" could not be remembered as a choice: ${(err as Error).message}`);
    }
  };

  const detail: ChoiceDetail | undefined = detailField
    ? {
        label: detailField.label,
        value: detailField.value,
        optionsFor: (val) => detailOptions(used.data?.details, val),
        onCommit: (d) => void detailField.onCommit(d),
      }
    : showsNote
      ? {
          label: canCarryNote(def) ? "Seller" : "Detail",
          value: note ?? null,
          optionsFor: (val) => detailOptions(used.data?.details, val),
          onCommit: (d) => void onCommitNote!(d),
        }
      : undefined;

  return (
    <ChoiceCombobox
      label={def.display_label}
      value={current ? (matchChoice(options, current)?.value ?? current) : null}
      options={options}
      onCommit={(v, final) => void commit(v, final)}
      detail={detail}
      autoFocus={autoFocus}
      onCancel={onCancel}
      className={className}
      live={live}
      placeholder={placeholder}
    />
  );
}

/** The details used with this value first, then every other one used anywhere
 *  (a seller bought from on eBay and on Amazon shows under both). */
export function detailOptions(details: Record<string, UsedValueBody[]> | undefined, value: string | null): ChoiceOption[] {
  if (!details) return [];
  const own = value ? asOptions(details[key(value)]) : [];
  const seen = new Set(own.map((o) => key(o.value)));
  const rest: ChoiceOption[] = [];
  for (const [k, list] of Object.entries(details)) {
    if (value && k === key(value)) continue;
    for (const o of asOptions(list)) {
      if (seen.has(key(o.value))) continue;
      seen.add(key(o.value));
      rest.push({ value: o.value });
    }
  }
  return [...own, ...rest.sort((a, b) => compareChoices(a.value, b.value))];
}
