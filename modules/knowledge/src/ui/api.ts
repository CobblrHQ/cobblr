// Thin fetch wrapper for the knowledge REST surface. Auth via getToken().
// Routes are mounted at /api/v1/orgs/:slug/modules/knowledge/...

import { describeUnreadableBody } from "@cobblr/platform-web";

export interface Entry {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  pinned: boolean;
  code: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

export type EntryInput = {
  title: string;
  body?: string | null;
  kind?: string | null;
  pinned?: boolean;
  code?: string | null;
  image_path?: string | null;
};

export class KnowledgeApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class KnowledgeApi {
  constructor(private readonly slug: string, private readonly getToken: () => string | null) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`/api/v1/orgs/${this.slug}/modules/knowledge${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    // TEXT first: res.json() CONSUMES the body, so once it throws the one
    // thing that says what went wrong is gone. See describeUnreadableBody.
    const raw = await res.text();
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new KnowledgeApiError(res.status, "non_json", describeUnreadableBody(res.status, raw));
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new KnowledgeApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
    }
    return parsed as T;
  }

  listEntries(opts?: { pinned?: boolean; kind?: string; q?: string }) {
    const qs = new URLSearchParams();
    if (opts?.pinned) qs.set("pinned", "1");
    if (opts?.kind) qs.set("kind", opts.kind);
    if (opts?.q) qs.set("q", opts.q);
    const s = qs.toString();
    return this.req<{ items: Entry[] }>("GET", `/entries${s ? `?${s}` : ""}`);
  }
  getEntry(id: string) {
    return this.req<Entry>("GET", `/entries/${id}`);
  }
  createEntry(body: EntryInput) {
    return this.req<Entry>("POST", "/entries", body);
  }
  updateEntry(id: string, body: Partial<EntryInput>) {
    return this.req<Entry>("PATCH", `/entries/${id}`, body);
  }
  deleteEntry(id: string) {
    return this.req<void>("DELETE", `/entries/${id}`);
  }
  async uploadImage(id: string, file: File): Promise<{ image_path: string }> {
    const token = this.getToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/v1/orgs/${this.slug}/modules/knowledge/entries/${id}/image`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new KnowledgeApiError(res.status, "upload_failed", e?.error?.message ?? "Image upload failed");
    }
    return (await res.json()) as { image_path: string };
  }
}
