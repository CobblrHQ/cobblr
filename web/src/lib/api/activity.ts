import { request } from "./client";

export interface ActivityEntry {
  summary?: string;
  template?: string;
  verb?: string;
  subject?: import("@cobblr/platform-contract/activity-summary").ActivitySubject;
  hidden?: boolean;
  repeats?: number;
  id: number;
  user_id: string | null;
  module_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  diff: unknown | null;
  auth_method: "session" | "api_token" | "system";
  api_token_id: string | null;
  occurred_at: string;
  actor: { id: string; display_name: string | null; email: string | null } | null;
  token: { id: string; name: string; prefix: string | null } | null;
  /** HOW the write was made, beside who (#3833): "mcp", "assistant",
   *  "automation", or null for a hand edit (and on older rows). */
  via_kind?: string | null;
  /** The automation's label, when via_kind is "automation". */
  via_label?: string | null;
  /** The entity's display title resolved from its live record (server-side), so
   *  updates/creates show a name instead of the bare entity_type. Null when the
   *  record is gone (deleted) or the kind isn't resolvable. */
  entity_title?: string | null;
  /** The COLLECTION the record lives in (`bookshelf:item`), resolved from the
   *  live record, so the feed can use its noun. Null when the record is gone. */
  entity_kind?: string | null;
  /** What an edit changed, in words (the api's history-describe): each field
   *  under its label, old → new, a photo as a photo. Empty for anything else. */
  said?: SaidChange[];
  restorable?: boolean;
}

/** A picture in a record's history: never named by its path on the line. */
export interface ShownPhoto {
  file_id: string;
  thumb: string;
  filename: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  source: import("@cobblr/platform-contract/photo-source").PhotoSource | null;
  /** The stored address, shown only inside the photo's detail card. */
  path: string;
}
export interface ShownValue {
  /** The value in words; null reads "(empty)". */
  text: string | null;
  photo?: ShownPhoto;
}
export interface SaidChange {
  field: string;
  label: string;
  /** Absent on an edit made before old values were kept. */
  from?: ShownValue;
  to: ShownValue;
}

/** Shape of /me/activity rows — every workspace activity attributed
 *  to the caller, joined with the org's slug + name. */
export interface CrossOrgActivityEntry {
  id: string;
  action: string;
  module: string | null;
  entity_type: string | null;
  entity_id: string | null;
  diff: unknown | null;
  occurred_at: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  /** The row as a sentence ("You reserved Review Blue Owl") and what it is
   *  about, named and linked: the same namer as the workspace's feed. */
  summary?: string;
  verb?: string;
  subject?: { href: string; title: string; kind: string | null; id: string; thumbnail: string | null };
}

export const activityApi = {

  orgActivity: (slug: string, limit = 25, before?: number | null) =>
    request<{ items: ActivityEntry[]; next_before?: number | null }>("GET", `/orgs/${slug}/activity?limit=${limit}${before != null ? `&before=${before}` : ""}`),
  // Cross-workspace activity feed: every action attributed to any
  // workspace the caller belongs to. Optional ?org= narrows to one.
  meActivity: (opts: { limit?: number; org?: string; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.org) qs.set("org", opts.org);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    return request<{ items: CrossOrgActivityEntry[]; next_cursor: string | null; total: number }>(
      "GET",
      `/me/activity${qs.toString() ? `?${qs.toString()}` : ""}`,
    );
  },
  restoreHistoryVersion: (slug: string, entryId: number, body: { kind: string; entity_id: string; expected_latest_id: number }) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/activity/${entryId}/restore`, body),
  listActivity: (
    slug: string,
    opts: {
      actions?: string[];
      authMethods?: ("session" | "api_token" | "system")[];
      apiTokenId?: string;
      entityType?: string;
      /** With entityType: one thing's own entries (a wire's firings). */
      entityId?: string;
      /** One record's history. */
      entity?: { kind: string; id: string };
      limit?: number;
      /** Entries older than this id: the next page. */
      before?: number;
    } = {},
  ) => {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.entity) {
      params.set("entity_kind", opts.entity.kind);
      params.set("entity_id", opts.entity.id);
    }
    if (opts.actions?.length) params.set("actions", opts.actions.join(","));
    if (opts.authMethods?.length) params.set("auth_methods", opts.authMethods.join(","));
    if (opts.apiTokenId) params.set("api_token_id", opts.apiTokenId);
    if (opts.entityType) params.set("entity_type", opts.entityType);
    if (opts.entityType && opts.entityId && !opts.entity) params.set("entity_id", opts.entityId);
    if (opts.before) params.set("before", String(opts.before));
    return request<{ items: ActivityEntry[]; total?: number; next_before?: number | null }>(
      "GET",
      `/orgs/${slug}/activity?${params.toString()}`,
    );
  },
};
