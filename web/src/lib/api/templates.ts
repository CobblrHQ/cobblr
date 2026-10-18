import { request } from "./client";

export interface EntityTemplate {
  id: string;
  target_kind: string;
  name: string;
  description: string | null;
  defaults: Record<string, unknown>;
  default_tags: string[];
  position: number;
  created_at: string;
  updated_at: string;
}

export const templatesApi = {

  // core-templates — per-workspace entity templates. See
  // docs/product/homebox-parity-report.md punch-list item #2.
  listTemplates: (slug: string, targetKind?: string) => {
    const qs = targetKind ? `?target_kind=${encodeURIComponent(targetKind)}` : "";
    return request<{ items: EntityTemplate[] }>(
      "GET",
      `/orgs/${slug}/modules/core-templates/templates${qs}`,
    );
  },
  /** The kinds a template can be made for in this workspace, named as a person says them. */
  listTemplateKinds: (slug: string) =>
    request<{ items: Array<{ id: string; display_name: string; display_name_plural: string | null }> }>(
      "GET",
      `/orgs/${slug}/modules/core-templates/templates/kinds`,
    ),
  getTemplate: (slug: string, id: string) =>
    request<EntityTemplate>(
      "GET",
      `/orgs/${slug}/modules/core-templates/templates/${id}`,
    ),
  createTemplate: (
    slug: string,
    body: {
      target_kind: string;
      name: string;
      description?: string | null;
      defaults?: Record<string, unknown>;
      default_tags?: string[];
      position?: number;
    },
  ) =>
    request<EntityTemplate>(
      "POST",
      `/orgs/${slug}/modules/core-templates/templates`,
      body,
    ),
  updateTemplate: (slug: string, id: string, body: Partial<EntityTemplate>) =>
    request<EntityTemplate>(
      "PATCH",
      `/orgs/${slug}/modules/core-templates/templates/${id}`,
      body,
    ),
  deleteTemplate: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-templates/templates/${id}`,
    ),
  instantiateTemplate: <T = { id: string }>(
    slug: string,
    id: string,
    overrides?: Record<string, unknown>,
    destination?: { instance?: string; scan_item_id?: string },
  ) =>
    request<T>(
      "POST",
      `/orgs/${slug}/modules/core-templates/templates/${id}/instantiate`,
      { overrides, ...destination },
    ),
};
