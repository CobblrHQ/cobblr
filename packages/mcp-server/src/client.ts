// Thin HTTP client over the Cobblr REST API.
//
// The MCP server adds NO new backend — every tool maps onto an existing
// /api/v1 endpoint. This client just attaches the bearer token, resolves the
// workspace slug, and normalises errors into a shape the tools can surface.

import type { Config } from "./config.js";

export class CobblrApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CobblrApiError";
  }
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export class CobblrClient {
  constructor(private cfg: Config) {}

  /** The workspace slug to use: explicit arg → configured default → error. */
  resolveSlug(explicit?: string | null): string {
    const slug = (explicit ?? "").trim() || this.cfg.defaultOrgSlug;
    if (!slug) {
      throw new CobblrApiError(
        400,
        "no_workspace",
        "No workspace specified. Pass `workspace` (the org slug), or set COBBLR_ORG_SLUG. Use the `cobblr_list_workspaces` tool to see available slugs.",
      );
    }
    return slug;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new CobblrApiError(
        0,
        "network_error",
        `Could not reach Cobblr at ${url}: ${e instanceof Error ? e.message : String(e)}. Check COBBLR_BASE_URL and that the install is running.`,
      );
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const err =
        parsed && typeof parsed === "object" && "error" in parsed
          ? (parsed as { error: { code?: string; message?: string; details?: unknown } }).error
          : undefined;
      throw new CobblrApiError(
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.message ?? `Request failed: ${method} ${path} → ${res.status}`,
        err?.details ?? parsed,
      );
    }

    return parsed as T;
  }

  // ── Workspace discovery ──────────────────────────────────────────────
  listOrgs(): Promise<{ items: OrgSummary[] }> {
    return this.request("GET", "/orgs");
  }

  // ── Operate any app's data (generic entity + action surface) ─────────
  // These wrap the kernel's generic registry endpoints, so they cover EVERY
  // module and every app a user builds — read records, discover the verbs that
  // apply, and invoke them. No per-module code.
  private orgBase(slug: string): string {
    return `/orgs/${encodeURIComponent(slug)}`;
  }

  listEntityKinds(slug: string): Promise<{ items: unknown[] }> {
    return this.request("GET", `${this.orgBase(slug)}/entity-kinds`);
  }

  listEntities(
    slug: string,
    kind: string,
    opts?: { q?: string; limit?: number; filter?: Record<string, string> },
  ): Promise<{ items: unknown[] }> {
    const p = new URLSearchParams();
    if (opts?.q) p.set("q", opts.q);
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.filter) for (const [k, v] of Object.entries(opts.filter)) p.set(`filter[${k}]`, v);
    const qs = p.toString();
    // `kind` is `module:kind` — safe path chars, passed raw (matches the app's own usage).
    return this.request("GET", `${this.orgBase(slug)}/entities/${kind}${qs ? `?${qs}` : ""}`);
  }

  getEntity(slug: string, kind: string, id: string): Promise<unknown> {
    return this.request("GET", `${this.orgBase(slug)}/entities/${kind}/${encodeURIComponent(id)}`);
  }

  listActions(slug: string): Promise<{ items: unknown[] }> {
    return this.request("GET", `${this.orgBase(slug)}/registered-actions`);
  }

  invokeAction(
    slug: string,
    actionId: string,
    entityKind: string,
    entityId: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request("POST", `${this.orgBase(slug)}/actions/invoke`, {
      actionId,
      entityKind,
      entityId,
      args,
    });
  }

  // ── core-authoring (the AI app-builder) ──────────────────────────────
  private authoringBase(slug: string): string {
    return `/orgs/${encodeURIComponent(slug)}/modules/core-authoring`;
  }

  listTemplates(slug: string): Promise<{ items: unknown[] }> {
    return this.request("GET", `${this.authoringBase(slug)}/templates`);
  }

  getTemplate(slug: string, id: string): Promise<unknown> {
    return this.request(
      "GET",
      `${this.authoringBase(slug)}/templates/${encodeURIComponent(id)}`,
    );
  }

  matchTemplate(slug: string, intent: string): Promise<unknown> {
    return this.request("POST", `${this.authoringBase(slug)}/match-template`, { intent });
  }

  authoringContext(slug: string, selectedKinds?: string[]): Promise<unknown> {
    return this.request("POST", `${this.authoringBase(slug)}/context`, {
      selected_kinds: selectedKinds,
    });
  }

  authoringCompile(
    slug: string,
    intent: string,
    selectedKinds?: string[],
    task?: string,
    baseTemplateId?: string,
  ): Promise<{ draft_id: string; prompt: string; warnings?: unknown }> {
    return this.request("POST", `${this.authoringBase(slug)}/compile`, {
      intent,
      selected_kinds: selectedKinds,
      task,
      base_template_id: baseTemplateId,
    });
  }

  authoringCandidate(slug: string, draftId: string, manifest: unknown): Promise<unknown> {
    return this.request(
      "POST",
      `${this.authoringBase(slug)}/drafts/${encodeURIComponent(draftId)}/candidate`,
      { manifest },
    );
  }

  authoringRepairPrompt(slug: string, draftId: string): Promise<{ prompt: string }> {
    return this.request(
      "POST",
      `${this.authoringBase(slug)}/drafts/${encodeURIComponent(draftId)}/repair-prompt`,
    );
  }

  authoringApply(slug: string, draftId: string, confirm = true): Promise<unknown> {
    return this.request(
      "POST",
      `${this.authoringBase(slug)}/drafts/${encodeURIComponent(draftId)}/apply`,
      { confirm },
    );
  }

  authoringListDrafts(slug: string): Promise<{ items: unknown[] }> {
    return this.request("GET", `${this.authoringBase(slug)}/drafts`);
  }

  authoringGetDraft(slug: string, draftId: string): Promise<unknown> {
    return this.request(
      "GET",
      `${this.authoringBase(slug)}/drafts/${encodeURIComponent(draftId)}`,
    );
  }

  // ── bundles (validate / install directly, for hand-authored manifests) ─
  validateBundle(slug: string, manifest: unknown, autoEnable?: boolean): Promise<unknown> {
    return this.request("POST", `/orgs/${encodeURIComponent(slug)}/bundles/validate`, {
      manifest,
      autoEnable,
    });
  }

  installBundle(slug: string, manifest: unknown, confirm?: boolean): Promise<unknown> {
    return this.request("POST", `/orgs/${encodeURIComponent(slug)}/bundles/install`, {
      manifest,
      confirm,
    });
  }

  // ── Browser driving (Feature 3) ──────────────────────────────────
  driveRequestWindow(slug: string): Promise<unknown> {
    return this.request("POST", `/orgs/${encodeURIComponent(slug)}/drive/driver/request`, {});
  }
  driveNavigate(slug: string, path: string): Promise<unknown> {
    return this.request("POST", `/orgs/${encodeURIComponent(slug)}/drive/driver/navigate`, { path });
  }
  driveStatus(slug: string): Promise<unknown> {
    return this.request("GET", `/orgs/${encodeURIComponent(slug)}/drive/status`);
  }
  drivePresent(slug: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/orgs/${encodeURIComponent(slug)}/drive/driver/present`, payload);
  }
  driveObserve(slug: string): Promise<unknown> {
    return this.request("GET", `/orgs/${encodeURIComponent(slug)}/drive/driver/observe`);
  }
}
