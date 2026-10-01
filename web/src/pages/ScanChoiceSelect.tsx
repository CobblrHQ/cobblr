// A dropdown field on a scan card, through the one choice picker (#2982, #4516).
//
// The owner, on his phone, with the Category dropdown open: "I need to be
// able to create a new category on the fly here." The choice list is the
// field's, so the door is the field's: the entry asks for the name inline
// (a one-line box where the select was, Enter to save, Escape to back out),
// appends it to the field's definition through the same write Configuration
// uses (PATCH field-defs {choices}), and selects it on this row. The server
// holds the bar (a member may grow a list, a guest may not), and a viewer
// the server would refuse sees no entry.
//
// `createByName` is the second home for this door: a table that keeps its own
// categories (inventory's tree) has no field def to append to — the category
// "travels by name" and the confirm creates it on file (#3223). So in that
// mode the New… box does not write a field def; it just selects the typed name
// on this row, and the confirm files the item under it. A scan came back
// "Hair Color" for a filament spool and the person had a free-text box but no
// visible way to coin the right category (reported 2026-09-28) - same door,
// same affordance table fields already had.
//
// Since #4516 there is no "New <field>…" entry: the box is the search, and a
// name typed that is not on the list is the value. On a field that learns it
// becomes a choice for everyone (platform:learn-choice, the same write and the
// same bar as the record page's picker); in `createByName` mode it is simply
// the value, and the confirm files the item under it.
import { useQueryClient } from "@tanstack/react-query";
import { ChoiceCombobox, matchChoice, runAction } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

/** May this role grow a dropdown's choices? The server's rule, mirrored so
 *  a refused viewer's typing is kept as the value without being remembered. */
export function canGrowChoices(role: string | null | undefined): boolean {
  return !role || roleSatisfies(role, ["member"]);
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
  onAdded,
  createByName,
  dataField,
  id,
}: {
  slug: string;
  /** The table the field belongs to ("inventory:part"). */
  entityKind: string | null;
  fieldName: string;
  /** The field's word ("Category"). */
  label: string;
  choices: string[];
  value: string;
  onChange: (v: string | null) => void;
  canAdd: boolean;
  className?: string;
  dataField?: string;
  id?: string;
  /** The definition changed: refresh whatever lists the choices. */
  onAdded?: () => void;
  /** The category travels by name: a new one is just the value here, and the
   *  confirm creates it on file. Nothing is remembered on a field. */
  createByName?: boolean;
}) {
  const qc = useQueryClient();
  const options = choices.map((c) => ({ value: c }));
  const learn = async (name: string) => {
    let kind = entityKind;
    if (!kind) {
      const defs = await api.listFieldDefs(slug);
      kind = defs.items.find((d) => d.name === fieldName)?.entity_kind ?? null;
    }
    if (!kind) return;
    // PRESS-ARGS: entity_kind, field and value come from the card's field and the name just typed.
    await runAction(api, qc, slug, { actionId: "platform:learn-choice", entityKind: "", entityId: "", args: { entity_kind: kind, field: fieldName, value: name } });
    void qc.invalidateQueries({ queryKey: ["scan-menu", slug] });
    void qc.invalidateQueries({ queryKey: ["platform-field-defs", slug] });
    onAdded?.();
  };
  return (
    <ChoiceCombobox
      label={label}
      value={value || null}
      options={options}
      className={className}
      id={id}
      dataField={dataField}
      onCommit={(v, final) => {
        onChange(v);
        if (final && v && canAdd && !createByName && !matchChoice(options, v)) void learn(v).catch(() => {});
      }}
    />
  );
}
