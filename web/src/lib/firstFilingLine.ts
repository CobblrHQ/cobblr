// Its own module so the notice every page mounts (JustFiledNotice) does not
// pull the scan inbox's code into the first load.

/** The once-per-workspace line under a first filing, saying where the table
 *  lives. "Is new" only when this filing set the table up: a first filing
 *  often lands in a table the workspace already had (a sandbox's seeded
 *  Groceries), and "Groceries is new" there is false (#9484). */
export function firstFilingLine(destination: string, madeTheTable: boolean): string {
  return madeTheTable ? `${destination} is new: find it any time in the menu.` : `Find ${destination} any time in the menu.`;
}
