// The no-AI matcher: lexical, deterministic, explainable. No model, no
// embeddings — the whole point is it works with zero AI connected. A rule's
// score is the word-length of its longest matched keyword phrase (a more
// specific phrase beats a loose single word); ties break by catalog order, so
// behaviour matches the old "first rule wins" floor.

import type { BasicRule } from "./basics-catalog.js";
import { NO_MATCH_REPLY } from "./basics-catalog.js";

/** lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(" ") : [];
}

/** is `needle` a contiguous run of tokens inside `hay`? */
function containsSequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export interface RuleCandidate {
  key: string;
  intent: string;
  score: number;
}

export interface BasicMatch {
  matched: boolean;
  reply: string;
  intent: string | null;
  key: string | null;
  score: number;
  /** every rule that scored > 0, best first — for the "try it" tester. */
  candidates: RuleCandidate[];
}

/** Score one rule against pre-tokenised message words. */
function scoreRule(msg: string[], rule: BasicRule): number {
  let best = 0;
  for (const kw of rule.keywords) {
    const kwt = tokens(kw);
    if (containsSequence(msg, kwt)) best = Math.max(best, kwt.length);
  }
  return best;
}

/**
 * Match a message against an ordered ruleset. Returns the winning rule's reply
 * (or NO_MATCH_REPLY), plus the ranked candidates so a tester can show *why*.
 * `rules` is passed in (built-ins today; built-ins overlaid with per-workspace
 * overrides + custom rows later) so this function stays pure + storage-agnostic.
 */
export function matchBasics(
  message: string,
  rules: BasicRule[],
  opts: { aiOn?: boolean; offering?: boolean } = {},
): BasicMatch {
  const msg = tokens(message);
  // Offering an answer to a half-typed sentence is a different act from
  // replying to one somebody sent: a rule that declines ("that needs AI
  // connected") is a fine reply and a terrible offer. Both default off, so
  // /basics/answer behaves exactly as it did.
  if (opts.offering) rules = rules.filter((r) => !r.notBeforeSend);
  const candidates: RuleCandidate[] = [];
  let winner: { rule: BasicRule; score: number; idx: number } | null = null;

  rules.forEach((rule, idx) => {
    const score = scoreRule(msg, rule);
    if (score <= 0) return;
    candidates.push({ key: rule.key, intent: rule.intent, score });
    // Higher score wins; on a tie the earlier rule (lower idx) keeps it.
    if (!winner || score > winner.score) winner = { rule, score, idx };
  });

  candidates.sort((a, b) => b.score - a.score);

  if (!winner) {
    return { matched: false, reply: NO_MATCH_REPLY, intent: null, key: null, score: 0, candidates };
  }
  const w = winner as { rule: BasicRule; score: number; idx: number };
  return {
    matched: true,
    reply: (opts.aiOn && w.rule.replyWhenAiOn) || w.rule.reply,
    intent: w.rule.intent,
    key: w.rule.key,
    score: w.score,
    candidates,
  };
}
