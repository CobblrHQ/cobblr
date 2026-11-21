// How long a record's free text may be, said once so the field that takes it
// and the route that saves it say the same number (#4115).
//
// A 9,000-character note pasted into a part's Notes was refused by the save
// (the route took 8,000) while the field took all of it and said nothing; the
// page closed and the note was gone. The field now says the limit as the text
// nears it and keeps what was typed until it fits; the route refuses past the
// same number.

/** A record's Notes: parts, assets, machines, orders, records, customers. */
export const RECORD_NOTES_MAX = 8_000;
