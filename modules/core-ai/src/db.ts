// Tenant-side DB types for core-ai.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CoreAiProvidersTable {
  id: Generated<string>;
  provider_id: string;
  label: string;
  credentials_enc: string;
  config: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  monthly_budget_cents: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreAiCapabilityDefaultsTable {
  capability: string;
  provider_id: string;
  model: string;
  config: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreAiCallsTable {
  id: Generated<string>;
  provider_id: string;
  capability: string;
  model: string | null;
  /** Who initiated the call (null = system-initiated, e.g. a wire). */
  user_id: string | null;
  input_summary: string | null;
  output_summary: string | null;
  /** Full prompt / response (images redacted, capped). For the activity log. */
  input_full: string | null;
  output_full: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  duration_ms: number | null;
  ok: boolean;
  error: string | null;
  source_kind: string | null;
  source_id: string | null;
  cached: Generated<boolean>;
  invoked_at: Generated<Date>;
}

export interface CoreAiCacheTable {
  cache_key: string;
  capability: string;
  result: Record<string, unknown>;
  cost_cents: number | null;
  hit_count: Generated<number>;
  created_at: Generated<Date>;
  last_hit_at: Date | null;
}

export interface CoreAiDB {
  core_ai_providers: CoreAiProvidersTable;
  core_ai_capability_defaults: CoreAiCapabilityDefaultsTable;
  core_ai_calls: CoreAiCallsTable;
  core_ai_cache: CoreAiCacheTable;
  core_ai_basics: CoreAiBasicsTable;
  core_ai_chat_prefs: CoreAiChatPrefsTable;
  core_ai_chat_writes: CoreAiChatWritesTable;
}

// Ask Cobb per-user tool consent: may the chat READ this user's workspace data
// into prompts, and what's the write mode (off / ask / auto)? Absent row =
// read on + ask. write_tools is the boolean-era column kept for back-compat;
// write_mode is the source of truth.
export interface CoreAiChatPrefsTable {
  user_id: string;
  read_tools: Generated<boolean>;
  write_tools: Generated<boolean>;
  write_mode: Generated<string>;
  updated_at: Generated<Date>;
}

// The AI change ledger: every write Cobb executes (confirmed or auto-applied),
// with a before-image so undo is mechanical. An undo is its own row (undo_of).
export interface CoreAiChatWritesTable {
  id: Generated<string>;
  user_id: string;
  tool: "create" | "update" | "delete" | "action";
  entity_kind: string;
  entity_id: string | null;
  entity_label: Generated<string>;
  before: unknown | null;
  payload: unknown | null;
  auto_applied: Generated<boolean>;
  undone_at: Date | null;
  undo_of: string | null;
  created_at: Generated<Date>;
}

// Ask Cobb "basic mode" per-workspace rows: overrides of built-in rules
// (builtin_key set) + net-new custom rules (builtin_key null). Built-in
// defaults live in code (basics-catalog.ts); this table only stores changes.
export interface CoreAiBasicsTable {
  id: Generated<string>;
  builtin_key: string | null;
  intent: string;
  keywords: Generated<string[]>; // jsonb array of trigger phrases
  reply: string;
  enabled: Generated<boolean>;
  position: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<CoreAiDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-ai route called without tenant context");
  return t.db as Kysely<CoreAiDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-ai route called without tenant context");
  return { org: t.org, role: t.role };
}

/** The user who made the request (for the AI activity log). Null if absent. */
export function sessionUserId(req: Request): string | null {
  return (req as unknown as RequestWithTenant).session?.id ?? null;
}

/** The signed-in user's display name — the person Cobb is ACTUALLY talking to.
 *  Must come from the request session, never the AI connection's owner (a shared
 *  connection is someone else's key; the caller is still the caller). */
export function sessionDisplayName(req: Request): string | null {
  const n = (req as unknown as RequestWithTenant).session?.display_name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}
