// A record's own text column whose list is what the workspace has already
// typed into it: a brand, a manufacturer. The one choice picker over the
// values the kind's records hold (most recent and most used first), so "Bambu
// Lab" typed once is offered on the next printer, and typing a new one is just
// the value. Nothing to remember and nothing to undo: the list IS the records.
//
// A field def with choices goes through ChoiceField instead; this is for a
// module's native column, which has no def to grow.

import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { ChoiceCombobox } from "./ChoiceCombobox";

export interface UsedValueInputProps {
  /** The kind whose records' values are offered ("inventory:part"). */
  kind: string;
  /** The column ("manufacturer"). */
  field: string;
  label: string;
  value: string | null;
  onCommit: (v: string | null) => void;
  /** Commit every keystroke (a form that saves as a whole). */
  live?: boolean;
  placeholder?: string;
  className?: string;
}

export function UsedValueInput({ kind, field, label, value, onCommit, live, placeholder, className }: UsedValueInputProps) {
  const { api, orgSlug } = usePlatformWeb();
  const used = useQuery({
    queryKey: ["field-values", orgSlug, kind, field, null, false],
    queryFn: () => api.fieldValues!(orgSlug, kind, field, {}),
    enabled: !!api.fieldValues && !!kind,
    staleTime: 30_000,
    meta: { kinds: [kind] },
  });
  return (
    <ChoiceCombobox
      label={label}
      value={value || null}
      options={used.data?.values ?? []}
      onCommit={(v) => onCommit(v)}
      live={live}
      placeholder={placeholder}
      className={className}
      dataField={field}
    />
  );
}
