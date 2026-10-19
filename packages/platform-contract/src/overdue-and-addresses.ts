/** One record at or past its deadline. */
export interface OverdueRow {
  kind: string;
  id: string;
  name: string;
  /** The day it was due, YYYY-MM-DD. */
  dueOn: string;
  /** Whose it is, as a person on the workspace's People list; null when
   *  nobody has it. */
  assigneePersonId: string | null;
}

export interface OverdueSource {
  /** The kind the rows are of (a task's `projects:task`). */
  kind: string;
  /** Rows due on `today` or before, not done. */
  read(orgId: string, today: string): Promise<OverdueRow[]>;
}

/** One address a module keeps outside record fields (a service visit's), as
 *  the address picker offers it: the place, the record it was used on, and
 *  when. */
export interface UsedAddressRow {
  address: unknown;
  usedOn: { kind: string; id: string; name: string };
  at: string | null;
}

/** The addresses a workspace already used, for the address picker (#5317).
 *  Every address FIELD is read by the kernel; a module that stores addresses
 *  of its own (core-maintenance's visits) registers them here, so a place
 *  used on a visit is offered on the next record too. */
export interface PlatformAddresses {
  registerUsedSource(id: string, source: (orgId: string) => Promise<UsedAddressRow[]>): void;
}
