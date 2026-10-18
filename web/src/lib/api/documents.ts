import { request } from "./client";

/** One library item (a document, a game) as the record's library panel shows it. */
export interface DocumentRow {
  connection_id: string;
  /** Linked rows say whether their connection still exists for this person. */
  connected?: boolean;
  ref: string;
  /** What it is ("document", "game") and its kind's heading ("Games"). */
  type: string;
  type_label: string;
  title: string;
  subtitle?: string | null;
  open_label?: string | null;
  created: string | null;
  tags: string[];
  open_url: string | null;
  has_thumb: boolean;
  /** Linked: the system it is in. */
  system?: string;
  /** What on it says it is another thing's (a VIN that is not this record's):
   *  shown, never a match (#5870). */
  conflict?: string | null;
  /** A softer disagreement (a year), shown beside the match. */
  warning?: string | null;
  written_back?: boolean;
  /** A library copy that finished and is attached to this record. */
  copied_at?: string | null;
  copied_filename?: string | null;
  copied_file_id?: string | null;
  /** The copy is in this person's Vault (a personal document, #5871). */
  copied_vault_file_id?: string | null;
  /** The copy is in someone else's Vault: their name (#5936). */
  vault_of?: string | null;
  /** Linked through another member's own library, which still works: their
   *  name. Not this person's to reconnect (#5936). */
  library_of?: string | null;
  /** A disconnected link: the library to connect again. */
  reconnect?: { provider: string | null; address: string | null };
  /** Suggested: what made it a match ("serial", "model", "name"). */
  because?: string | null;
  score?: number;
}
export interface RecordDocuments {
  available: boolean;
  /** Each library this person can ask here, and what it does beyond find. */
  systems: Array<{
    connection_id: string;
    label: string;
    can_link_back: boolean;
    can_copy: boolean;
    /** How this library pushes a new item to Cobblr, when it can. */
    push_setup: { library: string; arrives: string; before: string[]; after: string[] } | null;
  }>;
  linked: DocumentRow[];
  suggestions: DocumentRow[];
  matching: boolean;
  matched_at: string | null;
  /** The document system did not answer the last background ask. */
  unanswered: string | null;
}
export interface DocumentFindSystem {
  connection_id: string;
  label: string;
  items: DocumentRow[];
  error?: string;
}
const documentsPath = (slug: string, kind: string, id: string) =>
  `/orgs/${slug}/modules/core-documents/records/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;

export interface PersonalDocumentsReaderView {
  reader: { kind: "local" } | { kind: "cloud"; connection: string; label: string; company: string; consented_by: string | null; consented_at: string; consent: string };
  local_ai: boolean;
  can_change: boolean;
  choices: Array<{ connection: string; label: string; company: string; consent: string }>;
}

export const documentsApi = {
  /** Who reads this workspace's personal documents (#5621). */
  getPersonalDocumentsReader: (slug: string) => request<PersonalDocumentsReaderView>("GET", `/orgs/${slug}/personal-documents-reader`),
  /** Owner only. A cloud connection needs the consent sentence the page showed, word for word. */
  setPersonalDocumentsReader: (slug: string, body: { connection: "local" } | { connection: string; consent: string }) =>
    request<PersonalDocumentsReaderView>("PUT", `/orgs/${slug}/personal-documents-reader`, body),
  /** Every link touching one record, both ways round, whichever spelling of
   *  its kind each was stored under (#3875). */
  /** A record's documents (core-documents): what is linked and what was
   *  matched in the background. No outside call behind it. */
  recordDocuments: (slug: string, kind: string, id: string) =>
    request<RecordDocuments>("GET", `${documentsPath(slug, kind, id)}`),
  findDocuments: (slug: string, kind: string, id: string, query?: string) =>
    request<{ systems: DocumentFindSystem[] }>("POST", `${documentsPath(slug, kind, id)}/find`, query ? { query } : {}),
  linkDocument: (slug: string, kind: string, id: string, doc: { connection_id: string; ref: string; write_back?: boolean }) =>
    request<{ linked: { title: string; system: string }; write_back: { id: string; status: string } | null; already: boolean }>("POST", `${documentsPath(slug, kind, id)}/links`, doc),
  unlinkDocument: (slug: string, kind: string, id: string, doc: { connection_id: string; ref: string }) =>
    request<{ removed: boolean }>("DELETE", `${documentsPath(slug, kind, id)}/links?connection_id=${encodeURIComponent(doc.connection_id)}&ref=${encodeURIComponent(doc.ref)}`),
  dismissDocument: (slug: string, kind: string, id: string, doc: { connection_id: string; ref: string }) =>
    request<{ ok: true }>("POST", `${documentsPath(slug, kind, id)}/dismiss`, doc),
  rematchDocuments: (slug: string, kind: string, id: string) => request<{ ok: true }>("POST", `${documentsPath(slug, kind, id)}/rematch`, {}),
  /** `to: "vault"` keeps a personal document in the person's own Vault,
   *  linked to the record, where shared Files refuse it (#5871). */
  copyDocument: (slug: string, kind: string, id: string, doc: { connection_id: string; ref: string; to?: "files" | "vault" }) =>
    request<{ job: { id: string; status: string } }>("POST", `${documentsPath(slug, kind, id)}/copies`, doc),
  documentThumbPath: (slug: string, doc: { connection_id: string; ref: string }) =>
    `/orgs/${slug}/modules/core-documents/thumb?connection_id=${encodeURIComponent(doc.connection_id)}&ref=${encodeURIComponent(doc.ref)}`,
};
