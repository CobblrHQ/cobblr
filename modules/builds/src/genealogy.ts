// Genealogy / traceability (rung 8) — the pure as-built lineage walk, kept
// DB-independent (loaders injected) so it's unit-testable. A build RUN is a
// transformation node; its inputs are edges. When an input's lot_code matches a
// prior run's output serial_code, that prior run is the input's source subtree —
// recursing yields the full as-built tree ("what went into serial #X"). Cycle-
// guarded so a mis-entered code that points back up the tree can't loop.

import type { ActivitySubject } from "@cobblr/platform-contract/activity-summary";

export interface RunOutput {
  part_id: string | null;
  serial_code: string | null;
  quantity: number;
}
export interface RunInput {
  part_id: string;
  lot_code: string | null;
  quantity: number;
}

export interface GenealogyInput extends RunInput {
  /** If lot_code links to a prior run's output serial, that run's as-built tree. */
  source?: GenealogyNode;
  /** The record it was drawn from, named and linked (nameGenealogy); null
   *  when the record is gone or hidden from the reader. */
  subject?: ActivitySubject | null;
}
export interface GenealogyNode {
  run_id: string;
  output: (RunOutput & { subject?: ActivitySubject | null }) | null;
  inputs: GenealogyInput[];
}

export interface GenealogyLoaders {
  getOutput: (runId: string) => Promise<RunOutput | null> | RunOutput | null;
  getInputs: (runId: string) => Promise<RunInput[]> | RunInput[];
  /** run_id that produced an output with this serial_code, or null. */
  findRunByOutputSerial: (code: string) => Promise<string | null> | string | null;
}

export async function traceBackward(rootRunId: string, loaders: GenealogyLoaders): Promise<GenealogyNode> {
  async function build(runId: string, path: Set<string>): Promise<GenealogyNode> {
    const output = (await loaders.getOutput(runId)) ?? null;
    const inputs = await loaders.getInputs(runId);
    const node: GenealogyNode = { run_id: runId, output, inputs: [] };
    for (const inp of inputs) {
      const gi: GenealogyInput = { part_id: inp.part_id, lot_code: inp.lot_code, quantity: inp.quantity };
      if (inp.lot_code) {
        const srcRun = await loaders.findRunByOutputSerial(inp.lot_code);
        if (srcRun && !path.has(srcRun)) {
          gi.source = await build(srcRun, new Set(path).add(srcRun));
        }
      }
      node.inputs.push(gi);
    }
    return node;
  }
  return build(rootRunId, new Set([rootRunId]));
}

/** Flatten an as-built tree to the set of distinct lot/serial codes it touches —
 *  the "every lot involved in this unit" list a recall needs. */
export function lineageCodes(node: GenealogyNode): string[] {
  const codes = new Set<string>();
  const walk = (n: GenealogyNode) => {
    if (n.output?.serial_code) codes.add(n.output.serial_code);
    for (const inp of n.inputs) {
      if (inp.lot_code) codes.add(inp.lot_code);
      if (inp.source) walk(inp.source);
    }
  };
  walk(node);
  return [...codes];
}

/** The kind a run's inputs and outputs are stored against: the stock door's
 *  own, under which a record in any collection resolves. */
export const STOCK_KIND = "inventory:part";

/** Every input and output in an as-built tree, named and linked by `name`
 *  (the platform record namer), so the history never shows an id (#5977). */
export async function nameGenealogy(
  tree: GenealogyNode,
  name: (refs: Array<{ kind: string; id: string }>) => Promise<Map<string, ActivitySubject>>,
): Promise<GenealogyNode> {
  const ids = new Set<string>();
  const collect = (n: GenealogyNode) => {
    if (n.output?.part_id) ids.add(n.output.part_id);
    for (const i of n.inputs) {
      ids.add(i.part_id);
      if (i.source) collect(i.source);
    }
  };
  collect(tree);
  const names = await name([...ids].map((id) => ({ kind: STOCK_KIND, id })));
  const of = (id: string | null) => (id ? names.get(`${STOCK_KIND}:${id}`) ?? null : null);
  const apply = (n: GenealogyNode): GenealogyNode => ({
    ...n,
    output: n.output ? { ...n.output, subject: of(n.output.part_id) } : null,
    inputs: n.inputs.map((i) => ({ ...i, subject: of(i.part_id), ...(i.source ? { source: apply(i.source) } : {}) })),
  });
  return apply(tree);
}
