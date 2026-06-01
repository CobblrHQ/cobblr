// Tool registration for the Cobblr MCP server.
//
// Each tool maps onto exactly one Cobblr REST endpoint (see client.ts). The
// descriptions are written for the *driving model* (a local Claude Code /
// Desktop), so they explain the build loop, not just the parameters.
//
// Two build loops, both ending at the same validate→apply gate:
//
// A) FROM A TEMPLATE (cheapest, prefer this — most asks are a diff of a near template):
//   1. cobblr_list_workspaces            → pick a slug (or rely on the default)
//   2. cobblr_list_templates             → pick the template nearest the user's ask
//   3. cobblr_authoring_compile          → task="customize-template", base_template_id=<picked>
//   4. (the model edits that template's manifest for the user's intent)
//   5. cobblr_authoring_candidate        → submit; kernel validates
//   6. if invalid → cobblr_authoring_repair_prompt, fix, resubmit (5)
//   7. cobblr_authoring_apply            → install
//
// B) FROM SCRATCH (when no template is close):
//   2. cobblr_authoring_context          → see entity kinds + wireable actions
//   3. cobblr_authoring_compile          → task="create-bundle" (default)
//   4–7. same as above.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CobblrApiError, type CobblrClient } from "./client.js";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(e: unknown) {
  const msg =
    e instanceof CobblrApiError
      ? JSON.stringify(
          { error: { code: e.code, message: e.message, status: e.status, details: e.details } },
          null,
          2,
        )
      : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const workspaceArg = {
  workspace: z
    .string()
    .optional()
    .describe(
      "Workspace (org) slug. Optional if COBBLR_ORG_SLUG is set. Use cobblr_list_workspaces to discover slugs.",
    ),
};

export function registerTools(server: McpServer, client: CobblrClient): void {
  server.registerTool(
    "cobblr_list_workspaces",
    {
      title: "List Cobblr workspaces",
      description:
        "List the workspaces (orgs) this API token can access, with their slugs and your role. Call this first if you don't know which workspace slug to use.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.listOrgs());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_list_templates",
    {
      title: "List flagship templates",
      description:
        "List the curated starting templates (home inventory, collection+maintenance, garden, lego, …) with their use_case phrases and required modules. PREFER starting from a template: pick the one nearest the user's ask, then cobblr_authoring_compile with task='customize-template' and base_template_id. Only build from scratch (create-bundle) when nothing is close.",
      inputSchema: { ...workspaceArg },
    },
    async ({ workspace }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.listTemplates(slug));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_match_template",
    {
      title: "Match an intent to the nearest template (server-side)",
      description:
        "Ask Cobblr's own cheap AI which template best fits a plain-English idea, returning {template_id, confidence, reason, ai}. Optional — you can also just read cobblr_list_templates and pick yourself (free, no server inference). Useful as a quick suggestion; `ai:false` means no AI provider is configured server-side, so fall back to listing templates.",
      inputSchema: {
        ...workspaceArg,
        intent: z.string().min(1).max(4000).describe("Plain-English description of the app the user wants."),
      },
    },
    async ({ workspace, intent }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.matchTemplate(slug, intent));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_get_template",
    {
      title: "Get a template",
      description:
        "Fetch one template's full detail, including its starting bundle manifest. Use this to see exactly what you'll be editing when customizing.",
      inputSchema: {
        ...workspaceArg,
        template_id: z.string().describe("Template id from cobblr_list_templates (e.g. 'home-inventory')."),
      },
    },
    async ({ workspace, template_id }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.getTemplate(slug, template_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_authoring_context",
    {
      title: "Inspect buildable context",
      description:
        "Show the entity kinds (with their fields) and the actions those kinds can be wired to, in this workspace. This is the 'minimal sufficient context' for building a bundle — read it before composing a manifest so you only reference ids that exist. Optionally narrow to specific kinds.",
      inputSchema: {
        ...workspaceArg,
        selected_kinds: z
          .array(z.string())
          .optional()
          .describe("Entity-kind ids to focus on, e.g. ['inventory:part']. Omit for all enabled kinds."),
      },
    },
    async ({ workspace, selected_kinds }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.authoringContext(slug, selected_kinds));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_authoring_compile",
    {
      title: "Compile intent into a build draft",
      description:
        "Turn a plain-English description of what the user wants into a persisted draft and a compiled prompt. The prompt tells you exactly what bundle manifest to produce (from scratch) or how to edit a template. After this, YOU produce the manifest, then submit it with cobblr_authoring_candidate. PREFER task='customize-template' with a base_template_id (cheaper, higher quality); use the default 'create-bundle' only when no template is close.",
      inputSchema: {
        ...workspaceArg,
        intent: z
          .string()
          .min(1)
          .max(4000)
          .describe("Plain-English description of the app change the user wants."),
        selected_kinds: z
          .array(z.string())
          .optional()
          .describe("Entity-kind ids to scope the build to (keeps context minimal). Optional; defaults to the template's kinds for customize-template."),
        task: z
          .string()
          .optional()
          .describe("Authoring task: 'create-bundle' (default, from scratch) or 'customize-template' (diff a template — preferred)."),
        base_template_id: z
          .string()
          .optional()
          .describe("Required when task='customize-template': the template id to start from (see cobblr_list_templates)."),
      },
    },
    async ({ workspace, intent, selected_kinds, task, base_template_id }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.authoringCompile(slug, intent, selected_kinds, task, base_template_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_authoring_candidate",
    {
      title: "Submit a candidate bundle manifest",
      description:
        "Submit the bundle manifest you produced (from the compiled prompt) for a draft. The Cobblr kernel validates it (structure + that every referenced kind/action/module exists + collisions) and returns { valid, errors, preview }. NOTHING is applied yet. If valid:false, call cobblr_authoring_repair_prompt, fix the manifest, and resubmit.",
      inputSchema: {
        ...workspaceArg,
        draft_id: z.string().describe("The draft_id returned by cobblr_authoring_compile."),
        manifest: z
          .record(z.unknown())
          .describe("The bundle manifest object (id, version, name, requires[], field_defs[], wires[])."),
      },
    },
    async ({ workspace, draft_id, manifest }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.authoringCandidate(slug, draft_id, manifest));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_authoring_repair_prompt",
    {
      title: "Get a repair prompt for a rejected draft",
      description:
        "When a submitted candidate was invalid, get a prompt that restates the original ask plus the rejected manifest and the validation errors, so you can produce a corrected manifest and resubmit with cobblr_authoring_candidate.",
      inputSchema: {
        ...workspaceArg,
        draft_id: z.string().describe("The draft_id whose candidate failed validation."),
      },
    },
    async ({ workspace, draft_id }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.authoringRepairPrompt(slug, draft_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_authoring_apply",
    {
      title: "Apply a validated bundle",
      description:
        "Install the validated candidate for a draft into the workspace (adds the custom fields + wires). This is the only step that MUTATES the app. Re-validates before applying. Only call after cobblr_authoring_candidate returned valid:true and the user has confirmed they want it applied.",
      inputSchema: {
        ...workspaceArg,
        draft_id: z.string().describe("The draft_id whose candidate is valid and should be applied."),
        confirm: z
          .boolean()
          .optional()
          .describe("Auto-enable any required-but-disabled modules. Defaults to true."),
      },
    },
    async ({ workspace, draft_id, confirm }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.authoringApply(slug, draft_id, confirm ?? true));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_authoring_list_drafts",
    {
      title: "List build drafts",
      description: "List recent build drafts in this workspace (history + status).",
      inputSchema: { ...workspaceArg },
    },
    async ({ workspace }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.authoringListDrafts(slug));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_authoring_get_draft",
    {
      title: "Get a build draft",
      description: "Fetch one draft's full detail (intent, compiled prompt, candidate, validation).",
      inputSchema: {
        ...workspaceArg,
        draft_id: z.string().describe("The draft_id to fetch."),
      },
    },
    async ({ workspace, draft_id }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.authoringGetDraft(slug, draft_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_validate_bundle",
    {
      title: "Validate a hand-written bundle",
      description:
        "Validate a bundle manifest directly (without going through a draft). Returns { valid, errors, preview }. Use this when you already have a manifest and just want to check it. Applies nothing.",
      inputSchema: {
        ...workspaceArg,
        manifest: z.record(z.unknown()).describe("The bundle manifest object to validate."),
        auto_enable: z
          .boolean()
          .optional()
          .describe("Treat required-but-disabled modules as enable-able when previewing."),
      },
    },
    async ({ workspace, manifest, auto_enable }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.validateBundle(slug, manifest, auto_enable));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cobblr_install_bundle",
    {
      title: "Install a hand-written bundle",
      description:
        "Validate and install a bundle manifest directly (without a draft). MUTATES the app. Prefer the draft flow (compile → candidate → apply) for AI-built bundles; use this for a manifest you already trust.",
      inputSchema: {
        ...workspaceArg,
        manifest: z.record(z.unknown()).describe("The bundle manifest object to install."),
        confirm: z
          .boolean()
          .optional()
          .describe("Auto-enable any required-but-disabled modules. Defaults to true."),
      },
    },
    async ({ workspace, manifest, confirm }) => {
      try {
        const slug = client.resolveSlug(workspace);
        return ok(await client.installBundle(slug, manifest, confirm ?? true));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
