import { ApiError, getToken, request } from "./client";

export interface ActionLabelButton {
  entity_kind: string;
  entity_id: string;
  action_id: string;
  binding_id?: string | null;
  args?: Record<string, unknown>;
  label?: string | null;
}

export interface ActionLabel {
  id: string;
  code: string;
  url: string;
  title: string;
  hint: string | null;
  buttons: ActionLabelButton[];
  created_at: string;
  revoked_at: string | null;
}

export interface ActionLabelPreview {
  id: string;
  code: string;
  title: string;
  hint: string | null;
  buttons: Array<ActionLabelButton & { index: number; record_title: string | null; action_label: string; available: boolean }>;
}

export interface QrToken {
  id: string;
  token: string;
  entity_kind: string;
  entity_id: string;
  mode: "navigate" | "action";
  action_id: string | null;
  auth: "public" | "session";
  config: Record<string, unknown>;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  /** Ready-to-print scan URL the server built from the workspace's effective
   *  base (custom label base URL, else the serving origin) + /qr/<token>. */
  scan_url: string;
}

export interface QrSettings {
  token_style: "descriptive" | "opaque";
  /** Custom base URL printed codes encode, or null to use the serving origin. */
  label_base_url: string | null;
}

export const labelsApi = {

  // ─── labels: action labels (#3897) ────────────────────────────────
  listActionLabels: (slug: string) => request<{ items: ActionLabel[] }>("GET", `/orgs/${slug}/modules/labels/action-labels`),
  actionLabelByCode: (slug: string, code: string) =>
    request<ActionLabelPreview>(
      "GET",
      `/orgs/${slug}/modules/labels/action-labels/by-code/${code.split("/").map(encodeURIComponent).join("/")}`,
    ),
  createActionLabel: (slug: string, body: { title: string; hint?: string | null; buttons: ActionLabelButton[] }) =>
    request<ActionLabel>("POST", `/orgs/${slug}/modules/labels/action-labels`, body),
  updateActionLabel: (slug: string, id: string, body: { title?: string; hint?: string | null; buttons?: ActionLabelButton[] }) =>
    request<ActionLabel>("PATCH", `/orgs/${slug}/modules/labels/action-labels/${id}`, body),
  revokeActionLabel: (slug: string, id: string) => request<ActionLabel>("POST", `/orgs/${slug}/modules/labels/action-labels/${id}/revoke`, {}),
  printActionLabel: (slug: string, id: string, qty = 1) =>
    request<{ queued: unknown }>("POST", `/orgs/${slug}/modules/labels/action-labels/${id}/print`, { qty }),

  // ─── labels: QR scan tokens (merged from core-labels-qr) ──────────
  listQrTokens: (slug: string) =>
    request<{ items: QrToken[] }>(
      "GET",
      `/orgs/${slug}/modules/labels/qr/tokens`,
    ),
  downloadQrPng: async (slug: string, id: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`/api/v1/orgs/${encodeURIComponent(slug)}/modules/labels/qr/tokens/${encodeURIComponent(id)}/png`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(res.status, body?.error?.code ?? "download_failed", body?.error?.message ?? "Couldn't download the QR image. Try again.");
    }
    return res.blob();
  },
  revokeQrToken: (slug: string, id: string) =>
    request<QrToken>(
      "POST",
      `/orgs/${slug}/modules/labels/qr/tokens/${id}/revoke`,
    ),
  getQrSettings: (slug: string) =>
    request<QrSettings>(
      "GET",
      `/orgs/${slug}/modules/labels/qr/settings`,
    ),
  setQrTokenStyle: (slug: string, token_style: "descriptive" | "opaque") =>
    request<QrSettings>(
      "PUT",
      `/orgs/${slug}/modules/labels/qr/settings`,
      { token_style },
    ),
  /** Set (or clear, with "") the custom base URL printed QR codes encode. */
  setQrLabelBaseUrl: (slug: string, label_base_url: string) =>
    request<QrSettings>(
      "PUT",
      `/orgs/${slug}/modules/labels/qr/settings`,
      { label_base_url },
    ),
  // Resolve a native /qr/<token> to its target {entity_kind, entity_id, org_slug}
  // WITHOUT navigating — lets the scanner branch (e.g. a location → set the filing
  // bin) before falling back to the normal navigate. Unauthenticated, the same
  // JSON the /qr/:token page reads.
  resolveQrToken: (token: string) =>
    // Per-segment encode so a descriptive token's slash survives the path.
    fetch(`/api/v1/qr/${token.split("/").map(encodeURIComponent).join("/")}`, { headers: { accept: "application/json" } })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              org_slug?: string;
              entity_kind?: string;
              entity_id?: string;
              detail_path?: string;
              mode?: string;
            }>)
          : null,
      )
      .catch(() => null),
};
