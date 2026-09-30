// "Who does what, in order" for outside services (services.md section 7): the
// same list the AI page shows for AI work, per service capability, and the
// workspace's say over each one (section 9).
import { serviceConsent, type ServicePolicy } from "@cobblr/platform-contract/service-consent";
import type { ServiceChainStep } from "@cobblr/platform-contract/services";

/** Your own connections for one capability in the order after moving one of
 *  them up or down, or null when it cannot move that way. Only your own move:
 *  somebody else's shared connection keeps its place. */
export function movedOwnService(steps: readonly ServiceChainStep[], credentialId: string, by: -1 | 1): string[] | null {
  const own = steps.filter((s) => s.scope === "personal" && s.credential_id).map((s) => s.credential_id!);
  const i = own.indexOf(credentialId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= own.length) return null;
  const next = [...own];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export interface PolicyChoice {
  value: ServicePolicy;
  label: string;
}

/** What an owner may choose for a capability of this effect. A choice is
 *  offered only when it changes what happens, read from the one consent rule:
 *  "run without asking" never appears for something physical or paid, because
 *  the rule would ask anyway. */
export function policyChoices(effect: string): PolicyChoice[] {
  const whenDefault = serviceConsent(effect, "cobb", { writeMode: "ask" }).verdict === "run" ? "runs" : "asks first";
  const choices: PolicyChoice[] = [{ value: "default", label: `Default (${whenDefault})` }];
  if (changesAnything(effect, "always_ask")) choices.push({ value: "always_ask", label: "Always ask first" });
  if (changesAnything(effect, "run")) choices.push({ value: "run", label: "Run without asking" });
  choices.push({ value: "off", label: "Off here" });
  return choices;
}

/** Every door and chat mode a job can come in by. */
const CONTEXTS = [
  { door: "person", ctx: {} },
  { door: "cobb", ctx: { writeMode: "ask" } },
  { door: "cobb", ctx: { writeMode: "auto" } },
  { door: "mcp", ctx: { writeMode: "auto" } },
  { door: "wire", ctx: {} },
  { door: "wire", ctx: { wireRuns: true } },
  { door: "module", ctx: {} },
] as const;

/** Does this policy make any door, in any mode, do something different? */
function changesAnything(effect: string, policy: ServicePolicy): boolean {
  return CONTEXTS.some(({ door, ctx }) => serviceConsent(effect, door, { ...ctx, policy }).verdict !== serviceConsent(effect, door, ctx).verdict);
}

/** The words for where a step comes from, as the AI list says them. */
export function serviceSourceWords(scope: ServiceChainStep["scope"]): string {
  return scope === "personal" ? "yours" : scope === "shared" ? "shared with the workspace" : "built in";
}
