// Every query that says whether AI works here lives under one key family,
// ["ai", ...], so one invalidation refreshes all of them together: Cobb's
// panel, the scan's identify affordances, the AI settings page, the model
// pill, and the person's own connections.
//
// They were siblings ("ai-status", "ai-chat-prefs", "ai-chat-models",
// "connections", ...), and saving a verified personal connection's route
// invalidated only "connections": Cobb kept saying this workspace's plan
// does not include AI until a reload (#3654). A new availability query takes
// its key from here; lint:query-key-families refuses the literal anywhere
// else, and the api's request() signals every write below (AI_AVAILABILITY_WRITE)
// so the refresh never depends on a mutation remembering it.

export const aiAvailabilityKeys = {
  /** Everything below: what a connection, share, provider or setting write refreshes. */
  all: () => ["ai"] as const,
  /** Whether AI (chat, identify) is usable in this workspace for this person. */
  status: (slug: string) => ["ai", "status", slug] as const,
  /** Cobb's consent chips. */
  chatPrefs: (slug: string) => ["ai", "chat-prefs", slug] as const,
  /** The model pill: which models this person can pick here. */
  chatModels: (slug: string) => ["ai", "chat-models", slug] as const,
  /** The workspace's own providers. */
  providers: (slug: string) => ["ai", "providers", slug] as const,
  /** Which provider serves which kind of work. */
  capabilityDefaults: (slug: string) => ["ai", "capability-defaults", slug] as const,
  /** Members' AI offered to the workspace. */
  shares: (slug: string) => ["ai", "shares", slug] as const,
  /** The person's own connections, and where each is routed. */
  connections: () => ["ai", "connections"] as const,
  /** Who answers a job here, in order (GET /ai-chain). */
  chain: (slug: string, capability: string) => ["ai", "chain", slug, capability] as const,
};

/** A write that can change whether AI works somewhere: a personal
 *  connection or its routing, a workspace's shares, its AI switch, its
 *  providers, or which provider serves what. */
export const AI_AVAILABILITY_WRITE =
  /^\/(?:me\/connections(?:[/?#]|$)|orgs\/[^/]+\/(?:ai-shares|ai-settings)(?:[/?#]|$)|orgs\/[^/]+\/modules\/core-ai\/(?:providers|capability-defaults)(?:[/?#]|$))/;
