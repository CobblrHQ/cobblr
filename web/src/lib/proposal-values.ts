// The values a proposed write will set, as its card shows them (#3658).
// Built on the server from the write's own fields (core-ai write-values.ts);
// here they are drawn, and one the person does not want is taken off the
// write itself before Confirm, so what runs is what the card showed.

export interface ProposalValue {
  field: string;
  label: string;
  value: string;
  from?: string;
  suggested?: boolean;
  removable?: boolean;
}

/** The proposal with one field taken off: from its fields (top level or the
 *  metadata where custom fields live) and from the values the card lists. */
export function withoutValue<P extends { fields: Record<string, unknown>; values?: ProposalValue[] }>(proposal: P, field: string): P {
  const fields = { ...proposal.fields };
  delete fields[field];
  const meta = fields.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta) && field in (meta as Record<string, unknown>)) {
    const m = { ...(meta as Record<string, unknown>) };
    delete m[field];
    fields.metadata = m;
  }
  return { ...proposal, fields, values: (proposal.values ?? []).filter((v) => v.field !== field) };
}
