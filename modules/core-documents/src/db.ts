import type { ColumnType, Generated } from "kysely";
import type { RecordFacts } from "@cobblr/platform-contract/library";

type Stamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface RecordsTable {
  record_kind: string;
  record_id: string;
  facts: ColumnType<RecordFacts, string, string>;
  facts_key: string;
  status: Generated<"queued" | "done">;
  attempts: Generated<number>;
  matched_at: Date | null;
  last_error: string | null;
  updated_at: Stamp;
}

export interface DocumentRowCommon {
  record_kind: string;
  record_id: string;
  connection_id: string;
  ref: string;
  title: string;
  created: string | null;
  tags: ColumnType<string[], string, string>;
  open_url: string | null;
  has_thumb: boolean;
  item_type: Generated<string>;
  item_type_label: Generated<string>;
  subtitle: string | null;
  open_label: string | null;
}

export interface SuggestionsTable extends DocumentRowCommon {
  id: Generated<string>;
  score: number;
  because: string | null;
  for_user_id: string | null;
  dismissed_at: Date | null;
  found_at: Stamp;
}

export interface LinkedTable extends DocumentRowCommon {
  system_label: string;
  written_back: Generated<boolean>;
  linked_by: string | null;
  linked_at: Stamp;
  copied_at: Date | null;
  copied_filename: string | null;
  copied_file_id: string | null;
  copy_requested_by: string | null;
}

export interface ConnectionsTable {
  connection_id: string;
  first_seen_at: Stamp;
  caught_up_to: Date | null;
  caught_up_at: Date | null;
}

export interface ItemIdsTable {
  connection_id: string;
  catalogue: string;
  /** Trimmed and lowercased, as the matching rule compares them. */
  outside_id: string;
  ref: string;
  seen_at: Stamp;
}

export interface StateTable {
  id: Generated<boolean>;
  backfilled_at: Date | null;
}

export interface CoreDocumentsDB {
  core_documents_records: RecordsTable;
  core_documents_suggestions: SuggestionsTable;
  core_documents_linked: LinkedTable;
  core_documents_connections: ConnectionsTable;
  core_documents_state: StateTable;
  core_documents_item_ids: ItemIdsTable;
}
