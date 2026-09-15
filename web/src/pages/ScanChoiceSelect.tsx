// A dropdown field's select with one more entry: "New <field>…" (#2982).
//
// The owner, on his phone, with the Category dropdown open: "I need to be
// able to create a new category on the fly here." The choice list is the
// field's, so the door is the field's: the entry asks for the name inline
// (a one-line box where the select was, Enter to save, Escape to back out),
// appends it to the field's definition through the same write Configuration
// uses (PATCH field-defs {choices}), and selects it on this row. The server
// holds the bar (a member may grow a list, a guest may not), and a viewer
// the server would refuse sees no entry.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export const NEW_CHOICE = "__new_choice__";

/** May this role grow a dropdown's choices? The server's rule, mirrored so
 *  a refused viewer sees no entry. Unknown (still loading) is left to it. */
export function canGrowChoices(role: string | null | undefined): boolean {
  return !role || role === "owner" || role === "admin" || role === "member";
}

export function ScanChoiceSelect({
  slug,
  entityKind,
  fieldName,
  label,
  choices,
  value,
  onChange,
  canAdd,
  className,
  dataField,
  onAdded,
}: {
  slug: string;
  /** The table the field belongs to ("inventory:part"), for the lookup of its definition. */
  entityKind: string | null;
  fieldName: string;
  /** The field's word, for the entry: "New category…". */
  label: string;
  choices: string[];
  value: string;
  onChange: (v: string | null) => void;
  canAdd: boolean;
  className?: string;
  dataField?: string;
  /** The definition changed: refresh whatever lists the choices. */
  onAdded?: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async (name: string) => {
      const defs = await api.listFieldDefs(slug, entityKind ?? undefined);
      const def = defs.items.find((d) => d.name === fieldName && (!entityKind || d.entity_kind === entityKind)) ?? defs.items.find((d) => d.name === fieldName);
      if (!def) throw new Error("This field has no definition to add to.");
      if (!(def.choices ?? []).includes(name)) await api.appendFieldDefChoice(slug, def.id, name);
      return name;
    },
    onSuccess: (name) => {
      void qc.invalidateQueries({ queryKey: ["scan-menu", slug] });
      void qc.invalidateQueries({ queryKey: ["platform-field-defs", slug] });
      onAdded?.();
      setDraft(null);
      setError(null);
      onChange(name);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not add it."),
  });
  const word = label.trim().toLowerCase() || "choice";
  if (draft !== null) {
    const commit = () => {
      const v = draft.trim();
      if (!v) return setDraft(null);
      if (choices.includes(v)) {
        setDraft(null);
        onChange(v);
        return;
      }
      add.mutate(v);
    };
    return (
      <div className="w-full">
        <input
          autoFocus
          data-testid="new-choice"
          data-field={dataField}
          aria-label={`New ${word}`}
          placeholder={`New ${word}…`}
          value={draft}
          disabled={add.isPending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
              setError(null);
            }
          }}
          onBlur={() => {
            if (!add.isPending && !draft.trim()) setDraft(null);
          }}
          className={className}
        />
        <div className="mt-0.5 text-[11px] text-faint">
          {error ? <span className="text-ember-600 dark:text-ember-400">{error}</span> : add.isPending ? "Adding…" : "Enter adds it to this field for everyone. Esc backs out."}
        </div>
      </div>
    );
  }
  return (
    <select
      data-field={dataField}
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW_CHOICE) {
          setDraft("");
          return;
        }
        onChange(v || null);
      }}
      className={className}
    >
      <option value=""> - none - </option>
      {choices.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      {value && !choices.includes(value) && <option value={value}>{value}</option>}
      {canAdd && (
        <option value={NEW_CHOICE} data-testid="new-choice-entry">
          New {word}…
        </option>
      )}
    </select>
  );
}
