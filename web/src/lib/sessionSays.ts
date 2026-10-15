// What a session's own lines already say, so its rows do not say it again
// (#6095). The session's meta line names the place its rows are suggested
// ("3D Printers, in Printer Room (where your other 3D Printers are)") and its
// headline names the shop; a row repeating either on every line was the
// owner's "repeats on every row". A row keeps its own place or shop when it
// differs: that difference is the one thing worth reading there.

export interface SessionSays {
  /** The place the session's meta line names for its rows, or null. */
  place: string | null;
  /** The shop the session's headline names, or null. */
  vendor: string | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether the session already said this row's place. Pure. */
export function sessionSaidPlace(says: SessionSays | null | undefined, place: string | null | undefined): boolean {
  return !!says?.place && !!place && same(says.place, place);
}

/** Whether the session already said this row's shop. Pure. */
export function sessionSaidVendor(says: SessionSays | null | undefined, vendor: string | null | undefined): boolean {
  return !!says?.vendor && !!vendor && same(says.vendor, vendor);
}
