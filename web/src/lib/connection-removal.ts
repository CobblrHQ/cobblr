import type { AiProviderDef, UserConnection } from "./api";

export interface ConnectionRemovalPlan {
  title: string;
  message: string;
}

/** One consequence statement for every kind of personal connection. Providers
 *  with durable outside links name their exact boundary; all others still get
 *  a safe, truthful default rather than a silent destructive button. */
export function connectionRemovalPlan(
  connection: Pick<UserConnection, "label" | "provider_id">,
  provider?: Pick<AiProviderDef, "label" | "disconnect">,
): ConnectionRemovalPlan {
  const impact = provider?.disconnect ?? {
    stops: "Anything using this connection stops until you add it again.",
    keeps: "Data already stored in Cobblr stays where it is.",
  };
  return {
    title: `Remove ${connection.label || provider?.label || connection.provider_id}?`,
    message: `${impact.stops} ${impact.keeps}`,
  };
}
