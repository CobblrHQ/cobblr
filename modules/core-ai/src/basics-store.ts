// The effective basic-mode ruleset for a workspace: the built-in catalog
// (basics-catalog.ts) overlaid with per-workspace overrides + custom rows from
// core_ai_basics. This is the single place that merges code-defaults with
// DB-changes, so the matcher, the list endpoint, and the tester all agree.

import type { Kysely } from "kysely";
import type { CoreAiDB } from "./db.js";
import type { BasicRule } from "./basics-catalog.js";
import { BUILTIN_BASICS } from "./basics-catalog.js";

/** built-in key → its default index (used as the built-in's default position). */
const BUILTIN_INDEX = new Map(BUILTIN_BASICS.map((b, i) => [b.key, i]));

export function isBuiltinKey(key: string): boolean {
  return BUILTIN_INDEX.has(key);
}

/** A built-in's default position, so an override keeps its place in the list. */
export function builtinDefaultPosition(key: string): number {
  return BUILTIN_INDEX.get(key) ?? BUILTIN_BASICS.length;
}

export interface EffectiveRule {
  /** row id, or null for a pristine built-in that has no override row yet. */
  id: string | null;
  /** built-in key, or (for a custom rule) the row id — stable per rule. */
  key: string;
  builtin: boolean;
  intent: string;
  keywords: string[];
  reply: string;
  enabled: boolean;
  position: number;
}

/**
 * Load the workspace's effective rules, ordered: built-ins (in catalog order,
 * with any override applied) first, then custom rules by position. A built-in
 * with no override row shows its code default (id null).
 */
export async function loadEffectiveRules(db: Kysely<CoreAiDB>): Promise<EffectiveRule[]> {
  const rows = await db.selectFrom("core_ai_basics").selectAll().execute();
  const overrides = new Map<string, (typeof rows)[number]>();
  const customs: typeof rows = [];
  for (const r of rows) {
    if (r.builtin_key) overrides.set(r.builtin_key, r);
    else customs.push(r);
  }

  const out: EffectiveRule[] = [];
  BUILTIN_BASICS.forEach((b, i) => {
    const ov = overrides.get(b.key);
    out.push(
      ov
        ? { id: ov.id, key: b.key, builtin: true, intent: ov.intent, keywords: ov.keywords, reply: ov.reply, enabled: ov.enabled, position: ov.position }
        : { id: null, key: b.key, builtin: true, intent: b.intent, keywords: b.keywords, reply: b.reply, enabled: true, position: i },
    );
  });
  for (const c of customs) {
    out.push({ id: c.id, key: c.id, builtin: false, intent: c.intent, keywords: c.keywords, reply: c.reply, enabled: c.enabled, position: c.position });
  }

  // Position asc; on a tie built-ins keep their catalog order ahead of customs.
  out.sort((a, b) => a.position - b.position || (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1));
  return out;
}

/** The subset the matcher needs (enabled only), preserving effective order. */
export function toMatchable(rules: EffectiveRule[]): BasicRule[] {
  return rules
    .filter((r) => r.enabled)
    .map((r) => {
      // A workspace that rewrote a built-in owns its wording, and with it which
      // world the wording is true in — so the built-in's mode fields survive
      // only while the words are still the built-in's, character for character.
      const src = BUILTIN_BASICS.find((b) => b.key === r.key);
      const builtin = src && src.reply === r.reply ? src : undefined;
      return {
        key: r.key,
        intent: r.intent,
        keywords: r.keywords,
        reply: r.reply,
        ...(builtin?.notBeforeSend ? { notBeforeSend: builtin.notBeforeSend } : {}),
        ...(builtin?.replyWhenAiOn ? { replyWhenAiOn: builtin.replyWhenAiOn } : {}),
      };
    });
}

/** Default position for a NEW custom rule: after everything that exists. */
export function nextCustomPosition(rules: EffectiveRule[]): number {
  const max = rules.reduce((m, r) => Math.max(m, r.position), BUILTIN_BASICS.length - 1);
  return max + 1;
}
