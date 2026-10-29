// What the AI router reads from user-credentials, inert: no personal
// connection, and no AI kept by somebody else. A test that mocks the module
// spreads this first and overrides what it is about, so a new read the router
// makes is never "No export is defined on the mock" in nineteen files (#8855).
export const noPersonalAi = {
  resolvePersonalProvider: async (..._args: unknown[]): Promise<unknown> => null,
  aiKeptByItsOwner: async (..._args: unknown[]): Promise<{ ownerName: string } | null> => null,
};
