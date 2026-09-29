// The three provenance fields every physical thing can carry: where it came
// from, when, and what it cost. Named here once, because two doors make them:
// the Provenance field preset, and an import whose sheet has those columns.
// Two spellings of one field would be two fields that never meet.

export interface ProvenanceField {
  name: string;
  label: string;
  // VOCAB-ENUMERATION OK: the three provenance fields' own declaration, one per role
  field_role: "acquired-from" | "acquired-on" | "acquired-for";
}

export const PROVENANCE_FIELDS = {
  from: { name: "acquired_from", label: "Acquired from", field_role: "acquired-from" },
  on: { name: "acquired_on", label: "Acquired on", field_role: "acquired-on" },
  for: { name: "acquired_for", label: "Paid", field_role: "acquired-for" },
} as const satisfies Record<string, ProvenanceField>;

/** The provenance field that holds a role, when the role is one of the three. */
export function provenanceFieldFor(role: string | null | undefined): ProvenanceField | null {
  return Object.values(PROVENANCE_FIELDS).find((f) => f.field_role === role) ?? null;
}
