export interface BarcodeLookup {
  code: string;
  outcome: "hit" | "miss" | "unavailable";
  fields: Record<string, unknown>;
  existing: Array<{ kind: string; id: string; title: string; detail_url: string | null }>;
}
