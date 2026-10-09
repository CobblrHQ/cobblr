// How a model choice is stored, so an older api can still read it.
//
// A family's "latest" (claude-haiku-latest) is never sent to a provider: the
// platform resolves it per call (#5417). The api deployed before it reads the
// same rows (the canary channel shares every workspace's database) and sends
// whatever `model` holds, so `model` always names a model the provider serves
// and the choice of latest rides beside it in `model_follows` (migration
// 0016). Reading a choice is `model_follows ?? model`.

import { platform } from "@cobblr/platform-contract";
import { newestOfFamily } from "@cobblr/platform-contract/ai-models";

/** The columns to write for a model somebody picked. `resolves` is what the
 *  connection's listing says latest means now, when the caller has it; the
 *  provider's fallback list answers otherwise. */
export function storedModel(model: string, opts: { providerId?: string | null; resolves?: string | null } = {}): { model: string; model_follows: string | null } {
  const ids = opts.providerId ? [opts.providerId] : platform().ai.listProviders().map((p) => p.id);
  for (const id of ids) {
    const catalog = platform().ai.getProvider(id)?.modelCatalog;
    const family = catalog?.familyOfLatest(model);
    if (!catalog || !family) continue;
    const concrete = opts.resolves ?? newestOfFamily(catalog, family, catalog.fallback);
    if (concrete) return { model: concrete, model_follows: model };
  }
  return { model, model_follows: null };
}

/** The choice a row records: a family's latest when one was picked, else
 *  the exact model. */
export function chosenModel<T extends string | null>(row: { model: T; model_follows?: string | null }): string | T {
  return row.model_follows ?? row.model;
}
