// What `q` reads on an entry: one list, read by Search's resolver and by the
// Knowledge list, so a question asked in either finds the same entries. The
// list used to read the title, body and code as one phrase, and neither read
// an entry's custom fields.
export const ENTRY_SEARCH = { text: ["title", "body", "kind", "code"], json: ["metadata"] } as const;
