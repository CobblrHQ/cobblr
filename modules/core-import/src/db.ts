// Kysely tenant-DB types for core-import: the import runs and their steps.

import type { Generated, Kysely } from "kysely";

export interface ImportRunsTable {
  id: Generated<string>;
  created_at: Generated<Date>;
  created_by_user_id: string | null;
  source: Generated<string>;
  filename: string | null;
  status: Generated<string>;
  progress_done: Generated<number>;
  progress_total: Generated<number>;
  summary: Generated<unknown>;
  work: Generated<unknown>;
  error: string | null;
  finished_at: Date | null;
  undone_at: Date | null;
  undo_report: unknown | null;
  /** When the worker carrying the run last said it was alive; null between its chunks. */
  heartbeat_at: Date | null;
  /** Where the run had got to, and what it had found so far, to carry on from. */
  resume: unknown | null;
}

export interface ImportRunStepsTable {
  id: Generated<string>;
  run_id: string;
  seq: number;
  kind: string;
  entity_kind: string | null;
  entity_id: string | null;
  label: string | null;
  before: unknown | null;
  after_hash: string | null;
  detail: Generated<unknown>;
  undone_at: Date | null;
}

export interface CoreImportDB {
  core_import_runs: ImportRunsTable;
  core_import_run_steps: ImportRunStepsTable;
}

export type ImportDb = Kysely<CoreImportDB>;
