// The kernel's own actions a record's bar offers from its parts (lend and
// back, mark gone, offer to someone, share, suggestions), not from the
// record's action list (#7922).
//
// Each part drew its button from what the record holds (a loan, a share, a
// suggestion), never from whether its viewer may run it, so a member was
// offered Lend and told after the tap that they need permission. The actions
// list now answers `runs` for each of these, from the door's own answer
// (may-invoke.ts), and a part draws a button only where it runs.
export const RECORD_BAR_ACTIONS = [
  "platform:lend",
  "platform:return",
  "platform:mark-gone",
  "platform:bring-back",
  "platform:offer-to",
  "platform:share-with",
  "platform:share-list",
  "platform:stop-sharing",
  "platform:accept-suggestions",
  "platform:reject-suggestions",
  "platform:reopen-suggestions",
] as const;

export type RecordBarAction = (typeof RECORD_BAR_ACTIONS)[number];
