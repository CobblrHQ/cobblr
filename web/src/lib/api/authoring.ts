import type { BundleUpgradeConflict } from "./bundles";
import { request } from "./client";

// core-authoring — context assembler + validation result shapes.
export interface AuthoringContextKind {
  id: string;
  displayName: string;
  fields: { name: string; type: string; role?: string; required?: boolean }[];
}
export interface AuthoringContextAction {
  id: string;
  label: string;
  description: string;
}
export interface AuthoringContext {
  kinds: AuthoringContextKind[];
  actions: AuthoringContextAction[];
  output_contract: string;
  warnings: string[];
}
export interface BundleValidationError {
  path: string;
  code: string;
  message: string;
}
export interface BundleValidationPreview {
  fields_added: { entity_kind: string; name: string; type: string; display_label: string }[];
  wires_added: { source_kind: string; action_id: string; trigger_type: string }[];
  modules_required: string[];
  modules_to_enable: string[];
  instances_created?: {
    module: string;
    instance_name: string;
    display_name: string;
    item_noun: string | null;
    fields: { name: string; type: string; display_label: string }[];
    wires: number;
  }[];
  nav_headings?: { name: string; members: { target_kind: string; target_id: string }[] }[];
  /** Phase 2 — on a self-upgrade, fields the user customized that this version
   *  changes. Empty on a fresh install. */
  upgrade_conflicts?: BundleUpgradeConflict[];
}
export interface BundleValidation {
  valid: boolean;
  errors: BundleValidationError[];
  preview: BundleValidationPreview | null;
}

export const authoringApi = {

  // ─── core-authoring (AI bundle builder, Phase 1: copy-paste) ───────
  authoringContext: (slug: string, selected_kinds?: string[]) =>
    request<AuthoringContext>("POST", `/orgs/${slug}/modules/core-authoring/context`, { selected_kinds }),
  authoringCompile: (
    slug: string,
    body: { intent: string; selected_kinds?: string[]; task?: string; base_template_id?: string },
  ) =>
    request<{ draft_id: string; prompt: string; warnings: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/compile`,
      body,
    ),
  /** Hosted build (Phase 2): the server calls AI itself + auto-repairs. ASYNC —
   *  returns { draft_id, status:"building" } immediately; poll authoringDraft
   *  until status leaves "building". Throws 409 when the workspace has no AI
   *  (caller falls back to authoringCompile). */
  authoringBuild: (
    slug: string,
    body: { intent: string; selected_kinds?: string[]; task?: string; base_template_id?: string },
  ) =>
    request<{ draft_id: string; status: string }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/build`,
      body,
    ),
  /** Poll a build draft. status: building → keep polling; validated | candidate
   *  | failed → terminal. candidate/validation/interpretation populate as the
   *  background build progresses. */
  authoringDraft: (slug: string, draftId: string) =>
    request<{
      id: string;
      status: string;
      task: string;
      intent: string;
      candidate?: unknown;
      validation?: BundleValidation | null;
      interpretation?: string | null;
      /** design-workspace: starter records that apply will create. */
      seed_plan?: { kind: string; records: Record<string, unknown>[] }[] | null;
    }>("GET", `/orgs/${slug}/modules/core-authoring/drafts/${draftId}`),
  /** Phase 3 refine: revise a draft's artifact against a change request. A NEW
   *  draft is created (parent_draft_id lineage). run:true → hosted build (202,
   *  poll authoringDraft); run:false → copy-paste prompt (201). */
  authoringRefine: (slug: string, draftId: string, body: { intent: string; run?: boolean }) =>
    request<{ draft_id: string; parent_draft_id: string; status?: string; prompt?: string; warnings?: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/refine`,
      body,
    ),
  authoringCandidate: (slug: string, draftId: string, manifest: unknown) =>
    request<BundleValidation>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/candidate`,
      { manifest },
    ),
  authoringRepairPrompt: (slug: string, draftId: string) =>
    request<{ prompt: string }>("POST", `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/repair-prompt`),
  authoringApply: (slug: string, draftId: string, confirm = true) =>
    request<{
      applied: boolean;
      bundle?: unknown;
      seeded?: { created: number; skipped: number };
      // design-app: apply created a WorkspaceApp instead of installing a bundle.
      app?: { slug: string; name: string };
    }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/apply`,
      { confirm },
    ),
};
