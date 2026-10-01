// What a kind calls the things inside one of its records: "Contents" unless
// the workspace says otherwise. A computer's reads better as Parts, a bag's as
// In the bag, a toolbox's as Tools.
//
// One word per kind (every computer in "Computers" shares it), kept in the
// kind's own presentation override row, beside its name and icon:
//   config.contents_label          the workspace's word (a person's rename)
//   config.contents_label_default  a bundle's word, refreshed on every update
// The person's word wins and a bundle never writes it, so a rename survives
// updates; clearing it brings the bundle's word (or "Contents") back.

import { getOverrideConfig, upsertOverride, type OverrideTarget } from "./entity-kind-overrides.js";
import { mergeOverrideConfig } from "./override-config-merge.js";
import { listInstances } from "./instances.js";

export const CONTENTS_WORD_MAX = 40;

export interface ContentsWord {
  /** The word to show: the workspace's, else the bundle's, else null (the
   *  caller's own default, "Contents"). */
  word: string | null;
  /** The workspace's own word, when it set one. */
  custom: string | null;
  /** The bundle's word, when one declared it. */
  default_word: string | null;
}

/** Where a kind's word is kept: a collection's own row for `<instance>:item`,
 *  the kind's row otherwise. */
async function targetOf(orgId: string, kind: string): Promise<{ targetKind: OverrideTarget; targetId: string }> {
  const [prefix, suffix] = kind.split(":", 2);
  if (suffix === "item" && prefix) {
    const inst = (await listInstances(orgId)).find((i) => i.instance_name === prefix);
    if (inst) return { targetKind: "instance", targetId: `${inst.module_name}:${inst.instance_name}` };
  }
  return { targetKind: "entity_kind", targetId: kind };
}

const wordIn = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function contentsWordOf(orgId: string, kind: string): Promise<ContentsWord> {
  const t = await targetOf(orgId, kind);
  const config = await getOverrideConfig(orgId, t.targetKind, t.targetId);
  const custom = wordIn(config.contents_label);
  const fallback = wordIn(config.contents_label_default);
  return { word: custom ?? fallback, custom, default_word: fallback };
}

/** Set the workspace's word for a kind; null (or blank) puts the default back.
 *  Merged into the row's config, so nothing else there changes. */
export async function setContentsWord(orgId: string, kind: string, word: string | null): Promise<ContentsWord> {
  const clean = wordIn(word)?.slice(0, CONTENTS_WORD_MAX) ?? null;
  const t = await targetOf(orgId, kind);
  const config = mergeOverrideConfig(await getOverrideConfig(orgId, t.targetKind, t.targetId), { contents_label: clean });
  await upsertOverride({ orgId, targetKind: t.targetKind, targetId: t.targetId, config });
  return contentsWordOf(orgId, kind);
}
