// Who answers an AI call here, in order, as a person reads it (#3842).
//
// The order itself is the server's (GET /ai-chain walks the router's own
// decision), so nothing here re-derives it. What lives here is how a person
// reads it: the jobs grouped by what they do rather than by capability id,
// and the warnings, each one a sentence about a consequence ("scanning
// waits") rather than a state ("1 provider").

import type { AiCapability } from "@cobblr/platform-contract";

export interface AiChainStep {
  position: number;
  /** Within the providers one call may ask. */
  asked: boolean;
  source: "yours" | "shared" | "workspace" | "managed";
  label: string;
  provider_id?: string;
  model?: string;
  floating?: boolean;
  credential_id?: string;
  status: string | null;
  verified: boolean;
  /** "no": the provider cannot take an image at all. "declared": it reads
   *  images natively. null: in doubt (a bridge) and not yet shown the test
   *  picture. */
  reads_photos: "read" | "not-read" | "no" | "declared" | null;
}

export interface AiChain {
  steps: AiChainStep[];
  refusal?: { code: string; message: string };
}

export interface AiChainAnswer {
  capability: string;
  you: AiChain;
  automations: AiChain;
}

export interface AiJobGroup {
  id: "photos" | "chat" | "text" | "search";
  title: string;
  /** The job whose chain the group shows. */
  shows: AiCapability;
  /** Every job the group stands for: a reorder writes the order for each. */
  capabilities: AiCapability[];
  /** What waits when nothing answers, in the words of the warning. */
  waits: string;
}

/** Every capability sits in exactly one group (ai-chain.test.ts), so a job
 *  added to the contract cannot fall off the page. */
export const AI_JOB_GROUPS: AiJobGroup[] = [
  {
    id: "photos",
    title: "Reading photos",
    shows: "identify-image",
    capabilities: ["identify-image", "identify-glance", "split-image", "rank-images", "classify-image", "extract-text", "document-read"],
    waits: "scanning waits",
  },
  { id: "chat", title: "Chat", shows: "chat", capabilities: ["chat", "plan-changes", "design-workspace"], waits: "Cobb stops answering" },
  { id: "text", title: "Organising and text", shows: "summarise", capabilities: ["summarise", "match-to-catalog"], waits: "matching and summaries wait" },
  { id: "search", title: "Search", shows: "embed-text", capabilities: ["embed-text"], waits: "search falls back to plain words" },
];

/** "Gemini · Flash Lite (floating) · yours · Verified" */
export function stepLine(s: AiChainStep): string {
  const bits = [s.label];
  if (s.model) bits.push(s.floating ? `${s.model} (floating)` : s.model);
  bits.push(sourceWords(s.source));
  if (s.status) bits.push(s.status);
  return bits.join(" · ");
}

export function sourceWords(source: AiChainStep["source"]): string {
  switch (source) {
    case "yours":
      return "yours";
    case "shared":
      return "shared";
    case "workspace":
      return "this workspace's";
    case "managed":
      return "your plan's";
  }
}

/** What a person should know about one group's chain, most serious first.
 *  Only what is about THIS kind of work: a floating model or a "Just me"
 *  connection is the same fact in every group, so it is said once, by
 *  `sectionWarnings`, rather than four times in amber. */
export function chainWarnings(group: AiJobGroup, answer: AiChainAnswer): string[] {
  const out: string[] = [];
  const asked = answer.you.steps.filter((s) => s.asked);
  const first = asked[0];
  if (!first) return [`Nothing here can do this, so ${group.waits}.`];
  if (group.id === "photos") {
    for (const s of asked) {
      if (s.reads_photos === "not-read") out.push(`${s.label} doesn't read photos: it answered the test picture without naming it.`);
      else if (s.reads_photos === null && s.source === "yours") out.push(`${s.label} has not been checked with a photo. Test it on Your account, Connections.`);
    }
  }
  if (asked.length === 1) out.push(`No backup: if ${first.label} is busy, ${group.waits}.`);
  return out;
}

/** The warnings that hold for every kind of work at once, said once. */
export function sectionWarnings(answers: AiChainAnswer[]): string[] {
  const out: string[] = [];
  const floating = new Map<string, string>();
  for (const a of answers) for (const s of a.you.steps) if (s.asked && s.floating && s.model) floating.set(`${s.label}|${s.model}`, `${s.label} (${s.model})`);
  if (floating.size) {
    out.push(`Floating model: ${[...floating.values()].join(" and ")}. The provider can change what it points at without notice.`);
  }
  const justMe = new Set<string>();
  for (const a of answers) {
    const reach = new Set(a.automations.steps.map((s) => s.credential_id).filter(Boolean));
    for (const s of a.you.steps) if (s.asked && s.source === "yours" && s.credential_id && !reach.has(s.credential_id)) justMe.add(s.label);
  }
  if (justMe.size) {
    out.push(`Only you get ${[...justMe].join(" and ")}: automations and background work can't use a "Just me" connection. Share it with the workspace to let them.`);
  }
  return out;
}

/** The order of the caller's own connections after moving one up or down,
 *  as the ids the order endpoint takes. Somebody else's rows and the
 *  workspace's do not move: only the person who owns a connection ranks it. */
export function reorderedOwn(steps: AiChainStep[], credentialId: string, by: -1 | 1): string[] | null {
  const own = steps.filter((s) => s.source === "yours" && s.credential_id).map((s) => s.credential_id!);
  const i = own.indexOf(credentialId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= own.length) return null;
  const next = [...own];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** One line for a workspace on Your account, Connections: "Gemini, then
 *  Claude bridge". Null when nothing answers. */
export function chainSummary(chain: AiChain): string | null {
  const names = chain.steps.filter((s) => s.asked).map((s) => s.label);
  if (!names.length) return null;
  return names.join(", then ");
}
